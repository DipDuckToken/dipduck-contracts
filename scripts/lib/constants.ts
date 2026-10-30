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

/** Validité des transactions (courbe, Uniswap), en secondes après le dernier bloc. */
export const TX_DEADLINE_SECONDS = 600n;

/**
 * Délai maximal d'attente d'un reçu avant de rendre la main (la reprise prend le
 * relais). Sur une chaîne Arbitrum, l'inclusion par le séquenceur est la
 * confirmation utile : un reçu suffit, sans attendre de blocs supplémentaires.
 */
export const RECEIPT_TIMEOUT_MS = 10 * 60_000;

/** Délai maximal d'un essai de vérification sur Blockscout. */
export const VERIFY_ATTEMPT_TIMEOUT_MS = 90_000;
