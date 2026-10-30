/**
 * Étape 1 — Lance le token : déploie le contrat de blocage de ta part (vesting),
 * puis la courbe de lancement, qui crée le token et en garde 100 %. Vérifie
 * ensuite les trois codes sources sur Blockscout.
 *
 *   npm run deploy:mainnet
 *   npm run deploy:testnet   (seulement si Uniswap v2 est référencé sur le testnet)
 *
 * Le wallet de déploiement n'apporte aucun ETH (seulement les frais) et ne
 * détient jamais de tokens : la courbe vend sa part à prix croissant à partir de
 * curve.openAt ; quand elle a réuni curve.targetEth, elle verse ta part au
 * contrat de blocage et la réserve au Safe communauté, puis ouvre TOUTE SEULE le
 * pool Uniswap v2 et brûle les parts LP.
 *
 * Sur le mainnet, le plan s'affiche d'abord et rien n'est envoyé tant que tu
 * n'as pas retapé le symbole. Chaque transaction est signée puis notée dans
 * deployments/ (hash compris) AVANT d'être diffusée : si le script est
 * interrompu à n'importe quel moment, relancer la même commande reprend le
 * suivi sans jamais redéployer.
 */
import { ZeroAddress, getAddress } from "ethers";
import hre from "hardhat";
import type { NetworkConnection } from "hardhat/types/network";

import { launchConfig } from "../launch.config.ts";
import { UNIT } from "./lib/constants.ts";
import { type CurvePlan, buildCurvePlan, formatDelay, formatOpenAt, splitSupply } from "./lib/curve.ts";
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
import { type NetworkProfile, type UniswapV2Deployment, explorerLink, resolveNetworkProfile } from "./lib/networks.ts";
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
  CURVE_CONTRACT,
  TOKEN_CONTRACT,
  VESTING_CONTRACT,
  constructorArgs,
  curveConstructorArgs,
  estimateDeployment,
  paramsOf,
  vestingConstructorArgs,
} from "./lib/token.ts";
import { assertUniswapV2Deployment } from "./lib/uniswap.ts";
import {
  validateCommunityParams,
  validateCurveParams,
  validateTokenParams,
  validateVestingParams,
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

/** Affiche les chiffres de la courbe (prix, coût de 0,5 %, capitalisations). */
function showCurvePlan(plan: CurvePlan, symbol: string): void {
  const price = (wei: bigint) => `${formatRatio(wei, UNIT)} ETH par ${symbol}`;
  row("Confiés à la courbe", `${formatTokenAmount(plan.curveAmount)} ${symbol} (${percent(plan.curveAmount, plan.totalSupply)} de l'offre)`);
  row("", `vendus sur la courbe : ${formatTokenAmount(plan.soldTokens)} (${percent(plan.soldTokens, plan.totalSupply)} de l'offre)`);
  row("", `puis mis dans le pool : ${formatTokenAmount(plan.lpTokens)} (${percent(plan.lpTokens, plan.totalSupply)}), avec tout l'ETH réuni`);
  row("ETH à réunir (cible)", `${formatEth(plan.targetEthWei)} — versé en entier dans le pool, LP brûlées`);
  row("Prix de départ", price(plan.startPriceWei));
  row("Prix à l'ouverture du pool", `${price(plan.endPriceWei)} (× ${formatRatio(plan.endPriceWei, plan.startPriceWei)})`);
  row("0,5 % de l'offre coûte", `≈ ${formatEth(plan.halfPercentCostWei)} au tout premier achat (limite de la 1re heure)`);
  row("Capitalisation de départ", `≈ ${formatEth(plan.startFdvWei)}`);
  row("À l'ouverture du pool", `≈ ${formatEth(plan.poolFdvWei)}`);
}

async function deploy(connection: NetworkConnection, profile: NetworkProfile, uniswap: UniswapV2Deployment): Promise<void> {
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
      `Le token est déjà lancé sur ce réseau : ${existing.token.address} (courbe ${existing.token.curve}).\n` +
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
    // Reprise : les paramètres viennent du journal, pas de la config.
    token = await deployTokenStep(ctx, launchParamsOf(existing.token));
    vesting = existing.vesting;
  } else {
    // 1. Un contrat de blocage noté mais pas confirmé passe en premier : ces octets-là existent.
    if (existing?.vesting?.status === "pending") {
      vesting = await deployVestingStep(ctx, planFromJournal(existing.vesting));
    }

    // 2. Nouvelles signatures : tout est validé avant la première.
    validateTokenParams(launchConfig.token, { allowPlaceholder: false });
    await assertUniswapV2Deployment(ethers.provider, uniswap);
    const latest = await ethers.provider.getBlock("latest");
    if (latest === null) throw new LaunchError("Impossible de lire le dernier bloc. Rien n'a été envoyé.");
    const now = BigInt(latest.timestamp);
    const supply = launchConfig.token.supply;
    const curve = validateCurveParams(launchConfig.curve, { supplyWholeTokens: supply, now, isMainnet: profile.isMainnet });
    const reserve = validateCommunityParams(launchConfig.community, signer.address, curve.tokenPercent);
    const split = splitSupply(supply, curve.tokenPercent, reserve.percent);
    const plan = buildCurvePlan({ supplyWholeTokens: supply, split, virtualEthWei: curve.virtualEthWei, targetEthWei: curve.targetEthWei });

    // Ta part : bloquée dans un contrat de vesting déployé maintenant, rempli à l'ouverture du pool.
    let vestingPlan: VestingPlan | undefined;
    if (split.vestingWholeTokens > 0n) {
      if (!launchConfig.vesting.enabled) {
        throw new LaunchError(
          `Ta part (${percent(plan.vestingAmount, plan.totalSupply)} de l'offre) ne peut exister que bloquée : mets ` +
            "vesting.enabled: true, ou règle curve.tokenPercent + community.percent à 100. Rien n'a été envoyé.",
        );
      }
      if (vesting !== undefined) {
        // Contrat déjà déployé par une exécution précédente (vide) : son calendrier doit correspondre.
        vestingPlan = planFromJournal(vesting);
        if (vestingPlan.start !== curve.openAt) {
          throw new LaunchError(
            `Le contrat de blocage déjà déployé (${vesting.address}) commence le ${formatOpenAt(vestingPlan.start)}, ` +
              `mais curve.openAt vaut ${formatOpenAt(curve.openAt)}. Remets cette heure dans launch.config.ts, ou ` +
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
        // Le calendrier démarre à l'ouverture des achats.
        vestingPlan = {
          beneficiary: config.beneficiary,
          start: curve.openAt,
          durationSeconds: config.durationSeconds,
          cliffSeconds: config.cliffSeconds,
        };
      }
    }

    // Réserve communauté : un vrai Safe 2 sur 3, qui doit exister avant le déploiement.
    let community = ZeroAddress;
    if (split.communityWholeTokens > 0n) {
      if (reserve.beneficiary === undefined) {
        throw new LaunchError("community.beneficiary manque dans launch.config.ts. Rien n'a été envoyé.");
      }
      await assertSafe(ethers.provider, reserve.beneficiary, signer.address, "Le wallet communauté");
      community = reserve.beneficiary;
    }

    // Estimations : la courbe exige un contrat de blocage existant, d'où une adresse de contrat
    // quelconque (le routeur) à sa place tant qu'il n'est pas déployé ; le gas est le même.
    const launchFields = {
      name: launchConfig.token.name,
      symbol: launchConfig.token.symbol,
      supplyWholeTokens: supply.toString(),
      vesting: vesting?.address ?? (vestingPlan === undefined ? ZeroAddress : uniswap.router),
      vestingWholeTokens: split.vestingWholeTokens.toString(),
      community,
      communityWholeTokens: split.communityWholeTokens.toString(),
      virtualEthWei: curve.virtualEthWei.toString(),
      targetEthWei: curve.targetEthWei.toString(),
      openAt: curve.openAt.toString(),
      factory: uniswap.factory,
      weth: uniswap.weth,
    };
    const needsVesting = vestingPlan !== undefined && vesting === undefined;
    const [balance, sentCount, curveEstimate, vestingEstimate] = await Promise.all([
      ethers.provider.getBalance(signer.address),
      ethers.provider.getTransactionCount(signer.address, "latest"),
      estimateDeployment(ethers, signer, CURVE_CONTRACT, curveConstructorArgs(launchFields)),
      needsVesting && vestingPlan !== undefined
        ? estimateDeployment(ethers, signer, VESTING_CONTRACT, vestingConstructorArgs({
            beneficiary: vestingPlan.beneficiary,
            start: vestingPlan.start.toString(),
            durationSeconds: vestingPlan.durationSeconds.toString(),
            cliffSeconds: vestingPlan.cliffSeconds.toString(),
          }))
        : Promise.resolve({ gas: 0n, maxCostWei: 0n }),
    ]);
    const maxCost = curveEstimate.maxCostWei + vestingEstimate.maxCostWei;
    const tokenSymbol = launchConfig.token.symbol;

    heading(`Lancement — ${profile.label}`);
    row("Wallet de déploiement", signer.address);
    row("Solde", formatEth(balance));
    row("Transactions déjà envoyées", sentCount === 0 ? "0 (wallet neuf ✔)" : `${sentCount} ⚠ ce wallet n'est pas neuf`);
    row("Nom", launchConfig.token.name);
    row("Symbole", tokenSymbol);
    row("Offre totale", `${formatTokenAmount(plan.totalSupply)} ${tokenSymbol}, gardée à 100 % par la courbe`);
    row("Ton apport en ETH", "aucun (seulement les frais) ; ton wallet ne détiendra jamais de tokens");
    showCurvePlan(plan, tokenSymbol);
    row("Ouverture des achats", `${formatOpenAt(curve.openAt)} — ${formatDelay(curve.openAt, now)}`);
    row(
      "Anti-bot",
      "max 0,5 % de l'offre par wallet la 1re heure, 1 % jusqu'à 6 h, 2 % jusqu'à 24 h (sur la courbe), " +
        "puis de nouveau 24 h sur Uniswap après l'ouverture du pool",
    );
    if (vestingPlan !== undefined) {
      const isDeployer = getAddress(vestingPlan.beneficiary) === getAddress(signer.address);
      row(
        "Ta part (bloquée)",
        `${formatTokenAmount(plan.vestingAmount)} ${tokenSymbol} (${percent(plan.vestingAmount, plan.totalSupply)}), versée ` +
          "au contrat de blocage à l'ouverture du pool",
      );
      row("Contrat de blocage", vesting === undefined ? "déployé par cette étape, avant la courbe" : `${vesting.address} (déjà déployé)`);
      row("Bénéficiaire", isDeployer ? `${vestingPlan.beneficiary} (ton wallet de déploiement)` : vestingPlan.beneficiary);
      if (!isDeployer) {
        row("", "⚠ vérifie cette adresse caractère par caractère : elle seule recevra ta part, et sans sa clé la part est perdue");
      }
      row("Falaise", `${formatDate(vestingPlan.start + vestingPlan.cliffSeconds)} — rien n'est libérable avant (${formatDays(vestingPlan.cliffSeconds)} après l'ouverture)`);
      row("Fin", `${formatDate(vestingPlan.start + vestingPlan.durationSeconds)} — tout est libéré (${formatDays(vestingPlan.durationSeconds)} au total)`);
    } else {
      row("Ta part", "aucune : curve.tokenPercent + community.percent = 100");
    }
    if (community !== ZeroAddress) {
      row(
        "Réserve communauté",
        `${formatTokenAmount(plan.communityAmount)} ${tokenSymbol} (${percent(plan.communityAmount, plan.totalSupply)}), versée ` +
          "au Safe à l'ouverture du pool",
      );
      row("Safe communauté", `${community} (Safe 2 sur 3 vérifié sur la chaîne ✔)`);
    }
    row("", "si la cible n'est jamais atteinte, ta part et la réserve restent dans la courbe");
    row("Gas estimé", (curveEstimate.gas + vestingEstimate.gas).toString());
    row("Coût maximal estimé", formatEth(maxCost));

    if (balance < maxCost) {
      throw new LaunchError("Solde insuffisant pour payer les déploiements. Rien n'a été envoyé.");
    }
    if (profile.isMainnet) {
      await confirmByTypingSymbol(
        tokenSymbol,
        `${needsVesting ? "déployer le contrat de blocage puis " : "déployer "}la courbe de ${tokenSymbol}, ouverture le ` +
          `${formatOpenAt(curve.openAt)} (action irréversible)`,
      );
    }
    console.log("");

    if (needsVesting && vestingPlan !== undefined) {
      vesting = await deployVestingStep(ctx, vestingPlan);
    }
    const params: LaunchParams = {
      ...launchConfig.token,
      factory: uniswap.factory,
      weth: uniswap.weth,
      curveTokenPercent: curve.tokenPercent,
      curveWholeTokens: split.curveWholeTokens,
      virtualEthWei: curve.virtualEthWei,
      targetEthWei: curve.targetEthWei,
      openAt: curve.openAt,
      vesting: vestingPlan === undefined || vesting === undefined ? ZeroAddress : vesting.address,
      vestingWholeTokens: vestingPlan === undefined ? 0n : split.vestingWholeTokens,
      community,
      communityWholeTokens: split.communityWholeTokens,
    };
    token = await deployTokenStep(ctx, params);
  }

  heading("Courbe et token déployés");
  row("Token", token.address);
  row("Courbe de lancement", token.curve);
  row("Paire Uniswap v2 (vide)", token.pair ?? "—");
  row("Ouverture des achats", formatOpenAt(BigInt(token.openAt)));
  if (vesting !== undefined && BigInt(token.vestingWholeTokens) > 0n) row("Contrat de blocage", vesting.address);
  if (BigInt(token.communityWholeTokens) > 0n) row("Safe communauté", token.community);
  row("Transaction", token.txHash);
  row("Explorateur (token)", explorerLink(profile, "token", token.address) ?? "—");
  row("Explorateur (courbe)", explorerLink(profile, "address", token.curve) ?? "—");
  row("Journal", journal.location);

  console.log("\nVérification des codes sources sur Blockscout (tout le monde pourra les lire)…");
  const targets = [
    { label: "courbe", address: token.curve, contract: CURVE_CONTRACT, constructorArgs: curveConstructorArgs(token) as unknown[] },
    // Le token est créé par la courbe, avec ces arguments-là.
    { label: "token", address: token.address, contract: TOKEN_CONTRACT, constructorArgs: constructorArgs(paramsOf(token)) as unknown[] },
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
    `\nAnnonce publiquement l'heure d'ouverture (${formatOpenAt(BigInt(token.openAt))}) et l'adresse de la COURBE : ` +
      "c'est là qu'on achète, pas sur Uniswap (le pool s'ouvrira tout seul à la cible).",
  );
  console.log(`Suivi : npm run status:${step}`);
}

await runScript(async () => {
  const connection = await hre.network.create();
  const profile = await resolveNetworkProfile(connection.networkName, connection.ethers.provider, [
    "robinhoodTestnet",
    "robinhood",
  ]);
  const uniswap = profile.uniswapV2;
  if (uniswap === undefined) {
    throw new LaunchError(
      "La courbe de lancement a besoin d'Uniswap v2, qui n'est pas référencé sur ce réseau (testnet).\n" +
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
