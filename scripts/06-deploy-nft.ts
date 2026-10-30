/**
 * Étape 6 (après le lancement du token) — Déploie le contrat des cartes de
 * collection Dip Duck (ERC-721) puis vérifie son code sur Blockscout.
 *
 *   npm run nft:deploy:testnet
 *   npm run nft:deploy:mainnet
 *
 * Tout est fixé au déploiement et rien ne peut changer ensuite : prix, offre,
 * répartition des mints, wallets, date de début (et donc les périodes de 30
 * jours), fondations candidates de départ. Seuls les détenteurs de cartes
 * peuvent ensuite ajouter des fondations, par proposition et vote. Comme aux autres étapes, la transaction est signée puis notée
 * dans deployments/ avant d'être diffusée : relancer la même commande reprend
 * le suivi sans jamais déployer deux fois. Sur le mainnet, rien n'est envoyé
 * tant que tu n'as pas retapé le symbole du token.
 */
import hre from "hardhat";
import type { NetworkConnection } from "hardhat/types/network";

import { launchConfig } from "../launch.config.ts";
import { LaunchError, runScript } from "./lib/errors.ts";
import { confirmByTypingSymbol, formatDate, formatEth, heading, row } from "./lib/format.ts";
import { type NetworkProfile, explorerLink, resolveNetworkProfile } from "./lib/networks.ts";
import { type JournaledTx, acquireLock, fileJournal } from "./lib/records.ts";
import { type StepContext, deployNftStep } from "./lib/steps.ts";
import { NFT_CONTRACT, nftConstructorArgs } from "./lib/token.ts";
import { assertSafe } from "./lib/safe.ts";
import { validateNftParams } from "./lib/validation.ts";
import { manualVerifyCommand, verifyOnBlockscout } from "./lib/verify.ts";
import { assertSameAccount, localWallet } from "./lib/wallet.ts";

async function deployNft(connection: NetworkConnection, profile: NetworkProfile): Promise<void> {
  const { ethers, networkName } = connection;
  const journal = fileJournal(networkName);
  const record = await journal.read();
  const token = record?.token;
  if (record === undefined || token === undefined || token.status !== "confirmed") {
    throw new LaunchError(`Aucun token confirmé dans le journal (${journal.location}). Les cartes viennent après le token.`);
  }
  const others: (JournaledTx | undefined)[] = [
    record.vesting,
    record.lock,
    record.community,
    record.seeder,
    record.approval,
    record.liquidity,
    record.game,
  ];
  if (others.some((entry) => entry?.status === "pending")) {
    throw new LaunchError(
      "Une étape du lancement est notée mais pas encore confirmée : relance d'abord sa commande " +
        "(npm run status:… indique laquelle). Rien n'a été envoyé.",
    );
  }

  const [signer] = await ethers.getSigners();
  const wallet = await localWallet(connection);
  assertSameAccount(wallet, signer.address);
  const { chainId } = await ethers.provider.getNetwork();
  const ctx: StepContext = {
    ethers,
    wallet,
    journal,
    networkName,
    chainId,
    confirm: profile.isMainnet ? (action) => confirmByTypingSymbol(token.symbol, action) : async () => {},
    log: (message) => console.log(`  ${message}`),
  };

  if (record.nft === undefined) {
    const latest = await ethers.provider.getBlock("latest");
    if (latest === null) throw new LaunchError("Impossible de lire le dernier bloc. Rien n'a été envoyé.");
    const plan = validateNftParams(launchConfig.nft, {
      deployer: signer.address,
      community: launchConfig.community.beneficiary,
      isMainnet: profile.isMainnet,
      now: BigInt(latest.timestamp),
    });
    // Le wallet communauté est (sur le mainnet, doit être) un Safe 2 sur 3 : il reçoit 40 % des mints
    // et frappe les cartes Trophée par une transaction signée à plusieurs.
    if (profile.isMainnet || (await ethers.provider.getCode(plan.community)) !== "0x") {
      await assertSafe(ethers.provider, plan.community, signer.address, "Le wallet communauté");
    }
    for (const address of [plan.founders, ...plan.candidateWallets]) {
      if ((await ethers.provider.getCode(address)) !== "0x") {
        throw new LaunchError(
          `${address} est un contrat sur cette chaîne : les versements partent vers des wallets ordinaires. Rien n'a été envoyé.`,
        );
      }
    }
    const balance = await ethers.provider.getBalance(signer.address);

    heading(`Cartes NFT Dip Duck — ${profile.label}`);
    row("Collection", "Dip Duck Cards (DDCARD) — 3 333 cartes dont 111 Trophée (prix de concours, sans vote)");
    row("Prix du mint", "0,001 ETH, 10 cartes au maximum par wallet");
    row("Début du mint", formatDate(plan.mintStart));
    row("Périodes", "30 jours : chaque période a sa cagnotte et son vote ; rien n'est versé avant sa fin");
    row("Fondateurs (30 %)", plan.founders);
    row("Communauté (40 %, Trophées)", plan.community);
    plan.candidateNames.forEach((name, i) =>
      row(
        i === 0 ? "Fondations de départ (30 %)" : "",
        `${name} — ${plan.candidateWallets[i]}${plan.candidateUrls[i] ? ` — ${plan.candidateUrls[i]}` : ""}`,
      ),
    );
    row("Nouvelles fondations", "proposées par les détenteurs, approuvées par vote (quorum 10 voix), 20 au maximum");
    row("Images", `${plan.imageBaseURI}<numéro>.png`);
    row("Page d'une carte", `${plan.viewerURI}?id=<numéro>`);
    row("Hasard", "pseudo-aléatoire, non certifié (pas de VRF sur la chaîne) : acceptable pour des objets sans valeur");
    row("Solde du wallet", formatEth(balance));
    if (profile.isMainnet) {
      await confirmByTypingSymbol(token.symbol, "déployer les cartes NFT (rien ne pourra être modifié ensuite)");
    }
    console.log("");
    await deployNftStep(ctx, plan);
  } else {
    // Reprise (ou contrat déjà confirmé) : seul le journal fait foi, pas launch.config.ts.
    const noted = record.nft;
    await deployNftStep(ctx, { ...noted, mintStart: BigInt(noted.mintStart) });
  }

  const nft = (await journal.read())?.nft;
  if (nft === undefined) throw new LaunchError("Journal incohérent : le contrat des cartes a disparu du journal.");
  heading("Cartes NFT déployées");
  row("Adresse", nft.address);
  row("Transaction", nft.txHash);
  row("Explorateur", explorerLink(profile, "address", nft.address) ?? "—");
  row("Journal", journal.location);

  console.log("\nVérification du code source sur Blockscout…");
  const target = { address: nft.address, contract: NFT_CONTRACT, constructorArgs: nftConstructorArgs(nft) };
  if (await verifyOnBlockscout(hre, target, 3)) {
    console.log("  ✔ Code source vérifié.");
  } else {
    console.log(`  À relancer plus tard : ${manualVerifyCommand(networkName, target)}`);
  }
  console.log("\nMets cette adresse dans le site (CONFIG.nftContract) : le compteur et le mint s'y brancheront.");
}

await runScript(async () => {
  const connection = await hre.network.create();
  const profile = await resolveNetworkProfile(connection.networkName, connection.ethers.provider, [
    "robinhoodTestnet",
    "robinhood",
  ]);
  const releaseLock = await acquireLock(connection.networkName);
  try {
    await deployNft(connection, profile);
  } finally {
    await releaseLock();
  }
});
