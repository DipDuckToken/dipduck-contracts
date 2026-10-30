import { createRequire } from "node:module";

import type { HardhatEthers } from "@nomicfoundation/hardhat-ethers/types";
import { ContractFactory, type Signer } from "ethers";

// Artefacts compilés publiés par Uniswap sur npm : même bytecode que les déploiements
// officiels (init code hash du pool 0xe34f199b…, celui que le gestionnaire de positions attend).
const require = createRequire(import.meta.url);

interface BuildArtifact {
  abi: unknown[];
  bytecode: string;
}

const WETH9 = require("@uniswap/v2-periphery/build/WETH9.json") as BuildArtifact;
const FACTORY = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json") as BuildArtifact;
const POSITION_MANAGER =
  require("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json") as BuildArtifact;
const ROUTER = require("@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json") as BuildArtifact;
const QUOTER = require("@uniswap/v3-periphery/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json") as BuildArtifact;

/** Même forme que le déploiement du mainnet (scripts), plus `router` pour les tests de contrat. */
export interface UniswapV3Local {
  factory: string;
  positionManager: string;
  router: string;
  /** Routeur d'origine (avec date limite) ; les scripts reconnaissent sa version. */
  swapRouter: string;
  quoter: string;
  weth: string;
}

function factoryFor(artifact: BuildArtifact, signer: Signer): ContractFactory {
  const bytecode = artifact.bytecode.startsWith("0x") ? artifact.bytecode : `0x${artifact.bytecode}`;
  return new ContractFactory(artifact.abi as never, bytecode, signer);
}

/** Déploie WETH9, la factory v3, le gestionnaire de positions, le routeur et le quoter sur le réseau local. */
export async function deployLocalUniswapV3(_ethers: HardhatEthers, deployer: Signer): Promise<UniswapV3Local> {
  const weth = await factoryFor(WETH9, deployer).deploy();
  await weth.waitForDeployment();
  const factory = await factoryFor(FACTORY, deployer).deploy();
  await factory.waitForDeployment();
  const wethAddress = await weth.getAddress();
  const factoryAddress = await factory.getAddress();
  // Le descripteur ne sert qu'à tokenURI : n'importe quelle adresse convient ici.
  const positionManager = await factoryFor(POSITION_MANAGER, deployer).deploy(factoryAddress, wethAddress, wethAddress);
  await positionManager.waitForDeployment();
  const router = await factoryFor(ROUTER, deployer).deploy(factoryAddress, wethAddress);
  await router.waitForDeployment();
  const quoter = await factoryFor(QUOTER, deployer).deploy(factoryAddress, wethAddress);
  await quoter.waitForDeployment();
  return {
    factory: factoryAddress,
    positionManager: await positionManager.getAddress(),
    router: await router.getAddress(),
    swapRouter: await router.getAddress(),
    quoter: await quoter.getAddress(),
    weth: wethAddress,
  };
}

export const V3_ROUTER_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
] as const;
export const V3_POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function token0() view returns (address)",
  "function liquidity() view returns (uint128)",
] as const;
export const V3_POSITION_MANAGER_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function positions(uint256 tokenId) view returns (uint96, address, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256, uint256, uint128, uint128)",
] as const;
export const V3_FACTORY_ABI = [
  "function createPool(address tokenA, address tokenB, uint24 fee) returns (address pool)",
] as const;
