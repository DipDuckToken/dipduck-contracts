/** Adresse « morte » : personne n'en possède la clé. Les parts LP y sont émises directement. */
export const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD";

/** Parts LP qu'une paire Uniswap v2 verrouille à vie (adresse 0) lors du premier dépôt. */
export const UNISWAP_V2_MINIMUM_LIQUIDITY = 1000n;

export const TOKEN_DECIMALS = 18;

/** Une unité entière du token, en unités de base. */
export const UNIT = 10n ** 18n;

/**
 * Même borne que le contrat : floor((2^112 - 1) / 10^18) tokens entiers.
 * C'est la taille des réserves d'une paire Uniswap v2 ; elle tient aussi dans un u128.
 */
export const MAX_WHOLE_TOKENS = (2n ** 112n - 1n) / UNIT;

/** Validité des transactions Uniswap, en secondes après le dernier bloc. */
export const TX_DEADLINE_SECONDS = 600n;

/**
 * Don de WETH toléré entre l'affichage du plan et l'ouverture du pool, en points
 * de base de l'ETH apporté (100 = 1 %). Sans marge, un tiers pourrait bloquer
 * l'ouverture en ajoutant 1 wei avant chaque essai (puis le reprendre) ; avec
 * elle, le prix de départ ne peut pas dépasser de plus de 1 % celui que tu valides.
 */
export const DONATION_TOLERANCE_BPS = 100n;

/**
 * Gas réservé pour l'étape 3 : déploiement du PoolSeeder, approve et ouverture du pool.
 * Large exprès : sur Robinhood Chain (Arbitrum Nitro), l'estimation inclut aussi les
 * frais de données L1, convertis en gas L2.
 */
export const LIQUIDITY_GAS_RESERVE = 8_000_000n;

/**
 * Délai maximal d'attente d'un reçu avant de rendre la main (la reprise prend le
 * relais). Sur une chaîne Arbitrum, l'inclusion par le séquenceur est la
 * confirmation utile : un reçu suffit, sans attendre de blocs supplémentaires.
 */
export const RECEIPT_TIMEOUT_MS = 10 * 60_000;

/** Délai maximal d'un essai de vérification sur Blockscout. */
export const VERIFY_ATTEMPT_TIMEOUT_MS = 90_000;
