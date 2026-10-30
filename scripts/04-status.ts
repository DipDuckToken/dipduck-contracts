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
import { LaunchError, runScript } from "./lib/errors.ts";
import { formatDate, formatEth, formatRatio, formatTokenAmount, heading, percent, row } from "./lib/format.ts";
import { formatDelay, formatOpenAt, readLaunchStatus, tokenBalance } from "./lib/launch.ts";
import { explorerLink, resolveNetworkProfile } from "./lib/networks.ts";
import { fileJournal } from "./lib/records.ts";
import { ERC20_ABI } from "./lib/uniswap.ts";
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
    console.log(`\n  Déploiement du lanceur noté (nonce ${record.token.nonce}) mais pas encore confirmé.`);
    console.log(`  Relance npm run deploy:${step} pour reprendre son suivi.`);
    return;
  }

  const token = new Contract(record.token.address, ERC20_ABI, ethers.provider);
  const [name, symbol, totalSupply, deployerBalance, launch, latest] = await Promise.all([
    token.name() as Promise<string>,
    token.symbol() as Promise<string>,
    token.totalSupply() as Promise<bigint>,
    token.balanceOf(record.token.from) as Promise<bigint>,
    readLaunchStatus(ethers.provider, record.token.launcher),
    ethers.provider.getBlock("latest"),
  ]);
  const now = BigInt(latest?.timestamp ?? Math.floor(Date.now() / 1000));
  const { state } = launch;

  heading(`${name} (${symbol}) — ${profile.label}`);
  row("Token", record.token.address);
  row("Offre totale", `${formatTokenAmount(totalSupply)} ${symbol}`);
  row("Détenu par le déployeur", deployerBalance === 0n ? "rien ✔" : `${formatTokenAmount(deployerBalance)} ${symbol} ⚠`);
  row("Explorateur", explorerLink(profile, "token", record.token.address) ?? "—");

  heading("Pool Uniswap v3 (TOKEN/WETH, 1 %)");
  row("Pool", launch.pool);
  const open = now >= launch.openAt;
  row("Ouverture des échanges", `${formatOpenAt(launch.openAt)} — ${open ? "ouverts ✔" : `pas encore (${formatDelay(launch.openAt, now)})`}`);
  row("Prix actuel", `${formatRatio(state.priceWei, UNIT)} ETH par ${symbol}`);
  row("Capitalisation actuelle", formatEth((state.priceWei * totalSupply) / UNIT));
  row("ETH dans le pool", `${formatEth(state.wethBalance)} (apporté par les acheteurs)`);
  row("Tokens dans le pool", `${formatTokenAmount(state.tokenBalance)} ${symbol} (${percent(state.tokenBalance, totalSupply)} de l'offre)`);
  row("Placés au lancement", `${formatTokenAmount(launch.poolTokens)} ${symbol}`);
  row(
    "Limite par wallet",
    !open
      ? "aucun achat possible avant l'ouverture"
      : launch.walletLimit === MaxUint256
        ? "aucune (24 h passées)"
        : `${formatTokenAmount(launch.walletLimit)} ${symbol} (${percent(launch.walletLimit, totalSupply)} de l'offre)`,
  );
  row("Liquidité", `position n° ${launch.positionId}, gardée à vie par le lanceur ${launch.launcher}`);
  row(
    "Frais en attente",
    launch.pendingFees === undefined
      ? "illisibles pour l'instant (pendant les 24 h, le Safe peut dépasser la limite : réessaie après)"
      : `${formatEth(launch.pendingFees.weth)} et ${formatTokenAmount(launch.pendingFees.tokens)} ${symbol}` +
          (launch.pendingFees.weth > 0n || launch.pendingFees.tokens > 0n
            ? ` — npm run fees:${step} les partage (${100n - launch.teamFeePercent} % communauté, ${launch.teamFeePercent} % équipe)`
            : ""),
  );
  row("Explorateur (pool)", explorerLink(profile, "address", launch.pool) ?? "—");

  if (launch.vestingTokens > 0n && record.vesting?.status === "confirmed") {
    const vesting = await readVestingStatus(ethers.provider, record.vesting.address, record.token.address);
    heading("Ta part (vesting)");
    row("Contrat de blocage", record.vesting.address);
    row("Bénéficiaire", vesting.beneficiary);
    row("Encore bloqué", `${formatTokenAmount(vesting.locked)} ${symbol} (${percent(vesting.locked, totalSupply)} de l'offre)`);
    row("Déjà versé", `${formatTokenAmount(vesting.released)} ${symbol}`);
    row("Libérable maintenant", `${formatTokenAmount(vesting.releasable)} ${symbol}`);
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

  const teamPercent = launch.teamFeePercent;
  for (const [title, address, share] of [
    ["Safe communauté", launch.feeRecipient, 100n - teamPercent],
    ["Safe de l'équipe", launch.teamFeeRecipient, teamPercent],
  ] as const) {
    heading(title);
    row("Adresse", address);
    row("Part des frais du pool", `${share} %`);
    if (address === launch.feeRecipient && launch.communityTokens > 0n) {
      row("Réserve versée au lancement", `${formatTokenAmount(launch.communityTokens)} ${symbol} (${percent(launch.communityTokens, totalSupply)})`);
    }
    const [safeTokens, safeWeth] = await Promise.all([
      tokenBalance(ethers.provider, record.token.address, address),
      tokenBalance(ethers.provider, launch.weth, address),
    ]);
    row("Solde actuel", `${formatTokenAmount(safeTokens)} ${symbol} et ${formatEth(safeWeth)} de WETH`);
    row("Explorateur", explorerLink(profile, "address", address) ?? "—");
  }
});
