import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { LaunchError } from "./errors.ts";

/** Rend le rename durable. Windows ne permet pas d'ouvrir un dossier : NTFS journalise déjà le rename. */
async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Journal du lancement : un fichier JSON par réseau dans deployments/. */
export const DEPLOYMENTS_DIR = path.resolve(import.meta.dirname, "..", "..", "deployments");

/**
 * Une transaction journalisée. Elle est signée localement puis notée — hash et
 * octets signés compris — AVANT d'être diffusée. Tant que le statut est
 * "pending", une relance cherche son reçu par hash et, s'il est introuvable,
 * rediffuse exactement les mêmes octets : jamais une seconde transaction.
 */
export interface JournaledTx {
  status: "pending" | "confirmed";
  from: string;
  nonce: number;
  /** Hash de la version signée en cours, connu avant toute diffusion. */
  txHash: string;
  /** Transaction signée, rediffusable telle quelle lors d'une reprise. */
  rawTx: string;
  /** Versions précédentes (même nonce) re-signées avec des frais à jour. */
  replacedTxHashes?: string[];
  preparedAt: string;
  blockNumber?: number;
  confirmedAt?: string;
}

/**
 * Déploiement du lanceur (LaunchPool), qui crée le token (CREATE2), verse ta part
 * et la réserve, puis crée le pool Uniswap v3 et y place tout le reste.
 */
export interface TokenRecord extends JournaledTx {
  /** Adresse du TOKEN (CREATE2 : lanceur + sel + code), connue avant diffusion. */
  address: string;
  name: string;
  symbol: string;
  supplyWholeTokens: string;
  /** Gestionnaire de positions Uniswap v3, et la factory et le WETH qu'il annonce. */
  positionManager: string;
  factory: string;
  weth: string;
  /** Adresse du lanceur (CREATE : déployeur + nonce), connue avant diffusion. */
  launcher: string;
  /** Sel CREATE2 du token, tiré au hasard au moment de signer. */
  salt: string;
  /** Contrat de blocage qui reçoit ta part au déploiement (adresse 0 = aucun). */
  vesting: string;
  vestingWholeTokens: string;
  /** Safe communauté qui reçoit la réserve au déploiement (adresse 0 = aucune). */
  community: string;
  communityWholeTokens: string;
  /** Reçoit les frais d'échange de la position (le Safe communauté). */
  feeRecipient: string;
  /** Prix de départ en tick « WETH par token », multiple de 200. */
  startTick: number;
  /** Horodatage Unix (s) de l'ouverture des échanges. */
  openAt: string;
  /** Pool Uniswap v3 et numéro de la position, lus après confirmation. */
  pool?: string;
  positionId?: string;
}

/**
 * Contrat de vesting qui reçoit ta part. Déployé AVANT le lanceur (il ne dépend
 * pas du token) : le lanceur lui verse la part dès son déploiement.
 */
export interface VestingRecord extends JournaledTx {
  address: string;
  beneficiary: string;
  /** Arguments du constructeur : début (horodatage Unix = ouverture des échanges), durée et falaise en secondes. */
  start: string;
  durationSeconds: string;
  cliffSeconds: string;
}

/** Contrat des cartes NFT Dip Duck (déployé après le lancement du token). */
export interface NftRecord extends JournaledTx {
  address: string;
  founders: string;
  community: string;
  /** Horodatage Unix (s) du début du mint, et donc de la première période de 30 jours. */
  mintStart: string;
  imageBaseURI: string;
  viewerURI: string;
  candidateNames: string[];
  candidateWallets: string[];
  candidateUrls: string[];
}

/** Jeu « Attrape la baisse » (DipDuckGame), arguments du constructeur inclus. */
export interface GameRecord extends JournaledTx {
  address: string;
  /** Flux Chainlink BTC/USD (8 décimales). */
  feed: string;
  /** Flux BTC/USD de secours (adresse 0 = aucun) ; absent dans un ancien journal = aucun. */
  backupFeed?: string;
  detectFrom: number;
  dipDays: number[];
  dipBonus: number[];
  histMinSeconds: number[];
  /** Prix bruts (USD × 1e8) des jours detectFrom − 45 … detectFrom + 13, en chaînes décimales. */
  recentPrices: string[];
}

export interface LaunchRecord {
  network: string;
  chainId: string;
  /**
   * Prochain nonce minimal du wallet d'après les reçus déjà vus — transactions
   * en échec comprises. Jamais diminué, même quand une étape
   * revient en arrière : un RPC en retard ne peut pas faire réutiliser un nonce.
   */
  nonceFloor?: number;
  token?: TokenRecord;
  vesting?: VestingRecord;
  nft?: NftRecord;
  game?: GameRecord;
}

/** Où lire et écrire le journal : un fichier pour les vrais réseaux, la mémoire pour les simulations. */
export interface Journal {
  readonly location: string;
  read(): Promise<LaunchRecord | undefined>;
  write(record: LaunchRecord): Promise<void>;
}

export function recordPath(networkName: string): string {
  return path.join(DEPLOYMENTS_DIR, `${networkName}.json`);
}

export function fileJournal(networkName: string, directory: string = DEPLOYMENTS_DIR): Journal {
  const file = path.join(directory, `${networkName}.json`);
  return {
    location: file,
    async read() {
      try {
        return JSON.parse(await readFile(file, "utf8")) as LaunchRecord;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    },
    async write(record) {
      // Écriture atomique : un arrêt brutal ne laisse jamais un JSON tronqué.
      await mkdir(directory, { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      // fsync avant le rename : après une coupure de courant, le journal ne peut pas
      // revenir à une version qui ignore une transaction déjà diffusée.
      const handle = await open(temporary, "w");
      try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, file);
      await syncDirectory(directory);
    },
  };
}

export function memoryJournal(label = "journal en mémoire"): Journal {
  let current: LaunchRecord | undefined;
  return {
    location: label,
    async read() {
      return current === undefined ? undefined : (structuredClone(current) as LaunchRecord);
    },
    async write(record) {
      current = structuredClone(record) as LaunchRecord;
    },
  };
}

interface LockHolder {
  pid: number;
  startedAt: string;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Empêche deux lancements simultanés sur le même réseau (deux terminaux, par
 * exemple) : chacun pourrait sinon signer sa propre transaction. Rend la
 * fonction qui libère le verrou. Un verrou laissé par un processus disparu
 * (arrêt brutal) est repris automatiquement.
 */
export async function acquireLock(networkName: string, directory: string = DEPLOYMENTS_DIR): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${networkName}.lock`);
  const holder: LockHolder = { pid: process.pid, startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await writeFile(file, `${JSON.stringify(holder)}\n`, { flag: "wx" });
      return async () => {
        await rm(file, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let text: string;
    let modifiedAt: number;
    try {
      [text, modifiedAt] = await Promise.all([readFile(file, "utf8"), stat(file).then((info) => info.mtimeMs)]);
    } catch (error) {
      // Libéré entre-temps par son détenteur : on retente.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    let current: LockHolder | undefined;
    try {
      current = JSON.parse(text) as LockHolder;
    } catch {
      current = undefined;
    }
    // Illisible : un autre lancement est peut-être en train de l'écrire, sauf s'il date.
    const held =
      current !== undefined && Number.isInteger(current.pid) ? isAlive(current.pid) : Date.now() - modifiedAt < 60_000;
    if (held) {
      const who = current === undefined ? "verrou en cours d'écriture" : `processus ${current.pid}, depuis ${current.startedAt}`;
      throw new LaunchError(
        `Un autre lancement est en cours sur ce réseau (${who}).\n` +
          `  Attends qu'il se termine. Si aucun autre terminal ne l'exécute, supprime ${file} puis relance.`,
      );
    }
    await rm(file, { force: true });
  }
  throw new LaunchError(`Impossible de prendre le verrou ${file}. Rien n'a été envoyé.`);
}
