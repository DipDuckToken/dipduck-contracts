/**
 * Étape 7 (indépendante du token) — Déploie le jeu « Attrape la baisse » (DipDuckGame),
 * un seul contrat pour toujours, puis vérifie son code sur Blockscout.
 *
 *   npm run game:deploy:testnet
 *   npm run game:deploy:mainnet
 *
 * La genèse (baisses historiques, temps minimaux historiques, premier jour évalué par la
 * chaîne, prix récents) vient du fichier JSON indiqué par game.genesisFile dans
 * launch.config.ts — le même que celui du site. Elle est validée ici avec les règles du
 * contrat, puis figée au déploiement. Ensuite, la chaîne ajoute un prix par jour (flux
 * Chainlink BTC/USD, game.feed sur le mainnet, game.testnetFeed sur le testnet), y détecte
 * elle-même les nouvelles baisses et ouvre un concours par trimestre. Pas d'owner, pas
 * d'ETH, rien de modifiable. Comme aux autres étapes, la transaction est signée puis notée
 * dans deployments/ avant d'être diffusée : relancer la même commande reprend le suivi sans
 * jamais déployer deux fois. Sur le mainnet, rien n'est envoyé tant que tu n'as pas retapé
 * le symbole du token.
 */
import { getAddress, isAddress } from "ethers";
import hre from "hardhat";
import type { NetworkConnection } from "hardhat/types/network";

import { launchConfig } from "../launch.config.ts";
import { LaunchError, runScript } from "./lib/errors.ts";
import { confirmByTypingSymbol, formatEth, heading, row } from "./lib/format.ts";
import { loadGenesisFile, resolveGenesisPath } from "./lib/genesis.ts";
import { type NetworkProfile, explorerLink, resolveNetworkProfile } from "./lib/networks.ts";
import { type JournaledTx, acquireLock, fileJournal } from "./lib/records.ts";
import { GAME_MAX_STALE_SECONDS, type StepContext, checkFeed, deployGameStep } from "./lib/steps.ts";
import { GAME_CONTRACT, gameConstructorArgs } from "./lib/token.ts";
import { manualVerifyCommand, verifyOnBlockscout } from "./lib/verify.ts";
import { assertSameAccount, localWallet } from "./lib/wallet.ts";

/** Jour 0 des données du jeu : 2010-08-18 00:00 UTC (DATA_START du contrat). */
const DATA_START = 1282089600;

/** Date UTC d'un jour du jeu. */
function formatDay(day: number): string {
  return new Date((DATA_START + day * 86400) * 1000).toISOString().slice(0, 10);
}

/** Flux de prix du réseau : game.feed sur le mainnet, game.testnetFeed sur le testnet. */
function feedFor(profile: NetworkProfile): string {
  const value: string = profile.isMainnet ? launchConfig.game.feed : launchConfig.game.testnetFeed;
  const key = profile.isMainnet ? "game.feed" : "game.testnetFeed";
  if (value.trim() === "") {
    throw new LaunchError(
      `${key} est vide dans launch.config.ts : indique l'adresse d'un flux BTC/USD (8 décimales) sur ce réseau. Rien n'a été envoyé.`,
    );
  }
  if (!isAddress(value.trim())) throw new LaunchError(`${key} n'est pas une adresse valide. Rien n'a été envoyé.`);
  return getAddress(value.trim());
}

async function deployGame(connection: NetworkConnection, profile: NetworkProfile): Promise<void> {
  const { ethers, networkName } = connection;
  const journal = fileJournal(networkName);
  const record = await journal.read();
  // Le jeu ne dépend pas du token : le symbole du journal sert seulement à la confirmation.
  const symbol = record?.token?.symbol ?? launchConfig.token.symbol;
  const others: (JournaledTx | undefined)[] = [
    record?.token,
    record?.vesting,
    record?.lock,
    record?.community,
    record?.seeder,
    record?.approval,
    record?.liquidity,
    record?.nft,
  ];
  if (others.some((entry) => entry?.status === "pending")) {
    throw new LaunchError(
      "Une étape du lancement est notée mais pas encore confirmée : relance d'abord sa commande " +
        "(npm run status:… indique laquelle). Rien n'a été envoyé.",
    );
  }

  // Genèse et flux validés avant toute signature (même en reprise : le journal doit correspondre).
  const genesis = await loadGenesisFile(launchConfig.game.genesisFile);
  const feed = feedFor(profile);

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
    confirm: profile.isMainnet ? (action) => confirmByTypingSymbol(symbol, action) : async () => {},
    log: (message) => console.log(`  ${message}`),
  };

  if (record?.game === undefined) {
    const { price, ageSeconds } = await checkFeed(ctx, feed);
    const balance = await ethers.provider.getBalance(signer.address);
    const lastDip = genesis.dipDays.at(-1);
    heading(`Jeu « Attrape la baisse » — ${profile.label}`);
    row("Contrat", "DipDuckGame — sans owner, sans ETH, rien de modifiable");
    row("Fichier de genèse", resolveGenesisPath(launchConfig.game.genesisFile));
    row("Baisses historiques", `${genesis.dipDays.length}${lastDip === undefined ? "" : ` (dernière : ${formatDay(lastDip)})`}`);
    row("Détection par la chaîne", `à partir du jour ${genesis.detectFrom} (${formatDay(genesis.detectFrom)})`);
    row("Dernier prix fourni", `${formatDay(genesis.detectFrom + 13)} : ${Number(genesis.recentPrices.at(-1)) / 1e8} USD`);
    row("Temps minimal", `${genesis.histMinSeconds.length} tranches, ${genesis.histMinSeconds.at(-1)} s au dernier jour fourni`);
    row("Flux BTC/USD", `${feed} — ${Number(price) / 1e8} USD, il y a ${ageSeconds} s`);
    if (ageSeconds > GAME_MAX_STALE_SECONDS) {
      console.log("  ⚠ Ce prix a plus de 26 h : startRun et recordDay seront refusés (StalePrice) tant qu'il n'est pas mis à jour.");
    }
    row("Concours", "un par trimestre civil UTC, top 50 : le plus loin, puis baisses, pièces, score, le plus ancien");
    row("Reste possible", "un programme qui joue vraiment, en temps réel");
    row("Solde du wallet", formatEth(balance));
    if (profile.isMainnet) {
      await confirmByTypingSymbol(symbol, "déployer le jeu (rien ne pourra être modifié ensuite)");
    }
    console.log("");
  }
  // Reprise (ou contrat déjà confirmé) : seul le journal fait foi.
  await deployGameStep(ctx, genesis, feed);

  const game = (await journal.read())?.game;
  if (game === undefined) throw new LaunchError("Journal incohérent : le jeu a disparu du journal.");
  heading("Jeu déployé");
  row("Adresse", game.address);
  row("Flux BTC/USD", game.feed);
  row("Baisses historiques", String(game.dipDays.length));
  row("Détection à partir du jour", `${game.detectFrom} (${formatDay(game.detectFrom)})`);
  row("Transaction", game.txHash);
  row("Explorateur", explorerLink(profile, "address", game.address) ?? "—");
  row("Journal", journal.location);

  console.log("\nVérification du code source sur Blockscout…");
  const target = { address: game.address, contract: GAME_CONTRACT, constructorArgs: gameConstructorArgs(game) };
  if (await verifyOnBlockscout(hre, target, 3)) {
    console.log("  ✔ Code source vérifié.");
  } else {
    console.log(`  À relancer plus tard : ${manualVerifyCommand(networkName, target)}`);
  }
  console.log("\nMets cette adresse dans la CONFIG du site : le jeu s'y branchera.");
}

await runScript(async () => {
  const connection = await hre.network.create();
  const profile = await resolveNetworkProfile(connection.networkName, connection.ethers.provider, [
    "robinhoodTestnet",
    "robinhood",
  ]);
  const releaseLock = await acquireLock(connection.networkName);
  try {
    await deployGame(connection, profile);
  } finally {
    await releaseLock();
  }
});
