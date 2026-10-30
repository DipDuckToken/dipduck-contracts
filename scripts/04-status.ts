/**
 * État du lancement, en lecture seule : aucune clé privée n'est chargée.
 * (Le mot de passe du keystore peut quand même être demandé si ton URL RPC
 * y est enregistrée.)
 *
 *   npm run status:testnet
 *   npm run status:mainnet
 */
import { Contract, MaxUint256 } from "ethers";
import hre from "hardhat";

import { UNIT } from "./lib/constants.ts";
import { formatDelay, formatOpenAt, readCurveStatus } from "./lib/curve.ts";
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

  if (record?.vesting?.status === "pending") {
    console.log("\n  ⚠ Le déploiement du contrat de blocage est noté mais pas encore confirmé.");
    console.log(`  Relance npm run deploy:${step} pour reprendre son suivi.`);
  }
  if (record?.token === undefined) {
    throw new LaunchError(`Aucun token dans le journal (${journal.location}).`);
  }
  if (record.token.status !== "confirmed") {
    console.log(`\n  Déploiement de la courbe noté (nonce ${record.token.nonce}) mais pas encore confirmé.`);
    console.log(`  Relance npm run deploy:${step} pour reprendre son suivi.`);
    return;
  }

  const token = new Contract(record.token.address, ERC20_ABI, ethers.provider);
  const [name, symbol, totalSupply, deployerBalance, curve, latest] = await Promise.all([
    token.name() as Promise<string>,
    token.symbol() as Promise<string>,
    token.totalSupply() as Promise<bigint>,
    token.balanceOf(record.token.from) as Promise<bigint>,
    readCurveStatus(ethers.provider, record.token.curve),
    ethers.provider.getBlock("latest"),
  ]);
  const now = BigInt(latest?.timestamp ?? Math.floor(Date.now() / 1000));
  const curveBalance = (await token.balanceOf(curve.curve)) as bigint;

  heading(`${name} (${symbol}) — ${profile.label}`);
  row("Token", record.token.address);
  row("Offre totale", `${formatTokenAmount(totalSupply)} ${symbol}`);
  row("Détenu par le déployeur", deployerBalance === 0n ? "rien ✔" : `${formatTokenAmount(deployerBalance)} ${symbol} ⚠`);
  row("Explorateur", explorerLink(profile, "token", record.token.address) ?? "—");

  heading("Courbe de lancement");
  row("Adresse (pour acheter)", curve.curve);
  const open = now >= curve.openAt;
  row("Ouverture des achats", `${formatOpenAt(curve.openAt)} — ${open ? "ouverte ✔" : `pas encore (${formatDelay(curve.openAt, now)})`}`);
  row("ETH réuni", `${formatEth(curve.ethReserve)} / ${formatEth(curve.targetEth)} (${percent(curve.ethReserve, curve.targetEth)})`);
  row(
    "Tokens vendus",
    `${formatTokenAmount(curve.tokensSold)} ${symbol} — ${percent(curve.tokensSold, curve.curveTokens)} de ce que la courbe vend, ` +
      `${percent(curve.tokensSold, totalSupply)} de l'offre`,
  );
  if (!curve.graduated) {
    row("Prix actuel", `${formatRatio(curve.price, UNIT)} ETH par ${symbol}`);
    row("Capitalisation actuelle", formatEth((curve.price * totalSupply) / UNIT));
    row(
      "Limite par wallet",
      !open
        ? "achats pas encore ouverts"
        : curve.walletLimit === MaxUint256
          ? "aucune (24 h passées)"
          : `${formatTokenAmount(curve.walletLimit)} ${symbol} (${percent(curve.walletLimit, totalSupply)} de l'offre)`,
    );
    row("Tokens dans la courbe", `${formatTokenAmount(curveBalance)} ${symbol} (ta part et la réserve comprises)`);
  }
  row("Explorateur", explorerLink(profile, "address", curve.curve) ?? "—");

  if (curve.vestingTokens > 0n && record.vesting?.status === "confirmed") {
    const vesting = await readVestingStatus(ethers.provider, record.vesting.address, record.token.address);
    heading("Ta part (vesting)");
    row("Contrat de blocage", record.vesting.address);
    row("Bénéficiaire", vesting.beneficiary);
    row("Prévue", `${formatTokenAmount(curve.vestingTokens)} ${symbol} (${percent(curve.vestingTokens, totalSupply)} de l'offre)`);
    if (!curve.graduated) {
      row("", "gardée par la courbe, versée au contrat de blocage à l'ouverture du pool");
    } else {
      row("Encore bloqué", `${formatTokenAmount(vesting.locked)} ${symbol}`);
      row("Déjà versé", `${formatTokenAmount(vesting.released)} ${symbol}`);
      row("Libérable maintenant", `${formatTokenAmount(vesting.releasable)} ${symbol}`);
    }
    row("Falaise", `${formatDate(vesting.cliff)}${now < vesting.cliff ? " — rien de libérable avant" : " ✔ passée"}`);
    row("Fin", formatDate(vesting.end));
    row("Explorateur", explorerLink(profile, "address", record.vesting.address) ?? "—");
    if (vesting.releasable > 0n) {
      const pending = [record.vesting, record.token, record.nft, record.game].some((entry) => entry?.status === "pending");
      console.log(
        pending
          ? "\n  Une part est libérable : termine d'abord l'étape notée en attente, puis npm run release:" + step
          : `\n  Pour verser la part libérable au bénéficiaire : npm run release:${step}`,
      );
    }
  }

  if (curve.communityTokens > 0n) {
    const held = (await token.balanceOf(curve.community)) as bigint;
    heading("Réserve communauté");
    row("Safe communauté", curve.community);
    row("Prévue", `${formatTokenAmount(curve.communityTokens)} ${symbol} (${percent(curve.communityTokens, totalSupply)} de l'offre)`);
    row("Solde actuel", curve.graduated ? `${formatTokenAmount(held)} ${symbol}` : "rien avant l'ouverture du pool (gardée par la courbe)");
    row("Explorateur", explorerLink(profile, "address", curve.community) ?? "—");
  }

  if (!curve.graduated) {
    console.log(
      `\n  Pool pas encore ouvert : il s'ouvrira tout seul quand la courbe aura réuni ${formatEth(curve.targetEth)}` +
        ` (il manque ${formatEth(curve.targetEth - curve.ethReserve)}).`,
    );
    return;
  }

  heading("Pool Uniswap v2 (ouvert par la courbe)");
  const pool = profile.uniswapV2 === undefined
    ? undefined
    : await readPoolStatus(ethers.provider, profile.uniswapV2, record.token.address, record.token.from);
  if (pool === undefined) {
    row("Paire", curve.pair);
    console.log("\n  Uniswap v2 n'est pas référencé sur ce réseau : réserves non lues.");
    return;
  }
  row("Paire", pool.pair);
  row("Réserves", `${formatTokenAmount(pool.tokenReserve)} ${symbol} / ${formatEth(pool.wethReserve)}`);
  row("Prix actuel", `${formatRatio(pool.wethReserve, pool.tokenReserve)} ETH par ${symbol}`);
  row(
    "Capitalisation actuelle",
    pool.tokenReserve === 0n ? "—" : formatEth((pool.wethReserve * totalSupply) / pool.tokenReserve),
  );
  row("Part du pool verrouillée", `${percent(pool.lpBurned, pool.lpTotalSupply)} (adresse morte + adresse 0)`);
  row("Parts LP du déployeur", pool.lpHeldBy === 0n ? "aucune ✔" : `${pool.lpHeldBy} ⚠`);
  row("Explorateur (paire)", explorerLink(profile, "address", pool.pair) ?? "—");
});
