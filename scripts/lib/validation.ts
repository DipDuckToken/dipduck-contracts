import { ZeroAddress, getAddress, parseEther } from "ethers";

import { DEAD_ADDRESS, MAX_WHOLE_TOKENS, UNIT } from "./constants.ts";
import {
  DEFAULT_OPEN_DELAY_SECONDS,
  MAX_OPEN_DELAY_SECONDS,
  MIN_OPEN_DELAY_MAINNET_SECONDS,
  MIN_OPEN_DELAY_SECONDS,
  curveReserves,
  curveWholeTokensFor,
  formatOpenAt,
} from "./curve.ts";
import { LaunchError } from "./errors.ts";

export interface TokenParams {
  name: string;
  symbol: string;
  /** Offre en tokens entiers. */
  supply: bigint;
  /**
   * Factory et WETH Uniswap v2 : le token crée sa paire au déploiement et y attache
   * la limite anti-bot des 24 premières heures. Absents = pas de paire, pas de limite
   * (testnet sans Uniswap, tests).
   */
  factory?: string;
  weth?: string;
}

/** Section `curve` de launch.config.ts. */
export interface CurveParams {
  /** Part de l'offre confiée à la courbe (vendue + pool), en %. */
  tokenPercent: number;
  /** Réserve d'ETH virtuelle, en ETH (ex. "2"). */
  virtualEth: string;
  /** ETH à réunir pour ouvrir le pool, en ETH (ex. "3"). */
  targetEth: string;
  /** Heure d'ouverture des achats, date ISO en UTC ; vide = dans 2 h (hors mainnet seulement). */
  openAt: string;
}

export interface ValidatedCurve {
  tokenPercent: bigint;
  /** Tokens entiers confiés à la courbe : tokenPercent de l'offre, arrondi inférieur. */
  curveWholeTokens: bigint;
  virtualEthWei: bigint;
  targetEthWei: bigint;
  /** Horodatage Unix (s) de l'ouverture des achats. */
  openAt: bigint;
}

/** Bornes « raisonnables » de la config (le contrat accepte plus large) : une faute de frappe ne passe pas. */
const MIN_CURVE_ETH = parseEther("0.01");
const MAX_VIRTUAL_ETH = parseEther("1000");
const MAX_TARGET_ETH = parseEther("10000");

export interface VestingParams {
  enabled: boolean;
  /** Durée totale du blocage, en jours. */
  durationDays: number;
  /** Falaise : rien n'est libérable avant ce délai, en jours. */
  cliffDays: number;
  /** Adresse qui reçoit les tokens libérés ; vide = le wallet de déploiement. */
  beneficiary: string;
}

export interface CommunityParams {
  /** Réserve communauté, en % de l'offre. */
  percent: number;
  /** Wallet dédié qui la reçoit. */
  beneficiary: string;
}

export interface ValidatedCommunity {
  percent: bigint;
  /** Absent quand percent vaut 0. */
  beneficiary?: string;
}

export interface ValidatedVesting {
  enabled: boolean;
  durationSeconds: bigint;
  cliffSeconds: bigint;
  beneficiary: string;
}

const DAY_SECONDS = 86_400n;
const MAX_VESTING_DAYS = 3650;

const PLACEHOLDER_NAME = "CHANGE ME";
const PLACEHOLDER_SYMBOL = "CHANGEME";

// Lettres (accents compris), chiffres, espaces et ponctuation courante.
const NAME_PATTERN = /^[\p{L}\p{N} .,'&!?-]{1,40}$/u;
const SYMBOL_PATTERN = /^[A-Z0-9]{2,11}$/;

/** Minuscules, chiffres « 0 » lus comme « o », tout le reste retiré. */
function normalizeForBrandCheck(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/0/g, "o")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Les conditions de Robinhood Chain (section 5.7 et 5.11) interdisent ses
 * marques, ou toute marque qui y ressemble, dans un nom ou un ticker de token,
 * ainsi que toute référence à $HOOD.
 */
export function containsRobinhoodMark(value: string): boolean {
  return normalizeForBrandCheck(value).includes("hood");
}

export function isPlaceholder(params: TokenParams): boolean {
  return params.name === PLACEHOLDER_NAME || params.symbol === PLACEHOLDER_SYMBOL;
}

export function validateTokenParams(
  params: TokenParams,
  options: { allowPlaceholder: boolean },
): void {
  const problems: string[] = [];

  if (params.name !== params.name.trim()) {
    problems.push("le nom commence ou finit par un espace");
  }
  if (!NAME_PATTERN.test(params.name)) {
    problems.push(
      "le nom doit faire 1 à 40 caractères (lettres, chiffres, espaces, . , ' & ! ? -)",
    );
  }
  if (!SYMBOL_PATTERN.test(params.symbol)) {
    problems.push("le symbole doit faire 2 à 11 caractères, en majuscules et chiffres seulement");
  }
  if (params.supply < 1n || params.supply > MAX_WHOLE_TOKENS) {
    problems.push(
      `l'offre doit être comprise entre 1 et ${MAX_WHOLE_TOKENS} tokens ` +
        "(borne uint112 des réserves Uniswap v2)",
    );
  }
  if (containsRobinhoodMark(params.name) || containsRobinhoodMark(params.symbol)) {
    problems.push(
      "le nom ou le symbole contient « hood » : les conditions de Robinhood Chain interdisent " +
        "leurs marques (ou une marque qui y ressemble) dans un nom ou un ticker de token, " +
        "et toute référence à $HOOD",
    );
  }
  if (!options.allowPlaceholder && isPlaceholder(params)) {
    problems.push("remplace le nom et le symbole d'exemple dans launch.config.ts");
  }

  if (problems.length > 0) {
    throw new LaunchError(`Paramètres du token invalides :\n  - ${problems.join("\n  - ")}`);
  }
}

/** Date ISO avec fuseau (« Z » ou « +02:00 ») → horodatage Unix en secondes, ou undefined si invalide. */
export function parseIsoDate(value: string): bigint | undefined {
  const text = value.trim();
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed) || !/^\d{4}-\d{2}-\d{2}T/.test(text) || !/(Z|[+-]\d{2}:\d{2})$/.test(text)) return undefined;
  return BigInt(Math.floor(parsed / 1000));
}

function parseEthAmount(label: string, value: string, problems: string[]): bigint | undefined {
  try {
    return parseEther(value.trim());
  } catch {
    problems.push(`${label} invalide : "${value}" (attendu un nombre en ETH, ex. "2" ou "0.5")`);
    return undefined;
  }
}

/**
 * Paramètres de la courbe de lancement. `now` est l'heure du dernier bloc :
 * l'ouverture doit être dans le futur (au moins 1 h sur le mainnet, pour
 * bloquer ta part et annoncer l'heure), à 30 jours au plus, comme l'exige le contrat.
 */
export function validateCurveParams(
  params: CurveParams,
  options: { supplyWholeTokens: bigint; now: bigint; isMainnet: boolean },
): ValidatedCurve {
  const problems: string[] = [];
  const { now, isMainnet } = options;

  if (!Number.isInteger(params.tokenPercent) || params.tokenPercent < 1 || params.tokenPercent > 100) {
    problems.push("curve.tokenPercent doit être un nombre entier entre 1 et 100");
  }
  const virtualEthWei = parseEthAmount("curve.virtualEth", params.virtualEth, problems);
  const targetEthWei = parseEthAmount("curve.targetEth", params.targetEth, problems);
  if (virtualEthWei !== undefined && (virtualEthWei < MIN_CURVE_ETH || virtualEthWei > MAX_VIRTUAL_ETH)) {
    problems.push("curve.virtualEth doit être compris entre 0.01 et 1000 ETH (il fixe le prix de départ)");
  }
  if (targetEthWei !== undefined && (targetEthWei < MIN_CURVE_ETH || targetEthWei > MAX_TARGET_ETH)) {
    problems.push("curve.targetEth doit être compris entre 0.01 et 10000 ETH (il part en entier dans le pool)");
  }
  const tokenPercent = BigInt(Number.isInteger(params.tokenPercent) ? params.tokenPercent : 0);
  const curveWholeTokens = curveWholeTokensFor(options.supplyWholeTokens, tokenPercent);
  if (problems.length === 0 && virtualEthWei !== undefined && targetEthWei !== undefined) {
    if (curveReserves(curveWholeTokens * UNIT, virtualEthWei, targetEthWei) === undefined) {
      problems.push("la courbe refuserait cette combinaison (offre, curve.tokenPercent, virtualEth, targetEth) : trop peu de tokens");
    }
  }

  let openAt = now + DEFAULT_OPEN_DELAY_SECONDS;
  const minDelay = isMainnet ? MIN_OPEN_DELAY_MAINNET_SECONDS : MIN_OPEN_DELAY_SECONDS;
  if (params.openAt.trim() === "") {
    if (isMainnet) {
      problems.push('curve.openAt est obligatoire sur le mainnet (date ISO en UTC, ex. "2026-12-01T20:00:00Z")');
    }
  } else {
    const parsed = parseIsoDate(params.openAt);
    if (parsed === undefined) {
      problems.push(`curve.openAt n'est pas une date ISO avec fuseau (ex. "2026-12-01T20:00:00Z") : "${params.openAt}"`);
    } else {
      openAt = parsed;
      if (parsed <= now) {
        problems.push(`curve.openAt (${formatOpenAt(parsed)}) est déjà passée`);
      } else if (parsed < now + minDelay) {
        problems.push(
          `curve.openAt (${formatOpenAt(parsed)}) est trop proche : au moins ${minDelay / 60n} minutes après maintenant, ` +
            "pour vérifier les contrats et annoncer l'heure avant l'ouverture",
        );
      } else if (parsed > now + MAX_OPEN_DELAY_SECONDS) {
        problems.push(`curve.openAt (${formatOpenAt(parsed)}) est à plus de 30 jours : le contrat le refuserait`);
      }
    }
  }

  if (problems.length > 0) {
    throw new LaunchError(`Paramètres de la courbe invalides :\n  - ${problems.join("\n  - ")}`);
  }
  return {
    tokenPercent,
    curveWholeTokens,
    virtualEthWei: virtualEthWei as bigint,
    targetEthWei: targetEthWei as bigint,
    openAt,
  };
}

/** Casse mixte (somme de contrôle EIP-55) : une faute de frappe dans l'adresse serait détectée. */
function hasChecksumCase(address: string): boolean {
  const hex = address.slice(2);
  return !/[a-fA-F]/.test(hex) || (/[a-f]/.test(hex) && /[A-F]/.test(hex));
}

/**
 * Réserve communauté : un pourcentage entier de l'offre, envoyé à un wallet
 * neuf et public. Le contrôle « pas un contrat » demande la chaîne : il est
 * fait par le script de blocage, avant tout envoi.
 */
export function validateCommunityParams(
  params: CommunityParams,
  deployer: string,
  tokenPercent: bigint,
): ValidatedCommunity {
  const problems: string[] = [];
  if (!Number.isInteger(params.percent) || params.percent < 0 || params.percent > 99) {
    problems.push("community.percent doit être un nombre entier entre 0 et 99");
  } else if (tokenPercent + BigInt(params.percent) > 100n) {
    problems.push(
      `curve.tokenPercent (${tokenPercent}) + community.percent (${params.percent}) dépasse 100 : ` +
        "la courbe et la réserve ne peuvent pas recevoir plus que l'offre",
    );
  }
  const requested = params.beneficiary.trim();
  let beneficiary: string | undefined;
  if (problems.length === 0 && params.percent > 0) {
    const advice = "utilise un Safe 2 sur 3 dédié à la communauté (app.safe.global)";
    if (requested === "") {
      problems.push(`community.beneficiary est obligatoire quand community.percent > 0 : ${advice}`);
    } else {
      try {
        beneficiary = getAddress(requested);
        if (!hasChecksumCase(requested)) {
          problems.push(
            "community.beneficiary doit être recopiée avec ses majuscules et minuscules d'origine (copie-la " +
              "depuis ton wallet) : c'est ce qui permet de détecter une faute de frappe",
          );
        } else if (beneficiary === ZeroAddress || beneficiary === getAddress(DEAD_ADDRESS)) {
          problems.push("community.beneficiary ne peut être ni l'adresse 0 ni l'adresse morte : la réserve serait perdue");
        } else if (beneficiary === getAddress(deployer)) {
          problems.push(
            `community.beneficiary ne peut pas être le wallet de déploiement : la réserve doit se voir à part ; ${advice}`,
          );
        }
      } catch {
        problems.push(`community.beneficiary n'est pas une adresse valide (ou sa casse est fausse) : "${requested}"`);
      }
    }
  }
  if (problems.length > 0) {
    throw new LaunchError(`Paramètres de la réserve communauté invalides :\n  - ${problems.join("\n  - ")}`);
  }
  return { percent: BigInt(params.percent), beneficiary: params.percent > 0 ? beneficiary : undefined };
}

/**
 * `requireSeparateWallet` (mainnet) : la part bloquée doit aller à un wallet fondateur
 * à part (Ledger), jamais au wallet de déploiement dont la clé est sur le PC.
 */
export function validateVestingParams(
  params: VestingParams,
  deployer: string,
  options: { requireSeparateWallet?: boolean } = {},
): ValidatedVesting {
  const problems: string[] = [];
  if (options.requireSeparateWallet === true && params.beneficiary.trim() === "") {
    problems.push(
      "vesting.beneficiary est obligatoire sur le mainnet : mets l'adresse de ton wallet fondateur (Ledger), " +
        "pas celle du wallet de déploiement",
    );
  }
  if (!Number.isInteger(params.durationDays) || params.durationDays < 1 || params.durationDays > MAX_VESTING_DAYS) {
    problems.push(`vesting.durationDays doit être un nombre entier de jours entre 1 et ${MAX_VESTING_DAYS}`);
  }
  // Au moins un jour : rien ne doit pouvoir sortir du contrat avant l'ouverture du pool.
  if (!Number.isInteger(params.cliffDays) || params.cliffDays < 1 || params.cliffDays > params.durationDays) {
    problems.push("vesting.cliffDays doit être un nombre entier de jours entre 1 et vesting.durationDays");
  }
  let beneficiary = getAddress(deployer);
  const requested = params.beneficiary.trim();
  if (requested !== "") {
    try {
      beneficiary = getAddress(requested);
      const checksummed = hasChecksumCase(requested);
      if (beneficiary === ZeroAddress || beneficiary === getAddress(DEAD_ADDRESS)) {
        problems.push("vesting.beneficiary ne peut être ni l'adresse 0 ni l'adresse morte : la part serait perdue");
      } else if (options.requireSeparateWallet === true && beneficiary === getAddress(deployer)) {
        problems.push("vesting.beneficiary doit être ton wallet fondateur (Ledger), pas le wallet de déploiement");
      } else if (!checksummed && beneficiary !== getAddress(deployer)) {
        // Tout en minuscules (ou majuscules), une faute de frappe passerait inaperçue.
        problems.push(
          "vesting.beneficiary doit être recopiée avec ses majuscules et minuscules d'origine (copie-la depuis " +
            "ton wallet) : c'est ce qui permet de détecter une faute de frappe. Ou laisse vide pour utiliser " +
            "le wallet de déploiement",
        );
      }
    } catch {
      problems.push(`vesting.beneficiary n'est pas une adresse valide (ou sa casse est fausse) : "${requested}"`);
    }
  }
  if (problems.length > 0) {
    throw new LaunchError(`Paramètres du blocage invalides :\n  - ${problems.join("\n  - ")}`);
  }
  return {
    enabled: params.enabled,
    durationSeconds: BigInt(params.durationDays) * DAY_SECONDS,
    cliffSeconds: BigInt(params.cliffDays) * DAY_SECONDS,
    beneficiary,
  };
}

export interface NftCharity {
  name: string;
  address: string;
  /** Site de la fondation (facultatif), https. */
  url?: string;
}

export interface NftParams {
  /** Début du mint, date ISO en UTC (ex. "2026-12-01T20:00:00Z"). Vide = maintenant (testnet seulement). */
  mintStart: string;
  /** Wallet fondateur (Ledger) ; vide = le wallet de déploiement, testnet seulement. */
  founders: string;
  /** 2 à 5 fondations candidates au départ ; les détenteurs en proposent d'autres ensuite. */
  charities: readonly NftCharity[];
  /** Adresse publique des images : <imageBaseURI><numéro>.png */
  imageBaseURI: string;
  /** Page qui affiche une carte : <viewerURI>?id=<numéro> */
  viewerURI: string;
}

export interface ValidatedNft {
  founders: string;
  community: string;
  mintStart: bigint;
  imageBaseURI: string;
  viewerURI: string;
  candidateNames: string[];
  candidateWallets: string[];
  candidateUrls: string[];
}
const CHARITY_NAME_PATTERN = /^[\p{L}\p{N} .,'&()-]{1,40}$/u;

/** Adresse obligatoire, avec sa casse d'origine, ni 0 ni l'adresse morte. */
function checkedAddress(label: string, value: string, problems: string[]): string | undefined {
  try {
    const address = getAddress(value.trim());
    if (!hasChecksumCase(value.trim())) {
      problems.push(`${label} doit être recopiée avec ses majuscules et minuscules d'origine`);
    } else if (address === ZeroAddress || address === getAddress(DEAD_ADDRESS)) {
      problems.push(`${label} ne peut être ni l'adresse 0 ni l'adresse morte`);
    } else {
      return address;
    }
  } catch {
    problems.push(`${label} n'est pas une adresse valide : "${value}"`);
  }
  return undefined;
}

/**
 * Paramètres des cartes NFT. Sur le mainnet, tout doit être rempli : date de
 * début, wallet communauté, fondations réelles, adresses publiques des images.
 * Sur le testnet, les valeurs vides sont remplacées par des valeurs d'essai.
 */
export function validateNftParams(
  params: NftParams,
  options: { deployer: string; community: string; isMainnet: boolean; now: bigint },
): ValidatedNft {
  const problems: string[] = [];
  const { deployer, isMainnet, now } = options;

  let mintStart = now;
  if (params.mintStart.trim() === "") {
    if (isMainnet) problems.push("nft.mintStart est obligatoire sur le mainnet (date ISO en UTC, ex. \"2026-12-01T20:00:00Z\")");
  } else {
    const parsed = Date.parse(params.mintStart);
    if (Number.isNaN(parsed) || !/(Z|[+-]\d{2}:\d{2})$/.test(params.mintStart.trim())) {
      problems.push(`nft.mintStart n'est pas une date ISO avec fuseau (ex. "2026-12-01T20:00:00Z") : "${params.mintStart}"`);
    } else {
      mintStart = BigInt(Math.floor(parsed / 1000));
    }
  }

  let founders: string | undefined;
  if (params.founders.trim() === "") {
    if (isMainnet) {
      problems.push("nft.founders est obligatoire sur le mainnet : mets l'adresse de ton wallet fondateur (Ledger)");
    } else {
      founders = getAddress(deployer);
    }
  } else {
    founders = checkedAddress("nft.founders", params.founders, problems);
    if (isMainnet && founders === getAddress(deployer)) {
      problems.push("nft.founders doit être ton wallet fondateur (Ledger), pas le wallet de déploiement");
    }
  }

  let community = options.community.trim() === "" ? "" : checkedAddress("community.beneficiary", options.community, problems);
  if (community === "") {
    if (isMainnet) {
      problems.push("community.beneficiary est obligatoire : c'est lui qui reçoit 40 % des mints et frappe la réserve");
    } else {
      community = getAddress(deployer);
    }
  }

  let charities = params.charities;
  if (charities.length === 0 && !isMainnet) {
    // Testnet sans fondations : deux adresses d'essai distinctes (le contrat refuse les doublons).
    charities = [
      { name: "Test A", address: "0x0000000000000000000000000000000000001111" },
      { name: "Test B", address: "0x0000000000000000000000000000000000002222" },
    ];
  }
  const candidateNames: string[] = [];
  const candidateWallets: string[] = [];
  const candidateUrls: string[] = [];
  if (charities.length < 2 || charities.length > 5) {
    problems.push("nft.charities doit contenir de 2 à 5 fondations { name, address }");
  } else {
    charities.forEach((charity, i) => {
      if (!CHARITY_NAME_PATTERN.test(charity.name)) {
        problems.push(`nft.charities[${i}].name doit faire 1 à 40 caractères (lettres, chiffres, espaces, . , ' & ( ) -)`);
      }
      const address = checkedAddress(`nft.charities[${i}].address`, charity.address, problems);
      const url = (charity.url ?? "").trim();
      if (url !== "" && (!/^https:\/\/[^\s"\\]+$/.test(url) || url.length > 120)) {
        problems.push(`nft.charities[${i}].url doit être vide ou une adresse https (120 caractères au plus)`);
      }
      if (address !== undefined) {
        if (candidateWallets.includes(address)) problems.push(`nft.charities[${i}].address apparaît deux fois`);
        candidateNames.push(charity.name);
        candidateWallets.push(address);
        candidateUrls.push(url);
      }
    });
  }

  const uri = (label: string, value: string, fallback: string): string => {
    if (value.trim() === "") {
      if (isMainnet) problems.push(`${label} est obligatoire sur le mainnet (adresse https publique)`);
      return fallback;
    }
    if (!/^https:\/\/[^\s"\\]+$/.test(value.trim())) problems.push(`${label} doit être une adresse https sans espace ni guillemet`);
    return value.trim();
  };
  const imageBaseURI = uri("nft.imageBaseURI", params.imageBaseURI, "https://example.invalid/cards/");
  const viewerURI = uri("nft.viewerURI", params.viewerURI, "https://example.invalid/card.html");

  if (problems.length > 0) {
    throw new LaunchError(`Paramètres des cartes NFT invalides :\n  - ${problems.join("\n  - ")}`);
  }
  return {
    founders: founders as string,
    community: community as string,
    mintStart,
    imageBaseURI,
    viewerURI,
    candidateNames,
    candidateWallets,
    candidateUrls,
  };
}
