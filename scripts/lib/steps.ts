import type { HardhatEthers } from "@nomicfoundation/hardhat-ethers/types";
import {
  type BaseWallet,
  Contract,
  Interface,
  Transaction,
  type TransactionReceipt,
  getAddress,
  getCreateAddress,
} from "ethers";

import { DEAD_ADDRESS, RECEIPT_TIMEOUT_MS, UNIT } from "./constants.ts";
import { LaunchError } from "./errors.ts";
import { formatEth, formatTokenAmount } from "./format.ts";
import type { UniswapV2Deployment } from "./networks.ts";
import type {
  ApprovalRecord,
  CommunityRecord,
  GameRecord,
  Journal,
  JournaledTx,
  LaunchRecord,
  LiquidityRecord,
  LockRecord,
  NftRecord,
  SeederRecord,
  TokenRecord,
  VestingRecord,
} from "./records.ts";
import type { Genesis } from "./genesis.ts";
import {
  GAME_CONTRACT,
  NFT_CONTRACT,
  SEEDER_CONTRACT,
  TOKEN_CONTRACT,
  VESTING_CONTRACT,
  constructorArgs,
  gameConstructorArgs,
  nftConstructorArgs,
  paramsOf,
  vestingConstructorArgs,
} from "./token.ts";
import {
  type BroadcastResult,
  type TxPayload,
  broadcastRaw,
  firstLine,
  isFeeCapExceeded,
  isFeeRejection,
  isInsufficientFunds,
  nextNonce,
  signTx,
} from "./tx.ts";
import { ERC20_ABI, SEEDER_ABI, type SeedOutcome, readSeedReceipt } from "./uniswap.ts";
import type { TokenParams } from "./validation.ts";
import { VESTING_ABI, readTransferReceipt } from "./vesting.ts";

/**
 * Tout ce dont une étape a besoin. Les scripts fournissent un journal fichier et
 * une confirmation par saisie du symbole sur le mainnet ; la répétition et les
 * tests, un journal en mémoire et une confirmation automatique.
 */
export interface StepContext {
  ethers: HardhatEthers;
  /** Signe localement : le hash de chaque transaction est connu avant sa diffusion. */
  wallet: BaseWallet;
  journal: Journal;
  networkName: string;
  chainId: bigint;
  /** Dernier verrou avant une nouvelle signature décidée pendant une reprise. */
  confirm: (action: string) => Promise<void>;
  log: (message: string) => void;
  receiptTimeoutMs?: number;
}

const seederInterface = new Interface(SEEDER_ABI);
const erc20Interface = new Interface(ERC20_ABI);

function now(): string {
  return new Date().toISOString();
}

async function loadRecord(ctx: StepContext): Promise<LaunchRecord> {
  return (await ctx.journal.read()) ?? { network: ctx.networkName, chainId: ctx.chainId.toString() };
}

function assertSameSigner(ctx: StepContext, entry: JournaledTx): void {
  if (getAddress(ctx.wallet.address) !== getAddress(entry.from)) {
    throw new LaunchError(`Le journal attend le wallet ${entry.from}, mais le wallet chargé est ${ctx.wallet.address}.`);
  }
}

/** Relit un état juste après un reçu : un nœud RPC en retard peut mettre quelques secondes à le voir. */
async function eventually<T>(read: () => Promise<T>, attempts = 10): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw lastError;
}

/**
 * Prochain nonce du wallet, jamais en dessous de ce que le journal sait déjà
 * consommé : un nœud RPC en retard (RPC public réparti sur plusieurs nœuds)
 * peut annoncer un compte périmé juste après un reçu.
 */
async function freshNonce(ctx: StepContext, record: LaunchRecord): Promise<number> {
  const fromRpc = await nextNonce(ctx.ethers.provider, ctx.wallet.address);
  const entries: (JournaledTx | undefined)[] = [
    record.token,
    record.seeder,
    record.approval,
    record.liquidity,
    record.vesting,
    record.lock,
    record.community,
    record.nft,
    record.game,
  ];
  const consumed = entries
    .filter((entry): entry is JournaledTx => entry !== undefined && entry.status === "confirmed")
    .filter((entry) => getAddress(entry.from) === getAddress(ctx.wallet.address))
    .map((entry) => entry.nonce + 1);
  return Math.max(fromRpc, record.nonceFloor ?? 0, ...consumed);
}

/** Note qu'un reçu a été vu pour ce nonce (succès ou échec) : il ne resservira jamais. */
function withNonceConsumed<R extends LaunchRecord>(record: R, nonce: number): R {
  return { ...record, nonceFloor: Math.max(record.nonceFloor ?? 0, nonce + 1) };
}

/** Signe avec un nonce imposé et note la transaction (hash et octets) AVANT toute diffusion. */
async function signAndRecord<T extends JournaledTx>(
  ctx: StepContext,
  record: LaunchRecord,
  payload: TxPayload,
  build: (base: JournaledTx) => T,
  save: (entry: T) => Promise<void>,
): Promise<T> {
  const provider = ctx.ethers.provider;
  const nonce = await freshNonce(ctx, record);
  const signed = await signTx(provider, ctx.wallet, ctx.chainId, payload, nonce);
  const entry = build({
    status: "pending",
    from: ctx.wallet.address,
    nonce,
    txHash: signed.hash,
    rawTx: signed.raw,
    preparedAt: now(),
  });
  await save(entry);
  return entry;
}

/** Reçu de la version en cours ou d'une version précédente (même nonce) de la transaction. */
async function findReceipt(ctx: StepContext, entry: JournaledTx): Promise<TransactionReceipt | null> {
  for (const hash of [entry.txHash, ...(entry.replacedTxHashes ?? [])]) {
    const receipt = await ctx.ethers.provider.getTransactionReceipt(hash);
    if (receipt !== null) return receipt;
  }
  return null;
}

/** Interroge le réseau jusqu'à trouver un reçu (n'importe quelle version), ou rend null à l'échéance. */
async function pollReceipt(ctx: StepContext, entry: JournaledTx, timeoutMs: number): Promise<TransactionReceipt | null> {
  const deadline = Date.now() + timeoutMs;
  const interval = Math.min(2000, Math.max(250, Math.floor(timeoutMs / 4)));
  let lastError: unknown;
  for (;;) {
    try {
      const receipt = await findReceipt(ctx, entry);
      if (receipt !== null) return receipt;
      lastError = undefined;
    } catch (error) {
      // RPC momentanément indisponible : on réessaie jusqu'à l'échéance.
      lastError = error;
    }
    if (Date.now() >= deadline) {
      if (lastError !== undefined) {
        throw new LaunchError(
          `Le RPC ne répond plus (${firstLine(lastError)}).\n` +
            `  Relance la même commande : elle reprendra le suivi de ${entry.txHash} sans rien renvoyer.`,
        );
      }
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/** Le réseau connaît-il déjà une version de cette transaction (minée ou en attente) ? */
async function knownToNetwork(ctx: StepContext, entry: JournaledTx): Promise<boolean> {
  try {
    if ((await findReceipt(ctx, entry)) !== null) return true;
    for (const hash of [entry.txHash, ...(entry.replacedTxHashes ?? [])]) {
      if ((await ctx.ethers.provider.getTransaction(hash)) !== null) return true;
    }
  } catch {
    // RPC injoignable : on ne peut rien affirmer.
  }
  return false;
}

/** Raison pour laquelle la transaction échouerait maintenant, ou undefined si elle passerait. */
async function simulationFailure(ctx: StepContext, payload: TxPayload): Promise<string | undefined> {
  try {
    await ctx.ethers.provider.call({ from: ctx.wallet.address, ...payload });
    return undefined;
  } catch (error) {
    return describeSeedError(error);
  }
}

/** « le déploiement… » → « du déploiement… », « l'ouverture… » → « de l'ouverture… ». */
function withDe(label: string): string {
  return label.startsWith("le ") ? `du ${label.slice(3)}` : label.startsWith("les ") ? `des ${label.slice(4)}` : `de ${label}`;
}

/** Délai de grâce quand le nonce est déjà pris : le reçu peut mettre un instant à être visible. */
const NONCE_USED_GRACE_MS = 15_000;

/**
 * Diffuse la transaction notée puis attend son reçu. Aucune décision
 * destructive n'est prise sur une absence (reçu introuvable, nonce déjà pris,
 * RPC muet) : au pire, le script s'arrête et la relance reprend le suivi.
 * Seul un refus explicite du nœud pour cause de frais mène à une nouvelle
 * signature, avec le même nonce (donc sans doublon possible).
 */
async function broadcastAndWait<T extends JournaledTx>(
  ctx: StepContext,
  entry: T,
  payload: TxPayload,
  save: (entry: T) => Promise<void>,
  label: string,
): Promise<{ entry: T; receipt: TransactionReceipt }> {
  const provider = ctx.ethers.provider;
  const timeoutMs = ctx.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS;
  let current = entry;
  let result: BroadcastResult;
  try {
    result = await broadcastRaw(provider, current.rawTx);
  } catch (error) {
    if (isInsufficientFunds(error)) {
      throw new LaunchError(
        `Solde ETH insuffisant pour diffuser ${label} (${current.txHash}).\n` +
          "  Ajoute de l'ETH à ce wallet puis relance la même commande : la même transaction sera diffusée.",
      );
    }
    if (isFeeCapExceeded(error)) {
      throw new LaunchError(
        `Le RPC refuse ${label} (${current.txHash}) : ses frais maximum dépassent le plafond qu'il impose ` +
          `(${firstLine(error)}).
` +
          "  Re-signer n'y changerait rien. Enregistre une autre URL RPC dans le keystore (Alchemy, par exemple) " +
          "puis relance la même commande : la même transaction sera diffusée.",
      );
    }
    if (await knownToNetwork(ctx, current)) {
      // La réponse s'est perdue en route, mais la transaction est bien arrivée.
      result = "already-known";
    } else if (isFeeRejection(error)) {
      ctx.log(`Diffusion refusée (${firstLine(error)}).`);
      const failure = await simulationFailure(ctx, payload);
      if (failure !== undefined) {
        ctx.log(
          `⚠ La simulation indique qu'elle échouerait maintenant (${failure}). ` +
            "Minée en échec, elle ne coûtera que des frais et le journal reviendra à l'étape précédente.",
        );
      }
      await ctx.confirm(`re-signer ${label} avec des frais à jour (même nonce : aucun doublon possible)`);
      const originalGasLimit = Transaction.from(current.rawTx).gasLimit;
      const resigned = await signTx(provider, ctx.wallet, ctx.chainId, payload, current.nonce, originalGasLimit);
      current = {
        ...current,
        txHash: resigned.hash,
        rawTx: resigned.raw,
        replacedTxHashes: [...(current.replacedTxHashes ?? []), current.txHash],
      };
      await save(current);
      try {
        result = await broadcastRaw(provider, current.rawTx);
      } catch (retryError) {
        throw new LaunchError(
          `La version re-signée (${current.txHash}) n'a pas pu être diffusée (${firstLine(retryError)}).\n` +
            "  Relance la même commande : elle sera retrouvée ou rediffusée telle quelle.",
        );
      }
    } else {
      throw new LaunchError(
        `Diffusion ${withDe(label)} impossible pour l'instant (${firstLine(error)}).\n` +
          `  Relance la même commande : la transaction notée (${current.txHash}) sera retrouvée ou rediffusée telle quelle.`,
      );
    }
  }

  if (result === "nonce-used") {
    const receipt = await pollReceipt(ctx, current, Math.min(NONCE_USED_GRACE_MS, timeoutMs));
    if (receipt !== null) {
      return { entry: current, receipt };
    }
    throw new LaunchError(
      `Le nonce ${current.nonce} est déjà utilisé, mais aucun reçu n'est visible pour ${current.txHash}.\n` +
        "  Vérifie les transactions de ce wallet sur l'explorateur, puis relance la commande. Rien n'a été renvoyé.",
    );
  }
  ctx.log(
    `${result === "sent" ? "Transaction envoyée" : "Transaction déjà connue du réseau"} : ${current.txHash} ` +
      "— en attente de confirmation…",
  );
  const receipt = await pollReceipt(ctx, current, timeoutMs);
  if (receipt === null) {
    throw new LaunchError(
      `Pas de reçu pour ${current.txHash} après ${Math.round(timeoutMs / 1000)} s. ` +
        "Relance la même commande : elle reprendra le suivi sans envoyer de seconde transaction.",
    );
  }
  return { entry: current, receipt };
}

/**
 * Reprend une transaction notée « pending » : son reçu (par hash) s'il existe,
 * sinon une preuve positive par l'état de la chaîne, sinon la rediffusion des
 * mêmes octets signés.
 */
async function resumeJournaled<T extends JournaledTx>(
  ctx: StepContext,
  entry: T,
  payload: TxPayload,
  save: (entry: T) => Promise<void>,
  label: string,
  provenByState?: () => Promise<boolean>,
): Promise<{ entry: T; receipt: TransactionReceipt | null }> {
  assertSameSigner(ctx, entry);
  ctx.log(`Reprise : ${label} noté dans le journal (nonce ${entry.nonce}, ${entry.txHash}).`);
  let receipt: TransactionReceipt | null;
  try {
    receipt = await findReceipt(ctx, entry);
  } catch (error) {
    throw new LaunchError(`RPC injoignable (${firstLine(error)}). Relance la même commande ; rien n'a été envoyé.`);
  }
  if (receipt !== null) {
    return { entry, receipt };
  }
  // En cas de doute (RPC capricieux), la suite rediffuse les mêmes octets : sans risque.
  if (provenByState !== undefined && (await provenByState().catch(() => false))) {
    return { entry, receipt: null };
  }
  return await broadcastAndWait(ctx, entry, payload, save, label);
}

// --- Étape 1 : le token -------------------------------------------------------

async function tokenMatches(ctx: StepContext, entry: TokenRecord): Promise<boolean> {
  const provider = ctx.ethers.provider;
  if ((await provider.getCode(entry.address)) === "0x") return false;
  const token = new Contract(entry.address, ERC20_ABI, provider);
  const [name, symbol, totalSupply] = (await Promise.all([
    token.name(),
    token.symbol(),
    token.totalSupply(),
  ])) as [string, string, bigint];
  return name === entry.name && symbol === entry.symbol && totalSupply === BigInt(entry.supplyWholeTokens) * UNIT;
}

/**
 * Déploie le token, ou reprend un déploiement noté « pending ».
 * La confirmation d'un premier envoi est faite par l'appelant, après
 * affichage du plan.
 */
export async function deployTokenStep(ctx: StepContext, params: TokenParams): Promise<TokenRecord> {
  const record = await loadRecord(ctx);
  const save = (token: TokenRecord) => ctx.journal.write({ ...record, token });
  const factory = await ctx.ethers.getContractFactory(TOKEN_CONTRACT);
  const label = "le déploiement du token";

  if (record.token?.status === "confirmed") {
    throw new LaunchError(
      `Un token est déjà déployé sur ce réseau : ${record.token.address}.\n` +
        `  Pour en déployer un autre volontairement, renomme d'abord ${ctx.journal.location}.`,
    );
  }

  let entry: TokenRecord;
  let receipt: TransactionReceipt | null;
  if (record.token?.status === "pending") {
    const pending = record.token;
    const payload = { data: (await factory.getDeployTransaction(...constructorArgs(paramsOf(pending)))).data };
    ({ entry, receipt } = await resumeJournaled(ctx, pending, payload, save, label, () => tokenMatches(ctx, pending)));
  } else {
    const payload = { data: (await factory.getDeployTransaction(...constructorArgs(params))).data };
    const prepared = await signAndRecord(
      ctx,
      record,
      payload,
      (base) => ({
        ...base,
        address: getCreateAddress({ from: base.from, nonce: base.nonce }),
        name: params.name,
        symbol: params.symbol,
        supplyWholeTokens: params.supply.toString(),
      }),
      save,
    );
    ({ entry, receipt } = await broadcastAndWait(ctx, prepared, payload, save, label));
  }

  if (receipt !== null && receipt.status !== 1) {
    // Reçu de NOTRE transaction, en échec : c'est définitif, rien n'a été créé.
    await ctx.journal.write(
      withNonceConsumed({ network: record.network, chainId: record.chainId, nonceFloor: record.nonceFloor }, entry.nonce),
    );
    throw new LaunchError(`Le déploiement ${receipt.hash} a échoué : rien n'a été créé. Relance la commande pour réessayer.`);
  }
  const confirmedEntry = entry;
  const matches = await eventually(async () => {
    if (!(await tokenMatches(ctx, confirmedEntry))) throw new Error("pas encore visible");
    return true;
  }).catch(() => false);
  if (!matches) {
    throw new LaunchError(
      `Le contrat attendu à ${entry.address} n'est pas (encore) visible ou ne correspond pas au journal. ` +
        "Relance la commande dans un moment ; rien ne sera renvoyé.",
    );
  }
  // Prouvé par l'état de la chaîne sans reçu visible : on retente une fois de lire le reçu.
  const finalReceipt = receipt ?? (await findReceipt(ctx, entry).catch(() => null));
  const confirmed: TokenRecord = {
    ...entry,
    status: "confirmed",
    // Le hash de la version réellement minée (une version re-signée peut ne jamais l'avoir été).
    txHash: finalReceipt?.hash ?? entry.txHash,
    blockNumber: finalReceipt?.blockNumber ?? entry.blockNumber,
    confirmedAt: now(),
  };
  await save(confirmed);
  return confirmed;
}

// --- Étape 3a : le PoolSeeder -------------------------------------------------

async function seederMatches(ctx: StepContext, entry: SeederRecord, uniswap: UniswapV2Deployment): Promise<boolean> {
  const provider = ctx.ethers.provider;
  if ((await provider.getCode(entry.address)) === "0x") return false;
  const seeder = new Contract(entry.address, SEEDER_ABI, provider);
  const [factory, weth] = (await Promise.all([seeder.FACTORY(), seeder.WETH()])) as [string, string];
  return getAddress(factory) === getAddress(uniswap.factory) && getAddress(weth) === getAddress(uniswap.weth);
}

/** Déploie le PoolSeeder (une fois par réseau), ou réutilise / reprend celui du journal. */
export async function deploySeederStep(ctx: StepContext, uniswap: UniswapV2Deployment): Promise<SeederRecord> {
  const record = await loadRecord(ctx);
  const save = (seeder: SeederRecord) => ctx.journal.write({ ...record, seeder });
  const factory = await ctx.ethers.getContractFactory(SEEDER_CONTRACT);
  const payload = { data: (await factory.getDeployTransaction(uniswap.factory, uniswap.weth)).data };
  const label = "le déploiement du PoolSeeder";

  if (record.seeder?.status === "confirmed") {
    if (!(await seederMatches(ctx, record.seeder, uniswap))) {
      throw new LaunchError(`Le PoolSeeder du journal (${record.seeder.address}) ne correspond pas à Uniswap attendu.`);
    }
    return record.seeder;
  }

  let entry: SeederRecord;
  let receipt: TransactionReceipt | null;
  if (record.seeder?.status === "pending") {
    const pending = record.seeder;
    ({ entry, receipt } = await resumeJournaled(ctx, pending, payload, save, label, () =>
      seederMatches(ctx, pending, uniswap),
    ));
  } else {
    ctx.log("Déploiement du PoolSeeder (ouverture atomique du pool)…");
    const prepared = await signAndRecord(
      ctx,
      record,
      payload,
      (base) => ({
        ...base,
        address: getCreateAddress({ from: base.from, nonce: base.nonce }),
        factory: uniswap.factory,
        weth: uniswap.weth,
      }),
      save,
    );
    ({ entry, receipt } = await broadcastAndWait(ctx, prepared, payload, save, label));
  }

  if (receipt !== null && receipt.status !== 1) {
    const { seeder: _failed, ...rest } = record;
    await ctx.journal.write(withNonceConsumed(rest, entry.nonce));
    throw new LaunchError(`Le déploiement du PoolSeeder ${receipt.hash} a échoué. Relance la commande pour réessayer.`);
  }
  const deployed = entry;
  const matches = await eventually(async () => {
    if (!(await seederMatches(ctx, deployed, uniswap))) throw new Error("pas encore visible");
    return true;
  }).catch(() => false);
  if (!matches) {
    throw new LaunchError(
      `Le PoolSeeder attendu à ${entry.address} n'est pas (encore) visible. Relance la commande dans un moment.`,
    );
  }
  const finalReceipt = receipt ?? (await findReceipt(ctx, entry).catch(() => null));
  const confirmed: SeederRecord = {
    ...entry,
    status: "confirmed",
    txHash: finalReceipt?.hash ?? entry.txHash,
    blockNumber: finalReceipt?.blockNumber ?? entry.blockNumber,
    confirmedAt: now(),
  };
  await save(confirmed);
  return confirmed;
}

// --- Étape 3b : ouverture du pool --------------------------------------------

export interface SeedAmounts {
  tokenAmount: bigint;
  ethAmount: bigint;
  /** WETH déjà présent dans la paire (dons) accepté au maximum : ce qui était là au moment du plan. */
  maxPairWeth: bigint;
}

/** Cherche les données de revert (hex) dans l'erreur et ses causes, quelle que soit la couche qui l'a produite. */
function revertDataOf(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  const stack: unknown[] = [error];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const data = (current as { data?: unknown }).data;
    if (typeof data === "string" && /^0x[0-9a-fA-F]{8}/.test(data)) {
      return data;
    }
    for (const key of ["error", "info", "cause", "parent", "revert"]) {
      stack.push((current as Record<string, unknown>)[key]);
    }
  }
  return undefined;
}

function describeSeedError(error: unknown): string {
  const data = revertDataOf(error);
  const parsed = data === undefined ? null : seederInterface.parseError(data);
  if (parsed?.name === "PoolAlreadySeeded") {
    return `des parts LP existent déjà pour la paire ${String(parsed.args[0])}, ce dépôt ne fixerait plus le prix`;
  }
  if (parsed?.name === "DonationAboveLimit") {
    return (
      `la paire contient maintenant ${formatEth(parsed.args[0] as bigint)} de WETH donné par un tiers ` +
      `(maximum accepté : ${formatEth(parsed.args[1] as bigint)}) ; le prix de départ serait plus haut que prévu`
    );
  }
  if (parsed?.name === "ZeroAmount") {
    return "montant de tokens ou d'ETH nul";
  }
  return firstLine(error);
}

function seedPayload(seeder: string, token: string, amounts: SeedAmounts): TxPayload {
  return {
    to: seeder,
    data: seederInterface.encodeFunctionData("seed", [token, amounts.tokenAmount, amounts.maxPairWeth]),
    value: amounts.ethAmount,
  };
}

function approvePayload(token: string, spender: string, amount: bigint): TxPayload {
  return { to: token, data: erc20Interface.encodeFunctionData("approve", [spender, amount]) };
}

/**
 * Autorise le PoolSeeder pour le montant exact, comme les autres transactions :
 * signée et notée avant diffusion, reprise sans doublon, nonce retenu même en
 * cas d'échec. Rend le journal à jour.
 */
async function approvalStep(
  ctx: StepContext,
  record: LaunchRecord,
  token: string,
  spender: string,
  amount: bigint,
): Promise<LaunchRecord> {
  const contract = new Contract(token, ERC20_ABI, ctx.ethers.provider);
  const from = ctx.wallet.address;
  const label = "l'autorisation du PoolSeeder";
  let current = record;
  const save = (approval: ApprovalRecord) => ctx.journal.write({ ...current, approval });
  const reaches = (attempts: number) =>
    eventually(async () => {
      if (((await contract.allowance(from, spender)) as bigint) < amount) throw new Error("pas encore visible");
      return true;
    }, attempts).catch(() => false);
  const covered = () =>
    current.approval?.status === "confirmed" &&
    getAddress(current.approval.token) === getAddress(token) &&
    getAddress(current.approval.spender) === getAddress(spender) &&
    BigInt(current.approval.amount) >= amount;

  const settle = async (entry: ApprovalRecord, receipt: TransactionReceipt | null): Promise<void> => {
    if (receipt === null) {
      throw new LaunchError(`Reçu introuvable pour ${entry.txHash}. Relance la commande dans un moment.`);
    }
    if (receipt.status !== 1) {
      const { approval: _failed, ...rest } = current;
      current = withNonceConsumed(rest, entry.nonce);
      await ctx.journal.write(current);
      throw new LaunchError(`L'autorisation ${receipt.hash} a échoué : rien d'autre n'a été envoyé. Relance la commande.`);
    }
    current = withNonceConsumed(
      {
        ...current,
        approval: { ...entry, status: "confirmed", txHash: receipt.hash, blockNumber: receipt.blockNumber, confirmedAt: now() },
      },
      entry.nonce,
    );
    await ctx.journal.write(current);
  };

  // Une autorisation notée par une exécution interrompue est d'abord menée à son terme.
  const pending = current.approval?.status === "pending" ? current.approval : undefined;
  if (pending !== undefined) {
    const payload = approvePayload(pending.token, pending.spender, BigInt(pending.amount));
    const { entry, receipt } = await resumeJournaled(ctx, pending, payload, save, label);
    await settle(entry, receipt);
  }

  // Une autorisation confirmée par le journal mérite d'attendre un RPC en retard avant d'en signer une autre.
  if (await reaches(covered() ? 10 : 1)) {
    return current;
  }
  ctx.log(`Autorisation du PoolSeeder pour ${formatTokenAmount(amount)} tokens (montant exact)…`);
  if (current.approval !== undefined) {
    // L'autorisation précédente est remplacée dans le journal : son nonce reste compté.
    current = withNonceConsumed(current, current.approval.nonce);
  }
  const payload = approvePayload(token, spender, amount);
  const prepared = await signAndRecord(
    ctx,
    current,
    payload,
    (base) => ({ ...base, token, spender, amount: amount.toString() }),
    save,
  );
  const { entry, receipt } = await broadcastAndWait(ctx, prepared, payload, save, label);
  await settle(entry, receipt);
  if (!(await reaches(10))) {
    throw new LaunchError(
      "L'autorisation est minée mais le RPC ne la voit pas encore. Relance la commande dans un moment ; rien d'autre n'a été envoyé.",
    );
  }
  return current;
}

export interface SeedResult {
  record: LiquidityRecord;
  outcome: SeedOutcome;
}

/**
 * Ouvre le pool via le PoolSeeder, ou reprend une ouverture notée « pending ».
 * `amounts` ne sert qu'à un premier envoi ; une reprise rediffuse la
 * transaction signée du journal.
 */
export async function seedStep(
  ctx: StepContext,
  token: TokenRecord,
  seeder: SeederRecord,
  amounts: SeedAmounts,
): Promise<SeedResult> {
  let record = await loadRecord(ctx);
  const save = (liquidity: LiquidityRecord) => ctx.journal.write({ ...record, liquidity });
  const label = "l'ouverture du pool";

  if (record.liquidity?.status === "confirmed") {
    throw new LaunchError(`Le pool est déjà ouvert : paire ${record.liquidity.pair ?? "—"}.`);
  }

  let entry: LiquidityRecord;
  let receipt: TransactionReceipt | null;
  if (record.liquidity?.status === "pending") {
    const pending = record.liquidity;
    const payload = seedPayload(pending.seeder, token.address, {
      tokenAmount: BigInt(pending.tokenAmount),
      ethAmount: BigInt(pending.ethAmountWei),
      maxPairWeth: BigInt(pending.maxPairWeth),
    });
    // Pas de preuve « par l'état » ici : seule la lecture du reçu prouve que les LP sont brûlées.
    ({ entry, receipt } = await resumeJournaled(ctx, pending, payload, save, label));
  } else {
    record = await approvalStep(ctx, record, token.address, seeder.address, amounts.tokenAmount);
    const payload = seedPayload(seeder.address, token.address, amounts);
    ctx.log("Simulation exacte de l'ouverture du pool…");
    try {
      await ctx.ethers.provider.call({ from: ctx.wallet.address, ...payload });
    } catch (error) {
      throw new LaunchError(
        `La simulation de l'ouverture du pool a échoué : ${describeSeedError(error)}.\n` +
          "  Rien n'a été envoyé. (L'autorisation donnée au PoolSeeder ne peut servir qu'à ton propre wallet.)",
      );
    }
    ctx.log("Ouverture du pool (LP → adresse morte)…");
    const prepared = await signAndRecord(
      ctx,
      record,
      payload,
      (base) => ({
        ...base,
        seeder: seeder.address,
        tokenAmount: amounts.tokenAmount.toString(),
        ethAmountWei: amounts.ethAmount.toString(),
        maxPairWeth: amounts.maxPairWeth.toString(),
        lpRecipient: DEAD_ADDRESS,
      }),
      save,
    );
    ({ entry, receipt } = await broadcastAndWait(ctx, prepared, payload, save, label));
  }

  if (receipt === null) {
    throw new LaunchError(`Reçu introuvable pour ${entry.txHash}. Relance la commande dans un moment.`);
  }
  if (receipt.status !== 1) {
    // Reçu de NOTRE transaction, en échec : c'est définitif, rien n'a bougé (hors frais).
    const { liquidity: _failed, ...rest } = record;
    await ctx.journal.write(withNonceConsumed(rest, entry.nonce));
    throw new LaunchError(
      `L'ouverture du pool ${receipt.hash} a échoué : tes tokens et ton ETH n'ont pas bougé (hors frais).\n` +
        "  Le journal est revenu à l'étape précédente : relance la commande pour voir le nouveau plan.",
    );
  }
  const outcome = readSeedReceipt(receipt, entry.seeder, token.address);
  const confirmed: LiquidityRecord = {
    ...entry,
    status: "confirmed",
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    pair: outcome.pair,
    lpBurned: outcome.lpBurned.toString(),
    confirmedAt: now(),
  };
  await save(confirmed);
  return { record: confirmed, outcome };
}

// --- Étape 2 : blocage de ta part (vesting), avant l'ouverture du pool -----------

export interface VestingPlan {
  token: string;
  beneficiary: string;
  /** Horodatage Unix du début du calendrier. */
  start: bigint;
  durationSeconds: bigint;
  cliffSeconds: bigint;
}

/**
 * Le contrat à l'adresse notée a-t-il le calendrier noté ? L'adresse (CREATE)
 * dépend de ton wallet et du nonce : seul le déploiement noté peut s'y trouver.
 * Le bénéficiaire n'est pas comparé : il peut légitimement transmettre son rôle
 * (transferOwnership) sans toucher au calendrier.
 */
async function vestingMatches(ctx: StepContext, entry: VestingRecord): Promise<boolean> {
  const provider = ctx.ethers.provider;
  if ((await provider.getCode(entry.address)) === "0x") return false;
  const vesting = new Contract(entry.address, VESTING_ABI, provider);
  const [start, duration, cliff] = (await Promise.all([
    vesting.start(),
    vesting.duration(),
    vesting.cliff(),
  ])) as [bigint, bigint, bigint];
  return (
    start === BigInt(entry.start) &&
    duration === BigInt(entry.durationSeconds) &&
    cliff === BigInt(entry.start) + BigInt(entry.cliffSeconds)
  );
}

/** Déploie le contrat de vesting (une fois par réseau), ou reprend / réutilise celui du journal. */
export async function deployVestingStep(ctx: StepContext, plan: VestingPlan): Promise<VestingRecord> {
  const record = await loadRecord(ctx);
  const save = (vesting: VestingRecord) => ctx.journal.write({ ...record, vesting });
  const factory = await ctx.ethers.getContractFactory(VESTING_CONTRACT);
  const label = "le déploiement du contrat de blocage";

  if (record.vesting?.status === "confirmed") {
    if (!(await vestingMatches(ctx, record.vesting))) {
      throw new LaunchError(`Le contrat de blocage du journal (${record.vesting.address}) ne correspond pas à ce qui y est noté.`);
    }
    return record.vesting;
  }

  let entry: VestingRecord;
  let receipt: TransactionReceipt | null;
  if (record.vesting?.status === "pending") {
    const pending = record.vesting;
    const payload = { data: (await factory.getDeployTransaction(...vestingConstructorArgs(pending))).data };
    ({ entry, receipt } = await resumeJournaled(ctx, pending, payload, save, label, () => vestingMatches(ctx, pending)));
  } else {
    const fields = {
      token: plan.token,
      beneficiary: plan.beneficiary,
      start: plan.start.toString(),
      durationSeconds: plan.durationSeconds.toString(),
      cliffSeconds: plan.cliffSeconds.toString(),
    };
    const payload = { data: (await factory.getDeployTransaction(...vestingConstructorArgs(fields))).data };
    ctx.log("Déploiement du contrat de blocage (vesting)…");
    const prepared = await signAndRecord(
      ctx,
      record,
      payload,
      (base) => ({ ...base, address: getCreateAddress({ from: base.from, nonce: base.nonce }), ...fields }),
      save,
    );
    ({ entry, receipt } = await broadcastAndWait(ctx, prepared, payload, save, label));
  }

  if (receipt !== null && receipt.status !== 1) {
    const { vesting: _failed, ...rest } = record;
    await ctx.journal.write(withNonceConsumed(rest, entry.nonce));
    throw new LaunchError(`Le déploiement du contrat de blocage ${receipt.hash} a échoué. Relance la commande pour réessayer.`);
  }
  const deployed = entry;
  const matches = await eventually(async () => {
    if (!(await vestingMatches(ctx, deployed))) throw new Error("pas encore visible");
    return true;
  }).catch(() => false);
  if (!matches) {
    throw new LaunchError(`Le contrat de blocage attendu à ${entry.address} n'est pas (encore) visible. Relance la commande dans un moment.`);
  }
  const finalReceipt = receipt ?? (await findReceipt(ctx, entry).catch(() => null));
  const confirmed: VestingRecord = {
    ...entry,
    status: "confirmed",
    txHash: finalReceipt?.hash ?? entry.txHash,
    blockNumber: finalReceipt?.blockNumber ?? entry.blockNumber,
    confirmedAt: now(),
  };
  await save(confirmed);
  return confirmed;
}

function transferPayload(token: string, to: string, amount: bigint): TxPayload {
  return { to: token, data: erc20Interface.encodeFunctionData("transfer", [to, amount]) };
}

/**
 * Transfère la part gardée vers le contrat de vesting, ou reprend un transfert
 * noté « pending ». Le résultat est lu dans le reçu : transfert au montant
 * exact, depuis ton wallet, vers le contrat.
 */
export async function lockStep(ctx: StepContext, vesting: VestingRecord, amount: bigint): Promise<LockRecord> {
  const record = await loadRecord(ctx);
  const save = (lock: LockRecord) => ctx.journal.write({ ...record, lock });
  const label = "le blocage de ta part";

  if (record.lock?.status === "confirmed") {
    throw new LaunchError(`Ta part est déjà bloquée dans ${record.lock.vesting}.`);
  }

  let entry: LockRecord;
  let receipt: TransactionReceipt | null;
  if (record.lock?.status === "pending") {
    const pending = record.lock;
    const payload = transferPayload(pending.token, pending.vesting, BigInt(pending.amount));
    ({ entry, receipt } = await resumeJournaled(ctx, pending, payload, save, label));
  } else {
    if (amount <= 0n) {
      throw new LaunchError("Rien à bloquer : aucun token gardé dans ce wallet.");
    }
    const payload = transferPayload(vesting.token, vesting.address, amount);
    try {
      await ctx.ethers.provider.call({ from: ctx.wallet.address, ...payload });
    } catch (error) {
      throw new LaunchError(`La simulation du blocage a échoué : ${firstLine(error)}. Rien n'a été envoyé.`);
    }
    ctx.log(`Blocage de ${formatTokenAmount(amount)} tokens dans le contrat de vesting…`);
    const prepared = await signAndRecord(
      ctx,
      record,
      payload,
      (base) => ({ ...base, token: vesting.token, vesting: vesting.address, amount: amount.toString() }),
      save,
    );
    ({ entry, receipt } = await broadcastAndWait(ctx, prepared, payload, save, label));
  }

  if (receipt === null) {
    throw new LaunchError(`Reçu introuvable pour ${entry.txHash}. Relance la commande dans un moment.`);
  }
  if (receipt.status !== 1) {
    const { lock: _failed, ...rest } = record;
    await ctx.journal.write(withNonceConsumed(rest, entry.nonce));
    throw new LaunchError(
      `Le blocage ${receipt.hash} a échoué : tes tokens n'ont pas bougé (hors frais). Relance la commande pour réessayer.`,
    );
  }
  readTransferReceipt(receipt, { token: entry.token, from: entry.from, to: entry.vesting, amount: BigInt(entry.amount) });
  const confirmed: LockRecord = {
    ...entry,
    status: "confirmed",
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    confirmedAt: now(),
  };
  await ctx.journal.write(withNonceConsumed({ ...record, lock: confirmed }, entry.nonce));
  return confirmed;
}

/**
 * Envoie la réserve communauté à son wallet dédié, ou reprend un envoi noté
 * « pending ». Même mécanique que le blocage : signé et noté avant diffusion,
 * résultat lu dans le reçu (transfert au montant exact, depuis ton wallet, vers
 * ce wallet), retour en arrière seulement sur le reçu en échec de cet envoi.
 */
export async function communityStep(
  ctx: StepContext,
  plan: { token: string; recipient: string; amount: bigint },
): Promise<CommunityRecord> {
  const record = await loadRecord(ctx);
  const save = (community: CommunityRecord) => ctx.journal.write({ ...record, community });
  const label = "l'envoi de la réserve communauté";

  if (record.community?.status === "confirmed") {
    throw new LaunchError(`La réserve communauté est déjà envoyée à ${record.community.recipient}.`);
  }

  let entry: CommunityRecord;
  let receipt: TransactionReceipt | null;
  if (record.community?.status === "pending") {
    const pending = record.community;
    const payload = transferPayload(pending.token, pending.recipient, BigInt(pending.amount));
    ({ entry, receipt } = await resumeJournaled(ctx, pending, payload, save, label));
  } else {
    if (plan.amount <= 0n) {
      throw new LaunchError("Rien à envoyer : la réserve communauté est vide.");
    }
    const payload = transferPayload(plan.token, plan.recipient, plan.amount);
    try {
      await ctx.ethers.provider.call({ from: ctx.wallet.address, ...payload });
    } catch (error) {
      throw new LaunchError(`La simulation de l'envoi de la réserve a échoué : ${firstLine(error)}. Rien n'a été envoyé.`);
    }
    ctx.log(`Envoi de ${formatTokenAmount(plan.amount)} tokens au wallet communauté…`);
    const prepared = await signAndRecord(
      ctx,
      record,
      payload,
      (base) => ({ ...base, token: plan.token, recipient: getAddress(plan.recipient), amount: plan.amount.toString() }),
      save,
    );
    ({ entry, receipt } = await broadcastAndWait(ctx, prepared, payload, save, label));
  }

  if (receipt === null) {
    throw new LaunchError(`Reçu introuvable pour ${entry.txHash}. Relance la commande dans un moment.`);
  }
  if (receipt.status !== 1) {
    const { community: _failed, ...rest } = record;
    await ctx.journal.write(withNonceConsumed(rest, entry.nonce));
    throw new LaunchError(
      `L'envoi de la réserve ${receipt.hash} a échoué : tes tokens n'ont pas bougé (hors frais). Relance la commande pour réessayer.`,
    );
  }
  readTransferReceipt(receipt, { token: entry.token, from: entry.from, to: entry.recipient, amount: BigInt(entry.amount) });
  const confirmed: CommunityRecord = {
    ...entry,
    status: "confirmed",
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    confirmedAt: now(),
  };
  await ctx.journal.write(withNonceConsumed({ ...record, community: confirmed }, entry.nonce));
  return confirmed;
}

// --- Cartes NFT (après le lancement du token) -----------------------------------

/** Lecture seule du contrat de cartes, pour vérifier qu'il correspond au journal. */
export const NFT_ABI = [
  "function FOUNDERS() view returns (address)",
  "function COMMUNITY() view returns (address)",
  "function MINT_START() view returns (uint64)",
  "function candidateCount() view returns (uint256)",
  "function totalMinted() view returns (uint256)",
] as const;

async function nftMatches(ctx: StepContext, entry: NftRecord): Promise<boolean> {
  const provider = ctx.ethers.provider;
  if ((await provider.getCode(entry.address)) === "0x") return false;
  const nft = new Contract(entry.address, NFT_ABI, provider);
  const [founders, community, mintStart, candidates] = (await Promise.all([
    nft.FOUNDERS(),
    nft.COMMUNITY(),
    nft.MINT_START(),
    nft.candidateCount(),
  ])) as [string, string, bigint, bigint];
  return (
    getAddress(founders) === getAddress(entry.founders) &&
    getAddress(community) === getAddress(entry.community) &&
    mintStart === BigInt(entry.mintStart) &&
    // Des propositions approuvées peuvent ajouter des candidats après le déploiement.
    candidates >= BigInt(entry.candidateWallets.length)
  );
}

export interface NftPlan {
  founders: string;
  community: string;
  mintStart: bigint;
  imageBaseURI: string;
  viewerURI: string;
  candidateNames: string[];
  candidateWallets: string[];
  candidateUrls: string[];
}

/** Déploie le contrat des cartes (une fois par réseau), ou reprend / réutilise celui du journal. */
export async function deployNftStep(ctx: StepContext, plan: NftPlan): Promise<NftRecord> {
  const record = await loadRecord(ctx);
  const save = (nft: NftRecord) => ctx.journal.write({ ...record, nft });
  const factory = await ctx.ethers.getContractFactory(NFT_CONTRACT);
  const label = "le déploiement des cartes NFT";

  if (record.nft?.status === "confirmed") {
    if (!(await nftMatches(ctx, record.nft))) {
      throw new LaunchError(`Le contrat des cartes du journal (${record.nft.address}) ne correspond pas à ce qui y est noté.`);
    }
    return record.nft;
  }

  let entry: NftRecord;
  let receipt: TransactionReceipt | null;
  if (record.nft?.status === "pending") {
    const pending = record.nft;
    const payload = { data: (await factory.getDeployTransaction(...nftConstructorArgs(pending))).data };
    ({ entry, receipt } = await resumeJournaled(ctx, pending, payload, save, label, () => nftMatches(ctx, pending)));
  } else {
    const fields = {
      founders: plan.founders,
      community: plan.community,
      mintStart: plan.mintStart.toString(),
      imageBaseURI: plan.imageBaseURI,
      viewerURI: plan.viewerURI,
      candidateNames: plan.candidateNames,
      candidateWallets: plan.candidateWallets,
      candidateUrls: plan.candidateUrls,
    };
    const payload = { data: (await factory.getDeployTransaction(...nftConstructorArgs(fields))).data };
    ctx.log("Déploiement du contrat des cartes NFT…");
    const prepared = await signAndRecord(
      ctx,
      record,
      payload,
      (base) => ({ ...base, address: getCreateAddress({ from: base.from, nonce: base.nonce }), ...fields }),
      save,
    );
    ({ entry, receipt } = await broadcastAndWait(ctx, prepared, payload, save, label));
  }

  if (receipt !== null && receipt.status !== 1) {
    const { nft: _failed, ...rest } = record;
    await ctx.journal.write(withNonceConsumed(rest, entry.nonce));
    throw new LaunchError(`Le déploiement des cartes ${receipt.hash} a échoué. Relance la commande pour réessayer.`);
  }
  const deployed = entry;
  const matches = await eventually(async () => {
    if (!(await nftMatches(ctx, deployed))) throw new Error("pas encore visible");
    return true;
  }).catch(() => false);
  if (!matches) {
    throw new LaunchError(`Le contrat des cartes attendu à ${entry.address} n'est pas (encore) visible. Relance la commande dans un moment.`);
  }
  const finalReceipt = receipt ?? (await findReceipt(ctx, entry).catch(() => null));
  const confirmed: NftRecord = {
    ...entry,
    status: "confirmed",
    txHash: finalReceipt?.hash ?? entry.txHash,
    blockNumber: finalReceipt?.blockNumber ?? entry.blockNumber,
    confirmedAt: now(),
  };
  await save(confirmed);
  return confirmed;
}

// --- Jeu « Attrape la baisse » (indépendant du token) -------------------------------

/** Lecture seule du jeu, pour vérifier qu'il correspond au journal. */
export const GAME_ABI = [
  "function DATA_START() view returns (uint64)",
  "function TOP_SIZE() view returns (uint256)",
  "function FEED() view returns (address)",
  "function DETECT_FROM() view returns (uint32)",
  "function dipCount() view returns (uint256)",
  "function dipAt(uint256 i) view returns (uint16 day, uint8 bonus)",
  "function lastRecordedDay() view returns (uint32)",
] as const;

/** Lecture seule d'un flux Chainlink AggregatorV3. */
export const FEED_ABI = [
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function getRoundData(uint80 roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
] as const;

/** Constantes attendues du contrat de jeu. */
export const GAME_DATA_START = 1282089600n;
export const GAME_TOP_SIZE = 50n;
/** Au-delà de cet âge, le dernier prix du flux est signalé (recordDay attend un round après minuit). */
export const GAME_MAX_STALE_SECONDS = 26n * 3600n;

/** État du flux de prix : refuse un flux sans code, muet, à prix nul ou qui n'a pas 8 décimales. */
export async function checkFeed(ctx: StepContext, feed: string): Promise<{ price: bigint; ageSeconds: bigint }> {
  const provider = ctx.ethers.provider;
  if ((await provider.getCode(feed)) === "0x") {
    throw new LaunchError(`Le flux de prix ${feed} n'a pas de code sur ce réseau. Rien n'a été envoyé.`);
  }
  const aggregator = new Contract(feed, FEED_ABI, provider);
  let decimals: bigint;
  let answer: bigint;
  let updatedAt: bigint;
  try {
    decimals = (await aggregator.decimals()) as bigint;
    let roundId: bigint;
    [roundId, answer, , updatedAt] = (await aggregator.latestRoundData()) as [bigint, bigint, bigint, bigint, bigint];
    // recordDay relit l'historique : getRoundData doit répondre pour le dernier round.
    await aggregator.getRoundData(roundId);
  } catch {
    throw new LaunchError(`Le contrat ${feed} ne répond pas comme un flux Chainlink (decimals, latestRoundData, getRoundData). Rien n'a été envoyé.`);
  }
  if (decimals !== 8n) throw new LaunchError(`Le flux ${feed} a ${decimals} décimales, 8 attendues (BTC/USD). Rien n'a été envoyé.`);
  if (answer <= 0n) throw new LaunchError(`Le flux ${feed} donne un prix nul ou négatif. Rien n'a été envoyé.`);
  const block = await provider.getBlock("latest");
  const nowSeconds = BigInt(block?.timestamp ?? Math.floor(Date.now() / 1000));
  return { price: answer, ageSeconds: nowSeconds > updatedAt ? nowSeconds - updatedAt : 0n };
}

async function gameMatches(ctx: StepContext, entry: GameRecord): Promise<boolean> {
  const provider = ctx.ethers.provider;
  if ((await provider.getCode(entry.address)) === "0x") return false;
  const game = new Contract(entry.address, GAME_ABI, provider);
  const [dataStart, topSize, feed, detectFrom, dipCount] = (await Promise.all([
    game.DATA_START(),
    game.TOP_SIZE(),
    game.FEED(),
    game.DETECT_FROM(),
    game.dipCount(),
  ])) as [bigint, bigint, string, bigint, bigint];
  const n = entry.dipDays.length;
  if (
    dataStart !== GAME_DATA_START ||
    topSize !== GAME_TOP_SIZE ||
    getAddress(feed) !== getAddress(entry.feed) ||
    detectFrom !== BigInt(entry.detectFrom) ||
    dipCount < BigInt(n) // la chaîne ajoute ensuite ses propres baisses
  ) {
    return false;
  }
  if (n === 0) return true;
  const [day, bonus] = (await game.dipAt(n - 1)) as [bigint, bigint];
  return day === BigInt(entry.dipDays[n - 1]) && bonus === BigInt(entry.dipBonus[n - 1]);
}

function sameGenesis(entry: GameRecord, genesis: Genesis, feed: string): boolean {
  return (
    getAddress(entry.feed) === getAddress(feed) &&
    entry.detectFrom === genesis.detectFrom &&
    entry.dipDays.join(",") === genesis.dipDays.join(",") &&
    entry.dipBonus.join(",") === genesis.dipBonus.join(",") &&
    entry.histMinSeconds.join(",") === genesis.histMinSeconds.join(",") &&
    entry.recentPrices.join(",") === genesis.recentPrices.map(String).join(",")
  );
}

/**
 * Déploie le jeu (une fois par réseau), ou reprend / réutilise celui du journal.
 * Refuse si le journal contient déjà un jeu d'une autre genèse ou d'un autre flux.
 */
export async function deployGameStep(ctx: StepContext, genesis: Genesis, feed: string): Promise<GameRecord> {
  const record = await loadRecord(ctx);
  const save = (game: GameRecord) => ctx.journal.write({ ...record, game });
  const factory = await ctx.ethers.getContractFactory(GAME_CONTRACT);
  const label = "le déploiement du jeu";

  if (record.game !== undefined && !sameGenesis(record.game, genesis, feed)) {
    throw new LaunchError(
      `Le journal contient déjà le jeu ${record.game.address}, déployé avec une autre genèse ou un autre flux. ` +
        "Un seul jeu par journal : rien n'a été envoyé.",
    );
  }
  if (record.game?.status === "confirmed") {
    if (!(await gameMatches(ctx, record.game))) {
      throw new LaunchError(`Le jeu du journal (${record.game.address}) ne correspond pas à ce qui y est noté.`);
    }
    return record.game;
  }

  let entry: GameRecord;
  let receipt: TransactionReceipt | null;
  if (record.game?.status === "pending") {
    const pending = record.game;
    const payload = { data: (await factory.getDeployTransaction(...gameConstructorArgs(pending))).data };
    ({ entry, receipt } = await resumeJournaled(ctx, pending, payload, save, label, () => gameMatches(ctx, pending)));
  } else {
    await checkFeed(ctx, feed);
    const fields = {
      feed: getAddress(feed),
      detectFrom: genesis.detectFrom,
      dipDays: genesis.dipDays,
      dipBonus: genesis.dipBonus,
      histMinSeconds: genesis.histMinSeconds,
      recentPrices: genesis.recentPrices.map(String),
    };
    const payload = { data: (await factory.getDeployTransaction(...gameConstructorArgs(fields))).data };
    ctx.log(`Déploiement du jeu (${genesis.dipDays.length} baisses historiques, détection à partir du jour ${genesis.detectFrom})…`);
    const prepared = await signAndRecord(
      ctx,
      record,
      payload,
      (base) => ({ ...base, address: getCreateAddress({ from: base.from, nonce: base.nonce }), ...fields }),
      save,
    );
    ({ entry, receipt } = await broadcastAndWait(ctx, prepared, payload, save, label));
  }

  if (receipt !== null && receipt.status !== 1) {
    const { game: _failed, ...rest } = record;
    await ctx.journal.write(withNonceConsumed(rest, entry.nonce));
    throw new LaunchError(`Le déploiement du jeu ${receipt.hash} a échoué. Relance la commande pour réessayer.`);
  }
  const deployed = entry;
  const matches = await eventually(async () => {
    if (!(await gameMatches(ctx, deployed))) throw new Error("pas encore visible");
    return true;
  }).catch(() => false);
  if (!matches) {
    throw new LaunchError(`Le jeu attendu à ${entry.address} n'est pas (encore) visible. Relance la commande dans un moment.`);
  }
  const finalReceipt = receipt ?? (await findReceipt(ctx, entry).catch(() => null));
  const confirmed: GameRecord = {
    ...entry,
    status: "confirmed",
    txHash: finalReceipt?.hash ?? entry.txHash,
    blockNumber: finalReceipt?.blockNumber ?? entry.blockNumber,
    confirmedAt: now(),
  };
  await save(confirmed);
  return confirmed;
}
