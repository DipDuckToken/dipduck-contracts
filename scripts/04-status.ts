/**
 * État du lancement, en lecture seule : aucune clé privée n'est chargée.
 * (Le mot de passe du keystore peut quand même être demandé si ton URL RPC
 * y est enregistrée.)
 *
 *   npm run status:testnet
 *   npm run status:mainnet
 */
import { Contract } from "ethers";
import hre from "hardhat";

import { launchConfig } from "../launch.config.ts";
import { LaunchError, runScript } from "./lib/errors.ts";
import { formatDate, formatEth, formatRatio, formatTokenAmount, heading, percent, row } from "./lib/format.ts";
import { explorerLink, resolveNetworkProfile } from "./lib/networks.ts";
import { fileJournal } from "./lib/records.ts";
import { ERC20_ABI, readPoolStatus } from "./lib/uniswap.ts";
import { readVestingStatus } from "./lib/vesting.ts";

await runScript(async () => {
  const { ethers, networkName } = await hre.network.create({
    network: hre.globalOptions.network,
    override: { accounts: [] },
  });
  const profile = await resolveNetworkProfile(networkName, ethers.provider, ["robinhood", "robinhoodTestnet"]);
  const journal = fileJournal(networkName);
  const record = await journal.read();
  const step = profile.isMainnet ? "mainnet" : "testnet";

  if (record?.token === undefined) {
    throw new LaunchError(`Aucun token dans le journal (${journal.location}).`);
  }
  if (record.token.status !== "confirmed") {
    console.log(`\n  Déploiement noté (nonce ${record.token.nonce}) mais pas encore confirmé.`);
    console.log(`  Relance npm run deploy:${step} pour reprendre son suivi.`);
    return;
  }
  if ([record.seeder, record.approval, record.liquidity].some((entry) => entry?.status === "pending")) {
    console.log("\n  ⚠ Une étape de l'ouverture du pool est notée mais pas encore confirmée.");
    console.log("  Relance npm run liquidity:mainnet pour reprendre son suivi.");
  }
  if (record.vesting?.status === "pending" || record.lock?.status === "pending" || record.community?.status === "pending") {
    console.log("\n  ⚠ Le blocage de ta part ou l'envoi de la réserve communauté est noté mais pas encore confirmé.");
    console.log(`  Relance npm run lock:${step} pour reprendre son suivi.`);
  }

  const token = new Contract(record.token.address, ERC20_ABI, ethers.provider);
  const [name, symbol, totalSupply, deployerBalance] = (await Promise.all([
    token.name(),
    token.symbol(),
    token.totalSupply(),
    token.balanceOf(record.token.from),
  ])) as [string, string, bigint, bigint];

  heading(`${name} (${symbol}) — ${profile.label}`);
  row("Contrat", record.token.address);
  row("Offre totale", `${formatTokenAmount(totalSupply)} ${symbol}`);
  row("Détenu par le déployeur", `${formatTokenAmount(deployerBalance)} ${symbol} (${percent(deployerBalance, totalSupply)})`);
  row("Explorateur", explorerLink(profile, "token", record.token.address) ?? "—");

  if (record.vesting?.status === "confirmed") {
    const vesting = await readVestingStatus(ethers.provider, record.vesting.address, record.token.address);
    const now = BigInt(Math.floor(Date.now() / 1000));
    heading("Part bloquée (vesting)");
    row("Contrat de blocage", record.vesting.address);
    row("Bénéficiaire", vesting.beneficiary);
    row("Encore bloqué", `${formatTokenAmount(vesting.locked)} ${symbol} (${percent(vesting.locked, totalSupply)} de l'offre)`);
    row("Déjà versé", `${formatTokenAmount(vesting.released)} ${symbol}`);
    row("Libérable maintenant", `${formatTokenAmount(vesting.releasable)} ${symbol}`);
    row("Falaise", `${formatDate(vesting.cliff)}${now < vesting.cliff ? " — rien de libérable avant" : " ✔ passée"}`);
    row("Fin", formatDate(vesting.end));
    row("Explorateur", explorerLink(profile, "address", record.vesting.address) ?? "—");
    if (vesting.releasable > 0n) {
      const pending = [record.vesting, record.lock, record.community, record.seeder, record.approval, record.liquidity].some(
        (entry) => entry?.status === "pending",
      );
      console.log(
        pending
          ? "\n  Une part est libérable : termine d'abord l'étape notée en attente, puis npm run release:" + step
          : `\n  Pour verser la part libérable au bénéficiaire : npm run release:${step}`,
      );
    }
  }

  if (record.community?.status === "confirmed") {
    const held = (await token.balanceOf(record.community.recipient)) as bigint;
    heading("Réserve communauté");
    row("Wallet communauté", record.community.recipient);
    row("Envoyé au lancement", `${formatTokenAmount(BigInt(record.community.amount))} ${symbol}`);
    row("Solde actuel", `${formatTokenAmount(held)} ${symbol} (${percent(held, totalSupply)} de l'offre)`);
    row("Explorateur", explorerLink(profile, "address", record.community.recipient) ?? "—");
  }

  if (profile.uniswapV2 === undefined) {
    console.log("\n  Pas de pool Uniswap v2 référencé sur ce réseau.");
    return;
  }

  const pool = await readPoolStatus(ethers.provider, profile.uniswapV2, record.token.address, record.token.from);
  if (pool === undefined || pool.lpTotalSupply === 0n) {
    const teamPercent = 100 - launchConfig.liquidity.tokenPercent - launchConfig.community.percent;
    const shareNotLocked =
      (launchConfig.vesting.enabled && teamPercent > 0 && record.lock?.status !== "confirmed") ||
      (launchConfig.community.percent > 0 && record.community?.status !== "confirmed");
    console.log(
      shareNotLocked
        ? "\n  Pas encore de pool : bloque d'abord ta part et envoie la réserve (npm run lock:mainnet), puis npm run liquidity:mainnet"
        : "\n  Pas encore de pool : étape suivante, npm run liquidity:mainnet",
    );
    return;
  }

  heading("Pool Uniswap v2");
  row("Paire", pool.pair);
  row("Réserves", `${formatTokenAmount(pool.tokenReserve)} ${symbol} / ${formatEth(pool.wethReserve)}`);
  row("Prix actuel", `${formatRatio(pool.wethReserve, pool.tokenReserve)} ETH par ${symbol}`);
  row(
    "Capitalisation actuelle",
    pool.tokenReserve === 0n ? "—" : formatEth((pool.wethReserve * totalSupply) / pool.tokenReserve),
  );
  if (record.liquidity?.status === "confirmed" && record.liquidity.lpBurned !== undefined) {
    row("LP du lancement", `${formatTokenAmount(BigInt(record.liquidity.lpBurned))} parts, toutes brûlées ✔`);
  }
  row("Part du pool verrouillée", `${percent(pool.lpBurned, pool.lpTotalSupply)} (adresse morte + adresse 0)`);
  row("Parts LP du déployeur", pool.lpHeldBy === 0n ? "aucune ✔" : `${pool.lpHeldBy} ⚠`);
  row("Explorateur (paire)", explorerLink(profile, "address", pool.pair) ?? "—");

  if (record.liquidity?.status === "confirmed" && deployerBalance > 0n && record.lock === undefined) {
    console.log(`\n  ⚠ Ta part (${percent(deployerBalance, totalSupply)}) n'est pas bloquée : npm run lock:${step}`);
  }
});
