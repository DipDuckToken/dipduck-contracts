import type { HardhatEthers } from "@nomicfoundation/hardhat-ethers/types";
import {
  type BaseWallet,
  Contract,
  Interface,
  Transaction,
  type TransactionReceipt,
  ZeroAddress,
  getAddress,
  getCreateAddress,
} from "ethers";

import { RECEIPT_TIMEOUT_MS, UNIT } from "./constants.ts";
import { CURVE_ABI, MAX_OPEN_DELAY_SECONDS, formatOpenAt } from "./curve.ts";
import { LaunchError } from "./errors.ts";
import type { GameRecord, Journal, JournaledTx, LaunchRecord, NftRecord, TokenRecord, VestingRecord } from "./records.ts";
import type { Genesis } from "./genesis.ts";
import {
  CURVE_CONTRACT,
  GAME_CONTRACT,
  NFT_CONTRACT,
  VESTING_CONTRACT,
  curveConstructorArgs,
  gameConstructorArgs,
  nftConstructorArgs,
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
import { ERC20_ABI } from "./uniswap.ts";
import type { TokenParams } from "./validation.ts";
import { VESTING_ABI } from "./vesting.ts";

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

const curveInterface = new Interface(CURVE_ABI);

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
  const entries: (JournaledTx | undefined)[] = [record.vesting, record.token, record.nft, record.game];
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
    return describeRevert(error);
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

/** Raison lisible d'un refus de la courbe (ou, à défaut, la première ligne de l'erreur). */
export function describeRevert(error: unknown): string {
  const data = revertDataOf(error);
  let parsed: ReturnType<Interface["parseError"]> = null;
  try {
    parsed = data === undefined ? null : curveInterface.parseError(data);
  } catch {
    parsed = null;
  }
  if (parsed?.name === "InvalidParams") {
    return (
      "la courbe refuse ses paramètres (heure d'ouverture passée ou à plus de 30 jours, contrat de blocage " +
      "ou Safe sans code, ou répartition impossible)"
    );
  }
  if (parsed !== null) return `${parsed.name}(${parsed.args.join(", ")})`;
  return firstLine(error);
}

// --- Étape 1b : la courbe de lancement, qui crée le token ---------------------------

/** Paramètres du déploiement de la courbe (montants de tokens en tokens entiers). */
export interface LaunchParams extends TokenParams {
  factory: string;
  weth: string;
  curveTokenPercent: bigint;
  curveWholeTokens: bigint;
  virtualEthWei: bigint;
  targetEthWei: bigint;
  /** Horodatage Unix (s) de l'ouverture des achats. */
  openAt: bigint;
  /** Contrat de blocage déjà déployé (adresse 0 et 0 token = aucune part). */
  vesting: string;
  vestingWholeTokens: bigint;
  /** Safe communauté (adresse 0 et 0 token = aucune réserve). */
  community: string;
  communityWholeTokens: bigint;
}

/** Paramètres notés dans le journal (reprise d'un déploiement « pending »). */
export function launchParamsOf(token: TokenRecord): LaunchParams {
  return {
    name: token.name,
    symbol: token.symbol,
    supply: BigInt(token.supplyWholeTokens),
    factory: token.factory,
    weth: token.weth,
    curveTokenPercent: BigInt(token.curveTokenPercent),
    curveWholeTokens: BigInt(token.curveWholeTokens),
    virtualEthWei: BigInt(token.virtualEthWei),
    targetEthWei: BigInt(token.targetEthWei),
    openAt: BigInt(token.openAt),
    vesting: token.vesting,
    vestingWholeTokens: BigInt(token.vestingWholeTokens),
    community: token.community,
    communityWholeTokens: BigInt(token.communityWholeTokens),
  };
}

/**
 * La courbe et le token notés sont-ils sur la chaîne, avec les paramètres notés ?
 * Les deux adresses (CREATE) ne dépendent que du wallet et du nonce : seul le
 * déploiement noté peut s'y trouver.
 */
async function curveMatches(ctx: StepContext, entry: TokenRecord): Promise<boolean> {
  const provider = ctx.ethers.provider;
  if ((await provider.getCode(entry.curve)) === "0x" || (await provider.getCode(entry.address)) === "0x") return false;
  const curve = new Contract(entry.curve, CURVE_ABI, provider);
  const [tokenAddress, openAt, virtualEth, targetEth] = (await Promise.all([
    curve.TOKEN(),
    curve.OPEN_AT(),
    curve.VIRTUAL_ETH(),
    curve.TARGET_ETH(),
  ])) as [string, bigint, bigint, bigint];
  if (
    getAddress(tokenAddress) !== getAddress(entry.address) ||
    openAt !== BigInt(entry.openAt) ||
    virtualEth !== BigInt(entry.virtualEthWei) ||
    targetEth !== BigInt(entry.targetEthWei)
  ) {
    return false;
  }
  const token = new Contract(entry.address, ERC20_ABI, provider);
  const [name, symbol, totalSupply] = (await Promise.all([
    token.name(),
    token.symbol(),
    token.totalSupply(),
  ])) as [string, string, bigint];
  return name === entry.name && symbol === entry.symbol && totalSupply === BigInt(entry.supplyWholeTokens) * UNIT;
}

/**
 * Déploie la courbe de lancement (qui crée le token et garde toute l'offre), ou
 * reprend un déploiement noté « pending ». La confirmation d'un premier envoi
 * est faite par l'appelant, après affichage du plan. Le journal note l'adresse
 * du token (1er contrat créé par la courbe) et celle de la courbe, toutes deux
 * connues avant la diffusion.
 */
export async function deployTokenStep(ctx: StepContext, params: LaunchParams): Promise<TokenRecord> {
  const record = await loadRecord(ctx);
  const save = (token: TokenRecord) => ctx.journal.write({ ...record, token });
  const factory = await ctx.ethers.getContractFactory(CURVE_CONTRACT);
  const label = "le déploiement de la courbe";

  if (record.token?.status === "confirmed") {
    throw new LaunchError(
      `Un token est déjà déployé sur ce réseau : ${record.token.address} (courbe ${record.token.curve}).\n` +
        `  Pour en déployer un autre volontairement, renomme d'abord ${ctx.journal.location}.`,
    );
  }

  let entry: TokenRecord;
  let receipt: TransactionReceipt | null;
  if (record.token?.status === "pending") {
    const pending = record.token;
    const payload = { data: (await factory.getDeployTransaction(...curveConstructorArgs(pending))).data };
    ({ entry, receipt } = await resumeJournaled(ctx, pending, payload, save, label, () => curveMatches(ctx, pending)));
  } else {
    // Dernier contrôle juste avant de signer : le contrat refuserait sinon (et l'annonce serait fausse).
    const latest = await ctx.ethers.provider.getBlock("latest");
    const nowSeconds = BigInt(latest?.timestamp ?? Math.floor(Date.now() / 1000));
    if (params.openAt <= nowSeconds + 60n) {
      throw new LaunchError(
        `L'heure d'ouverture des achats (${formatOpenAt(params.openAt)}) est passée ou imminente : ` +
          "choisis une nouvelle heure (curve.openAt) et relance. Rien n'a été envoyé.",
      );
    }
    if (params.openAt > nowSeconds + MAX_OPEN_DELAY_SECONDS) {
      throw new LaunchError(
        `L'heure d'ouverture des achats (${formatOpenAt(params.openAt)}) est à plus de 30 jours : le contrat la refuserait. ` +
          "Rien n'a été envoyé.",
      );
    }
    if (params.supply - params.vestingWholeTokens - params.communityWholeTokens !== params.curveWholeTokens) {
      throw new LaunchError("Répartition incohérente : courbe + ta part + réserve doit faire l'offre totale. Rien n'a été envoyé.");
    }
    const fields = {
      name: params.name,
      symbol: params.symbol,
      supplyWholeTokens: params.supply.toString(),
      factory: getAddress(params.factory),
      weth: getAddress(params.weth),
      curveTokenPercent: Number(params.curveTokenPercent),
      curveWholeTokens: params.curveWholeTokens.toString(),
      vesting: getAddress(params.vesting),
      vestingWholeTokens: params.vestingWholeTokens.toString(),
      community: getAddress(params.community),
      communityWholeTokens: params.communityWholeTokens.toString(),
      virtualEthWei: params.virtualEthWei.toString(),
      targetEthWei: params.targetEthWei.toString(),
      openAt: params.openAt.toString(),
    };
    const payload = { data: (await factory.getDeployTransaction(...curveConstructorArgs(fields))).data };
    try {
      await ctx.ethers.provider.call({ from: ctx.wallet.address, ...payload });
    } catch (error) {
      throw new LaunchError(`La simulation du déploiement de la courbe a échoué : ${describeRevert(error)}. Rien n'a été envoyé.`);
    }
    ctx.log("Déploiement de la courbe de lancement (elle crée le token)…");
    const prepared = await signAndRecord(
      ctx,
      record,
      payload,
      (base) => {
        const curve = getCreateAddress({ from: base.from, nonce: base.nonce });
        // Le token est le 1er contrat créé par la courbe (le nonce d'un contrat commence à 1).
        return { ...base, address: getCreateAddress({ from: curve, nonce: 1 }), curve, ...fields };
      },
      save,
    );
    ({ entry, receipt } = await broadcastAndWait(ctx, prepared, payload, save, label));
  }

  if (receipt !== null && receipt.status !== 1) {
    // Reçu de NOTRE transaction, en échec : c'est définitif, rien n'a été créé.
    const { token: _failed, ...rest } = record;
    await ctx.journal.write(withNonceConsumed(rest, entry.nonce));
    throw new LaunchError(`Le déploiement ${receipt.hash} a échoué : rien n'a été créé. Relance la commande pour réessayer.`);
  }
  const confirmedEntry = entry;
  const matches = await eventually(async () => {
    if (!(await curveMatches(ctx, confirmedEntry))) throw new Error("pas encore visible");
    return true;
  }).catch(() => false);
  if (!matches) {
    throw new LaunchError(
      `La courbe attendue à ${entry.curve} (token ${entry.address}) n'est pas (encore) visible ou ne correspond pas au journal. ` +
        "Relance la commande dans un moment ; rien ne sera renvoyé.",
    );
  }
  const pair = (await new Contract(entry.curve, CURVE_ABI, ctx.ethers.provider).PAIR().catch(() => undefined)) as
    | string
    | undefined;
  // Prouvé par l'état de la chaîne sans reçu visible : on retente une fois de lire le reçu.
  const finalReceipt = receipt ?? (await findReceipt(ctx, entry).catch(() => null));
  const confirmed: TokenRecord = {
    ...entry,
    status: "confirmed",
    // Le hash de la version réellement minée (une version re-signée peut ne jamais l'avoir été).
    txHash: finalReceipt?.hash ?? entry.txHash,
    blockNumber: finalReceipt?.blockNumber ?? entry.blockNumber,
    ...(pair === undefined ? {} : { pair: getAddress(pair) }),
    confirmedAt: now(),
  };
  await save(confirmed);
  return confirmed;
}

// --- Étape 1a : le contrat de blocage de ta part, déployé AVANT la courbe -------------

export interface VestingPlan {
  beneficiary: string;
  /** Horodatage Unix du début du calendrier : l'ouverture des achats. */
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
  "function BACKUP_FEED() view returns (address)",
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
  const [dataStart, topSize, feed, backupFeed, detectFrom, dipCount] = (await Promise.all([
    game.DATA_START(),
    game.TOP_SIZE(),
    game.FEED(),
    game.BACKUP_FEED(),
    game.DETECT_FROM(),
    game.dipCount(),
  ])) as [bigint, bigint, string, string, bigint, bigint];
  const n = entry.dipDays.length;
  if (
    dataStart !== GAME_DATA_START ||
    topSize !== GAME_TOP_SIZE ||
    getAddress(feed) !== getAddress(entry.feed) ||
    getAddress(backupFeed) !== getAddress(entry.backupFeed ?? ZeroAddress) ||
    detectFrom !== BigInt(entry.detectFrom) ||
    dipCount < BigInt(n) // la chaîne ajoute ensuite ses propres baisses
  ) {
    return false;
  }
  if (n === 0) return true;
  const [day, bonus] = (await game.dipAt(n - 1)) as [bigint, bigint];
  return day === BigInt(entry.dipDays[n - 1]) && bonus === BigInt(entry.dipBonus[n - 1]);
}

function sameGenesis(entry: GameRecord, genesis: Genesis, feed: string, backupFeed: string): boolean {
  return (
    getAddress(entry.feed) === getAddress(feed) &&
    getAddress(entry.backupFeed ?? ZeroAddress) === getAddress(backupFeed) &&
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
 * `backupFeed` : flux BTC/USD de secours, adresse 0 = aucun.
 */
export async function deployGameStep(
  ctx: StepContext,
  genesis: Genesis,
  feed: string,
  backupFeed: string = ZeroAddress,
): Promise<GameRecord> {
  const record = await loadRecord(ctx);
  const save = (game: GameRecord) => ctx.journal.write({ ...record, game });
  const factory = await ctx.ethers.getContractFactory(GAME_CONTRACT);
  const label = "le déploiement du jeu";

  if (record.game !== undefined && !sameGenesis(record.game, genesis, feed, backupFeed)) {
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
    if (backupFeed !== ZeroAddress) {
      if (getAddress(backupFeed) === getAddress(feed)) {
        throw new LaunchError("Le flux de secours doit être différent du flux principal. Rien n'a été envoyé.");
      }
      await checkFeed(ctx, backupFeed);
    }
    const fields = {
      feed: getAddress(feed),
      backupFeed: getAddress(backupFeed),
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
