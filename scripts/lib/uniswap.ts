import { Contract, ZeroAddress, getAddress, type Provider } from "ethers";

import { DEAD_ADDRESS } from "./constants.ts";
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
