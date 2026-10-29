import { createInterface } from "node:readline/promises";

import { formatEther } from "ethers";

import { UNIT } from "./constants.ts";
import { LaunchError } from "./errors.ts";

const grouping = new Intl.NumberFormat("fr-CA", { maximumFractionDigits: 0 });

/** Montant en unités de base → « 1 000 000 000 » (ou « 12,5 ») sans perte. */
export function formatTokenAmount(amount: bigint): string {
  const whole = amount / UNIT;
  const fraction = amount % UNIT;
  const wholeText = grouping.format(whole);
  if (fraction === 0n) {
    return wholeText;
  }
  const fractionText = fraction.toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
  return fractionText.length > 0 ? `${wholeText},${fractionText}` : `${wholeText},000000…`;
}

/** Montant en wei → « 1 234,5 ETH », sans perte (jusqu'au wei). */
export function formatEth(wei: bigint): string {
  if (wei < 0n) {
    return `-${formatEth(-wei)}`;
  }
  const [whole = "0", fraction = ""] = formatEther(wei).split(".");
  const fractionText = fraction.replace(/0+$/, "");
  const wholeText = grouping.format(BigInt(whole));
  return `${fractionText.length > 0 ? `${wholeText},${fractionText}` : wholeText} ETH`;
}

/** Ratio affiché avec 4 chiffres significatifs (affichage seulement), virgule décimale. */
export function formatRatio(numerator: bigint, denominator: bigint): string {
  if (denominator === 0n) {
    return "—";
  }
  const value = Number(numerator) / Number(denominator);
  return (value >= 0.001 ? value.toPrecision(4) : value.toExponential(3)).replace(".", ",");
}

const dateFormat = new Intl.DateTimeFormat("fr-CA", { dateStyle: "long", timeStyle: "short" });

/** Horodatage Unix (secondes) → « 9 janvier 2027 à 14 h 05 », à l'heure de ton ordinateur. */
export function formatDate(timestamp: bigint): string {
  return dateFormat.format(new Date(Number(timestamp) * 1000));
}

/** Durée en secondes → « 90 jours » (arrondi au jour inférieur). */
export function formatDays(seconds: bigint): string {
  const days = seconds / 86_400n;
  return `${days} jour${days > 1n ? "s" : ""}`;
}

export function percent(part: bigint, whole: bigint): string {
  if (whole === 0n) {
    return "—";
  }
  const basisPoints = (part * 10_000n) / whole;
  return `${(Number(basisPoints) / 100).toFixed(2).replace(".", ",")} %`;
}

export function heading(title: string): void {
  console.log(`\n=== ${title} ===`);
}

export function row(label: string, value: string): void {
  console.log(`  ${label.padEnd(26)} ${value}`);
}

/**
 * Dernier verrou avant un envoi sur le mainnet : il faut retaper le symbole.
 * Toute autre réponse (ou un terminal non interactif) annule sans rien envoyer.
 */
export async function confirmByTypingSymbol(symbol: string, action: string): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new LaunchError(
      "Confirmation impossible : lance cette commande dans un terminal interactif. Rien n'a été envoyé.",
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `\n⚠ MAINNET — ${action}\n  Pour confirmer, tape exactement le symbole (${symbol}) puis Entrée : `,
    );
    if (answer.trim() !== symbol) {
      throw new LaunchError("Confirmation refusée. Rien n'a été envoyé.");
    }
  } finally {
    rl.close();
  }
}
