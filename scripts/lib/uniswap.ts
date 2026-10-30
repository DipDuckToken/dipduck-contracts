import { Contract, type ContractRunner, type ContractTransactionResponse, Interface, type Provider, ZeroAddress, getAddress } from "ethers";

import { UNIT } from "./constants.ts";
import { LaunchError } from "./errors.ts";
import type { UniswapV3Deployment } from "./networks.ts";

/** Niveau de frais du pool du lancement (1 %) et son espacement de ticks. */
export const POOL_FEE = 10_000;
export const TICK_SPACING = 200;

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

export const V3_FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
  "function feeAmountTickSpacing(uint24 fee) view returns (int24)",
] as const;

export const V3_POSITION_MANAGER_ABI = [
  "function factory() view returns (address)",
  "function WETH9() view returns (address)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
] as const;

export const V3_POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function token0() view returns (address)",
  "function liquidity() view returns (uint128)",
] as const;

/** SwapRouter02 (mainnet) : exactInputSingle SANS date limite. */
const SWAP_ROUTER02_ABI = [
  "function factory() view returns (address)",
  "function WETH9() view returns (address)",
  "function factoryV2() view returns (address)",
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
] as const;

/** SwapRouter d'origine (réseau de test local) : exactInputSingle AVEC date limite. */
const SWAP_ROUTER_V1_ABI = [
  "function factory() view returns (address)",
  "function WETH9() view returns (address)",
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
] as const;

export const QUOTER_V2_ABI = [
  "function factory() view returns (address)",
  "function WETH9() view returns (address)",
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
] as const;

/**
 * Contrôle que les adresses Uniswap v3 pointent vers de vrais contrats, cohérents
 * entre eux : le gestionnaire de positions, le routeur et le quoter doivent
 * annoncer la factory et le WETH attendus, et le niveau 1 % doit exister avec un
 * espacement de 200 ticks. Une adresse erronée arrête tout avant la moindre transaction.
 */
export async function assertUniswapV3Deployment(provider: Provider, deployment: UniswapV3Deployment): Promise<void> {
  for (const [label, address] of [
    ["factory", deployment.factory],
    ["gestionnaire de positions", deployment.positionManager],
    ["routeur", deployment.swapRouter],
    ["quoter", deployment.quoter],
    ["WETH", deployment.weth],
  ] as const) {
    if ((await provider.getCode(address)) === "0x") {
      throw new LaunchError(`Aucun contrat à l'adresse ${label} ${address} sur ce réseau.`);
    }
  }
  for (const [label, address, abi] of [
    ["gestionnaire de positions", deployment.positionManager, V3_POSITION_MANAGER_ABI],
    ["routeur", deployment.swapRouter, SWAP_ROUTER_V1_ABI],
    ["quoter", deployment.quoter, QUOTER_V2_ABI],
  ] as const) {
    const contract = new Contract(address, abi, provider);
    const [factory, weth] = (await Promise.all([contract.factory(), contract.WETH9()])) as [string, string];
    if (getAddress(factory) !== getAddress(deployment.factory)) {
      throw new LaunchError(`Le ${label} ${address} annonce la factory ${factory}, attendu ${deployment.factory}.`);
    }
    if (getAddress(weth) !== getAddress(deployment.weth)) {
      throw new LaunchError(`Le ${label} ${address} annonce le WETH ${weth}, attendu ${deployment.weth}.`);
    }
  }
  const spacing = (await new Contract(deployment.factory, V3_FACTORY_ABI, provider).feeAmountTickSpacing(POOL_FEE)) as bigint;
  if (spacing !== BigInt(TICK_SPACING)) {
    throw new LaunchError(`La factory ${deployment.factory} donne un espacement de ${spacing} ticks au niveau 1 %, attendu ${TICK_SPACING}.`);
  }
}

const Q192 = 2n ** 192n;

/** Prix en wei par token entier, depuis sqrtPriceX96 (les deux côtés ont 18 décimales). */
export function priceFromSqrt(sqrtPriceX96: bigint, tokenIsToken0: boolean): bigint {
  const square = sqrtPriceX96 * sqrtPriceX96;
  if (square === 0n) return 0n;
  // token0 : sqrtP² / 2^192 = WETH par token ; token1 : c'est l'inverse.
  return tokenIsToken0 ? (square * UNIT) / Q192 : (Q192 * UNIT) / square;
}

export interface PoolStatus {
  pool: string;
  tokenIsToken0: boolean;
  /** Prix actuel, en wei par token entier. */
  priceWei: bigint;
  tick: bigint;
  /** Tokens et WETH détenus par le pool (la position du lancement et les achats). */
  tokenBalance: bigint;
  wethBalance: bigint;
}

/** État actuel du pool v3 TOKEN/WETH à 1 %. */
export async function readPoolStatus(provider: Provider, pool: string, token: string, weth: string): Promise<PoolStatus> {
  const contract = new Contract(pool, V3_POOL_ABI, provider);
  const [slot0, token0, tokenBalance, wethBalance] = (await Promise.all([
    contract.slot0(),
    contract.token0(),
    new Contract(token, ERC20_ABI, provider).balanceOf(pool),
    new Contract(weth, ERC20_ABI, provider).balanceOf(pool),
  ])) as [[bigint, bigint], string, bigint, bigint];
  const tokenIsToken0 = getAddress(token0) === getAddress(token);
  return {
    pool: getAddress(pool),
    tokenIsToken0,
    priceWei: priceFromSqrt(slot0[0], tokenIsToken0),
    tick: slot0[1],
    tokenBalance,
    wethBalance,
  };
}

/** Achats et reventes sur le pool à 1 %, quel que soit le routeur (SwapRouter02 ou d'origine). */
export interface Swapper {
  /** Tokens qu'un achat de `ethIn` rapporterait (QuoterV2, frais compris). */
  quoteBuy(token: string, ethIn: bigint): Promise<bigint>;
  /** ETH qu'une revente de `amount` rapporterait. */
  quoteSell(token: string, amount: bigint): Promise<bigint>;
  buy(signer: ContractRunner, token: string, ethIn: bigint, minOut: bigint): Promise<ContractTransactionResponse>;
  /** Revente contre de l'ETH (le routeur reçoit le WETH puis le déballe). L'autorisation doit être donnée. */
  sell(signer: ContractRunner, token: string, amount: bigint, minEthOut: bigint): Promise<ContractTransactionResponse>;
  /** Adresse à autoriser avant une revente. */
  router: string;
}

/** Le routeur sait-il garder les fonds lui-même (SwapRouter02 : adresse 2 ; d'origine : adresse 0) ? */
const ROUTER02_SELF = "0x0000000000000000000000000000000000000002";

export async function swapperFor(provider: Provider, deployment: UniswapV3Deployment): Promise<Swapper> {
  // Seul SwapRouter02 expose factoryV2() : c'est ainsi qu'on reconnaît sa version.
  const isRouter02 = await new Contract(deployment.swapRouter, SWAP_ROUTER02_ABI, provider)
    .factoryV2()
    .then(() => true, () => false);
  const abi = isRouter02 ? SWAP_ROUTER02_ABI : SWAP_ROUTER_V1_ABI;
  const routerInterface = new Interface(abi);
  const quoter = new Contract(deployment.quoter, QUOTER_V2_ABI, provider);
  const deadline = async () => BigInt((await provider.getBlock("latest"))?.timestamp ?? Math.floor(Date.now() / 1000)) + 600n;
  const swapParams = async (tokenIn: string, tokenOut: string, recipient: string, amountIn: bigint, minOut: bigint) =>
    isRouter02
      ? { tokenIn, tokenOut, fee: POOL_FEE, recipient, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }
      : { tokenIn, tokenOut, fee: POOL_FEE, recipient, deadline: await deadline(), amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n };
  const quote = async (tokenIn: string, tokenOut: string, amountIn: bigint) => {
    const [amountOut] = (await quoter.quoteExactInputSingle.staticCall({
      tokenIn,
      tokenOut,
      amountIn,
      fee: POOL_FEE,
      sqrtPriceLimitX96: 0n,
    })) as [bigint];
    return amountOut;
  };
  const signerAddress = async (signer: ContractRunner) => {
    const address = await (signer as { getAddress?: () => Promise<string> }).getAddress?.();
    if (address === undefined) throw new LaunchError("Un compte signataire est nécessaire pour échanger.");
    return address;
  };
  return {
    router: deployment.swapRouter,
    quoteBuy: (token, ethIn) => quote(deployment.weth, token, ethIn),
    quoteSell: (token, amount) => quote(token, deployment.weth, amount),
    async buy(signer, token, ethIn, minOut) {
      const router = new Contract(deployment.swapRouter, abi, signer);
      const params = await swapParams(deployment.weth, token, await signerAddress(signer), ethIn, minOut);
      return (await router.exactInputSingle(params, { value: ethIn })) as ContractTransactionResponse;
    },
    async sell(signer, token, amount, minEthOut) {
      const router = new Contract(deployment.swapRouter, abi, signer);
      const self = isRouter02 ? ROUTER02_SELF : ZeroAddress;
      const params = await swapParams(token, deployment.weth, self, amount, minEthOut);
      const calls = [
        routerInterface.encodeFunctionData("exactInputSingle", [params]),
        routerInterface.encodeFunctionData("unwrapWETH9", [minEthOut, await signerAddress(signer)]),
      ];
      return (await router.multicall(calls)) as ContractTransactionResponse;
    },
  };
}
