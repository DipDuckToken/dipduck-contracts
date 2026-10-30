import type { Provider } from "ethers";

import { LaunchError } from "./errors.ts";

export interface UniswapV3Deployment {
  factory: string;
  /** NonfungiblePositionManager : il crée la position du lancement. */
  positionManager: string;
  /** Routeur d'échange (SwapRouter02 sur le mainnet) : achats et reventes de la répétition. */
  swapRouter: string;
  /** QuoterV2 : montant exact d'un échange avant de l'envoyer. */
  quoter: string;
  weth: string;
}

/**
 * Uniswap v3 sur Robinhood Chain (chain ID 4663), adresses officielles. Les scripts
 * revérifient sur la chaîne, avant toute transaction, que le gestionnaire de
 * positions, le routeur et le quoter annoncent bien cette factory et ce WETH, et
 * que le niveau de frais 1 % a un espacement de 200 ticks.
 */
export const ROBINHOOD_UNISWAP_V3: UniswapV3Deployment = {
  factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
  positionManager: "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3",
  swapRouter: "0xCaf681a66D020601342297493863E78C959E5cb2",
  quoter: "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
};

export interface NetworkProfile {
  name: string;
  label: string;
  /** Chain ID attendu ; absent pour le fork local. */
  chainId?: bigint;
  isMainnet: boolean;
  isFork: boolean;
  explorerUrl?: string;
  /** Absent quand Uniswap v3 n'est pas référencé sur le réseau (testnet). */
  uniswapV3?: UniswapV3Deployment;
}

export const NETWORK_PROFILES: Readonly<Record<string, NetworkProfile>> = {
  robinhood: {
    name: "robinhood",
    label: "Robinhood Chain — MAINNET",
    chainId: 4663n,
    isMainnet: true,
    isFork: false,
    explorerUrl: "https://robinhoodchain.blockscout.com",
    uniswapV3: ROBINHOOD_UNISWAP_V3,
  },
  robinhoodTestnet: {
    name: "robinhoodTestnet",
    label: "Robinhood Chain Testnet",
    chainId: 46630n,
    isMainnet: false,
    isFork: false,
    explorerUrl: "https://explorer.testnet.chain.robinhood.com",
  },
  robinhoodFork: {
    name: "robinhoodFork",
    label: "Fork local du mainnet (simulation, rien n'est envoyé)",
    isMainnet: false,
    isFork: true,
    uniswapV3: ROBINHOOD_UNISWAP_V3,
  },
};

/**
 * Vérifie que le script tourne sur un réseau autorisé et que le RPC répond
 * avec le bon chain ID (une URL qui pointe vers la mauvaise chaîne est refusée).
 */
export async function resolveNetworkProfile(
  networkName: string,
  provider: Provider,
  allowed: readonly string[],
): Promise<NetworkProfile> {
  if (!allowed.includes(networkName)) {
    throw new LaunchError(
      `Ce script doit tourner sur ${allowed.map((n) => `--network ${n}`).join(" ou ")} ` +
        `(réseau reçu : "${networkName}").`,
    );
  }
  const profile = NETWORK_PROFILES[networkName];
  if (profile === undefined) {
    throw new LaunchError(`Réseau "${networkName}" inconnu des scripts de lancement.`);
  }
  if (profile.chainId !== undefined) {
    const { chainId } = await provider.getNetwork();
    if (chainId !== profile.chainId) {
      throw new LaunchError(
        `Le RPC de "${networkName}" répond avec le chain ID ${chainId}, attendu ${profile.chainId}. ` +
          "Vérifie l'URL RPC enregistrée dans le keystore.",
      );
    }
  }
  return profile;
}

export function explorerLink(
  profile: NetworkProfile,
  kind: "address" | "tx" | "token",
  value: string,
): string | undefined {
  return profile.explorerUrl === undefined ? undefined : `${profile.explorerUrl}/${kind}/${value}`;
}
