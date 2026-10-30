import type { HardhatEthers } from "@nomicfoundation/hardhat-ethers/types";
import { Contract, Interface, MaxUint256, type TransactionReceipt, ZeroAddress, getAddress } from "ethers";
import type { NetworkConnection } from "hardhat/types/network";

import { LAUNCHER_ABI, type LaunchPlan, type LaunchStatus, TOKEN_LIMIT_ABI, buildLaunchPlan, readLaunchStatus, splitSupply } from "./launch.ts";
import { LaunchError } from "./errors.ts";
import type { UniswapV3Deployment } from "./networks.ts";
import { type TokenRecord, type VestingRecord, memoryJournal } from "./records.ts";
import { assertSafe } from "./safe.ts";
import { type StepContext, deployTokenStep, deployVestingStep } from "./steps.ts";
import { ERC20_ABI, V3_POSITION_MANAGER_ABI, assertUniswapV3Deployment, swapperFor } from "./uniswap.ts";
import type { TokenParams, ValidatedCommunity, ValidatedPool, ValidatedVesting } from "./validation.ts";
import { VESTING_ABI, readVestingStatus } from "./vesting.ts";
import { assertSameAccount, localWallet } from "./wallet.ts";

const launcherInterface = new Interface(LAUNCHER_ABI);

export interface RehearsalReport {
  token: TokenRecord;
  plan: LaunchPlan;
  /** Contrat de blocage déployé avant le lanceur (absent sans part gardée). */
  vestingRecord?: VestingRecord;
  /** Safe communauté (réserve et frais) ; `fakeSafe` = Safe d'essai déployé sur la copie locale. */
  communitySafe: { address: string; fakeSafe: boolean };
  gasUsed: { vesting: bigint; launcher: bigint };
  /** Répartition lue sur la chaîne juste après le déploiement. */
  distribution: { inPool: bigint; inVesting: bigint; inCommunity: bigint; deployer: bigint; positionHeldByLauncher: boolean };
  antiBot: {
    buyBeforeOpenBlocked: boolean;
    /** Limite de la 1re heure, et l'achat au-delà refusé. */
    limitAtOpen: bigint;
    bigBuyBlocked: boolean;
    /** Après 24 h : plus de limite, un gros achat passe. */
    bigBuyAfter24h: { ethIn: bigint; tokensOut: bigint };
  };
  smallBuys: { buyers: number; ethIn: bigint; tokensOut: bigint };
  resale: { tokensIn: bigint; ethOut: bigint };
  fees: { weth: bigint; tokens: bigint };
  status: LaunchStatus;
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

/**
 * Le lancement complet sur un réseau local (fork du mainnet ou chaîne de test),
 * avec exactement les mêmes étapes que le script de déploiement — journal en
 * mémoire, confirmations automatiques — puis la vie du pool : achat refusé avant
 * l'heure et au-delà de 0,5 %, petits achats, une revente, gros achat après 24 h,
 * frais versés au Safe, libération de la part bloquée.
 */
export async function runRehearsal(
  connection: NetworkConnection,
  uniswap: UniswapV3Deployment,
  input: { token: TokenParams; pool: ValidatedPool; vestingPercent: bigint; vesting?: ValidatedVesting; community?: ValidatedCommunity },
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

  log("Contrôle des contrats Uniswap v3…");
  await assertUniswapV3Deployment(ethers.provider, uniswap);

  const split = splitSupply(input.token.supply, input.vestingPercent, input.community?.percent ?? 0n);
  const plan = buildLaunchPlan({ supplyWholeTokens: input.token.supply, split, startTick: input.pool.startTick });

  // 1. Le contrat de blocage, AVANT le lanceur : il lui verse la part dès son déploiement.
  let vestingRecord: VestingRecord | undefined;
  if (split.vestingWholeTokens > 0n) {
    if (input.vesting?.enabled !== true) {
      throw new LaunchError("Ta part ne peut exister que bloquée : active le blocage, ou mets vesting.percent à 0.");
    }
    vestingRecord = await deployVestingStep(ctx, {
      beneficiary: input.vesting.beneficiary,
      start: input.pool.openAt,
      durationSeconds: input.vesting.durationSeconds,
      cliffSeconds: input.vesting.cliffSeconds,
    });
  }

  // 2. Le Safe communauté (réserve et frais) doit exister avant : un Safe d'essai si aucun n'est donné.
  let safeAddress = input.community?.beneficiary;
  let fakeSafe = false;
  if (safeAddress === undefined) {
    log("Pas de Safe communauté dans la config : déploiement d'un Safe d'essai 2 sur 3 (copie locale seulement)…");
    const singleton = await ethers.deployContract("MockSafeSingleton", ["1.4.1"], extra(10));
    const safe = await ethers.deployContract(
      "MockSafe",
      [await singleton.getAddress(), [extra(10).address, extra(11).address, extra(12).address], 2],
      extra(10),
    );
    safeAddress = await safe.getAddress();
    fakeSafe = true;
  }
  await assertSafe(ethers.provider, safeAddress, deployer.address, "Le wallet communauté");
  const communitySafe = { address: getAddress(safeAddress), fakeSafe };

  // 3. Le lanceur : token, part, réserve, pool et position d'un seul côté.
  const positionManager = new Contract(uniswap.positionManager, V3_POSITION_MANAGER_ABI, ethers.provider);
  const token = await deployTokenStep(ctx, {
    ...input.token,
    positionManager: uniswap.positionManager,
    factory: (await positionManager.factory()) as string,
    weth: (await positionManager.WETH9()) as string,
    startTick: input.pool.startTick,
    openAt: input.pool.openAt,
    vesting: vestingRecord?.address ?? ZeroAddress,
    vestingWholeTokens: vestingRecord === undefined ? 0n : split.vestingWholeTokens,
    community: split.communityWholeTokens > 0n ? communitySafe.address : ZeroAddress,
    communityWholeTokens: split.communityWholeTokens,
    feeRecipient: communitySafe.address,
  });
  const tokenContract = new Contract(token.address, ERC20_ABI, ethers.provider);
  const balanceOf = async (holder: string) => (await tokenContract.balanceOf(holder)) as bigint;
  const launched = await readLaunchStatus(ethers.provider, token.launcher);
  const distribution = {
    inPool: await balanceOf(launched.pool),
    inVesting: vestingRecord === undefined ? 0n : await balanceOf(vestingRecord.address),
    inCommunity: await balanceOf(communitySafe.address),
    deployer: await balanceOf(deployer.address),
    positionHeldByLauncher:
      getAddress((await positionManager.ownerOf(launched.positionId)) as string) === getAddress(token.launcher),
  };
  if (
    distribution.deployer !== 0n ||
    distribution.inVesting !== plan.vestingAmount ||
    distribution.inCommunity !== plan.communityAmount ||
    distribution.inPool !== launched.poolTokens ||
    !distribution.positionHeldByLauncher
  ) {
    throw new LaunchError("Répartition inattendue après le déploiement (wallet, blocage, Safe, pool ou position).");
  }

  // 4. Avant l'heure : refusé.
  const swapper = await swapperFor(ethers.provider, uniswap);
  const canBuy = async (index: number, ethIn: bigint) =>
    await swapper.buy(extra(index), token.address, ethIn, 0n).then(
      async (tx) => {
        await tx.wait();
        return true;
      },
      () => false,
    );
  log("Achat avant l'heure d'ouverture : doit être refusé…");
  const snapshotBefore = await networkHelpers.takeSnapshot();
  const buyBeforeOpenBlocked = !(await canBuy(1, plan.halfPercentCostWei / 4n + 1n));
  await snapshotBefore.restore();

  await networkHelpers.time.increaseTo(input.pool.openAt);

  // 5. 1re heure : au-delà de 0,5 % de l'offre, refusé.
  log("Ouverture : un achat au-delà de 0,5 % de l'offre doit être refusé…");
  const tokenLimit = new Contract(token.address, TOKEN_LIMIT_ABI, ethers.provider);
  const limitAtOpen = (await tokenLimit.walletLimit()) as bigint;
  const snapshotOpen = await networkHelpers.takeSnapshot();
  const bigBuyBlocked = !(await canBuy(1, plan.halfPercentCostWei * 2n));
  await snapshotOpen.restore();
  if (!buyBeforeOpenBlocked || !bigBuyBlocked) {
    throw new LaunchError(
      `Anti-bot inattendu : achat avant l'heure ${buyBeforeOpenBlocked ? "refusé" : "accepté"}, ` +
        `achat au-delà de 0,5 % ${bigBuyBlocked ? "refusé" : "accepté"}.`,
    );
  }

  // 6. Petits achats (chacun ≈ 0,1 % de l'offre), au montant exact annoncé par le quoter : aucune taxe.
  log("Petits achats via le routeur Uniswap…");
  const smallIn = plan.halfPercentCostWei / 5n > 0n ? plan.halfPercentCostWei / 5n : 1n;
  let smallTokens = 0n;
  const buyerIndexes = [1, 6, 7];
  for (const index of buyerIndexes) {
    const expected = await swapper.quoteBuy(token.address, smallIn);
    const before = await balanceOf(extra(index).address);
    await (await swapper.buy(extra(index), token.address, smallIn, expected)).wait();
    const got = (await balanceOf(extra(index).address)) - before;
    if (got !== expected) throw new LaunchError(`L'acheteur a reçu ${got} au lieu de ${expected} : un prélèvement inattendu.`);
    smallTokens += got;
  }

  // 7. Une revente contre de l'ETH, au montant exact annoncé.
  log("Revente d'une partie contre de l'ETH…");
  const tokensIn = (await balanceOf(buyer.address)) / 2n;
  await (await new Contract(token.address, ERC20_ABI, buyer).approve(swapper.router, tokensIn)).wait();
  const expectedEth = await swapper.quoteSell(token.address, tokensIn);
  const ethBefore = await ethers.provider.getBalance(buyer.address);
  const sellReceipt = await (await swapper.sell(buyer, token.address, tokensIn, expectedEth)).wait();
  const ethOut = (await ethers.provider.getBalance(buyer.address)) - ethBefore + (sellReceipt?.fee ?? 0n);
  if (ethOut !== expectedEth) throw new LaunchError(`La revente a rendu ${ethOut} wei au lieu de ${expectedEth}.`);

  // 8. 24 h plus tard : plus de limite, un gros achat passe.
  await networkHelpers.time.increase(24 * 60 * 60);
  if (((await tokenLimit.walletLimit()) as bigint) !== MaxUint256) {
    throw new LaunchError("La limite par wallet du token devrait être levée après 24 h.");
  }
  log("Après 24 h : gros achat (au-delà de 2 % de l'offre)…");
  const bigIn = plan.halfPercentCostWei * 20n;
  const bigExpected = await swapper.quoteBuy(token.address, bigIn);
  const whaleBefore = await balanceOf(extra(8).address);
  await (await swapper.buy(extra(8), token.address, bigIn, bigExpected)).wait();
  const bigOut = (await balanceOf(extra(8).address)) - whaleBefore;
  if (bigOut !== bigExpected || bigOut <= plan.totalSupply / 50n) {
    throw new LaunchError(`Gros achat inattendu : ${bigOut} reçus pour ${bigExpected} annoncés.`);
  }

  // 9. Les frais d'échange (1 %) vont au Safe, appelés par n'importe qui.
  log("Versement des frais d'échange au Safe (appelé par un inconnu)…");
  const weth = new Contract(launched.weth, ERC20_ABI, ethers.provider);
  const safeWethBefore = (await weth.balanceOf(communitySafe.address)) as bigint;
  const safeTokensBefore = await balanceOf(communitySafe.address);
  const feeReceipt = (await (await new Contract(token.launcher, LAUNCHER_ABI, extra(9)).collectFees()).wait()) as TransactionReceipt | null;
  const collected = feeReceipt?.logs
    .filter((entry) => getAddress(entry.address) === getAddress(token.launcher))
    .map((entry) => launcherInterface.parseLog({ topics: [...entry.topics], data: entry.data }))
    .find((parsed) => parsed?.name === "FeesCollected");
  const fees = {
    weth: ((await weth.balanceOf(communitySafe.address)) as bigint) - safeWethBefore,
    tokens: (await balanceOf(communitySafe.address)) - safeTokensBefore,
  };
  if (collected === undefined || fees.weth <= 0n) {
    throw new LaunchError("Les frais d'échange n'ont pas été versés au Safe.");
  }

  const status = await readLaunchStatus(ethers.provider, token.launcher);

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
      launcher: await gasUsedBy(ethers, token.txHash),
    },
    distribution,
    antiBot: { buyBeforeOpenBlocked, limitAtOpen, bigBuyBlocked, bigBuyAfter24h: { ethIn: bigIn, tokensOut: bigOut } },
    smallBuys: { buyers: buyerIndexes.length, ethIn: smallIn * BigInt(buyerIndexes.length), tokensOut: smallTokens },
    resale: { tokensIn, ethOut },
    fees,
    status,
    vesting: vestingReport,
  };
}
