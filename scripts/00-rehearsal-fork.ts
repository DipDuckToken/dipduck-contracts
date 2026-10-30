/**
 * Répétition générale sur une copie locale du mainnet (fork) :
 * vrais contrats Uniswap v2 de Robinhood Chain, comptes de test locaux,
 * exactement les mêmes étapes que le vrai lancement.
 * Rien n'est signé avec ta clé et rien n'est envoyé sur le vrai réseau.
 *
 *   npm run rehearsal
 */
import hre from "hardhat";

import { launchConfig } from "../launch.config.ts";
import { LaunchError, runScript } from "./lib/errors.ts";
import { formatDate, formatEth, formatRatio, formatTokenAmount, heading, percent, row } from "./lib/format.ts";
import { resolveNetworkProfile } from "./lib/networks.ts";
import { runRehearsal } from "./lib/rehearsal.ts";
import {
  type TokenParams,
  isPlaceholder,
  validateCommunityParams,
  validateLiquidityParams,
  validateTokenParams,
  validateVestingParams,
} from "./lib/validation.ts";

await runScript(async () => {
  const connection = await hre.network.create();
  const { ethers, networkName } = connection;
  const profile = await resolveNetworkProfile(networkName, ethers.provider, ["robinhoodFork"]);
  if (profile.uniswapV2 === undefined) {
    throw new LaunchError("Adresses Uniswap v2 manquantes pour le fork.");
  }

  const params: TokenParams = launchConfig.token;
  validateTokenParams(params, { allowPlaceholder: true });
  const liquidity = validateLiquidityParams(launchConfig.liquidity);
  const [deployer, , communityTestWallet] = await ethers.getSigners();
  const vesting =
    liquidity.tokenPercent < 100n && launchConfig.vesting.enabled
      ? validateVestingParams(launchConfig.vesting, deployer.address)
      : undefined;
  // Wallet communauté pas encore choisi : un compte de test local le remplace pour la répétition.
  const communityBeneficiary = launchConfig.community.beneficiary.trim() || communityTestWallet.address;
  const community = validateCommunityParams(
    { ...launchConfig.community, beneficiary: communityBeneficiary },
    deployer.address,
    liquidity.tokenPercent,
  );

  const block = await ethers.provider.getBlock("latest");
  heading("Répétition générale — copie locale du mainnet");
  row("Bloc de départ", block === null ? "—" : `${block.number} (${new Date(block.timestamp * 1000).toISOString()})`);
  if (isPlaceholder(params)) {
    console.log("  ℹ Nom et symbole d'exemple : à remplacer avant le vrai lancement.");
  }
  console.log("");

  const report = await runRehearsal(
    connection,
    profile.uniswapV2,
    { token: params, liquidity, vesting, community },
    (message) => console.log(`  ${message}`),
  );
  const { plan, pool, outcome, roundTrip, gasUsed } = report;
  const roundTripLoss = roundTrip.ethIn - roundTrip.ethBack;

  heading("Résultat");
  row("Token (local)", report.token.address);
  row("PoolSeeder (local)", report.seeder.address);
  row("Paire (locale)", outcome.pair);
  row("Pool", `${formatTokenAmount(outcome.tokenAmount)} ${params.symbol} / ${formatEth(outcome.ethAmount)}`);
  row("Prix de départ", `${formatRatio(plan.ethAmount, plan.tokenAmount)} ETH par ${params.symbol}`);
  row("Capitalisation de départ", formatEth(plan.impliedFdvWei));
  row("Parts LP brûlées", `${formatTokenAmount(outcome.lpBurned)} (toutes, lu dans le reçu) ✔`);
  row("Part du pool verrouillée", percent(pool.lpBurned, pool.lpTotalSupply));
  row("Achat test", `${formatEth(roundTrip.ethIn)} → ${formatTokenAmount(roundTrip.tokensBought)} ${params.symbol}`);
  row(
    "Revente test",
    `→ ${formatEth(roundTrip.ethBack)} (écart ${percent(roundTripLoss, roundTrip.ethIn)} : frais 2 × 0,3 % + impact de prix)`,
  );
  row(
    "Anti-bot",
    `max ${formatTokenAmount(report.antiBot.limitAtLaunch)} ${params.symbol} par wallet à l'ouverture : ` +
      "gros achat refusé ✔, accepté après 24 h ✔",
  );
  row("Gas token/seeder/pool", `${gasUsed.token} / ${gasUsed.seeder} / ${gasUsed.seed}`);
  if (report.vesting !== undefined) {
    const { locked, cliff, end, releasedAtCliff, releasedAtEnd } = report.vesting;
    row("Part bloquée", `${formatTokenAmount(locked)} ${params.symbol} (${percent(locked, plan.tokenTotalSupply)} de l'offre)`);
    row("Contrat de blocage (local)", report.vesting.record.address);
    row("Libération test", `falaise (${formatDate(cliff)}) → ${formatTokenAmount(releasedAtCliff)} ${params.symbol}`);
    row("", `fin (${formatDate(end)}) → ${formatTokenAmount(releasedAtEnd)} ${params.symbol}, tout versé au bénéficiaire ✔`);
  }
  if (report.community !== undefined) {
    const amount = BigInt(report.community.amount);
    row("Réserve communauté", `${formatTokenAmount(amount)} ${params.symbol} (${percent(amount, plan.tokenTotalSupply)} de l'offre)`);
    row(
      "Wallet communauté",
      launchConfig.community.beneficiary.trim() === ""
        ? `${report.community.recipient} (compte de test : renseigne community.beneficiary avant le vrai lancement)`
        : report.community.recipient,
    );
  }
  console.log(
    "\n✔ Répétition réussie. Les montants de gas sont ceux de l'exécution ; sur Robinhood Chain,\n" +
      "  les frais réels ajoutent la part « données L1 » de chaque transaction.",
  );
});
