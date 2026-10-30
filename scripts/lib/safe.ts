import { Contract, type Provider, getAddress, zeroPadValue } from "ethers";

import { LaunchError } from "./errors.ts";

/** Versions officielles de Safe{Wallet} acceptées pour le contrat de base (singleton). */
export const SAFE_VERSIONS = ["1.3.0", "1.4.1", "1.5.0"] as const;

/** Réserve communauté : au moins 2 signatures exigées, sur au moins 3 propriétaires. */
export const SAFE_MIN_THRESHOLD = 2n;
export const SAFE_MIN_OWNERS = 3;

const SAFE_ABI = [
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)",
] as const;
/** Premier élément de la liste des modules d'un Safe. */
const SENTINEL = "0x0000000000000000000000000000000000000001";
/** Emplacement du garde de transactions : keccak256("guard_manager.guard.address"). */
const GUARD_SLOT = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";
const SINGLETON_ABI = ["function VERSION() view returns (string)"] as const;

export interface SafeInfo {
  address: string;
  version: string;
  threshold: bigint;
  owners: string[];
}

/**
 * Vérifie sur la chaîne que `address` est un vrai Safe : un proxy Safe dont le
 * contrat de base (lu dans l'emplacement 0, comme le fait le proxy officiel)
 * annonce une version officielle, avec au moins 2 signatures sur 3 propriétaires,
 * sans module ni garde (un module peut envoyer sans les signatures des propriétaires),
 * et dont le wallet de déploiement n'est PAS propriétaire (sa clé est sur un PC
 * connecté : elle ne doit jamais suffire, même en partie, à vider la réserve).
 */
export async function assertSafe(provider: Provider, address: string, deployer: string, label: string): Promise<SafeInfo> {
  const fail = (reason: string): never => {
    throw new LaunchError(
      `${label} ${address} n'est pas un Safe valide : ${reason}. Crée-le sur app.safe.global (réseau Robinhood Chain), ` +
        `${SAFE_MIN_THRESHOLD} signatures sur ${SAFE_MIN_OWNERS} propriétaires, puis recopie son adresse. Rien n'a été envoyé.`,
    );
  };
  if ((await provider.getCode(address)) === "0x") fail("aucun contrat à cette adresse");

  const slot0 = await provider.getStorage(address, 0n);
  const singleton = getAddress(`0x${slot0.slice(-40)}`);
  if (zeroPadValue(singleton, 32).toLowerCase() !== slot0.toLowerCase() || (await provider.getCode(singleton)) === "0x") {
    fail("ce n'est pas un proxy Safe");
  }
  const version = (await new Contract(singleton, SINGLETON_ABI, provider).VERSION().catch(() => "")) as string;
  if (!(SAFE_VERSIONS as readonly string[]).includes(version)) {
    fail(`version du contrat Safe inconnue (« ${version || "aucune"} »)`);
  }

  const safe = new Contract(address, SAFE_ABI, provider);
  const [threshold, rawOwners] = (await Promise.all([safe.getThreshold(), safe.getOwners()]).catch(() =>
    fail("impossible de lire ses propriétaires"),
  )) as [bigint, string[]];
  const owners = rawOwners.map((owner) => getAddress(owner));
  if (threshold < SAFE_MIN_THRESHOLD) fail(`${threshold} signature(s) suffi(sen)t, il en faut au moins ${SAFE_MIN_THRESHOLD}`);
  if (owners.length < SAFE_MIN_OWNERS) fail(`${owners.length} propriétaire(s), il en faut au moins ${SAFE_MIN_OWNERS}`);
  if (owners.includes(getAddress(deployer))) fail("le wallet de déploiement en est propriétaire");
  const [modules] = (await safe.getModulesPaginated(SENTINEL, 1n).catch(() =>
    fail("impossible de lire ses modules"),
  )) as [string[], string];
  if (modules.length > 0) fail(`un module est activé (${modules[0]}) : il pourrait envoyer sans les signatures`);
  if (BigInt(await provider.getStorage(address, GUARD_SLOT)) !== 0n) fail("un garde de transactions est installé");
  return { address: getAddress(address), version, threshold, owners };
}
