import { createRequire } from "node:module";

import type { HardhatEthers } from "@nomicfoundation/hardhat-ethers/types";
import { ContractFactory, type Signer } from "ethers";

import type { UniswapV2Deployment } from "../../scripts/lib/networks.ts";

// Artefacts compilés publiés par Uniswap sur npm : même bytecode que les
// déploiements officiels (init code hash de la paire 0x96e8ac42…).
const require = createRequire(import.meta.url);

interface BuildArtifact {
  abi: unknown[];
  bytecode: string;
}

const WETH9 = require("@uniswap/v2-periphery/build/WETH9.json") as BuildArtifact;
const FACTORY = require("@uniswap/v2-core/build/UniswapV2Factory.json") as BuildArtifact;
const ROUTER = require("@uniswap/v2-periphery/build/UniswapV2Router02.json") as BuildArtifact;

function factoryFor(artifact: BuildArtifact, signer: Signer): ContractFactory {
  const bytecode = artifact.bytecode.startsWith("0x") ? artifact.bytecode : `0x${artifact.bytecode}`;
  return new ContractFactory(artifact.abi as never, bytecode, signer);
}

/** Déploie WETH9, la factory et le routeur Uniswap v2 sur le réseau local. */
export async function deployLocalUniswapV2(
  ethers: HardhatEthers,
  deployer: Signer,
): Promise<UniswapV2Deployment> {
  const [, , , , feeToSetter] = await ethers.getSigners();

  const weth = await factoryFor(WETH9, deployer).deploy();
  await weth.waitForDeployment();
  const factory = await factoryFor(FACTORY, deployer).deploy(feeToSetter.address);
  await factory.waitForDeployment();
  const router = await factoryFor(ROUTER, deployer).deploy(
    await factory.getAddress(),
    await weth.getAddress(),
  );
  await router.waitForDeployment();

  return {
    factory: await factory.getAddress(),
    router: await router.getAddress(),
    weth: await weth.getAddress(),
  };
}

export const PAIR_GRIEF_ABI = ["function sync()"] as const;
export const WETH_ABI = [
  "function deposit() payable",
  "function transfer(address to, uint256 amount) returns (bool)",
] as const;
export const FACTORY_WRITE_ABI = [
  "function createPair(address tokenA, address tokenB) returns (address pair)",
  "function getPair(address tokenA, address tokenB) view returns (address)",
] as const;
