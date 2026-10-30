/**
 * Étape 1 — Lance le token : déploie le contrat de blocage de ta part (vesting),
 * puis le lanceur (LaunchPool), qui crée le token, verse ta part au blocage et la
 * réserve au Safe communauté, crée le pool Uniswap v3 TOKEN/WETH (1 %) et y place
 * tout le reste d'un seul côté, verrouillé à vie. Vérifie ensuite les trois codes
 * sources sur Blockscout.
 *
 *   npm run deploy:mainnet
 *   npm run deploy:testnet   (seulement si Uniswap v3 est référencé sur le testnet)
 *
 * Le wallet de déploiement n'apporte aucun ETH (seulement les frais) et ne
 * détient jamais de tokens. Les échanges s'ouvrent tout seuls à pool.openAt.
 *
 * Sur le mainnet, le plan s'affiche d'abord et rien n'est envoyé tant que tu
 * n'as pas retapé le symbole. Chaque transaction est signée puis notée dans
 * deployments/ (hash, sel et adresses compris) AVANT d'être diffusée : si le
 * script est interrompu à n'importe quel moment, relancer la même commande
 * reprend le suivi sans jamais redéployer.
 */
import { Contract, ZeroAddress, getAddress, hexlify, randomBytes } from "ethers";
import hre from "hardhat";
import type { NetworkConnection } from "hardhat/types/network";

import { launchConfig } from "../launch.config.ts";
import { UNIT } from "./lib/constants.ts";
import { LaunchError, runScript } from "./lib/errors.ts";
import {
  confirmByTypingSymbol,
  formatDate,
  formatDays,
  formatEth,
  formatRatio,
  formatTokenAmount,
  heading,
  percent,
  row,
} from "./lib/format.ts";
import { type LaunchPlan, buildLaunchPlan, formatDelay, formatOpenAt, splitSupply } from "./lib/launch.ts";
import { type NetworkProfile, type UniswapV3Deployment, explorerLink, resolveNetworkProfile } from "./lib/networks.ts";
import { type TokenRecord, type VestingRecord, acquireLock, fileJournal } from "./lib/records.ts";
import { assertSafe } from "./lib/safe.ts";
import {
  type LaunchParams,
  type StepContext,
  type VestingPlan,
  deployTokenStep,
  deployVestingStep,
  launchParamsOf,
} from "./lib/steps.ts";
import {
  LAUNCHER_CONTRACT,
  TOKEN_CONTRACT,
  VESTING_CONTRACT,
  estimateDeployment,
  launcherConstructorArgs,
  tokenConstructorArgs,
  vestingConstructorArgs,
} from "./lib/token.ts";
import { assertUniswapV3Deployment } from "./lib/uniswap.ts";
import {
  validateCommunityParams,
  validatePoolParams,
  validateTokenParams,
  validateVestingParams,
  validateVestingPercent,
} from "./lib/validation.ts";
import { manualVerifyCommand, verifyOnBlockscout } from "./lib/verify.ts";
import { assertSameAccount, localWallet } from "./lib/wallet.ts";

/** Calendrier noté dans le journal (reprise ou contrat déjà déployé). */
function planFromJournal(vesting: VestingRecord): VestingPlan {
  return {
    beneficiary: vesting.beneficiary,
    start: BigInt(vesting.start),
    durationSeconds: BigInt(vesting.durationSeconds),
    cliffSeconds: BigInt(vesting.cliffSeconds),
  };
}

/** Affiche les chiffres du pool (prix, capitalisation, coût de 0,5 %, répartition). */
function showLaunchPlan(plan: LaunchPlan, symbol: string, wantedCapWei: bigint): void {
  row("Dans le pool", `${formatTokenAmount(plan.poolAmount)} ${symbol} (${percent(plan.poolAmount, plan.totalSupply)} de l'offre), d'un seul côté`);
  row("Pool", "Uniswap v3 TOKEN/WETH, frais de 1 %, liquidité verrouillée à vie");
  row("Prix de départ", `${formatRatio(plan.startPriceWei, UNIT)} ETH par ${symbol} (tick ${plan.startTick})`);
  row("Capitalisation de départ", `≈ ${formatEth(plan.startFdvWei)} (demandé : ${formatEth(wantedCapWei)})`);
  row("0,5 % de l'offre coûte", `≈ ${formatEth(plan.halfPercentCostWei)} au tout premier achat, frais de 1 % compris`);
  row("Ensuite", "chaque achat fait monter le prix ; l'ETH des acheteurs reste dans le pool");
}

async function deploy(connection: NetworkConnection, profile: NetworkProfile, uniswap: UniswapV3Deployment): Promise<void> {
  const { ethers, networkName } = connection;
  const journal = fileJournal(networkName);
  const existing = await journal.read();
  const [signer] = await ethers.getSigners();
  const wallet = await localWallet(connection);
  assertSameAccount(wallet, signer.address);
  const { chainId } = await ethers.provider.getNetwork();
  const symbol = existing?.token?.symbol ?? launchConfig.token.symbol;

  if (existing?.token?.status === "confirmed") {
    throw new LaunchError(
      `Le token est déjà lancé sur ce réseau : ${existing.token.address} (lanceur ${existing.token.launcher}).\n` +
        `  Suivi : npm run status:${profile.isMainnet ? "mainnet" : "testnet"}. Pour en lancer un autre volontairement, ` +
        `renomme d'abord ${journal.location}.`,
    );
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

  let vesting: VestingRecord | undefined = existing?.vesting?.status === "confirmed" ? existing.vesting : undefined;
  let token: TokenRecord;
  if (existing?.token?.status === "pending") {
    // Reprise : les paramètres (sel compris) viennent du journal, pas de la config.
    token = await deployTokenStep(ctx, launchParamsOf(existing.token));
    vesting = existing.vesting;
  } else {
    // 1. Un contrat de blocage noté mais pas confirmé passe en premier : ces octets-là existent.
    if (existing?.vesting?.status === "pending") {
      vesting = await deployVestingStep(ctx, planFromJournal(existing.vesting));
    }

    // 2. Nouvelles signatures : tout est validé avant la première.
    validateTokenParams(launchConfig.token, { allowPlaceholder: false });
    await assertUniswapV3Deployment(ethers.provider, uniswap);
    const latest = await ethers.provider.getBlock("latest");
    if (latest === null) throw new LaunchError("Impossible de lire le dernier bloc. Rien n'a été envoyé.");
    const now = BigInt(latest.timestamp);
    const supply = launchConfig.token.supply;
    const pool = validatePoolParams(launchConfig.pool, { supplyWholeTokens: supply, now, isMainnet: profile.isMainnet });
    const vestingPercent = validateVestingPercent(launchConfig.vesting);
    const reserve = validateCommunityParams(launchConfig.community, signer.address, vestingPercent);
    const split = splitSupply(supply, vestingPercent, reserve.percent);
    const plan = buildLaunchPlan({ supplyWholeTokens: supply, split, startTick: pool.startTick });

    // Ta part : bloquée dans un contrat de vesting déployé maintenant, rempli par le lanceur.
    let vestingPlan: VestingPlan | undefined;
    if (split.vestingWholeTokens > 0n) {
      if (vesting !== undefined) {
        // Contrat déjà déployé par une exécution précédente (vide) : son calendrier doit correspondre.
        vestingPlan = planFromJournal(vesting);
        if (vestingPlan.start !== pool.openAt) {
          throw new LaunchError(
            `Le contrat de blocage déjà déployé (${vesting.address}) commence le ${formatOpenAt(vestingPlan.start)}, ` +
              `mais pool.openAt vaut ${formatOpenAt(pool.openAt)}. Remets cette heure dans launch.config.ts, ou ` +
              'retire seulement l\'entrée "vesting" du journal (ce contrat est vide) pour en déployer un neuf. Rien n\'a été envoyé.',
          );
        }
      } else {
        const config = validateVestingParams(launchConfig.vesting, signer.address, { requireSeparateWallet: profile.isMainnet });
        if ((await ethers.provider.getCode(config.beneficiary)) !== "0x") {
          throw new LaunchError(
            `Le bénéficiaire ${config.beneficiary} est un contrat sur cette chaîne : choisis l'adresse d'un wallet ` +
              "ordinaire dont tu as la clé. Rien n'a été envoyé.",
          );
        }
        // Le calendrier démarre à l'ouverture des échanges.
        vestingPlan = {
          beneficiary: config.beneficiary,
          start: pool.openAt,
          durationSeconds: config.durationSeconds,
          cliffSeconds: config.cliffSeconds,
        };
      }
    }

    // Safe communauté : reçoit la réserve et les frais d'échange ; un vrai Safe 2 sur 3, qui doit exister avant.
    if (reserve.beneficiary === undefined) {
      throw new LaunchError(
        "community.beneficiary est obligatoire : le Safe communauté reçoit la réserve et les frais d'échange du pool. " +
          "Rien n'a été envoyé.",
      );
    }
    await assertSafe(ethers.provider, reserve.beneficiary, signer.address, "Le wallet communauté");
    const safe = reserve.beneficiary;

    // Estimations : le lanceur exige un contrat de blocage existant, d'où une adresse de contrat
    // quelconque (le routeur) à sa place tant qu'il n'est pas déployé ; le gas est le même.
    const launchFields = {
      name: launchConfig.token.name,
      symbol: launchConfig.token.symbol,
      supplyWholeTokens: supply.toString(),
      vesting: vesting?.address ?? (vestingPlan === undefined ? ZeroAddress : uniswap.swapRouter),
      vestingWholeTokens: split.vestingWholeTokens.toString(),
      community: split.communityWholeTokens > 0n ? safe : ZeroAddress,
      communityWholeTokens: split.communityWholeTokens.toString(),
      feeRecipient: safe,
      startTick: pool.startTick,
      openAt: pool.openAt.toString(),
      positionManager: uniswap.positionManager,
      salt: hexlify(randomBytes(32)),
    };
    const needsVesting = vestingPlan !== undefined && vesting === undefined;
    const [balance, sentCount, launcherEstimate, vestingEstimate] = await Promise.all([
      ethers.provider.getBalance(signer.address),
      ethers.provider.getTransactionCount(signer.address, "latest"),
      estimateDeployment(ethers, signer, LAUNCHER_CONTRACT, launcherConstructorArgs(launchFields)),
      needsVesting && vestingPlan !== undefined
        ? estimateDeployment(ethers, signer, VESTING_CONTRACT, vestingConstructorArgs({
            beneficiary: vestingPlan.beneficiary,
            start: vestingPlan.start.toString(),
            durationSeconds: vestingPlan.durationSeconds.toString(),
            cliffSeconds: vestingPlan.cliffSeconds.toString(),
          }))
        : Promise.resolve({ gas: 0n, maxCostWei: 0n }),
    ]);
    const maxCost = launcherEstimate.maxCostWei + vestingEstimate.maxCostWei;
    const tokenSymbol = launchConfig.token.symbol;

    heading(`Lancement — ${profile.label}`);
    row("Wallet de déploiement", signer.address);
    row("Solde", formatEth(balance));
    row("Transactions déjà envoyées", sentCount === 0 ? "0 (wallet neuf ✔)" : `${sentCount} ⚠ ce wallet n'est pas neuf`);
    row("Nom", launchConfig.token.name);
    row("Symbole", tokenSymbol);
    row("Offre totale", `${formatTokenAmount(plan.totalSupply)} ${tokenSymbol}`);
    row("Ton apport en ETH", "aucun (seulement les frais) ; ton wallet ne détiendra jamais de tokens");
    showLaunchPlan(plan, tokenSymbol, pool.startMarketCapWei);
    row("Ouverture des échanges", `${formatOpenAt(pool.openAt)} — ${formatDelay(pool.openAt, now)}`);
    row(
      "Anti-bot",
      "aucun échange avant l'heure ; puis max 0,5 % de l'offre par wallet la 1re heure, 1 % jusqu'à 6 h, " +
        "2 % jusqu'à 24 h, puis plus aucune limite",
    );
    if (vestingPlan !== undefined) {
      const isDeployer = getAddress(vestingPlan.beneficiary) === getAddress(signer.address);
      row(
        "Ta part (bloquée)",
        `${formatTokenAmount(plan.vestingAmount)} ${tokenSymbol} (${percent(plan.vestingAmount, plan.totalSupply)}), versée ` +
          "au contrat de blocage par le lanceur",
      );
      row("Contrat de blocage", vesting === undefined ? "déployé par cette étape, avant le lanceur" : `${vesting.address} (déjà déployé)`);
      row("Bénéficiaire", isDeployer ? `${vestingPlan.beneficiary} (ton wallet de déploiement)` : vestingPlan.beneficiary);
      if (!isDeployer) {
        row("", "⚠ vérifie cette adresse caractère par caractère : elle seule recevra ta part, et sans sa clé la part est perdue");
      }
      row("Falaise", `${formatDate(vestingPlan.start + vestingPlan.cliffSeconds)} — rien n'est libérable avant (${formatDays(vestingPlan.cliffSeconds)} après l'ouverture)`);
      row("Fin", `${formatDate(vestingPlan.start + vestingPlan.durationSeconds)} — tout est libéré (${formatDays(vestingPlan.durationSeconds)} au total)`);
    } else {
      row("Ta part", "aucune (vesting.percent vaut 0)");
    }
    if (split.communityWholeTokens > 0n) {
      row(
        "Réserve communauté",
        `${formatTokenAmount(plan.communityAmount)} ${tokenSymbol} (${percent(plan.communityAmount, plan.totalSupply)}), versée au Safe`,
      );
    }
    row("Safe communauté", `${safe} (Safe 2 sur 3 vérifié sur la chaîne ✔)`);
    row("Frais d'échange (1 %)", "versés au Safe communauté (npm run fees:mainnet, par n'importe qui)");
    row("Gas estimé", (launcherEstimate.gas + vestingEstimate.gas).toString());
    row("Coût maximal estimé", formatEth(maxCost));

    if (balance < maxCost) {
      throw new LaunchError("Solde insuffisant pour payer les déploiements. Rien n'a été envoyé.");
    }
    if (profile.isMainnet) {
      await confirmByTypingSymbol(
        tokenSymbol,
        `${needsVesting ? "déployer le contrat de blocage puis " : "déployer "}le lanceur de ${tokenSymbol}, ouverture le ` +
          `${formatOpenAt(pool.openAt)} (action irréversible)`,
      );
    }
    console.log("");

    if (needsVesting && vestingPlan !== undefined) {
      vesting = await deployVestingStep(ctx, vestingPlan);
    }
    const npm = new Contract(uniswap.positionManager, ["function factory() view returns (address)", "function WETH9() view returns (address)"], ethers.provider);
    const params: LaunchParams = {
      ...launchConfig.token,
      positionManager: uniswap.positionManager,
      factory: (await npm.factory()) as string,
      weth: (await npm.WETH9()) as string,
      startTick: pool.startTick,
      openAt: pool.openAt,
      vesting: vestingPlan === undefined || vesting === undefined ? ZeroAddress : vesting.address,
      vestingWholeTokens: vestingPlan === undefined ? 0n : split.vestingWholeTokens,
      community: launchFields.community,
      communityWholeTokens: split.communityWholeTokens,
      feeRecipient: safe,
    };
    token = await deployTokenStep(ctx, params);
  }

  heading("Token lancé");
  row("Token", token.address);
  row("Lanceur (garde la liquidité)", token.launcher);
  row("Pool Uniswap v3", token.pool ?? "—");
  row("Ouverture des échanges", formatOpenAt(BigInt(token.openAt)));
  if (vesting !== undefined && BigInt(token.vestingWholeTokens) > 0n) row("Contrat de blocage", vesting.address);
  row("Safe communauté", token.feeRecipient);
  row("Transaction", token.txHash);
  row("Explorateur (token)", explorerLink(profile, "token", token.address) ?? "—");
  row("Explorateur (pool)", token.pool === undefined ? "—" : (explorerLink(profile, "address", token.pool) ?? "—"));
  row("Journal", journal.location);

  console.log("\nVérification des codes sources sur Blockscout (tout le monde pourra les lire)…");
  const targets = [
    { label: "lanceur", address: token.launcher, contract: LAUNCHER_CONTRACT, constructorArgs: launcherConstructorArgs(token) as unknown[] },
    // Le token est créé par le lanceur, avec ces arguments-là.
    { label: "token", address: token.address, contract: TOKEN_CONTRACT, constructorArgs: tokenConstructorArgs(token) as unknown[] },
  ];
  if (vesting !== undefined && BigInt(token.vestingWholeTokens) > 0n) {
    targets.push({
      label: "contrat de blocage",
      address: vesting.address,
      contract: VESTING_CONTRACT,
      constructorArgs: vestingConstructorArgs(vesting) as unknown[],
    });
  }
  for (const { label, ...target } of targets) {
    if (await verifyOnBlockscout(hre, target, 3)) {
      console.log(`  ✔ ${label} : code source vérifié.`);
    } else {
      console.log(`  ${label} : à relancer plus tard avec :`);
      console.log(`  ${manualVerifyCommand(networkName, target)}`);
    }
  }

  const step = profile.isMainnet ? "mainnet" : "testnet";
  console.log(
    `\nAnnonce publiquement l'heure d'ouverture (${formatOpenAt(BigInt(token.openAt))}) et l'adresse du TOKEN : ` +
      "on l'achète sur Uniswap (pool TOKEN/WETH à 1 %), visible aussi sur DEXTools et GeckoTerminal.",
  );
  console.log(`Suivi : npm run status:${step}`);
}

await runScript(async () => {
  const connection = await hre.network.create();
  const profile = await resolveNetworkProfile(connection.networkName, connection.ethers.provider, [
    "robinhoodTestnet",
    "robinhood",
  ]);
  const uniswap = profile.uniswapV3;
  if (uniswap === undefined) {
    throw new LaunchError(
      "Le lancement a besoin d'Uniswap v3, qui n'est pas référencé sur ce réseau (testnet).\n" +
        "  Répète tout le lancement sur une copie locale du mainnet : npm run rehearsal. Rien n'a été envoyé.",
    );
  }
  // Un seul lancement à la fois sur ce réseau (deux terminaux pourraient sinon signer chacun le leur).
  const releaseLock = await acquireLock(connection.networkName);
  try {
    await deploy(connection, profile, uniswap);
  } finally {
    await releaseLock();
  }
});
