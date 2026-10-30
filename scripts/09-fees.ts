/**
 * Verse au Safe communauté les frais d'échange (1 %) accumulés par la position
 * du lancement. N'importe qui peut déclencher ce versement : les frais vont
 * toujours au Safe, et la liquidité, elle, ne peut jamais sortir. Aucun risque
 * de doublon : un second appel ne verse que ce qui s'est accumulé entre-temps.
 *
 *   npm run fees:mainnet
 *
 * Pendant les 24 h qui suivent l'ouverture, le versement peut être refusé (le
 * Safe détient déjà la réserve, au-delà de la limite par wallet) : réessaie après.
 */
import { Contract, Interface, getAddress } from "ethers";
import hre from "hardhat";
import type { NetworkConnection } from "hardhat/types/network";

import { LaunchError, runScript } from "./lib/errors.ts";
import { confirmByTypingSymbol, formatEth, formatTokenAmount, heading, row } from "./lib/format.ts";
import { LAUNCHER_ABI, readLaunchStatus } from "./lib/launch.ts";
import { type NetworkProfile, explorerLink, resolveNetworkProfile } from "./lib/networks.ts";
import { type JournaledTx, acquireLock, fileJournal } from "./lib/records.ts";

async function collect(connection: NetworkConnection, profile: NetworkProfile): Promise<void> {
  const { ethers, networkName } = connection;
  const journal = fileJournal(networkName);
  const record = await journal.read();
  const token = record?.token;
  if (record === undefined || token?.status !== "confirmed") {
    throw new LaunchError(`Aucun lancement confirmé dans le journal (${journal.location}).`);
  }
  // Une étape notée mais pas confirmée attend son nonce : ne pas le lui prendre.
  const entries: (JournaledTx | undefined)[] = [record.vesting, record.token, record.nft, record.game];
  if (entries.some((entry) => entry?.status === "pending")) {
    throw new LaunchError(
      "Une étape du lancement est notée mais pas encore confirmée : relance d'abord sa commande " +
        "(npm run status:… indique laquelle). Rien n'a été envoyé.",
    );
  }

  const status = await readLaunchStatus(ethers.provider, token.launcher);
  heading(`Frais d'échange — ${profile.label}`);
  row("Lanceur", status.launcher);
  row("Versés à (Safe)", status.feeRecipient);
  if (status.pendingFees === undefined) {
    throw new LaunchError(
      "Le versement serait refusé pour l'instant : pendant les 24 h qui suivent l'ouverture, le Safe détient déjà " +
        "plus que la limite par wallet. Réessaie après. Rien n'a été envoyé.",
    );
  }
  row("En attente", `${formatEth(status.pendingFees.weth)} et ${formatTokenAmount(status.pendingFees.tokens)} ${token.symbol}`);
  if (status.pendingFees.weth === 0n && status.pendingFees.tokens === 0n) {
    console.log("\n  Rien à verser pour l'instant.");
    return;
  }
  if (profile.isMainnet) {
    await confirmByTypingSymbol(token.symbol, "verser les frais d'échange au Safe communauté");
  }

  const [signer] = await ethers.getSigners();
  const launcher = new Contract(token.launcher, LAUNCHER_ABI, signer);
  console.log("\nVersement au Safe…");
  const tx = await launcher.collectFees();
  console.log(`  Transaction envoyée : ${tx.hash as string}`);
  const receipt = await tx.wait();
  if (receipt === null) {
    throw new LaunchError(`Pas de reçu pour ${tx.hash as string}. Vérifie-la sur l'explorateur avant de relancer.`);
  }
  // Ce nonce est consommé (succès ou échec) : les prochaines étapes ne le réutiliseront pas.
  if (getAddress(signer.address) === getAddress(token.from)) {
    const latest = (await journal.read()) ?? record;
    await journal.write({ ...latest, nonceFloor: Math.max(latest.nonceFloor ?? 0, Number(tx.nonce) + 1) });
  }
  if (receipt.status !== 1) {
    throw new LaunchError(`Le versement ${tx.hash as string} a échoué : rien n'a bougé (hors frais).`);
  }
  const launcherInterface = new Interface(LAUNCHER_ABI);
  const collected = receipt.logs
    .map((log: { topics: string[]; data: string }) => launcherInterface.parseLog(log))
    .find((parsed: ReturnType<Interface["parseLog"]>) => parsed?.name === "FeesCollected");
  const [amount0, amount1] = [(collected?.args[0] as bigint | undefined) ?? 0n, (collected?.args[1] as bigint | undefined) ?? 0n];
  const [tokens, weth] = status.state.tokenIsToken0 ? [amount0, amount1] : [amount1, amount0];

  heading("Frais versés");
  row("Au Safe", `${formatEth(weth)} et ${formatTokenAmount(tokens)} ${token.symbol}`);
  row("Transaction", receipt.hash);
  row("Explorateur", explorerLink(profile, "tx", receipt.hash) ?? "—");
}

await runScript(async () => {
  const connection = await hre.network.create();
  const profile = await resolveNetworkProfile(connection.networkName, connection.ethers.provider, ["robinhood"]);
  // Comme les autres étapes : un seul script à la fois sur ce réseau.
  const releaseLock = await acquireLock(connection.networkName);
  try {
    await collect(connection, profile);
  } finally {
    await releaseLock();
  }
});
