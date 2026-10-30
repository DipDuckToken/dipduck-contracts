import type { HardhatEthers } from "@nomicfoundation/hardhat-ethers/types";
import { type Signer, ZeroAddress } from "ethers";

import type { GameRecord, NftRecord, TokenRecord, VestingRecord } from "./records.ts";
import { GAS_MARGIN_PERCENT } from "./tx.ts";
import type { TokenParams } from "./validation.ts";

/** Noms complets des contrats, utilisés aussi pour la vérification sur Blockscout. */
export const TOKEN_CONTRACT = "contracts/MemeToken.sol:MemeToken";
export const CURVE_CONTRACT = "contracts/LaunchCurve.sol:LaunchCurve";
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
 * temps minimaux historiques, premier jour évalué, prix récents, flux de secours (0 = aucun).
 */
export function gameConstructorArgs(
  game: Pick<GameRecord, "feed" | "dipDays" | "dipBonus" | "histMinSeconds" | "detectFrom" | "recentPrices" | "backupFeed">,
): [string, number[], number[], number[], number, bigint[], string] {
  return [
    game.feed,
    [...game.dipDays],
    [...game.dipBonus],
    [...game.histMinSeconds],
    game.detectFrom,
    game.recentPrices.map((price) => BigInt(price)),
    game.backupFeed ?? ZeroAddress,
  ];
}

/** Paramètres de LaunchCurve.Config, dans l'ordre du contrat (montants de tokens en tokens entiers). */
export type CurveConfigTuple = [bigint, string, bigint, string, bigint, bigint, bigint, bigint, string, string];

/**
 * Arguments du constructeur de LaunchCurve : nom, symbole, puis Config (offre, blocage et sa part,
 * Safe communauté et sa réserve, ETH virtuel, cible, heure d'ouverture, factory, WETH).
 */
export function curveConstructorArgs(
  token: Pick<
    TokenRecord,
    | "name"
    | "symbol"
    | "supplyWholeTokens"
    | "vesting"
    | "vestingWholeTokens"
    | "community"
    | "communityWholeTokens"
    | "virtualEthWei"
    | "targetEthWei"
    | "openAt"
    | "factory"
    | "weth"
  >,
): [string, string, CurveConfigTuple] {
  return [
    token.name,
    token.symbol,
    [
      BigInt(token.supplyWholeTokens),
      token.vesting,
      BigInt(token.vestingWholeTokens),
      token.community,
      BigInt(token.communityWholeTokens),
      BigInt(token.virtualEthWei),
      BigInt(token.targetEthWei),
      BigInt(token.openAt),
      token.factory,
      token.weth,
    ],
  ];
}

/** Arguments du constructeur de TokenVesting, dans l'ordre : bénéficiaire, début, durée, falaise. */
export function vestingConstructorArgs(
  vesting: Pick<VestingRecord, "beneficiary" | "start" | "durationSeconds" | "cliffSeconds">,
): [string, bigint, bigint, bigint] {
  return [vesting.beneficiary, BigInt(vesting.start), BigInt(vesting.durationSeconds), BigInt(vesting.cliffSeconds)];
}

/**
 * Arguments du constructeur de MemeToken, dans l'ordre : nom, symbole, offre, factory, WETH.
 * Le token est créé par la courbe avec ces arguments : ils servent à le vérifier sur Blockscout.
 */
export function constructorArgs(params: TokenParams): [string, string, bigint, string, string] {
  return [params.name, params.symbol, params.supply, params.factory ?? ZeroAddress, params.weth ?? ZeroAddress];
}

export function paramsOf(record: TokenRecord): TokenParams {
  return {
    name: record.name,
    symbol: record.symbol,
    supply: BigInt(record.supplyWholeTokens),
    factory: record.factory,
    weth: record.weth,
  };
}

export interface DeploymentEstimate {
  gas: bigint;
  /** Coût maximal estimé, en wei : gas × maxFeePerGas, avec la marge de gas que la signature ajoutera. */
  maxCostWei: bigint;
}

/** Coût maximal estimé d'un déploiement (gas estimé + marge, au prix du gas actuel). */
export async function estimateDeployment(
  ethers: HardhatEthers,
  deployer: Signer,
  contract: string,
  args: unknown[],
): Promise<DeploymentEstimate> {
  const factory = await ethers.getContractFactory(contract, deployer);
  const tx = await factory.getDeployTransaction(...args);
  const gas = await ethers.provider.estimateGas({ ...tx, from: await deployer.getAddress() });
  const fees = await ethers.provider.getFeeData();
  const pricePerGas = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
  const gasLimit = gas + (gas * GAS_MARGIN_PERCENT) / 100n;
  return { gas, maxCostWei: gasLimit * pricePerGas };
}
