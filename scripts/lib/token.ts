import type { HardhatEthers } from "@nomicfoundation/hardhat-ethers/types";
import type { Signer } from "ethers";

import type { GameRecord, NftRecord, TokenRecord, VestingRecord } from "./records.ts";
import { GAS_MARGIN_PERCENT } from "./tx.ts";
import type { TokenParams } from "./validation.ts";

/** Noms complets des contrats, utilisés aussi pour la vérification sur Blockscout. */
export const TOKEN_CONTRACT = "contracts/MemeToken.sol:MemeToken";
export const SEEDER_CONTRACT = "contracts/PoolSeeder.sol:PoolSeeder";
export const VESTING_CONTRACT = "contracts/TokenVesting.sol:TokenVesting";
export const NFT_CONTRACT = "contracts/DipDuckCards.sol:DipDuckCards";
export const GAME_CONTRACT = "contracts/DipDuckGame.sol:DipDuckGame";
/** Flux de prix d'essai (tests uniquement). */
export const MOCK_FEED_CONTRACT = "contracts/mocks/MockAggregator.sol:MockAggregator";

/**
 * Arguments du constructeur de DipDuckCards, dans l'ordre : fondateurs, communauté,
 * début du mint, base des images, page de la carte, puis noms, wallets et sites des fondations.
 */
export function nftConstructorArgs(
  nft: Pick<
    NftRecord,
    "founders" | "community" | "mintStart" | "imageBaseURI" | "viewerURI" | "candidateNames" | "candidateWallets" | "candidateUrls"
  >,
): [string, string, bigint, string, string, string[], string[], string[]] {
  return [
    nft.founders,
    nft.community,
    BigInt(nft.mintStart),
    nft.imageBaseURI,
    nft.viewerURI,
    [...nft.candidateNames],
    [...nft.candidateWallets],
    [...nft.candidateUrls],
  ];
}

/**
 * Arguments du constructeur de DipDuckGame, dans l'ordre : flux, jours des baisses, bonus,
 * temps minimaux historiques, premier jour évalué, prix récents.
 */
export function gameConstructorArgs(
  game: Pick<GameRecord, "feed" | "dipDays" | "dipBonus" | "histMinSeconds" | "detectFrom" | "recentPrices">,
): [string, number[], number[], number[], number, bigint[]] {
  return [
    game.feed,
    [...game.dipDays],
    [...game.dipBonus],
    [...game.histMinSeconds],
    game.detectFrom,
    game.recentPrices.map((price) => BigInt(price)),
  ];
}

/** Arguments du constructeur de TokenVesting, dans l'ordre : bénéficiaire, début, durée, falaise. */
export function vestingConstructorArgs(
  vesting: Pick<VestingRecord, "beneficiary" | "start" | "durationSeconds" | "cliffSeconds">,
): [string, bigint, bigint, bigint] {
  return [vesting.beneficiary, BigInt(vesting.start), BigInt(vesting.durationSeconds), BigInt(vesting.cliffSeconds)];
}

export function constructorArgs(params: TokenParams): [string, string, bigint] {
  return [params.name, params.symbol, params.supply];
}

export function paramsOf(record: TokenRecord): TokenParams {
  return { name: record.name, symbol: record.symbol, supply: BigInt(record.supplyWholeTokens) };
}

export interface DeploymentEstimate {
  gas: bigint;
  /** Coût maximal estimé, en wei : gas × maxFeePerGas, avec la marge de gas que la signature ajoutera. */
  maxCostWei: bigint;
}

export async function estimateTokenDeployment(
  ethers: HardhatEthers,
  deployer: Signer,
  params: TokenParams,
): Promise<DeploymentEstimate> {
  const factory = await ethers.getContractFactory(TOKEN_CONTRACT, deployer);
  const tx = await factory.getDeployTransaction(...constructorArgs(params));
  const gas = await ethers.provider.estimateGas({ ...tx, from: await deployer.getAddress() });
  const fees = await ethers.provider.getFeeData();
  const pricePerGas = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
  const gasLimit = gas + (gas * GAS_MARGIN_PERCENT) / 100n;
  return { gas, maxCostWei: gasLimit * pricePerGas };
}
