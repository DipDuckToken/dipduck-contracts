import type { HardhatEthersProvider } from "@nomicfoundation/hardhat-ethers/types";
import { type BaseWallet, type TransactionRequest, keccak256 } from "ethers";

import { LaunchError } from "./errors.ts";

export interface TxPayload {
  to?: string;
  data: string;
  value?: bigint;
}

export interface SignedTx {
  hash: string;
  raw: string;
  nonce: number;
}

/** Marge ajoutée à l'estimation de gas (le gas non utilisé n'est pas payé). */
export const GAS_MARGIN_PERCENT = 20n;

export async function nextNonce(provider: HardhatEthersProvider, from: string): Promise<number> {
  return await provider.getTransactionCount(from, "pending");
}

/**
 * Prépare et signe localement une transaction avec un nonce imposé. Son hash
 * est connu avant toute diffusion : il peut être noté dans le journal d'abord.
 */
export async function signTx(
  provider: HardhatEthersProvider,
  wallet: BaseWallet,
  chainId: bigint,
  payload: TxPayload,
  nonce: number,
  fallbackGasLimit?: bigint,
): Promise<SignedTx> {
  const value = payload.value ?? 0n;
  let gasLimit: bigint;
  try {
    const estimate = await provider.estimateGas({ from: wallet.address, to: payload.to, data: payload.data, value });
    gasLimit = estimate + (estimate * GAS_MARGIN_PERCENT) / 100n;
  } catch (error) {
    // Re-signature d'une transaction déjà notée : si elle ne passerait plus,
    // on garde sa limite de gas d'origine ; minée en échec, elle libère le journal.
    if (fallbackGasLimit === undefined) throw error;
    gasLimit = fallbackGasLimit;
  }
  const fees = await provider.getFeeData();
  const request: TransactionRequest = {
    chainId,
    nonce,
    to: payload.to ?? null,
    data: payload.data,
    value,
    gasLimit,
  };
  if (fees.maxFeePerGas !== null && fees.maxPriorityFeePerGas !== null) {
    request.type = 2;
    request.maxFeePerGas = fees.maxFeePerGas;
    request.maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
  } else if (fees.gasPrice !== null) {
    request.type = 0;
    request.gasPrice = fees.gasPrice;
  } else {
    throw new LaunchError("Impossible de lire le prix du gas sur ce réseau.");
  }
  const raw = await wallet.signTransaction(request);
  return { hash: keccak256(raw), raw, nonce };
}

/** Tous les messages d'une erreur et de ses causes, pour la classer quelle que soit la couche. */
function messagesOf(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const stack: unknown[] = [error];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    for (const key of ["message", "shortMessage", "reason"]) {
      const text = (current as Record<string, unknown>)[key];
      if (typeof text === "string") parts.push(text);
    }
    for (const key of ["error", "info", "cause", "parent", "data"]) {
      stack.push((current as Record<string, unknown>)[key]);
    }
  }
  return parts.join(" | ");
}

export type BroadcastResult = "sent" | "already-known" | "nonce-used";

/**
 * Diffuse une transaction signée. « Déjà connue » et « nonce déjà utilisé » ne
 * sont pas des erreurs ici : ce sont des informations pour la reprise. Toute
 * autre erreur (frais devenus insuffisants, par exemple) est relancée.
 */
export async function broadcastRaw(provider: HardhatEthersProvider, raw: string): Promise<BroadcastResult> {
  try {
    await provider.send("eth_sendRawTransaction", [raw]);
    return "sent";
  } catch (error) {
    const message = messagesOf(error);
    if (/already known|known transaction|alreadyknown|already imported/i.test(message)) {
      return "already-known";
    }
    if (/nonce too low|nonce has already been used|noncetoolow|nonce is too low/i.test(message)) {
      return "nonce-used";
    }
    throw error;
  }
}

/**
 * Le nœud refuse la transaction à cause de ses frais ou de sa limite de gas
 * (formulations geth/Nitro et Hardhat) : la re-signer avec des valeurs à jour
 * et le même nonce est alors la bonne réponse.
 */
export function isFeeRejection(error: unknown): boolean {
  if (isFeeCapExceeded(error)) return false;
  return /less than block base fee|too low for the next block|underpriced|gas price too low|fee ?cap (?:too low|less than)|intrinsic gas too low/i.test(
    messagesOf(error),
  );
}

/**
 * Le RPC refuse toute transaction dont les frais maximum dépassent son plafond
 * (« tx fee (…) exceeds the configured cap », --rpc.txfeecap de geth). Re-signer
 * n'y change rien : il faut un autre RPC, la transaction notée reste valable.
 */
export function isFeeCapExceeded(error: unknown): boolean {
  return /exceeds the configured cap/i.test(messagesOf(error));
}

/** Le nœud refuse la transaction faute d'ETH pour payer valeur + frais maximum (formulations geth/Nitro et Hardhat). */
export function isInsufficientFunds(error: unknown): boolean {
  return /insufficient funds|doesn't have enough funds|not enough funds/i.test(messagesOf(error));
}

export function firstLine(error: unknown): string {
  const text = messagesOf(error).split(" | ")[0] ?? String(error);
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}
