import { Contract, type Provider, getAddress } from "ethers";

import { UNIT } from "./constants.ts";
import { LaunchError } from "./errors.ts";
import { formatDate } from "./format.ts";
import { ERC20_ABI, type PoolStatus, TICK_SPACING, readPoolStatus } from "./uniswap.ts";

/** Fonctions et événements de LaunchPool utilisés par les scripts. */
export const LAUNCHER_ABI = [
  "function TOKEN() view returns (address)",
  "function POOL() view returns (address)",
  "function WETH() view returns (address)",
  "function POSITION_MANAGER() view returns (address)",
  "function POSITION_ID() view returns (uint256)",
  "function POOL_TOKENS() view returns (uint256)",
  "function OPEN_AT() view returns (uint256)",
  "function START_TICK() view returns (int24)",
  "function FEE_RECIPIENT() view returns (address)",
  "function VESTING() view returns (address)",
  "function VESTING_TOKENS() view returns (uint256)",
  "function COMMUNITY() view returns (address)",
  "function COMMUNITY_TOKENS() view returns (uint256)",
  "function collectFees() returns (uint256 amount0, uint256 amount1)",
  "event Launched(address indexed token, address indexed pool, uint256 positionId, uint256 poolTokens, int24 startTick)",
  "event FeesCollected(uint256 amount0, uint256 amount1)",
  "error InvalidParams()",
  "error PoolAlreadyExists(address pool)",
  "error InvalidSupply(uint256 wholeTokens)",
] as const;

/** Lecture de l'anti-bot du token. */
export const TOKEN_LIMIT_ABI = ["function walletLimit() view returns (uint256)", "function OPEN_AT() view returns (uint256)"] as const;

/** Bornes du contrat : l'heure d'ouverture doit être dans le futur, à 30 jours au plus du déploiement. */
export const MAX_OPEN_DELAY_SECONDS = 30n * 86_400n;

/**
 * Sur le mainnet, l'ouverture doit laisser au moins 1 h après le déploiement :
 * le temps de vérifier les contrats et d'annoncer l'heure.
 */
export const MIN_OPEN_DELAY_MAINNET_SECONDS = 3_600n;

/** Ailleurs (testnet, fork, tests) : un délai plus court suffit. */
export const MIN_OPEN_DELAY_SECONDS = 900n;

/** Heure d'ouverture par défaut hors mainnet quand pool.openAt est vide : dans 2 h. */
export const DEFAULT_OPEN_DELAY_SECONDS = 7_200n;

/** Le contrat exige −887 000 < startTick < 0. */
export const MIN_START_TICK = -887_000 + TICK_SPACING;

/**
 * Tick de départ pour une capitalisation de départ voulue : le plus grand multiple de
 * 200 inférieur ou égal à log(capitalisation / offre) / log(1,0001). Le prix réel est
 * donc un peu sous la cible (au plus 2 %).
 */
export function startTickFor(startMarketCapWei: bigint, supplyWholeTokens: bigint): number {
  const priceEth = Number(startMarketCapWei) / 1e18 / Number(supplyWholeTokens);
  const tick = Math.floor(Math.log(priceEth) / Math.log(1.0001));
  return Math.floor(tick / TICK_SPACING) * TICK_SPACING;
}

/** Prix d'un tick, en wei par token entier (1,0001^tick ETH ; précision d'affichage). */
export function tickPriceWei(tick: number): bigint {
  return BigInt(Math.round(1.0001 ** tick * 1e18));
}

export interface SupplySplit {
  /** Placés dans le pool, d'un seul côté : tout le reste. */
  poolWholeTokens: bigint;
  /** Ta part, versée au contrat de blocage au déploiement (vesting.percent, arrondi inférieur). */
  vestingWholeTokens: bigint;
  /** Réserve communauté, versée au Safe au déploiement (community.percent, arrondi inférieur). */
  communityWholeTokens: bigint;
}

/** Répartition de l'offre en tokens entiers : pool + ta part + réserve = offre, le pool prend les arrondis. */
export function splitSupply(supplyWholeTokens: bigint, vestingPercent: bigint, communityPercent: bigint): SupplySplit {
  const vestingWholeTokens = (supplyWholeTokens * vestingPercent) / 100n;
  const communityWholeTokens = (supplyWholeTokens * communityPercent) / 100n;
  return { poolWholeTokens: supplyWholeTokens - vestingWholeTokens - communityWholeTokens, vestingWholeTokens, communityWholeTokens };
}

export interface LaunchPlan {
  totalSupply: bigint;
  poolAmount: bigint;
  vestingAmount: bigint;
  communityAmount: bigint;
  startTick: number;
  /** Prix de départ réel (après arrondi du tick), en wei par token entier. */
  startPriceWei: bigint;
  /** Capitalisation de départ réelle (offre × prix), en wei. */
  startFdvWei: bigint;
  /** ETH à payer (environ) pour 0,5 % de l'offre au tout premier achat, frais de 1 % compris. */
  halfPercentCostWei: bigint;
}

/**
 * Chiffres du lancement. Position d'un seul côté du prix P0 à l'infini avec X tokens :
 * acheter t tokens coûte P0 × t × X / (X − t), plus 1 % de frais sur l'ETH apporté.
 */
export function buildLaunchPlan(input: { supplyWholeTokens: bigint; split: SupplySplit; startTick: number }): LaunchPlan {
  const totalSupply = input.supplyWholeTokens * UNIT;
  const poolAmount = input.split.poolWholeTokens * UNIT;
  const startPriceWei = tickPriceWei(input.startTick);
  const t = totalSupply / 200n;
  if (t >= poolAmount) throw new LaunchError("Le pool recevrait moins de 0,5 % de l'offre. Rien n'a été envoyé.");
  const cost = (startPriceWei * t * poolAmount) / (UNIT * (poolAmount - t));
  return {
    totalSupply,
    poolAmount,
    vestingAmount: input.split.vestingWholeTokens * UNIT,
    communityAmount: input.split.communityWholeTokens * UNIT,
    startTick: input.startTick,
    startPriceWei,
    startFdvWei: (startPriceWei * totalSupply) / UNIT,
    halfPercentCostWei: (cost * 100n) / 99n,
  };
}

/** « dans 3 h 05 min », « dans 2 j 4 h », « passée depuis 12 min ». */
export function formatDelay(target: bigint, now: bigint): string {
  const past = target < now;
  let seconds = past ? now - target : target - now;
  const days = seconds / 86_400n;
  seconds -= days * 86_400n;
  const hours = seconds / 3_600n;
  seconds -= hours * 3_600n;
  const minutes = seconds / 60n;
  const text =
    days > 0n ? `${days} j ${hours} h` : hours > 0n ? `${hours} h ${minutes.toString().padStart(2, "0")} min` : `${minutes} min`;
  return past ? `passée depuis ${text}` : `dans ${text}`;
}

/** Date lisible et heure UTC exacte, pour l'annonce publique. */
export function formatOpenAt(openAt: bigint): string {
  return `${formatDate(openAt)} (${new Date(Number(openAt) * 1000).toISOString().replace(".000Z", "Z")})`;
}

export interface LaunchStatus {
  launcher: string;
  token: string;
  pool: string;
  weth: string;
  positionManager: string;
  positionId: bigint;
  poolTokens: bigint;
  openAt: bigint;
  startTick: bigint;
  feeRecipient: string;
  vesting: string;
  vestingTokens: bigint;
  community: string;
  communityTokens: bigint;
  /** 2^256 − 1 = aucune limite (avant l'ouverture ou après 24 h). */
  walletLimit: bigint;
  state: PoolStatus;
  /** Frais en attente (WETH, tokens), ou undefined s'ils ne sont pas lisibles en ce moment. */
  pendingFees?: { weth: bigint; tokens: bigint };
}

/** État du lancement, lu sur la chaîne. */
export async function readLaunchStatus(provider: Provider, launcherAddress: string): Promise<LaunchStatus> {
  const launcher = new Contract(launcherAddress, LAUNCHER_ABI, provider);
  const [token, pool, weth, positionManager, positionId, poolTokens, openAt, startTick, feeRecipient] = (await Promise.all([
    launcher.TOKEN(),
    launcher.POOL(),
    launcher.WETH(),
    launcher.POSITION_MANAGER(),
    launcher.POSITION_ID(),
    launcher.POOL_TOKENS(),
    launcher.OPEN_AT(),
    launcher.START_TICK(),
    launcher.FEE_RECIPIENT(),
  ])) as [string, string, string, string, bigint, bigint, bigint, bigint, string];
  const [vesting, vestingTokens, community, communityTokens] = (await Promise.all([
    launcher.VESTING(),
    launcher.VESTING_TOKENS(),
    launcher.COMMUNITY(),
    launcher.COMMUNITY_TOKENS(),
  ])) as [string, bigint, string, bigint];
  const [walletLimit, state] = await Promise.all([
    new Contract(token, TOKEN_LIMIT_ABI, provider).walletLimit() as Promise<bigint>,
    readPoolStatus(provider, pool, token, weth),
  ]);
  // Simulation de collectFees : le gestionnaire de positions met les frais à jour avant de les verser.
  let pendingFees: LaunchStatus["pendingFees"];
  try {
    const [amount0, amount1] = (await launcher.collectFees.staticCall()) as [bigint, bigint];
    pendingFees = state.tokenIsToken0 ? { tokens: amount0, weth: amount1 } : { tokens: amount1, weth: amount0 };
  } catch {
    pendingFees = undefined;
  }
  return {
    launcher: getAddress(launcherAddress),
    token: getAddress(token),
    pool: getAddress(pool),
    weth: getAddress(weth),
    positionManager: getAddress(positionManager),
    positionId,
    poolTokens,
    openAt,
    startTick,
    feeRecipient: getAddress(feeRecipient),
    vesting: getAddress(vesting),
    vestingTokens,
    community: getAddress(community),
    communityTokens,
    walletLimit,
    state,
    pendingFees,
  };
}

/** Solde d'un token pour une adresse. */
export async function tokenBalance(provider: Provider, token: string, holder: string): Promise<bigint> {
  return (await new Contract(token, ERC20_ABI, provider).balanceOf(holder)) as bigint;
}
