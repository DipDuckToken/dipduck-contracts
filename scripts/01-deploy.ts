/**
 * Étape 1 — Déploie le token (testnet ou mainnet) puis vérifie son code sur
 * Blockscout.
 *
 *   npm run deploy:testnet
 *   npm run deploy:mainnet
 *
 * Sur le mainnet, le plan s'affiche d'abord et rien n'est envoyé tant que tu
 * n'as pas retapé le symbole. La transaction est signée puis notée dans
 * deployments/ (hash compris) AVANT d'être diffusée : si le script est
 * interrompu à n'importe quel moment, relancer la même commande reprend le
 * suivi sans jamais redéployer.
 */
import hre from "hardhat";
import type { NetworkConnection } from "hardhat/types/network";

import { launchConfig } from "../launch.config.ts";
import { UNIT } from "./lib/constants.ts";
import { LaunchError, runScript } from "./lib/errors.ts";
import { confirmByTypingSymbol, formatEth, formatTokenAmount, heading, row } from "./lib/format.ts";
import { type NetworkProfile, explorerLink, resolveNetworkProfile } from "./lib/networks.ts";
import { acquireLock, fileJournal } from "./lib/records.ts";
import { type StepContext, deployTokenStep } from "./lib/steps.ts";
import { TOKEN_CONTRACT, constructorArgs, estimateTokenDeployment, paramsOf } from "./lib/token.ts";
import { type TokenParams, validateTokenParams } from "./lib/validation.ts";
import { manualVerifyCommand, verifyOnBlockscout } from "./lib/verify.ts";
import { assertSameAccount, localWallet } from "./lib/wallet.ts";

async function deploy(connection: NetworkConnection, profile: NetworkProfile): Promise<void> {
  const { ethers, networkName } = connection;
  const journal = fileJournal(networkName);
  const existing = await journal.read();
  const [signer] = await ethers.getSigners();
  const wallet = await localWallet(connection);
  assertSameAccount(wallet, signer.address);
  const { chainId } = await ethers.provider.getNetwork();

  // Le token crée sa paire Uniswap v2 au déploiement : la limite anti-bot s'y attache.
  const params: TokenParams = { ...launchConfig.token, factory: profile.uniswapV2?.factory, weth: profile.uniswapV2?.weth };
  if (profile.isMainnet && profile.uniswapV2 === undefined) {
    throw new LaunchError("Adresses Uniswap v2 manquantes : impossible d'activer l'anti-bot. Rien n'a été envoyé.");
  }
  const symbol = existing?.token?.symbol ?? params.symbol;

  if (existing?.token === undefined) {
    validateTokenParams(params, { allowPlaceholder: false });
    const [balance, sentCount, estimate] = await Promise.all([
      ethers.provider.getBalance(signer.address),
      ethers.provider.getTransactionCount(signer.address, "latest"),
      estimateTokenDeployment(ethers, signer, params),
    ]);

    heading(`Déploiement — ${profile.label}`);
    row("Wallet de déploiement", signer.address);
    row("Solde", formatEth(balance));
    row("Transactions déjà envoyées", sentCount === 0 ? "0 (wallet neuf ✔)" : `${sentCount} ⚠ ce wallet n'est pas neuf`);
    row("Nom", params.name);
    row("Symbole", params.symbol);
    row("Offre totale", `${formatTokenAmount(params.supply * UNIT)} ${params.symbol}`);
    row(
      "Anti-bot",
      params.factory === undefined
        ? "aucun (pas d'Uniswap v2 sur ce réseau)"
        : "max 0,5 % par wallet la 1re heure, 1 % jusqu'à 6 h, 2 % jusqu'à 24 h, puis aucune limite",
    );
    row("Gas estimé", estimate.gas.toString());
    row("Coût maximal estimé", formatEth(estimate.maxCostWei));

    if (balance < estimate.maxCostWei) {
      throw new LaunchError("Solde insuffisant pour payer le déploiement. Rien n'a été envoyé.");
    }
    if (profile.isMainnet) {
      await confirmByTypingSymbol(params.symbol, `déployer ${params.symbol} (action irréversible)`);
    }
    console.log("\nEnvoi du déploiement…");
  }

  const ctx: StepContext = {
    ethers,
    wallet,
    journal,
    networkName,
    chainId,
    confirm: profile.isMainnet ? (action) => confirmByTypingSymbol(symbol, action) : async () => {},
    log: (message) => console.log(`  ${message}`),
  };
  const token = await deployTokenStep(ctx, params);

  heading("Token déployé");
  row("Adresse", token.address);
  row("Transaction", token.txHash);
  row("Explorateur", explorerLink(profile, "token", token.address) ?? "—");
  row("Journal", journal.location);

  console.log("\nVérification du code source sur Blockscout…");
  const target = { address: token.address, contract: TOKEN_CONTRACT, constructorArgs: constructorArgs(paramsOf(token)) };
  if (await verifyOnBlockscout(hre, target)) {
    console.log("  ✔ Code source vérifié.");
  } else {
    console.log("  Relance-la plus tard avec :");
    console.log(`  ${manualVerifyCommand(networkName, target)}`);
  }

  const step = profile.isMainnet ? "mainnet" : "testnet";
  if (launchConfig.vesting.enabled && launchConfig.liquidity.tokenPercent < 100) {
    console.log(`\nÉtape suivante : npm run lock:${step} (bloque ta part avant l'ouverture du pool)`);
  } else if (profile.isMainnet) {
    console.log("\nÉtape suivante : npm run liquidity:mainnet");
  } else {
    console.log("\nTestnet validé. Répète l'ouverture du pool sur le fork (npm run rehearsal), puis passe au mainnet.");
  }
}

await runScript(async () => {
  const connection = await hre.network.create();
  const profile = await resolveNetworkProfile(connection.networkName, connection.ethers.provider, [
    "robinhoodTestnet",
    "robinhood",
  ]);
  // Un seul lancement à la fois sur ce réseau (deux terminaux pourraient sinon signer chacun le leur).
  const releaseLock = await acquireLock(connection.networkName);
  try {
    await deploy(connection, profile);
  } finally {
    await releaseLock();
  }
});
