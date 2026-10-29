import { Contract, Interface, ZeroAddress, getAddress, type Provider, type TransactionReceipt } from "ethers";

import { DEAD_ADDRESS, DONATION_TOLERANCE_BPS, UNISWAP_V2_MINIMUM_LIQUIDITY } from "./constants.ts";
import { LaunchError } from "./errors.ts";
import type { UniswapV2Deployment } from "./networks.ts";

export const ROUTER_ABI = [
  "function factory() view returns (address)",
  "function WETH() view returns (address)",
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
] as const;

export const FACTORY_ABI = ["function getPair(address tokenA, address tokenB) view returns (address)"] as const;

export const PAIR_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function token0() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
] as const;

export const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
] as const;

export const SEEDER_ABI = [
  "event PoolSeeded(address indexed token, address indexed pair, address indexed seeder, uint256 tokenAmount, uint256 ethAmount, uint256 liquidityBurned)",
  "error PoolAlreadySeeded(address pair)",
  "error DonationAboveLimit(uint256 pairWeth, uint256 maxPairWeth)",
  "error ZeroAmount()",
  "function FACTORY() view returns (address)",
  "function WETH() view returns (address)",
  "function seed(address token, uint256 tokenAmount, uint256 maxPairWeth) payable returns (address pair, uint256 liquidity)",
] as const;

const pairInterface = new Interface(PAIR_ABI);
const seederInterface = new Interface(SEEDER_ABI);

/**
 * Contrôle que les adresses Uniswap pointent vers de vrais contrats et qu'elles
 * sont cohérentes entre elles : le routeur officiel doit annoncer la factory et
 * le WETH attendus. Une adresse erronée arrête tout avant la moindre transaction.
 */
export async function assertUniswapV2Deployment(
  provider: Provider,
  deployment: UniswapV2Deployment,
): Promise<void> {
  for (const [label, address] of [
    ["routeur", deployment.router],
    ["factory", deployment.factory],
    ["WETH", deployment.weth],
  ] as const) {
    if ((await provider.getCode(address)) === "0x") {
      throw new LaunchError(`Aucun contrat à l'adresse ${label} ${address} sur ce réseau.`);
    }
  }
  const router = new Contract(deployment.router, ROUTER_ABI, provider);
  const [factory, weth] = (await Promise.all([router.factory(), router.WETH()])) as [string, string];
  if (getAddress(factory) !== getAddress(deployment.factory)) {
    throw new LaunchError(
      `Le routeur ${deployment.router} annonce la factory ${factory}, attendu ${deployment.factory}.`,
    );
  }
  if (getAddress(weth) !== getAddress(deployment.weth)) {
    throw new LaunchError(
      `Le routeur ${deployment.router} annonce le WETH ${weth}, attendu ${deployment.weth}.`,
    );
  }
}

export interface PairPreview {
  pair: string;
  exists: boolean;
  lpTotalSupply: bigint;
  /** WETH et tokens présents dans la paire (dons) : ils rejoindront le pool s'ils y sont encore à l'ouverture. */
  donatedWeth: bigint;
  donatedTokens: bigint;
  /**
   * Part synchronisée de ces dons (réserves de la paire) : personne ne peut la
   * retirer avant le premier dépôt. Le reste peut être repris par n'importe qui (skim).
   */
  lockedWeth: bigint;
  lockedTokens: bigint;
}

/** État de la paire avant l'ouverture, pour l'afficher et refuser si des LP existent déjà. */
export async function previewPair(
  provider: Provider,
  deployment: UniswapV2Deployment,
  token: string,
): Promise<PairPreview> {
  const factory = new Contract(deployment.factory, FACTORY_ABI, provider);
  const pair = getAddress((await factory.getPair(token, deployment.weth)) as string);
  if (pair === ZeroAddress) {
    return { pair, exists: false, lpTotalSupply: 0n, donatedWeth: 0n, donatedTokens: 0n, lockedWeth: 0n, lockedTokens: 0n };
  }
  const pairContract = new Contract(pair, PAIR_ABI, provider);
  const [lpTotalSupply, donatedTokens, donatedWeth, token0, reserves] = (await Promise.all([
    pairContract.totalSupply(),
    new Contract(token, ERC20_ABI, provider).balanceOf(pair),
    new Contract(deployment.weth, ERC20_ABI, provider).balanceOf(pair),
    pairContract.token0(),
    pairContract.getReserves(),
  ])) as [bigint, bigint, bigint, string, [bigint, bigint, bigint]];
  const tokenIsToken0 = getAddress(token0) === getAddress(token);
  const lockedTokens = tokenIsToken0 ? reserves[0] : reserves[1];
  const lockedWeth = tokenIsToken0 ? reserves[1] : reserves[0];
  return {
    pair,
    exists: true,
    lpTotalSupply,
    donatedWeth,
    donatedTokens,
    lockedWeth: lockedWeth < donatedWeth ? lockedWeth : donatedWeth,
    lockedTokens: lockedTokens < donatedTokens ? lockedTokens : donatedTokens,
  };
}

/** WETH accepté au maximum dans la paire au moment de l'ouverture : l'existant plus la marge tolérée. */
export function maxPairWethFor(preview: PairPreview, ethAmount: bigint): bigint {
  return preview.donatedWeth + (ethAmount * DONATION_TOLERANCE_BPS) / 10_000n;
}

export interface PoolComposition {
  weth: bigint;
  tokens: bigint;
}

/** Fourchette du pool d'ouverture, pour afficher le prix attendu, le plus bas possible et le plus haut accepté. */
export interface OpeningRange {
  /** Si rien ne bouge d'ici l'ouverture. */
  expected: PoolComposition;
  /** Si les dons non verrouillés sont repris avant l'ouverture. */
  lowest: PoolComposition;
  /** Limite acceptée par le PoolSeeder (au-delà, il refuse sans rien déplacer). */
  highest: PoolComposition;
}

export function openingRange(
  plan: Pick<LiquidityPlan, "ethAmount" | "tokenAmount">,
  preview: PairPreview,
  maxPairWeth: bigint,
): OpeningRange {
  return {
    expected: { weth: plan.ethAmount + preview.donatedWeth, tokens: plan.tokenAmount + preview.donatedTokens },
    lowest: { weth: plan.ethAmount + preview.lockedWeth, tokens: plan.tokenAmount + preview.donatedTokens },
    highest: { weth: plan.ethAmount + maxPairWeth, tokens: plan.tokenAmount + preview.lockedTokens },
  };
}

export interface LiquidityPlan {
  tokenAmount: bigint;
  ethAmount: bigint;
  keptTokens: bigint;
  tokenTotalSupply: bigint;
  /** Capitalisation totale implicite au prix de départ, en wei. */
  impliedFdvWei: bigint;
}

export function buildLiquidityPlan(input: {
  deployerTokenBalance: bigint;
  tokenTotalSupply: bigint;
  tokenPercent: bigint;
  ethAmount: bigint;
}): LiquidityPlan {
  const tokenAmount = (input.deployerTokenBalance * input.tokenPercent) / 100n;
  if (tokenAmount === 0n) {
    throw new LaunchError("Aucun token à mettre dans le pool : le solde du déployeur est vide.");
  }
  if (input.ethAmount === 0n) {
    throw new LaunchError("Le montant d'ETH du pool doit être strictement positif.");
  }
  return {
    tokenAmount,
    ethAmount: input.ethAmount,
    keptTokens: input.deployerTokenBalance - tokenAmount,
    tokenTotalSupply: input.tokenTotalSupply,
    impliedFdvWei: (input.ethAmount * input.tokenTotalSupply) / tokenAmount,
  };
}

export interface SeedOutcome {
  pair: string;
  tokenAmount: bigint;
  ethAmount: bigint;
  /** Parts LP émises vers l'adresse morte par cette transaction. */
  lpBurned: bigint;
}

/**
 * Lit le résultat d'une ouverture de pool dans son reçu, et seulement là :
 * l'état actuel du pool peut avoir changé depuis (autres dépôts, frais du
 * protocole), le reçu, lui, décrit exactement ce que cette transaction a fait.
 *
 * Exige l'événement PoolSeeded du PoolSeeder pour ce token, et que toutes les
 * parts LP émises dans la transaction soient allées à l'adresse morte (plus les
 * 1000 parts que la paire verrouille à l'adresse 0).
 */
export function readSeedReceipt(receipt: TransactionReceipt, seeder: string, token: string): SeedOutcome {
  if (receipt.status !== 1) {
    throw new LaunchError(`La transaction ${receipt.hash} a échoué.`);
  }

  let seeded: SeedOutcome | undefined;
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(seeder)) continue;
    const parsed = seederInterface.parseLog({ topics: [...log.topics], data: log.data });
    if (parsed?.name === "PoolSeeded" && getAddress(parsed.args.token as string) === getAddress(token)) {
      seeded = {
        pair: getAddress(parsed.args.pair as string),
        tokenAmount: parsed.args.tokenAmount as bigint,
        ethAmount: parsed.args.ethAmount as bigint,
        lpBurned: parsed.args.liquidityBurned as bigint,
      };
    }
  }
  if (seeded === undefined) {
    throw new LaunchError(`Aucun événement PoolSeeded pour ce token dans la transaction ${receipt.hash}.`);
  }

  let toDead = 0n;
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== seeded.pair) continue;
    const parsed = pairInterface.parseLog({ topics: [...log.topics], data: log.data });
    if (parsed?.name !== "Transfer") continue;
    const to = getAddress(parsed.args.to as string);
    const value = parsed.args.value as bigint;
    if (to === getAddress(DEAD_ADDRESS)) {
      toDead += value;
    } else if (!(to === ZeroAddress && value === UNISWAP_V2_MINIMUM_LIQUIDITY)) {
      throw new LaunchError(`Des parts LP ont été envoyées à ${to} dans ${receipt.hash} : elles ne sont pas toutes brûlées.`);
    }
  }
  if (toDead === 0n || toDead !== seeded.lpBurned) {
    throw new LaunchError(`Les parts LP émises vers l'adresse morte ne correspondent pas à l'événement (${receipt.hash}).`);
  }
  return seeded;
}

export interface PoolStatus {
  pair: string;
  tokenReserve: bigint;
  wethReserve: bigint;
  lpTotalSupply: bigint;
  lpBurned: bigint;
  lpHeldBy: bigint;
}

/** État actuel du pool : réserves et part des LP détenue par l'adresse morte et l'adresse 0. */
export async function readPoolStatus(
  provider: Provider,
  deployment: UniswapV2Deployment,
  token: string,
  holder: string,
): Promise<PoolStatus | undefined> {
  const factory = new Contract(deployment.factory, FACTORY_ABI, provider);
  const pair = getAddress((await factory.getPair(token, deployment.weth)) as string);
  if (pair === ZeroAddress) {
    return undefined;
  }
  const lp = new Contract(pair, PAIR_ABI, provider);
  const [token0, reserves, lpTotalSupply, deadBalance, zeroBalance, holderBalance] = (await Promise.all([
    lp.token0(),
    lp.getReserves(),
    lp.totalSupply(),
    lp.balanceOf(DEAD_ADDRESS),
    lp.balanceOf(ZeroAddress),
    lp.balanceOf(holder),
  ])) as [string, [bigint, bigint, bigint], bigint, bigint, bigint, bigint];

  const tokenIsToken0 = getAddress(token0) === getAddress(token);
  return {
    pair,
    tokenReserve: tokenIsToken0 ? reserves[0] : reserves[1],
    wethReserve: tokenIsToken0 ? reserves[1] : reserves[0],
    lpTotalSupply,
    lpBurned: deadBalance + zeroBalance,
    lpHeldBy: holderBalance,
  };
}
