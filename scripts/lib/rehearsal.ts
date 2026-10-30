import type { HardhatEthers } from "@nomicfoundation/hardhat-ethers/types";
import { Contract, Interface, MaxUint256, ZeroAddress, getAddress } from "ethers";
import type { NetworkConnection } from "hardhat/types/network";

import { DEAD_ADDRESS, TX_DEADLINE_SECONDS, UNISWAP_V2_MINIMUM_LIQUIDITY } from "./constants.ts";
import { CURVE_ABI, type CurvePlan, buildCurvePlan, splitSupply } from "./curve.ts";
import { LaunchError } from "./errors.ts";
import type { UniswapV2Deployment } from "./networks.ts";
import { type TokenRecord, type VestingRecord, memoryJournal } from "./records.ts";
import { assertSafe } from "./safe.ts";
import { type StepContext, deployTokenStep, deployVestingStep } from "./steps.ts";
import { ERC20_ABI, PAIR_ABI, type PoolStatus, ROUTER_ABI, assertUniswapV2Deployment, readPoolStatus } from "./uniswap.ts";
import type { TokenParams, ValidatedCommunity, ValidatedCurve, ValidatedVesting } from "./validation.ts";
import { VESTING_ABI, readVestingStatus } from "./vesting.ts";
import { assertSameAccount, localWallet } from "./wallet.ts";

const curveInterface = new Interface(CURVE_ABI);

export interface RehearsalReport {
  token: TokenRecord;
  plan: CurvePlan;
  /** Contrat de blocage déployé avant la courbe (absent sans part gardée). */
  vestingRecord?: VestingRecord;
  /** Safe communauté utilisé ; `fakeSafe` = Safe d'essai déployé sur la copie locale. */
  communitySafe?: { address: string; fakeSafe: boolean };
  gasUsed: { vesting: bigint; curve: bigint; graduation: bigint };
  antiBot: {
    buyBeforeOpenBlocked: boolean;
    /** Limite de la 1re heure, et l'achat au-delà refusé. */
    limitAtOpen: bigint;
    bigBuyBlocked: boolean;
    /** Après l'ouverture du pool : un gros achat sur Uniswap refusé par le token (24 h). */
    poolBigBuyBlocked: boolean;
  };
  smallBuys: { buyers: number; ethIn: bigint; tokensOut: bigint };
  resale: { tokensIn: bigint; ethOut: bigint };
  graduation: {
    ethSent: bigint;
    ethUsed: bigint;
    refunded: bigint;
    pair: string;
    ethInPool: bigint;
    tokensInPool: bigint;
    lpBurned: bigint;
    tokensBurned: bigint;
    vestingReceived: bigint;
    communityReceived: bigint;
  };
  pool: PoolStatus;
  routerBuy: { ethIn: bigint; tokensOut: bigint };
  /** Présent quand une part est gardée : versée au bénéficiaire en avançant le temps. */
  vesting?: {
    locked: bigint;
    cliff: bigint;
    end: bigint;
    releasedAtCliff: bigint;
    releasedAtEnd: bigint;
  };
}

async function gasUsedBy(ethers: HardhatEthers, txHash: string | undefined): Promise<bigint> {
  if (txHash === undefined) return 0n;
  const receipt = await ethers.provider.getTransactionReceipt(txHash);
  return receipt?.gasUsed ?? 0n;
}

async function deadline(ethers: HardhatEthers): Promise<bigint> {
  const block = await ethers.provider.getBlock("latest");
  if (block === null) throw new LaunchError("Impossible de lire le dernier bloc.");
  return BigInt(block.timestamp) + TX_DEADLINE_SECONDS;
}

async function reverts(call: Promise<unknown>): Promise<boolean> {
  return await call.then(
    () => false,
    () => true,
  );
}

/**
 * Le lancement complet sur un réseau local (fork du mainnet ou chaîne de test),
 * avec exactement les mêmes étapes que les scripts du vrai lancement — journal
 * en mémoire, confirmations automatiques — puis la vie de la courbe : achats
 * refusés avant l'heure et au-delà de 0,5 %, petits achats, une revente, la cible
 * atteinte (pool ouvert, LP brûlées, part et réserve versées) et un achat sur Uniswap.
 */
export async function runRehearsal(
  connection: NetworkConnection,
  uniswap: UniswapV2Deployment,
  input: { token: TokenParams; curve: ValidatedCurve; vesting?: ValidatedVesting; community?: ValidatedCommunity },
  log: (message: string) => void = () => {},
): Promise<RehearsalReport> {
  const { ethers, networkHelpers } = connection;
  const signers = await ethers.getSigners();
  const [deployer, buyer] = signers;
  const extra = (index: number) => {
    const signer = signers[index];
    if (signer === undefined) throw new LaunchError(`Compte de test n°${index} manquant pour la répétition.`);
    return signer;
  };
  const wallet = await localWallet(connection);
  assertSameAccount(wallet, deployer.address);
  const { chainId } = await ethers.provider.getNetwork();
  const ctx: StepContext = {
    ethers,
    wallet,
    journal: memoryJournal("répétition"),
    networkName: "rehearsal",
    chainId,
    confirm: async () => {},
    log,
  };

  log("Contrôle des contrats Uniswap v2…");
  await assertUniswapV2Deployment(ethers.provider, uniswap);

  const communityPercent = input.community?.percent ?? 0n;
  const split = splitSupply(input.token.supply, input.curve.tokenPercent, communityPercent);
  const plan = buildCurvePlan({
    supplyWholeTokens: input.token.supply,
    split,
    virtualEthWei: input.curve.virtualEthWei,
    targetEthWei: input.curve.targetEthWei,
  });

  // 1. Le contrat de blocage, AVANT la courbe : elle doit connaître son adresse.
  let vestingRecord: VestingRecord | undefined;
  if (split.vestingWholeTokens > 0n) {
    if (input.vesting?.enabled !== true) {
      throw new LaunchError("Ta part ne peut exister que bloquée : active le blocage, ou règle tokenPercent + réserve à 100.");
    }
    vestingRecord = await deployVestingStep(ctx, {
      beneficiary: input.vesting.beneficiary,
      start: input.curve.openAt,
      durationSeconds: input.vesting.durationSeconds,
      cliffSeconds: input.vesting.cliffSeconds,
    });
  }

  // 2. Le Safe communauté, qui doit exister avant la courbe : un Safe d'essai si aucun n'est donné.
  let communitySafe: RehearsalReport["communitySafe"];
  if (split.communityWholeTokens > 0n) {
    let address = input.community?.beneficiary;
    let fakeSafe = false;
    if (address === undefined) {
      log("Pas de Safe communauté dans la config : déploiement d'un Safe d'essai 2 sur 3 (copie locale seulement)…");
      const singleton = await ethers.deployContract("MockSafeSingleton", ["1.4.1"], extra(10));
      const safe = await ethers.deployContract(
        "MockSafe",
        [await singleton.getAddress(), [extra(10).address, extra(11).address, extra(12).address], 2],
        extra(10),
      );
      address = await safe.getAddress();
      fakeSafe = true;
    }
    if ((await ethers.provider.getCode(address)) === "0x") {
      throw new LaunchError(`Le wallet communauté ${address} n'a pas de code : la courbe exige un Safe (contrat).`);
    }
    await assertSafe(ethers.provider, address, deployer.address, "Le wallet communauté");
    communitySafe = { address: getAddress(address), fakeSafe };
  }

  // 3. La courbe, qui crée le token et garde 100 % de l'offre.
  const token = await deployTokenStep(ctx, {
    ...input.token,
    factory: uniswap.factory,
    weth: uniswap.weth,
    curveTokenPercent: input.curve.tokenPercent,
    curveWholeTokens: split.curveWholeTokens,
    virtualEthWei: input.curve.virtualEthWei,
    targetEthWei: input.curve.targetEthWei,
    openAt: input.curve.openAt,
    vesting: vestingRecord?.address ?? ZeroAddress,
    vestingWholeTokens: vestingRecord === undefined ? 0n : split.vestingWholeTokens,
    community: communitySafe?.address ?? ZeroAddress,
    communityWholeTokens: split.communityWholeTokens,
  });
  const tokenContract = new Contract(token.address, ERC20_ABI, ethers.provider);
  const curveRead = new Contract(token.curve, CURVE_ABI, ethers.provider);
  const curveAs = (index: number) => new Contract(token.curve, CURVE_ABI, extra(index));
  const balanceOf = async (holder: string) => (await tokenContract.balanceOf(holder)) as bigint;
  if ((await balanceOf(deployer.address)) !== 0n || (await balanceOf(token.curve)) !== plan.totalSupply) {
    throw new LaunchError("La courbe devrait détenir toute l'offre, et le wallet de déploiement aucun token.");
  }

  // 4. Avant l'heure : refusé.
  log("Achat avant l'heure d'ouverture : doit être refusé…");
  const buyBeforeOpenBlocked = await reverts(
    curveAs(1).buy.staticCall(0n, await deadline(ethers), { value: plan.halfPercentCostWei / 4n + 1n }),
  );

  await networkHelpers.time.increaseTo(input.curve.openAt);

  // 5. 1re heure : au-delà de 0,5 % de l'offre, refusé.
  log("Ouverture : un achat au-delà de 0,5 % de l'offre doit être refusé…");
  const limitAtOpen = (await curveRead.walletLimit()) as bigint;
  const bigBuyBlocked = await reverts(
    curveAs(1).buy.staticCall(0n, await deadline(ethers), { value: plan.halfPercentCostWei * 2n }),
  );

  if (!buyBeforeOpenBlocked || !bigBuyBlocked) {
    throw new LaunchError(
      `Anti-bot inattendu : achat avant l'heure ${buyBeforeOpenBlocked ? "refusé" : "accepté"}, ` +
        `achat au-delà de 0,5 % ${bigBuyBlocked ? "refusé" : "accepté"}.`,
    );
  }

  // 6. Petits achats (chacun ≈ 0,1 % de l'offre), au montant exact annoncé : aucune taxe.
  log("Petits achats sur la courbe…");
  const smallIn = plan.halfPercentCostWei / 5n > 0n ? plan.halfPercentCostWei / 5n : 1n;
  let smallTokens = 0n;
  const buyerIndexes = [1, 6, 7];
  for (const index of buyerIndexes) {
    const [expected] = (await curveRead.quoteBuy(smallIn)) as [bigint, bigint];
    const before = await balanceOf(extra(index).address);
    await (await curveAs(index).buy(expected, await deadline(ethers), { value: smallIn })).wait();
    const got = (await balanceOf(extra(index).address)) - before;
    if (got !== expected) throw new LaunchError(`L'acheteur a reçu ${got} au lieu de ${expected} : un prélèvement inattendu.`);
    smallTokens += got;
  }

  // 7. Une revente à la courbe, au montant exact annoncé.
  log("Revente d'une partie à la courbe…");
  const tokensIn = (await balanceOf(buyer.address)) / 2n;
  await (await new Contract(token.address, ERC20_ABI, buyer).approve(token.curve, tokensIn)).wait();
  const expectedEth = (await curveRead.quoteSell(tokensIn)) as bigint;
  const ethBefore = await ethers.provider.getBalance(buyer.address);
  const sellReceipt = await (await curveAs(1).sell(tokensIn, expectedEth, await deadline(ethers))).wait();
  const ethOut = (await ethers.provider.getBalance(buyer.address)) - ethBefore + (sellReceipt?.fee ?? 0n);
  if (ethOut !== expectedEth) throw new LaunchError(`La revente a rendu ${ethOut} wei au lieu de ${expectedEth}.`);

  // 8. 24 h plus tard : plus de limite sur la courbe ; un achat atteint la cible.
  await networkHelpers.time.increase(24 * 60 * 60);
  if (((await curveRead.walletLimit()) as bigint) !== MaxUint256) {
    throw new LaunchError("La limite par wallet de la courbe devrait être levée après 24 h.");
  }
  log("Achat qui atteint la cible : le pool doit s'ouvrir tout seul…");
  const whale = extra(8);
  const missing = input.curve.targetEthWei - ((await curveRead.ethReserve()) as bigint);
  const ethSent = missing + missing / 10n + 1n; // un surplus, qui doit être rendu
  const whaleBefore = await ethers.provider.getBalance(whale.address);
  const graduationReceipt = await (await curveAs(8).buy(0n, await deadline(ethers), { value: ethSent })).wait();
  if (graduationReceipt === null) throw new LaunchError("Reçu introuvable pour l'achat qui atteint la cible.");
  const spent = whaleBefore - (await ethers.provider.getBalance(whale.address)) - graduationReceipt.fee;
  let graduated: { pair: string; eth: bigint; tokens: bigint; lp: bigint; burned: bigint } | undefined;
  for (const entry of graduationReceipt.logs) {
    if (getAddress(entry.address) !== getAddress(token.curve)) continue;
    const parsed = curveInterface.parseLog({ topics: [...entry.topics], data: entry.data });
    if (parsed?.name === "Graduated") {
      graduated = {
        pair: getAddress(parsed.args.pair as string),
        eth: parsed.args.ethAmount as bigint,
        tokens: parsed.args.tokenAmount as bigint,
        lp: parsed.args.liquidityBurned as bigint,
        burned: parsed.args.tokensBurned as bigint,
      };
    }
  }
  if (graduated === undefined || !((await curveRead.graduated()) as boolean)) {
    throw new LaunchError("La cible est atteinte mais le pool ne s'est pas ouvert (aucun événement Graduated).");
  }
  if (graduated.eth !== input.curve.targetEthWei || spent !== missing) {
    throw new LaunchError(`Ouverture inattendue : ${graduated.eth} wei dans le pool, ${spent} wei payés pour ${missing} manquants.`);
  }
  if ((await ethers.provider.getBalance(token.curve)) !== 0n) {
    throw new LaunchError("Il reste de l'ETH dans la courbe après l'ouverture du pool.");
  }
  const lp = new Contract(graduated.pair, PAIR_ABI, ethers.provider);
  const [lpTotal, lpDead] = (await Promise.all([lp.totalSupply(), lp.balanceOf(DEAD_ADDRESS)])) as [bigint, bigint];
  if (lpDead !== graduated.lp || lpTotal !== lpDead + UNISWAP_V2_MINIMUM_LIQUIDITY) {
    throw new LaunchError("Les parts LP ne sont pas toutes brûlées.");
  }
  const vestingReceived = vestingRecord === undefined ? 0n : await balanceOf(vestingRecord.address);
  const communityReceived = communitySafe === undefined ? 0n : await balanceOf(communitySafe.address);
  if (vestingReceived !== plan.vestingAmount || communityReceived !== plan.communityAmount) {
    throw new LaunchError("Ta part ou la réserve n'a pas été versée au montant prévu à l'ouverture du pool.");
  }
  if ((await balanceOf(token.curve)) !== 0n) {
    throw new LaunchError("Il reste des tokens dans la courbe après l'ouverture du pool.");
  }

  const pool = await readPoolStatus(ethers.provider, uniswap, token.address, deployer.address);
  if (pool === undefined) throw new LaunchError("Le pool est introuvable après son ouverture.");

  // 9. Un achat sur Uniswap, au montant exact annoncé par le routeur ; un gros achat refusé (24 h du token).
  log("Achat via le routeur Uniswap, et gros achat refusé par l'anti-bot du token…");
  const path = [uniswap.weth, token.address];
  const routerBuyer = new Contract(uniswap.router, ROUTER_ABI, extra(9));
  const tokenLimit = (await new Contract(token.address, ["function walletLimit() view returns (uint256)"], ethers.provider).walletLimit()) as bigint;
  const bigIn = pool.wethReserve / 5n;
  const [, bigOut] = (await routerBuyer.getAmountsOut(bigIn, path)) as [bigint, bigint];
  const poolBigBuyBlocked =
    bigOut > tokenLimit &&
    (await reverts(routerBuyer.swapExactETHForTokens.staticCall(0n, path, extra(9).address, await deadline(ethers), { value: bigIn })));
  const routerIn = pool.wethReserve / 1000n > 0n ? pool.wethReserve / 1000n : 1n;
  const [, expectedOut] = (await routerBuyer.getAmountsOut(routerIn, path)) as [bigint, bigint];
  await (await routerBuyer.swapExactETHForTokens(expectedOut, path, extra(9).address, await deadline(ethers), { value: routerIn })).wait();
  const routerOut = await balanceOf(extra(9).address);
  if (routerOut !== expectedOut) {
    throw new LaunchError(`L'acheteur Uniswap a reçu ${routerOut} au lieu de ${expectedOut} : un prélèvement inattendu.`);
  }

  // 10. En dernier (le temps avancé ne concerne que cette copie locale) : la part
  //     bloquée se libère bien selon le calendrier, au bénéficiaire.
  let vestingReport: RehearsalReport["vesting"];
  if (vestingRecord !== undefined) {
    log("Libération de la part bloquée, en avançant le temps (copie locale seulement)…");
    const before = await readVestingStatus(ethers.provider, vestingRecord.address, token.address);
    const vestingAsStranger = new Contract(vestingRecord.address, VESTING_ABI, buyer);
    const initial = await balanceOf(before.beneficiary);
    // Le temps n'avance jamais à rebours (falaise et fin peuvent coïncider).
    const advanceTo = async (target: bigint) => {
      if (target > BigInt(await networkHelpers.time.latest())) await networkHelpers.time.increaseTo(target);
    };
    await advanceTo(before.cliff);
    await (await vestingAsStranger.release(token.address)).wait();
    const releasedAtCliff = (await balanceOf(before.beneficiary)) - initial;
    await advanceTo(before.end);
    await (await vestingAsStranger.release(token.address)).wait();
    const releasedAtEnd = (await balanceOf(before.beneficiary)) - initial;
    if (releasedAtEnd !== before.locked) {
      throw new LaunchError(`La part bloquée (${before.locked}) n'a pas été entièrement versée à la fin (${releasedAtEnd}).`);
    }
    vestingReport = { locked: before.locked, cliff: before.cliff, end: before.end, releasedAtCliff, releasedAtEnd };
  }

  return {
    token,
    plan,
    vestingRecord,
    communitySafe,
    gasUsed: {
      vesting: await gasUsedBy(ethers, vestingRecord?.txHash),
      curve: await gasUsedBy(ethers, token.txHash),
      graduation: graduationReceipt.gasUsed,
    },
    antiBot: { buyBeforeOpenBlocked, limitAtOpen, bigBuyBlocked, poolBigBuyBlocked },
    smallBuys: { buyers: buyerIndexes.length, ethIn: smallIn * BigInt(buyerIndexes.length), tokensOut: smallTokens },
    resale: { tokensIn, ethOut },
    graduation: {
      ethSent,
      ethUsed: spent,
      refunded: ethSent - spent,
      pair: graduated.pair,
      ethInPool: graduated.eth,
      tokensInPool: graduated.tokens,
      lpBurned: graduated.lp,
      tokensBurned: graduated.burned,
      vestingReceived,
      communityReceived,
    },
    pool,
    routerBuy: { ethIn: routerIn, tokensOut: routerOut },
    vesting: vestingReport,
  };
}

