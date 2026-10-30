import type { HardhatEthers } from "@nomicfoundation/hardhat-ethers/types";
import { Contract } from "ethers";
import type { NetworkConnection } from "hardhat/types/network";

import { TX_DEADLINE_SECONDS } from "./constants.ts";
import { LaunchError } from "./errors.ts";
import type { UniswapV2Deployment } from "./networks.ts";
import {
  type CommunityRecord,
  type LiquidityRecord,
  type LockRecord,
  type SeederRecord,
  type TokenRecord,
  type VestingRecord,
  memoryJournal,
} from "./records.ts";
import {
  type StepContext,
  communityStep,
  deploySeederStep,
  deployTokenStep,
  deployVestingStep,
  lockStep,
  seedStep,
} from "./steps.ts";
import {
  ERC20_ABI,
  type LiquidityPlan,
  type PoolStatus,
  ROUTER_ABI,
  type SeedOutcome,
  assertUniswapV2Deployment,
  buildLiquidityPlan,
  maxPairWethFor,
  previewPair,
  readPoolStatus,
} from "./uniswap.ts";
import type { TokenParams, ValidatedCommunity, ValidatedLiquidity, ValidatedVesting } from "./validation.ts";
import { VESTING_ABI, communityShare, poolBaseAmount, poolShare, readVestingStatus, shareToLock } from "./vesting.ts";
import { assertSameAccount, localWallet } from "./wallet.ts";

/** Lecture de la limite anti-bot du token (MemeToken). */
const ANTI_BOT_ABI = ["function walletLimit() view returns (uint256)"] as const;

export interface RehearsalReport {
  token: TokenRecord;
  seeder: SeederRecord;
  liquidity: LiquidityRecord;
  plan: LiquidityPlan;
  outcome: SeedOutcome;
  pool: PoolStatus;
  gasUsed: { token: bigint; seeder: bigint; seed: bigint };
  roundTrip: { ethIn: bigint; tokensBought: bigint; ethBack: bigint };
  /** Gros achat (5 % de l'ETH du pool) : refusé à l'ouverture, accepté après 24 h. */
  antiBot: { limitAtLaunch: bigint; bigBuyBlocked: boolean; bigBuyAfter24h: boolean };
  /** Présent quand une part est gardée et que le blocage est activé. */
  vesting?: {
    record: VestingRecord;
    lock: LockRecord;
    locked: bigint;
    cliff: bigint;
    end: bigint;
    /** Versé au bénéficiaire en avançant le temps jusqu'à la falaise, puis jusqu'à la fin. */
    releasedAtCliff: bigint;
    releasedAtEnd: bigint;
  };
  /** Présent quand une réserve communauté est prévue : envoyée avant l'ouverture du pool. */
  community?: CommunityRecord;
}

async function gasUsedBy(ethers: HardhatEthers, txHash: string | undefined): Promise<bigint> {
  if (txHash === undefined) return 0n;
  const receipt = await ethers.provider.getTransactionReceipt(txHash);
  return receipt?.gasUsed ?? 0n;
}

/**
 * Le lancement complet sur un réseau local (fork du mainnet ou chaîne de test),
 * avec exactement les mêmes étapes que les scripts du vrai lancement — journal
 * en mémoire, confirmations automatiques — puis un aller-retour achat/revente
 * par un second compte pour prouver que le token se revend sans taxe ni blocage.
 */
export async function runRehearsal(
  connection: NetworkConnection,
  uniswap: UniswapV2Deployment,
  input: { token: TokenParams; liquidity: ValidatedLiquidity; vesting?: ValidatedVesting; community?: ValidatedCommunity },
  log: (message: string) => void = () => {},
): Promise<RehearsalReport> {
  const { ethers, networkHelpers } = connection;
  const [deployer, buyer] = await ethers.getSigners();
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

  log("Déploiement du token…");
  const token = await deployTokenStep(ctx, { ...input.token, factory: uniswap.factory, weth: uniswap.weth });
  const tokenContract = new Contract(token.address, ERC20_ABI, deployer);
  const totalSupply = (await tokenContract.totalSupply()) as bigint;

  // Étape 2 : blocage de ta part AVANT l'ouverture du pool, comme le vrai lancement.
  let locked: { record: VestingRecord; lock: LockRecord } | undefined;
  const communityPercent = input.community?.percent ?? 0n;
  const toLock = shareToLock(totalSupply, input.liquidity.tokenPercent, communityPercent);
  if (input.vesting?.enabled === true && toLock > 0n) {
    const startBlock = await ethers.provider.getBlock("latest");
    if (startBlock === null) {
      throw new LaunchError("Impossible de lire le dernier bloc.");
    }
    log("Blocage de ta part (vesting), avant l'ouverture du pool…");
    const record = await deployVestingStep(ctx, {
      token: token.address,
      beneficiary: input.vesting.beneficiary,
      start: BigInt(startBlock.timestamp),
      durationSeconds: input.vesting.durationSeconds,
      cliffSeconds: input.vesting.cliffSeconds,
    });
    const lock = await lockStep(ctx, record, toLock);
    locked = { record, lock };
  }
  // Puis la réserve communauté, vers son wallet dédié, toujours avant le pool.
  let community: CommunityRecord | undefined;
  if (communityPercent > 0n && input.community?.beneficiary !== undefined) {
    log("Envoi de la réserve communauté, avant l'ouverture du pool…");
    community = await communityStep(ctx, {
      token: token.address,
      recipient: input.community.beneficiary,
      amount: communityShare(totalSupply, communityPercent),
    });
  }
  const share = poolShare({
    tokenPercent: input.liquidity.tokenPercent,
    vestingEnabled: input.vesting?.enabled === true,
    lockConfirmed: locked !== undefined,
    lockCommand: "le blocage de la répétition",
    communityPercent,
    communityConfirmed: community !== undefined,
  });

  // Étape 3 : ouverture du pool avec tout ce qui reste (ou tokenPercent sans blocage).
  const seeder = await deploySeederStep(ctx, uniswap);
  // Part bloquée : exactement l'offre moins ta part, comme l'étape de liquidité.
  const balance = poolBaseAmount({
    mode: share.mode,
    totalSupply,
    lockedAmount: locked === undefined ? 0n : toLock,
    balance: (await tokenContract.balanceOf(deployer.address)) as bigint,
    communityAmount: community === undefined ? 0n : BigInt(community.amount),
  });
  const preview = await previewPair(ethers.provider, uniswap, token.address);
  if (preview.lpTotalSupply !== 0n) {
    throw new LaunchError(`Des parts LP existent déjà pour la paire ${preview.pair}.`);
  }
  const plan = buildLiquidityPlan({
    deployerTokenBalance: balance,
    tokenTotalSupply: totalSupply,
    tokenPercent: share.poolPercent,
    ethAmount: input.liquidity.ethAmountWei,
  });
  const { record: liquidity, outcome } = await seedStep(ctx, token, seeder, {
    ...plan,
    maxPairWeth: maxPairWethFor(preview, plan.ethAmount),
  });

  const pool = await readPoolStatus(ethers.provider, uniswap, token.address, deployer.address);
  if (pool === undefined) {
    throw new LaunchError("Le pool est introuvable après son ouverture.");
  }

  log("Aller-retour d'un acheteur (achat puis revente)…");
  const router = new Contract(uniswap.router, ROUTER_ABI, buyer);
  const latest = await ethers.provider.getBlock("latest");
  if (latest === null) {
    throw new LaunchError("Impossible de lire le dernier bloc.");
  }
  const deadline = BigInt(latest.timestamp) + TX_DEADLINE_SECONDS;

  // Petit achat (0,2 % de l'ETH du pool) : sous la limite anti-bot de la première heure.
  const ethIn = plan.ethAmount / 500n > 0n ? plan.ethAmount / 500n : 1n;
  const buyPath = [uniswap.weth, token.address];
  const [, expectedTokens] = (await router.getAmountsOut(ethIn, buyPath)) as [bigint, bigint];
  await (await router.swapExactETHForTokens(expectedTokens, buyPath, buyer.address, deadline, { value: ethIn })).wait();
  const tokensBought = (await tokenContract.balanceOf(buyer.address)) as bigint;
  if (tokensBought !== expectedTokens) {
    throw new LaunchError(
      `L'acheteur a reçu ${tokensBought} au lieu de ${expectedTokens} : le token prélève quelque chose au transfert.`,
    );
  }

  const tokenAsBuyer = tokenContract.connect(buyer) as Contract;
  await (await tokenAsBuyer.approve(uniswap.router, tokensBought)).wait();
  const sellPath = [token.address, uniswap.weth];
  const [, expectedEth] = (await router.getAmountsOut(tokensBought, sellPath)) as [bigint, bigint];
  const ethBefore = await ethers.provider.getBalance(buyer.address);
  const sellReceipt = await (
    await router.swapExactTokensForETH(tokensBought, expectedEth, sellPath, buyer.address, deadline)
  ).wait();
  const ethBack = (await ethers.provider.getBalance(buyer.address)) - ethBefore + (sellReceipt?.fee ?? 0n);
  if (ethBack !== expectedEth) {
    throw new LaunchError(`La revente a rendu ${ethBack} wei au lieu de ${expectedEth}.`);
  }

  log("Anti-bot : un gros achat doit être refusé à l'ouverture, puis accepté après 24 h…");
  const antiBotToken = new Contract(token.address, ANTI_BOT_ABI, ethers.provider);
  const limitAtLaunch = (await antiBotToken.walletLimit()) as bigint;
  const bigIn = plan.ethAmount / 20n > 0n ? plan.ethAmount / 20n : 1n;
  const bigBuy = async () => {
    const block = await ethers.provider.getBlock("latest");
    const until = BigInt(block?.timestamp ?? 0) + TX_DEADLINE_SECONDS;
    return await router.swapExactETHForTokens.staticCall(0n, buyPath, buyer.address, until, { value: bigIn }).then(
      () => true,
      () => false,
    );
  };
  const bigBuyBlocked = !(await bigBuy());
  await networkHelpers.time.increase(24 * 60 * 60);
  const bigBuyAfter24h = await bigBuy();
  if (!bigBuyBlocked || !bigBuyAfter24h) {
    throw new LaunchError(
      `Anti-bot inattendu : gros achat ${bigBuyBlocked ? "refusé" : "accepté"} à l'ouverture, ` +
        `${bigBuyAfter24h ? "accepté" : "refusé"} après 24 h.`,
    );
  }

  // En dernier (le temps avancé ne concerne que cette copie locale) : la part
  // bloquée se libère bien selon le calendrier, au bénéficiaire.
  let vestingReport: RehearsalReport["vesting"];
  if (locked !== undefined) {
    log("Libération de la part bloquée, en avançant le temps (copie locale seulement)…");
    const vestingAddress = locked.record.address;
    const before = await readVestingStatus(ethers.provider, vestingAddress, token.address);
    const beneficiaryToken = new Contract(token.address, ERC20_ABI, ethers.provider);
    const vestingAsBuyer = new Contract(vestingAddress, VESTING_ABI, buyer);
    const balanceOfBeneficiary = async () => (await beneficiaryToken.balanceOf(before.beneficiary)) as bigint;

    // Le temps n'avance jamais à rebours (falaise et fin peuvent coïncider).
    const advanceTo = async (target: bigint) => {
      if (target > BigInt(await networkHelpers.time.latest())) await networkHelpers.time.increaseTo(target);
    };
    const initial = await balanceOfBeneficiary();
    await advanceTo(before.cliff);
    await (await vestingAsBuyer.release(token.address)).wait();
    const releasedAtCliff = (await balanceOfBeneficiary()) - initial;
    await advanceTo(before.end);
    await (await vestingAsBuyer.release(token.address)).wait();
    const releasedAtEnd = (await balanceOfBeneficiary()) - initial;
    if (releasedAtEnd !== before.locked) {
      throw new LaunchError(`La part bloquée (${before.locked}) n'a pas été entièrement versée à la fin (${releasedAtEnd}).`);
    }
    vestingReport = {
      ...locked,
      locked: before.locked,
      cliff: before.cliff,
      end: before.end,
      releasedAtCliff,
      releasedAtEnd,
    };
  }

  return {
    token,
    seeder,
    liquidity,
    plan,
    outcome,
    pool,
    vesting: vestingReport,
    community,
    gasUsed: {
      token: await gasUsedBy(ethers, token.txHash),
      seeder: await gasUsedBy(ethers, seeder.txHash),
      seed: await gasUsedBy(ethers, liquidity.txHash),
    },
    roundTrip: { ethIn, tokensBought, ethBack },
    antiBot: { limitAtLaunch, bigBuyBlocked, bigBuyAfter24h },
  };
}
