import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LaunchError } from "./errors.ts";

/**
 * Genèse du jeu « Attrape la baisse » (DipDuckGame), partagée avec le site : baisses
 * historiques, table des temps minimaux historiques, premier jour évalué par la chaîne et
 * prix bruts des jours qui l'entourent. Mêmes règles que le constructeur : un fichier
 * refusé ici serait refusé par le contrat (InvalidGenesis), mais après avoir payé la transaction.
 */
export interface Genesis {
  /** Premier jour évalué par la chaîne (jours depuis le 2010-08-18). */
  detectFrom: number;
  dipDays: number[];
  dipBonus: number[];
  /** Temps minimal (s) au début de chaque tranche de 30 jours, jusqu'à celle de detectFrom + 13. */
  histMinSeconds: number[];
  /** Prix bruts (USD × 1e8) des jours detectFrom − 45 … detectFrom + 13 (59 valeurs). */
  recentPrices: bigint[];
}

export const GENESIS_MAX_BONUS = 10;
export const GENESIS_BUCKET_DAYS = 30;
/** Prix fournis : 45 jours avant detectFrom, 13 après, detectFrom compris. */
export const GENESIS_RECENT_BEFORE = 45;
export const GENESIS_RECENT_AFTER = 13;
export const GENESIS_RECENT_COUNT = GENESIS_RECENT_BEFORE + GENESIS_RECENT_AFTER + 1;
const UINT16_MAX = 0xffff;
const UINT64_MAX = (1n << 64n) - 1n;
/** Le contrat garde 15 jours de marge sous 2^16 pour les baisses trouvées ensuite. */
const DETECT_FROM_MAX = UINT16_MAX - 15;
/** Taille maximale du contrat de données (EIP-170) : 1 + 3 × baisses + 2 × tranches. */
const DATA_MAX_BYTES = 24576;

/** Racine du projet (là où se trouve launch.config.ts). */
const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function isInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** Nombre de tranches de la table historique : (detectFrom + 13) / 30 + 1. */
export function genesisBuckets(detectFrom: number): number {
  return Math.floor((detectFrom + GENESIS_RECENT_AFTER) / GENESIS_BUCKET_DAYS) + 1;
}

/**
 * Valide le contenu d'un fichier de genèse :
 * { "detectFrom": n, "dips": [[jour, bonus], ...], "histMinSeconds": [...], "recentPrices": [...] }.
 * Les prix sont des entiers (USD × 1e8), en chaînes décimales ou en nombres entiers sûrs.
 * Les autres clés sont ignorées.
 */
export function validateGenesis(raw: unknown, source = "le fichier de genèse"): Genesis {
  const fail = (reason: string): never => {
    throw new LaunchError(`Genèse invalide (${source}) : ${reason}. Rien n'a été envoyé.`);
  };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("un objet JSON est attendu");
  const { detectFrom, dips, histMinSeconds, recentPrices } = raw as Record<string, unknown>;
  if (!isInteger(detectFrom, GENESIS_RECENT_BEFORE, DETECT_FROM_MAX)) {
    fail(`« detectFrom » doit être un entier de ${GENESIS_RECENT_BEFORE} à ${DETECT_FROM_MAX}`);
  }
  const from = detectFrom as number;

  if (!Array.isArray(dips)) fail("« dips » doit être une liste de baisses [jour, bonus]");
  const dipDays: number[] = [];
  const dipBonus: number[] = [];
  (dips as unknown[]).forEach((dip, i) => {
    if (!Array.isArray(dip) || dip.length !== 2) fail(`la baisse n° ${i} doit être [jour, bonus]`);
    const [day, bonus] = dip as unknown[];
    if (!isInteger(day, 0, from - 1)) fail(`le jour de la baisse n° ${i} doit être un entier de 0 à detectFrom − 1 (${from - 1})`);
    if (!isInteger(bonus, 0, GENESIS_MAX_BONUS)) fail(`le bonus de la baisse n° ${i} doit être un entier de 0 à ${GENESIS_MAX_BONUS}`);
    if (i > 0 && (day as number) <= dipDays[i - 1]) fail(`les jours doivent être strictement croissants (baisse n° ${i} : ${day})`);
    dipDays.push(day as number);
    dipBonus.push(bonus as number);
  });

  const buckets = genesisBuckets(from);
  if (!Array.isArray(histMinSeconds) || histMinSeconds.length !== buckets) {
    fail(`« histMinSeconds » doit contenir ${buckets} valeurs ((detectFrom + 13) / 30 + 1)`);
  }
  const table: number[] = [];
  (histMinSeconds as unknown[]).forEach((value, k) => {
    if (!isInteger(value, 0, UINT16_MAX)) fail(`« histMinSeconds[${k}] » doit être un entier de 0 à ${UINT16_MAX}`);
    if (k > 0 && (value as number) < table[k - 1]) fail(`« histMinSeconds » doit être non décroissant (indice ${k})`);
    table.push(value as number);
  });

  if (!Array.isArray(recentPrices) || recentPrices.length !== GENESIS_RECENT_COUNT) {
    fail(`« recentPrices » doit contenir ${GENESIS_RECENT_COUNT} prix (jours detectFrom − 45 à detectFrom + 13)`);
  }
  const prices = (recentPrices as unknown[]).map((value, i): bigint => {
    let price: bigint | undefined;
    if (typeof value === "string" && /^[0-9]{1,20}$/.test(value)) price = BigInt(value);
    else if (typeof value === "number" && Number.isSafeInteger(value)) price = BigInt(value);
    if (price === undefined || price <= 0n || price > UINT64_MAX) {
      fail(`« recentPrices[${i}] » doit être un entier strictement positif (USD × 1e8) tenant sur 64 bits`);
    }
    return price as bigint;
  });

  if (1 + 3 * dipDays.length + 2 * buckets > DATA_MAX_BYTES) fail("trop de baisses pour le contrat de données (24 576 octets)");
  return { detectFrom: from, dipDays, dipBonus, histMinSeconds: table, recentPrices: prices };
}

/** Chemin absolu d'un fichier de genèse ; un chemin relatif part de la racine du projet. */
export function resolveGenesisPath(genesisFile: string): string {
  return isAbsolute(genesisFile) ? genesisFile : resolve(PROJECT_ROOT, genesisFile);
}

/** Lit et valide un fichier de genèse. */
export async function loadGenesisFile(genesisFile: string): Promise<Genesis> {
  if (genesisFile.trim() === "") throw new LaunchError("game.genesisFile est vide dans launch.config.ts.");
  const file = resolveGenesisPath(genesisFile);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new LaunchError(`Fichier de genèse introuvable : ${file}. Rien n'a été envoyé.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new LaunchError(`Le fichier de genèse ${file} n'est pas du JSON valide. Rien n'a été envoyé.`);
  }
  return validateGenesis(raw, file);
}
