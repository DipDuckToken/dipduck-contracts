import { Contract, type Provider, getAddress } from "ethers";

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
