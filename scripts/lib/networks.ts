import type { Provider } from "ethers";

import { LaunchError } from "./errors.ts";

export interface UniswapV2Deployment {
  factory: string;
  router: string;
  weth: string;
}

/**
 * Uniswap v2 sur Robinhood Chain (chain ID 4663).
 * Source : @uniswap/sdk-core 7.19.4 (V2_FACTORY_ADDRESSES, V2_ROUTER_ADDRESSES,
 * WETH9) ; l'adresse WETH correspond aussi à « L2 Weth » dans la doc Robinhood
 * Chain. Les scripts revérifient sur la chaîne que router.factory() et
 * router.WETH() renvoient bien ces adresses avant toute transaction.
 */
export const ROBINHOOD_UNISWAP_V2: UniswapV2Deployment = {
  factory: "0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f",
  router: "0x89e5DB8B5aA49aA85AC63f691524311AEB649eba",
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
  /** Absent quand Uniswap v2 n'est pas référencé sur le réseau (testnet). */
  uniswapV2?: UniswapV2Deployment;
}

export const NETWORK_PROFILES: Readonly<Record<string, NetworkProfile>> = {
  robinhood: {
    name: "robinhood",
    label: "Robinhood Chain — MAINNET",
    chainId: 4663n,
    isMainnet: true,
    isFork: false,
    explorerUrl: "https://robinhoodchain.blockscout.com",
    uniswapV2: ROBINHOOD_UNISWAP_V2,
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
    uniswapV2: ROBINHOOD_UNISWAP_V2,
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
