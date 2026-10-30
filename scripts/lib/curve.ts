import { Contract, type Provider, getAddress } from "ethers";

import { UNIT } from "./constants.ts";
import { LaunchError } from "./errors.ts";
import { formatDate } from "./format.ts";

/** Fonctions et événements de LaunchCurve utilisés par les scripts. */
export const CURVE_ABI = [
  "function TOKEN() view returns (address)",
  "function PAIR() view returns (address)",
  "function WETH() view returns (address)",
  "function OPEN_AT() view returns (uint256)",
  "function VIRTUAL_ETH() view returns (uint256)",
  "function VIRTUAL_TOKENS() view returns (uint256)",
  "function TARGET_ETH() view returns (uint256)",
  "function CURVE_TOKENS() view returns (uint256)",
  "function LP_TOKENS() view returns (uint256)",
  "function VESTING() view returns (address)",
  "function VESTING_TOKENS() view returns (uint256)",
  "function COMMUNITY() view returns (address)",
  "function COMMUNITY_TOKENS() view returns (uint256)",
  "function ethReserve() view returns (uint256)",
  "function tokensSold() view returns (uint256)",
  "function graduated() view returns (bool)",
  "function walletLimit() view returns (uint256)",
  "function quoteBuy(uint256 ethIn) view returns (uint256 tokensOut, uint256 ethUsed)",
  "function quoteSell(uint256 tokensIn) view returns (uint256 ethOut)",
  "function price() view returns (uint256)",
  "function buy(uint256 minTokensOut, uint256 deadline) payable returns (uint256 tokensOut)",
  "function sell(uint256 tokensIn, uint256 minEthOut, uint256 deadline) returns (uint256 ethOut)",
  "event Bought(address indexed buyer, uint256 ethIn, uint256 tokensOut, uint256 ethReserve, uint256 tokensSold)",
  "event Sold(address indexed seller, uint256 tokensIn, uint256 ethOut, uint256 ethReserve, uint256 tokensSold)",
  "event Graduated(address indexed pair, uint256 ethAmount, uint256 tokenAmount, uint256 liquidityBurned, uint256 tokensBurned)",
  "error InvalidParams()",
  "error NotOpen()",
  "error AlreadyGraduated()",
  "error Expired()",
  "error ZeroAmount()",
  "error Slippage()",
  "error TooManyTokens(uint256 max)",
  "error WalletLimit(uint256 limit)",
  "error EthTransferFailed()",
] as const;

/** Bornes du contrat : l'heure d'ouverture doit être dans le futur, à 30 jours au plus du déploiement. */
export const MAX_OPEN_DELAY_SECONDS = 30n * 86_400n;

/**
 * Sur le mainnet, l'ouverture doit laisser au moins 1 h après le déploiement :
 * le temps de vérifier les contrats sur Blockscout et d'annoncer l'heure.
 */
export const MIN_OPEN_DELAY_MAINNET_SECONDS = 3_600n;

/** Ailleurs (testnet, fork, tests) : un délai plus court suffit. */
export const MIN_OPEN_DELAY_SECONDS = 900n;

/** Heure d'ouverture par défaut hors mainnet quand curve.openAt est vide : dans 2 h. */
export const DEFAULT_OPEN_DELAY_SECONDS = 7_200n;

/** Plafond du contrat pour virtualEth et targetEth (1 million d'ETH). */
const CONTRACT_MAX_ETH = 1_000_000n * UNIT;
const UINT112_MAX = 2n ** 112n - 1n;

function ceilDiv(a: bigint, b: bigint): bigint {
  return a === 0n ? 0n : (a - 1n) / b + 1n;
}

export interface CurveReserves {
  /** Réserve de tokens virtuelle (VIRTUAL_TOKENS). */
  virtualTokens: bigint;
  /** Tokens vendus par la courbe jusqu'à la cible (CURVE_TOKENS). */
  soldTokens: bigint;
  /** Tokens mis dans le pool avec la cible, au prix de fin de courbe (LP_TOKENS). */
  lpTokens: bigint;
}

/**
 * Même calcul que le constructeur de LaunchCurve (`_reserves`), arrondis compris.
 * Rend undefined quand le contrat refuserait ces paramètres.
 */
export function curveReserves(curveAmount: bigint, virtualEthWei: bigint, targetEthWei: bigint): CurveReserves | undefined {
  if (curveAmount <= 0n || virtualEthWei <= 0n || targetEthWei <= 0n) return undefined;
  // Comme le contrat : au moins 10^6 unités de token par wei de la cible.
  if (curveAmount / targetEthWei < 1_000_000n) return undefined;
  const v = virtualEthWei;
  const e = targetEthWei;
  const virtualTokens = (curveAmount * (v + e) * (v + e)) / (e * (2n * v + e));
  const soldTokens = virtualTokens - ceilDiv(v * virtualTokens, v + e);
  const lpTokens = (e * (virtualTokens - soldTokens)) / (v + e);
  if (soldTokens === 0n || lpTokens === 0n || soldTokens + lpTokens > curveAmount || lpTokens > UINT112_MAX) {
    return undefined;
  }
  return { virtualTokens, soldTokens, lpTokens };
}

/** Tokens entiers confiés à la courbe : tokenPercent de l'offre, arrondi au token entier inférieur. */
export function curveWholeTokensFor(supplyWholeTokens: bigint, tokenPercent: bigint): bigint {
  return (supplyWholeTokens * tokenPercent) / 100n;
}

export interface SupplySplit {
  /** Vendus par la courbe puis mis dans le pool (curve.tokenPercent, arrondi inférieur). */
  curveWholeTokens: bigint;
  /** Réserve communauté, versée au Safe à l'ouverture du pool (community.percent, arrondi inférieur). */
  communityWholeTokens: bigint;
  /** Ta part, versée au contrat de blocage à l'ouverture du pool : le reste. */
  vestingWholeTokens: bigint;
}

/**
 * Répartition de l'offre, en tokens entiers : courbe + réserve + ta part = offre,
 * ta part prenant les arrondis. Tout reste dans la courbe jusqu'à l'ouverture du pool.
 */
export function splitSupply(supplyWholeTokens: bigint, tokenPercent: bigint, communityPercent: bigint): SupplySplit {
  const curveWholeTokens = curveWholeTokensFor(supplyWholeTokens, tokenPercent);
  const communityWholeTokens = (supplyWholeTokens * communityPercent) / 100n;
  return {
    curveWholeTokens,
    communityWholeTokens,
    vestingWholeTokens: supplyWholeTokens - curveWholeTokens - communityWholeTokens,
  };
}

export interface CurvePlan extends CurveReserves {
  totalSupply: bigint;
  /** Tokens confiés à la courbe (vendus + pool + arrondis brûlés à l'ouverture du pool). */
  curveAmount: bigint;
  /** Ta part et la réserve, gardées par la courbe puis versées à l'ouverture du pool. */
  vestingAmount: bigint;
  communityAmount: bigint;
  virtualEthWei: bigint;
  targetEthWei: bigint;
  /** Prix au départ et à l'ouverture du pool, en wei par token entier. */
  startPriceWei: bigint;
  endPriceWei: bigint;
  /** ETH à payer (environ) pour 0,5 % de l'offre au tout premier achat : la limite de la 1re heure. */
  halfPercentCostWei: bigint;
  /** Capitalisation (offre totale × prix) au départ et à l'ouverture du pool, en wei. */
  startFdvWei: bigint;
  poolFdvWei: bigint;
}

/** Chiffres du lancement, calculés avec les formules exactes du contrat. */
export function buildCurvePlan(input: {
  supplyWholeTokens: bigint;
  split: SupplySplit;
  virtualEthWei: bigint;
  targetEthWei: bigint;
}): CurvePlan {
  const totalSupply = input.supplyWholeTokens * UNIT;
  const curveAmount = input.split.curveWholeTokens * UNIT;
  const reserves = curveReserves(curveAmount, input.virtualEthWei, input.targetEthWei);
  if (reserves === undefined) {
    throw new LaunchError("La courbe refuserait ces paramètres (part de l'offre, virtualEth ou targetEth). Rien n'a été envoyé.");
  }
  const v = input.virtualEthWei;
  const e = input.targetEthWei;
  const y = reserves.virtualTokens;
  const endY = y - reserves.soldTokens;
  // Achat de t tokens au départ : ethIn tel que y − ceil(v·y / (v + ethIn)) = t.
  const t = totalSupply / 200n;
  const halfPercentCostWei = t >= reserves.soldTokens ? e : ceilDiv(v * y, y - t) - v;
  return {
    ...reserves,
    totalSupply,
    curveAmount,
    vestingAmount: input.split.vestingWholeTokens * UNIT,
    communityAmount: input.split.communityWholeTokens * UNIT,
    virtualEthWei: v,
    targetEthWei: e,
    startPriceWei: (v * UNIT) / y,
    endPriceWei: ((v + e) * UNIT) / endY,
    halfPercentCostWei,
    startFdvWei: (v * totalSupply) / y,
    poolFdvWei: ((v + e) * totalSupply) / endY,
  };
}

/** Vérifie les bornes du contrat sur virtualEth et targetEth (en plus des bornes « raisonnables » de la config). */
export function withinContractBounds(virtualEthWei: bigint, targetEthWei: bigint): boolean {
  return virtualEthWei > 0n && targetEthWei > 0n && virtualEthWei <= CONTRACT_MAX_ETH && targetEthWei <= CONTRACT_MAX_ETH;
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

export interface CurveStatus {
  curve: string;
  token: string;
  pair: string;
  openAt: bigint;
  virtualEth: bigint;
  virtualTokens: bigint;
  targetEth: bigint;
  curveTokens: bigint;
  lpTokens: bigint;
  vesting: string;
  vestingTokens: bigint;
  community: string;
  communityTokens: bigint;
  ethReserve: bigint;
  tokensSold: bigint;
  graduated: boolean;
  /** Prix marginal actuel, en wei par token entier. */
  price: bigint;
  /** 0 avant l'ouverture, 2^256 − 1 quand il n'y a plus de limite. */
  walletLimit: bigint;
}

/** État de la courbe, lu sur la chaîne. */
export async function readCurveStatus(provider: Provider, curveAddress: string): Promise<CurveStatus> {
  const curve = new Contract(curveAddress, CURVE_ABI, provider);
  const [vesting, vestingTokens, community, communityTokens] = (await Promise.all([
    curve.VESTING(),
    curve.VESTING_TOKENS(),
    curve.COMMUNITY(),
    curve.COMMUNITY_TOKENS(),
  ])) as [string, bigint, string, bigint];
  const [token, pair, openAt, virtualEth, virtualTokens, targetEth, curveTokens, lpTokens, ethReserve, tokensSold, graduated, price, walletLimit] =
    (await Promise.all([
      curve.TOKEN(),
      curve.PAIR(),
      curve.OPEN_AT(),
      curve.VIRTUAL_ETH(),
      curve.VIRTUAL_TOKENS(),
      curve.TARGET_ETH(),
      curve.CURVE_TOKENS(),
      curve.LP_TOKENS(),
      curve.ethReserve(),
      curve.tokensSold(),
      curve.graduated(),
      curve.price(),
      curve.walletLimit(),
    ])) as [string, string, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, boolean, bigint, bigint];
  return {
    curve: getAddress(curveAddress),
    token: getAddress(token),
    pair: getAddress(pair),
    openAt,
    virtualEth,
    virtualTokens,
    targetEth,
    curveTokens,
    lpTokens,
    vesting: getAddress(vesting),
    vestingTokens,
    community: getAddress(community),
    communityTokens,
    ethReserve,
    tokensSold,
    graduated,
    price,
    walletLimit,
  };
}
