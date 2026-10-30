/**
 * Verse au bénéficiaire la partie de ta part que le calendrier du vesting a
 * déjà libérée. N'importe qui peut déclencher ce versement : les tokens vont
 * toujours au bénéficiaire. Aucun risque de doublon : un second appel ne
 * verse que ce qui s'est libéré entre-temps.
 *
 *   npm run release:mainnet
 *   npm run release:testnet
 */
import { Contract, Interface, getAddress } from "ethers";
import hre from "hardhat";
import type { NetworkConnection } from "hardhat/types/network";

import { LaunchError, runScript } from "./lib/errors.ts";
import { formatDate, formatTokenAmount, heading, row } from "./lib/format.ts";
import { type NetworkProfile, explorerLink, resolveNetworkProfile } from "./lib/networks.ts";
import { type JournaledTx, acquireLock, fileJournal } from "./lib/records.ts";
import { VESTING_ABI, readVestingStatus } from "./lib/vesting.ts";

async function release(connection: NetworkConnection, profile: NetworkProfile): Promise<void> {
  const { ethers, networkName } = connection;
  const journal = fileJournal(networkName);
  const record = await journal.read();
  const token = record?.token;
  const vesting = record?.vesting;
  if (record === undefined || token === undefined || vesting?.status !== "confirmed") {
    throw new LaunchError(`Aucun contrat de blocage confirmé dans le journal (${journal.location}).`);
  }
  // Une étape notée mais pas confirmée attend son nonce : ne pas le lui prendre.
  const entries: (JournaledTx | undefined)[] = [
    record.token,
    record.vesting,
    record.nft,
    record.game,
  ];
  if (entries.some((entry) => entry?.status === "pending")) {
    throw new LaunchError(
      "Une étape du lancement est notée mais pas encore confirmée : relance d'abord sa commande " +
        "(npm run status:… indique laquelle). Rien n'a été envoyé.",
    );
  }

  const status = await readVestingStatus(ethers.provider, vesting.address, token.address);
  heading(`Ta part bloquée — ${profile.label}`);
  row("Contrat de blocage", vesting.address);
  row("Bénéficiaire", status.beneficiary);
  row("Encore bloqué", `${formatTokenAmount(status.locked)} ${token.symbol}`);
  row("Déjà versé", `${formatTokenAmount(status.released)} ${token.symbol}`);
  row("Libérable maintenant", `${formatTokenAmount(status.releasable)} ${token.symbol}`);

  if (status.releasable === 0n) {
    const now = BigInt(Math.floor(Date.now() / 1000));
    console.log(
      now < status.cliff
        ? `\n  Rien à libérer avant la falaise : ${formatDate(status.cliff)}.`
        : status.locked === 0n
          ? "\n  Tout a déjà été versé."
          : "\n  Rien à libérer pour l'instant : la part libérable augmente chaque seconde jusqu'à la fin.",
    );
    return;
  }

  const [signer] = await ethers.getSigners();
  const contract = new Contract(vesting.address, VESTING_ABI, signer);
  console.log("\nVersement au bénéficiaire…");
  const tx = await contract.release(token.address);
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
  const vestingInterface = new Interface(VESTING_ABI);
  const released = receipt.logs
    .map((log: { topics: string[]; data: string }) => vestingInterface.parseLog(log))
    .find((parsed: ReturnType<Interface["parseLog"]>) => parsed?.name === "ERC20Released");
  const amount = (released?.args[1] as bigint | undefined) ?? 0n;

  heading("Versement effectué");
  row("Versé au bénéficiaire", `${formatTokenAmount(amount)} ${token.symbol}`);
  row("Transaction", receipt.hash);
  row("Explorateur", explorerLink(profile, "tx", receipt.hash) ?? "—");
}

await runScript(async () => {
  const connection = await hre.network.create();
  const profile = await resolveNetworkProfile(connection.networkName, connection.ethers.provider, [
    "robinhood",
    "robinhoodTestnet",
  ]);
  // Comme les autres étapes : un seul script à la fois sur ce réseau.
  const releaseLock = await acquireLock(connection.networkName);
  try {
    await release(connection, profile);
  } finally {
    await releaseLock();
  }
});
