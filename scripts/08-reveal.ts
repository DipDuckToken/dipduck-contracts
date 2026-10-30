/**
 * Robot de révélation des cartes (pendant la vente) : toutes les 5 minutes,
 * révèle les cartes en attente dont le bloc cible est passé.
 *
 *   npm run nft:reveal:testnet
 *   npm run nft:reveal:mainnet
 *
 * Une carte non révélée dans les 256 blocs qui suivent son bloc cible reste
 * « Plain » pour toujours (et une carte Trophée tombe au plancher épique).
 * Chaque mint révèle déjà jusqu'à 3 cartes prêtes, et le site demande une
 * révélation à l'acheteur ; ce robot couvre le reste (page fermée, fin de vente,
 * période creuse). `revealMany` est ouvert à tous : le robot paie seulement le
 * gas, ne reçoit rien et ne peut rien choisir (le tirage vient du bloc cible).
 * Laisse la fenêtre ouverte ; Ctrl+C pour arrêter.
 */
import { Contract } from "ethers";
import hre from "hardhat";

import { LaunchError, runScript } from "./lib/errors.ts";
import { formatEth } from "./lib/format.ts";
import { resolveNetworkProfile } from "./lib/networks.ts";
import { fileJournal } from "./lib/records.ts";

const CARDS_ABI = [
  "function totalMinted() view returns (uint256)",
  "function cardOf(uint256 tokenId) view returns (bytes32 name, uint8 mood, uint8 element, uint16 lucky, uint64 commitBlock, bool revealed, bool trophy)",
  "function revealMany(uint256[] tokenIds)",
] as const;

/** Délai entre deux passages : bien sous la fenêtre de 256 blocs. */
const INTERVAL_MS = 5 * 60 * 1000;
/** Bloc cible = commitBlock + REVEAL_DELAY (DipDuckCards). */
const REVEAL_DELAY = 2n;
/** Cartes révélées au plus par transaction. */
const BATCH = 100;

await runScript(async () => {
  const { ethers, networkName } = await hre.network.create();
  await resolveNetworkProfile(networkName, ethers.provider, ["robinhood", "robinhoodTestnet"]);
  const nft = (await fileJournal(networkName).read())?.nft;
  if (nft === undefined || nft.status !== "confirmed") {
    throw new LaunchError("Aucun contrat de cartes confirmé dans le journal : déploie-le d'abord (npm run nft:deploy:…).");
  }
  const [signer] = await ethers.getSigners();
  const cards = new Contract(nft.address, CARDS_ABI, signer);
  console.log(`\n  Robot de révélation : ${nft.address}, wallet ${signer.address}. Ctrl+C pour arrêter.`);

  // Plus petit numéro qui peut encore être en attente : tout ce qui est avant est révélé.
  let from = 1n;
  for (;;) {
    try {
      const [total, block] = await Promise.all([cards.totalMinted() as Promise<bigint>, ethers.provider.getBlockNumber()]);
      const ready: bigint[] = [];
      let pendingSeen = false;
      for (let id = from; id <= total; id++) {
        const card = await cards.cardOf(id);
        if (card.revealed) {
          if (!pendingSeen) from = id + 1n;
          continue;
        }
        pendingSeen = true;
        if (BigInt(block) > card.commitBlock + REVEAL_DELAY) ready.push(id);
      }
      for (let i = 0; i < ready.length; i += BATCH) {
        const ids = ready.slice(i, i + BATCH);
        const receipt = await (await cards.revealMany(ids)).wait();
        const fee: bigint = receipt?.fee ?? 0n;
        console.log(`  ${new Date().toISOString()} — ${ids.length} carte(s) révélée(s) (n° ${ids[0]} à ${ids.at(-1)}), frais ${formatEth(fee)} ETH`);
      }
      if (ready.length === 0) console.log(`  ${new Date().toISOString()} — rien à révéler (${total} cartes)`);
    } catch (error) {
      // Une panne du RPC ne doit pas arrêter le robot : on réessaie au prochain passage.
      console.log(`  ${new Date().toISOString()} — erreur, nouvel essai dans 5 min : ${(error as Error).message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
});
