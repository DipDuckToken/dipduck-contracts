import { Contract, type Provider, type TransactionReceipt, getAddress, Interface } from "ethers";

import { LaunchError } from "./errors.ts";
import { ERC20_ABI } from "./uniswap.ts";

/** Fonctions de TokenVesting (VestingWalletCliff d'OpenZeppelin) utilisées par les scripts. */
export const VESTING_ABI = [
  "function owner() view returns (address)",
  "function start() view returns (uint256)",
  "function duration() view returns (uint256)",
  "function cliff() view returns (uint256)",
  "function end() view returns (uint256)",
  "function released(address token) view returns (uint256)",
  "function releasable(address token) view returns (uint256)",
  "function release(address token)",
  "event ERC20Released(address indexed token, uint256 amount)",
] as const;

const erc20Interface = new Interface(ERC20_ABI);

export interface VestingStatus {
  beneficiary: string;
  start: bigint;
  cliff: bigint;
  end: bigint;
  /** Encore dans le contrat. */
  locked: bigint;
  /** Déjà versé au bénéficiaire. */
  released: bigint;
  /** Versable dès maintenant (n'importe qui peut déclencher le versement). */
  releasable: bigint;
}

export async function readVestingStatus(provider: Provider, vesting: string, token: string): Promise<VestingStatus> {
  const contract = new Contract(vesting, VESTING_ABI, provider);
  const [beneficiary, start, cliff, end, released, releasable, locked] = (await Promise.all([
    contract.owner(),
    contract.start(),
    contract.cliff(),
    contract.end(),
    contract.released(token),
    contract.releasable(token),
    new Contract(token, ERC20_ABI, provider).balanceOf(vesting),
  ])) as [string, bigint, bigint, bigint, bigint, bigint, bigint];
  return { beneficiary: getAddress(beneficiary), start, cliff, end, locked, released, releasable };
}

/**
 * Lit dans le reçu un transfert de tes tokens (ta part vers le contrat de
 * vesting, ou la réserve vers le wallet communauté) : la preuve qu'ils y sont
 * arrivés, au montant exact, depuis ton wallet.
 */
export function readTransferReceipt(
  receipt: TransactionReceipt,
  transfer: { token: string; from: string; to: string; amount: bigint },
): void {
  const found = receipt.logs.some((log) => {
    if (getAddress(log.address) !== getAddress(transfer.token)) return false;
    const parsed = erc20Interface.parseLog(log);
    return (
      parsed?.name === "Transfer" &&
      getAddress(parsed.args[0] as string) === getAddress(transfer.from) &&
      getAddress(parsed.args[1] as string) === getAddress(transfer.to) &&
      (parsed.args[2] as bigint) === transfer.amount
    );
  });
  if (!found) {
    throw new LaunchError(`Aucun transfert de ${transfer.amount} vers ${transfer.to} dans la transaction ${receipt.hash}.`);
  }
}

/**
 * Ta part : ce que le pool ne recevra pas. Elle se bloque AVANT l'ouverture du
 * pool, pour que les acheteurs la voient bloquée dès la première seconde. Le
 * contrat de blocage ne peut rien en faire d'autre que la verser au
 * bénéficiaire selon le calendrier : il ne peut pas ouvrir un pool avant toi.
 */
export function shareToLock(totalSupply: bigint, tokenPercent: bigint, communityPercent = 0n): bigint {
  return totalSupply - (totalSupply * tokenPercent) / 100n - communityShare(totalSupply, communityPercent);
}

/**
 * Réserve communauté, envoyée à son wallet dédié avant l'ouverture du pool.
 * Arrondi inférieur ; ta part reçoit le reste : pool + réserve + ta part = offre.
 */
export function communityShare(totalSupply: bigint, communityPercent: bigint): bigint {
  return (totalSupply * communityPercent) / 100n;
}

/** Temps minimal entre le blocage et la falaise quand on réutilise un contrat déjà déployé. */
export const MIN_CLIFF_AHEAD_SECONDS = 3_600n;

/**
 * Refuse de remplir un contrat de blocage déjà déployé dont la falaise est passée
 * ou imminente : son début a été fixé à son déploiement, et une relance tardive
 * rendrait aussitôt libérable une partie de la part (90 jours sur 365 ≈ 25 %).
 */
export function assertCliffAhead(input: { start: bigint; cliffSeconds: bigint; now: bigint; vesting: string }): void {
  const cliff = input.start + input.cliffSeconds;
  if (cliff < input.now + MIN_CLIFF_AHEAD_SECONDS) {
    throw new LaunchError(
      `La falaise du contrat de blocage déjà déployé (${input.vesting}) est passée ou à moins d'une heure : ` +
        "y bloquer ta part la rendrait libérable presque aussitôt. Ce contrat est vide, il ne sert à rien : " +
        'retire seulement l\'entrée "vesting" du journal, puis relance pour en déployer un neuf avec un calendrier ' +
        "qui commence maintenant. Rien n'a été envoyé.",
    );
  }
}

export type ShareMode = "none" | "locked" | "unlocked";

/**
 * Ce que l'ouverture du pool fait de ta part :
 * - bloquée : le pool reçoit l'offre moins ta part et moins la réserve communauté ;
 * - pas de part (tokenPercent + réserve = 100) : tout ce qui reste dans ton wallet va au pool ;
 * - blocage désactivé : le pool reçoit tokenPercent de ton solde, le reste reste libre chez toi ;
 * - blocage activé mais pas encore fait, ou réserve communauté pas encore envoyée : refus.
 */
export function poolShare(input: {
  tokenPercent: bigint;
  vestingEnabled: boolean;
  lockConfirmed: boolean;
  lockCommand: string;
  communityPercent?: bigint;
  communityConfirmed?: boolean;
}): { poolPercent: bigint; mode: ShareMode } {
  const communityPercent = input.communityPercent ?? 0n;
  const teamPercent = 100n - input.tokenPercent - communityPercent;
  if (!input.lockConfirmed && teamPercent > 0n && input.vestingEnabled) {
    throw new LaunchError(
      `Bloque d'abord ta part : ${input.lockCommand}\n` +
        "  Elle se bloque avant l'ouverture du pool, pour que les acheteurs la voient bloquée dès la " +
        "première seconde. Rien n'a été envoyé.",
    );
  }
  if (communityPercent > 0n && input.communityConfirmed !== true) {
    throw new LaunchError(
      `Envoie d'abord la réserve communauté à son wallet : ${input.lockCommand}\n` +
        "  Elle part avant l'ouverture du pool, pour que tout le monde la voie à part dès la première " +
        "seconde. Rien n'a été envoyé.",
    );
  }
  if (input.lockConfirmed) {
    return { poolPercent: 100n, mode: "locked" };
  }
  if (teamPercent === 0n) {
    return { poolPercent: 100n, mode: "none" };
  }
  if (communityPercent > 0n) {
    // Sans blocage, tokenPercent s'appliquerait au solde déjà amputé de la réserve : montant faux.
    throw new LaunchError(
      "Une réserve communauté demande que ta part soit bloquée (vesting.enabled: true), ou que " +
        "tokenPercent + community.percent fasse 100. Rien n'a été envoyé.",
    );
  }
  return { poolPercent: input.tokenPercent, mode: "unlocked" };
}

/**
 * Nombre de tokens pour le pool. Part bloquée : exactement l'offre moins ta
 * part et moins la réserve communauté, même si des tokens libérés sont revenus dans ton wallet entre-temps
 * (ils restent hors du pool). Sinon : ton solde, auquel tokenPercent s'applique.
 */
export function poolBaseAmount(input: {
  mode: ShareMode;
  totalSupply: bigint;
  lockedAmount: bigint;
  balance: bigint;
  communityAmount?: bigint;
}): bigint {
  return input.mode === "locked"
    ? input.totalSupply - input.lockedAmount - (input.communityAmount ?? 0n)
    : input.balance;
}
