/** Adresse « morte » : personne n'en possède la clé (les arrondis de la position y sont brûlés). */
export const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD";

export const TOKEN_DECIMALS = 18;

/** Une unité entière du token, en unités de base. */
export const UNIT = 10n ** 18n;

/**
 * Même borne que le contrat : floor((2^112 - 1) / 10^18) tokens entiers.
 * Elle tient dans un u128 (pont futur par verrouillage).
 */
export const MAX_WHOLE_TOKENS = (2n ** 112n - 1n) / UNIT;

/**
 * Délai maximal d'attente d'un reçu avant de rendre la main (la reprise prend le
 * relais). Sur une chaîne Arbitrum, l'inclusion par le séquenceur est la
 * confirmation utile : un reçu suffit, sans attendre de blocs supplémentaires.
 */
export const RECEIPT_TIMEOUT_MS = 10 * 60_000;

/** Délai maximal d'un essai de vérification sur Blockscout. */
export const VERIFY_ATTEMPT_TIMEOUT_MS = 90_000;
