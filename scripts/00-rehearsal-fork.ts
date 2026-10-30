/**
 * Répétition générale sur une copie locale du mainnet (fork) :
 * vrais contrats Uniswap v2 de Robinhood Chain, comptes de test locaux,
 * exactement les mêmes étapes que le vrai lancement, puis la vie de la courbe
 * jusqu'à l'ouverture du pool (le temps est avancé sur la copie locale).
 * Rien n'est signé avec ta clé et rien n'est envoyé sur le vrai réseau.
 *
 *   npm run rehearsal
 */
import hre from "hardhat";

import { launchConfig } from "../launch.config.ts";
import { UNIT } from "./lib/constants.ts";
import { formatOpenAt } from "./lib/curve.ts";
import { LaunchError, runScript } from "./lib/errors.ts";
import { formatDate, formatEth, formatRatio, formatTokenAmount, heading, percent, row } from "./lib/format.ts";
import { resolveNetworkProfile } from "./lib/networks.ts";
import { runRehearsal } from "./lib/rehearsal.ts";
import {
  type TokenParams,
  type ValidatedCommunity,
  type ValidatedCurve,
  isPlaceholder,
  validateCommunityParams,
  validateCurveParams,
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
  const block = await ethers.provider.getBlock("latest");
  if (block === null) throw new LaunchError("Impossible de lire le dernier bloc du fork.");
  const now = BigInt(block.timestamp);

  // L'heure de launch.config.ts sert si elle tombe dans la fenêtre du contrat vue depuis la copie
  // locale ; sinon (vide, trop lointaine…), l'ouverture est simulée dans 2 h.
  let curve: ValidatedCurve;
  let openAtNote: string | undefined;
  try {
    curve = validateCurveParams(launchConfig.curve, { supplyWholeTokens: params.supply, now, isMainnet: false });
  } catch (error) {
    if (launchConfig.curve.openAt.trim() === "") throw error;
    curve = validateCurveParams({ ...launchConfig.curve, openAt: "" }, { supplyWholeTokens: params.supply, now, isMainnet: false });
    openAtNote = `curve.openAt (${launchConfig.curve.openAt}) est hors de la fenêtre du contrat vue d'ici : ouverture simulée dans 2 h`;
  }
  if (launchConfig.curve.openAt.trim() === "") {
    openAtNote = "curve.openAt est vide : ouverture simulée dans 2 h (obligatoire sur le mainnet)";
  }

  const [deployer] = await ethers.getSigners();
  const vesting = launchConfig.vesting.enabled ? validateVestingParams(launchConfig.vesting, deployer.address) : undefined;
  // Safe communauté pas encore choisi : la répétition déploie un Safe d'essai 2 sur 3 à sa place.
  const configuredSafe = launchConfig.community.beneficiary.trim();
  let community: ValidatedCommunity;
  if (configuredSafe === "" && launchConfig.community.percent > 0) {
    validateCommunityParams(
      { ...launchConfig.community, beneficiary: "0x000000000000000000000000000000000000bEEF" },
      deployer.address,
      curve.tokenPercent,
    );
    community = { percent: BigInt(launchConfig.community.percent), beneficiary: undefined };
  } else {
    community = validateCommunityParams(launchConfig.community, deployer.address, curve.tokenPercent);
  }

  heading("Répétition générale — copie locale du mainnet");
  row("Bloc de départ", `${block.number} (${new Date(block.timestamp * 1000).toISOString()})`);
  row("Ouverture des achats", formatOpenAt(curve.openAt));
  if (openAtNote !== undefined) console.log(`  ℹ ${openAtNote}.`);
  if (isPlaceholder(params)) {
    console.log("  ℹ Nom et symbole d'exemple : à remplacer avant le vrai lancement.");
  }
  console.log("");

  const report = await runRehearsal(
    connection,
    profile.uniswapV2,
    { token: params, curve, vesting, community },
    (message) => console.log(`  ${message}`),
  );
  const { plan, antiBot, graduation, pool, gasUsed } = report;
  const symbol = params.symbol;
  const tokens = (amount: bigint) => `${formatTokenAmount(amount)} ${symbol}`;

  heading("Résultat");
  row("Token (local)", report.token.address);
  row("Courbe (locale)", report.token.curve);
  row("Prix de départ", `${formatRatio(plan.startPriceWei, UNIT)} ETH par ${symbol}`);
  row("Capitalisation de départ", `≈ ${formatEth(plan.startFdvWei)}`);
  row("0,5 % de l'offre coûtait", `≈ ${formatEth(plan.halfPercentCostWei)}`);
  row("Avant l'heure", antiBot.buyBeforeOpenBlocked ? "achat refusé ✔" : "achat accepté ⚠");
  row("1re heure", `max ${tokens(antiBot.limitAtOpen)} par wallet : achat au-delà refusé ✔`);
  row(
    "Petits achats",
    `${report.smallBuys.buyers} acheteurs, ${formatEth(report.smallBuys.ethIn)} → ${tokens(report.smallBuys.tokensOut)} (montants exacts ✔)`,
  );
  row("Revente à la courbe", `${tokens(report.resale.tokensIn)} → ${formatEth(report.resale.ethOut)} (montant exact ✔)`);
  row(
    "Cible atteinte (après 24 h)",
    `${formatEth(graduation.ethSent)} envoyés, ${formatEth(graduation.ethUsed)} utilisés, ${formatEth(graduation.refunded)} rendus ✔`,
  );
  row("Pool ouvert", `${tokens(graduation.tokensInPool)} / ${formatEth(graduation.ethInPool)} — paire ${graduation.pair}`);
  row("Prix à l'ouverture", `${formatRatio(pool.wethReserve, pool.tokenReserve)} ETH par ${symbol} (prévu : ${formatRatio(plan.endPriceWei, UNIT)})`);
  row("Parts LP brûlées", `${formatTokenAmount(graduation.lpBurned)} — toutes (${percent(pool.lpBurned, pool.lpTotalSupply)} du pool verrouillé) ✔`);
  if (graduation.tokensBurned > 0n) row("Arrondis brûlés", tokens(graduation.tokensBurned));
  if (report.vestingRecord !== undefined) {
    row("Ta part versée au blocage", `${tokens(graduation.vestingReceived)} (${percent(graduation.vestingReceived, plan.totalSupply)}) ✔`);
  }
  if (report.communitySafe !== undefined) {
    row(
      "Réserve versée au Safe",
      `${tokens(graduation.communityReceived)} (${percent(graduation.communityReceived, plan.totalSupply)}) ✔` +
        (report.communitySafe.fakeSafe ? " — Safe d'essai : renseigne community.beneficiary avant le vrai lancement" : ""),
    );
  }
  row("Achat Uniswap", `${formatEth(report.routerBuy.ethIn)} → ${tokens(report.routerBuy.tokensOut)} (montant exact ✔)`);
  row("Anti-bot du token (24 h)", antiBot.poolBigBuyBlocked ? "gros achat sur Uniswap refusé ✔" : "non testé (pool trop petit)");
  if (report.vesting !== undefined) {
    const { cliff, end, releasedAtCliff, releasedAtEnd } = report.vesting;
    row("Libération test", `falaise (${formatDate(cliff)}) → ${tokens(releasedAtCliff)}`);
    row("", `fin (${formatDate(end)}) → ${tokens(releasedAtEnd)}, tout versé au bénéficiaire ✔`);
  }
  row("Gas blocage/courbe/cible", `${gasUsed.vesting} / ${gasUsed.curve} / ${gasUsed.graduation}`);
  console.log(
    "\n✔ Répétition réussie. Les montants de gas sont ceux de l'exécution ; sur Robinhood Chain,\n" +
      "  les frais réels ajoutent la part « données L1 » de chaque transaction.",
  );
});
