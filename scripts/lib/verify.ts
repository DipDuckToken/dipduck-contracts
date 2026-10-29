import { setTimeout as sleep } from "node:timers/promises";

import { verifyContract } from "@nomicfoundation/hardhat-verify/verify";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";

import { VERIFY_ATTEMPT_TIMEOUT_MS } from "./constants.ts";

const RETRY_DELAY_MS = 15_000;

export interface VerifyTarget {
  address: string;
  /** Nom complet `<fichier>:<contrat>`. */
  contract: string;
  constructorArgs: unknown[];
}

/** Commande à relancer à la main si la vérification automatique n'aboutit pas. */
export function manualVerifyCommand(networkName: string, target: VerifyTarget): string {
  const args = target.constructorArgs
    .map((arg) =>
      Array.isArray(arg)
        ? `'${JSON.stringify(arg)}'`
        : typeof arg === "string" && !arg.startsWith("0x")
          ? `"${arg}"`
          : String(arg),
    )
    .join(" ");
  return `npx hardhat verify blockscout --network ${networkName} ${target.address} ${args}`.trimEnd();
}

/**
 * Vérifie le code source sur Blockscout. Un contrat tout juste déployé met
 * quelques secondes à être indexé : on réessaie, avec un délai maximal par essai.
 */
export async function verifyOnBlockscout(
  hre: HardhatRuntimeEnvironment,
  target: VerifyTarget,
  attempts = 5,
): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`pas de réponse après ${VERIFY_ATTEMPT_TIMEOUT_MS / 1000} s`)),
        VERIFY_ATTEMPT_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([
        verifyContract(
          {
            address: target.address,
            constructorArgs: target.constructorArgs,
            contract: target.contract,
            provider: "blockscout",
          },
          hre,
        ),
        timeout,
      ]);
      return true;
    } catch (error) {
      const reason = (error as Error).message.split("\n")[0] ?? "";
      if (attempt === attempts) {
        console.warn(`  Échec de la vérification : ${reason}`);
        return false;
      }
      const short = reason.length > 110 ? `${reason.slice(0, 110)}…` : reason;
      console.log(`  Essai ${attempt}/${attempts} sans succès (${short}) — nouvel essai dans 15 s…`);
      await sleep(RETRY_DELAY_MS);
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}
