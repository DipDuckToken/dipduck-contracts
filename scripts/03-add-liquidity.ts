/**
 * Étape 3 — Ouvre le marché : déploie le PoolSeeder (une fois), puis crée la
 * paire Uniswap v2 TOKEN/WETH et y dépose ta liquidité en UNE transaction,
 * parts LP émises directement vers l'adresse morte.
 *
 *   npm run liquidity:mainnet
 *
 * Si tu gardes une part avec le blocage activé, elle doit déjà être bloquée,
 * et la réserve communauté (community.percent > 0) déjà envoyée à son wallet
 * (étape 2, npm run lock:mainnet) : le pool reçoit alors exactement l'offre
 * moins ta part et moins la réserve.
 *
 * Contrôles avant tout envoi : adresses Uniswap cohérentes sur la chaîne,
 * aucune part LP existante, soldes suffisants, simulation exacte. Chaque
 * transaction est signée puis notée dans deployments/ (hash compris) avant
 * d'être diffusée : relancer la même commande reprend le suivi sans jamais
 * rouvrir le pool deux fois.
 */
import { Contract, getAddress } from "ethers";
import hre from "hardhat";
import type { NetworkConnection } from "hardhat/types/network";

import { launchConfig } from "../launch.config.ts";
import { DEAD_ADDRESS, DONATION_TOLERANCE_BPS, LIQUIDITY_GAS_RESERVE } from "./lib/constants.ts";
import { LaunchError, runScript } from "./lib/errors.ts";
import {
  confirmByTypingSymbol,
  formatDate,
  formatEth,
  formatRatio,
  formatTokenAmount,
  heading,
  percent,
  row,
} from "./lib/format.ts";
import { type NetworkProfile, type UniswapV2Deployment, explorerLink, resolveNetworkProfile } from "./lib/networks.ts";
import { type SeederRecord, acquireLock, fileJournal } from "./lib/records.ts";
import { type SeedAmounts, type StepContext, deploySeederStep, seedStep } from "./lib/steps.ts";
import { SEEDER_CONTRACT } from "./lib/token.ts";
import {
  ERC20_ABI,
  type PoolComposition,
  assertUniswapV2Deployment,
  buildLiquidityPlan,
  maxPairWethFor,
  openingRange,
  previewPair,
  readPoolStatus,
} from "./lib/uniswap.ts";
import { validateCommunityParams, validateLiquidityParams } from "./lib/validation.ts";
import { manualVerifyCommand, verifyOnBlockscout } from "./lib/verify.ts";
import { poolBaseAmount, poolShare, readVestingStatus } from "./lib/vesting.ts";
import { assertSameAccount, localWallet } from "./lib/wallet.ts";

async function openMarket(connection: NetworkConnection, profile: NetworkProfile, uniswap: UniswapV2Deployment) {
  const { ethers, networkName } = connection;
  const step = profile.isMainnet ? "mainnet" : "testnet";
  const journal = fileJournal(networkName);
  const record = await journal.read();
  const token = record?.token;
  if (token === undefined) {
    throw new LaunchError(`Aucun token dans le journal (${journal.location}). Lance d'abord l'étape 1.`);
  }
  if (token.status !== "confirmed") {
    throw new LaunchError("Le déploiement du token n'est pas confirmé. Relance l'étape 1 pour reprendre son suivi.");
  }
  if (record?.liquidity?.status === "confirmed") {
    throw new LaunchError(`Le pool est déjà ouvert : paire ${record.liquidity.pair ?? "—"}.`);
  }

  const [signer] = await ethers.getSigners();
  const wallet = await localWallet(connection);
  assertSameAccount(wallet, signer.address);
  if (getAddress(signer.address) !== getAddress(token.from)) {
    throw new LaunchError(`Le wallet chargé (${signer.address}) n'est pas celui qui a déployé le token (${token.from}).`);
  }
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

  await assertUniswapV2Deployment(ethers.provider, uniswap);

  let seeder: SeederRecord;
  let amounts: SeedAmounts;
  const pendingLiquidity = record?.liquidity;
  if (pendingLiquidity !== undefined) {
    // Reprise : les montants viennent du journal, pas de la config.
    if (record?.seeder?.status !== "confirmed") {
      throw new LaunchError("Journal incohérent : une ouverture de pool est notée sans PoolSeeder confirmé.");
    }
    seeder = record.seeder;
    amounts = {
      tokenAmount: BigInt(pendingLiquidity.tokenAmount),
      ethAmount: BigInt(pendingLiquidity.ethAmountWei),
      maxPairWeth: BigInt(pendingLiquidity.maxPairWeth),
    };
  } else {
    const liquidity = validateLiquidityParams(launchConfig.liquidity);
    if (record?.vesting?.status === "pending" || record?.lock?.status === "pending" || record?.community?.status === "pending") {
      throw new LaunchError(
        `Le blocage de ta part ou l'envoi de la réserve communauté est noté mais pas encore confirmé : relance d'abord npm run lock:${step}. Rien n'a été envoyé.`,
      );
    }
    const reserve = validateCommunityParams(launchConfig.community, signer.address, liquidity.tokenPercent);
    const communityConfirmed = record?.community?.status === "confirmed";
    // Ta part bloquée (étape 2) : le pool reçoit tout le reste. Blocage activé mais pas fait : refus.
    const lockedIn = record?.lock?.status === "confirmed" ? record.lock.vesting : undefined;
    const share = poolShare({
      tokenPercent: liquidity.tokenPercent,
      vestingEnabled: launchConfig.vesting.enabled,
      lockConfirmed: lockedIn !== undefined,
      lockCommand: `npm run lock:${step}`,
      communityPercent: reserve.percent,
      communityConfirmed,
    });
    const tokenContract = new Contract(token.address, ERC20_ABI, ethers.provider);
    const [totalSupply, tokenBalance, ethBalance, fees, preview] = await Promise.all([
      tokenContract.totalSupply() as Promise<bigint>,
      tokenContract.balanceOf(signer.address) as Promise<bigint>,
      ethers.provider.getBalance(signer.address),
      ethers.provider.getFeeData(),
      previewPair(ethers.provider, uniswap, token.address),
    ]);
    if (preview.lpTotalSupply !== 0n) {
      throw new LaunchError(
        `Des parts LP existent déjà pour la paire ${preview.pair} : quelqu'un a déjà ouvert un pool, ` +
          "ce qui n'est possible qu'avec des tokens venant de ton wallet. Rien n'a été envoyé.",
      );
    }
    // Part bloquée : le pool reçoit exactement l'offre moins ta part. Si des tokens
    // ont déjà été libérés vers ton wallet (falaise passée), ils restent hors du pool.
    const lockedAmount = record?.lock?.status === "confirmed" ? BigInt(record.lock.amount) : 0n;
    const communityAmount = communityConfirmed && record?.community !== undefined ? BigInt(record.community.amount) : 0n;
    const poolBase = poolBaseAmount({ mode: share.mode, totalSupply, lockedAmount, balance: tokenBalance, communityAmount });
    if (poolBase > tokenBalance) {
      throw new LaunchError(
        `Ton wallet ne détient que ${formatTokenAmount(tokenBalance)} ${token.symbol}, il en faut ` +
          `${formatTokenAmount(poolBase)} pour le pool. Des tokens ont-ils quitté ce wallet ? Rien n'a été envoyé.`,
      );
    }
    const plan = buildLiquidityPlan({
      deployerTokenBalance: poolBase,
      tokenTotalSupply: totalSupply,
      tokenPercent: share.poolPercent,
      ethAmount: liquidity.ethAmountWei,
    });
    const gasReserve = LIQUIDITY_GAS_RESERVE * (fees.maxFeePerGas ?? fees.gasPrice ?? 0n);
    if (ethBalance < plan.ethAmount + gasReserve) {
      throw new LaunchError(
        `Solde ETH insuffisant : ${formatEth(ethBalance)} disponible, ` +
          `${formatEth(plan.ethAmount + gasReserve)} nécessaire (pool + réserve de frais). Rien n'a été envoyé.`,
      );
    }
    const vesting = lockedIn === undefined ? undefined : await readVestingStatus(ethers.provider, lockedIn, token.address);
    // Le PoolSeeder refusera d'ouvrir si la paire contient plus de WETH que cela.
    const maxPairWeth = maxPairWethFor(preview, plan.ethAmount);
    const range = openingRange(plan, preview, maxPairWeth);
    const price = (pool: PoolComposition) => `${formatRatio(pool.weth, pool.tokens)} ETH par ${token.symbol}`;
    const fdv = (pool: PoolComposition) => formatEth((pool.weth * totalSupply) / pool.tokens);

    heading(`Ouverture du marché — ${profile.label}`);
    row("Token", `${token.symbol} — ${token.address}`);
    row(
      "PoolSeeder",
      record?.seeder === undefined
        ? "déployé par cette étape"
        : record.seeder.status === "confirmed"
          ? record.seeder.address
          : `${record.seeder.address} (déploiement noté, sera repris)`,
    );
    row("Paire Uniswap v2", preview.exists ? `${preview.pair} (existe, sans parts LP)` : "créée par cette étape");
    if (preview.donatedWeth > 0n || preview.donatedTokens > 0n) {
      const removableWeth = preview.donatedWeth - preview.lockedWeth;
      row(
        "Déjà dans la paire",
        `${formatEth(preview.donatedWeth)} de WETH donné par un tiers` +
          (removableWeth > 0n
            ? ` (dont ${formatEth(removableWeth)} reprenables par n'importe qui avant l'ouverture)`
            : " (verrouillé : rejoindra le pool)"),
      );
      if (preview.donatedTokens > 0n) {
        row("", `et ${formatTokenAmount(preview.donatedTokens)} ${token.symbol}`);
      }
    }
    row("Tokens dans le pool", `${formatTokenAmount(plan.tokenAmount)} ${token.symbol} (${percent(plan.tokenAmount, totalSupply)} de l'offre)`);
    row("ETH dans le pool", formatEth(plan.ethAmount));
    row("Prix de départ", price(range.expected));
    row("Capitalisation de départ", fdv(range.expected));
    if (range.lowest.weth !== range.expected.weth) {
      row("Au plus bas", `${price(range.lowest)} — capitalisation ${fdv(range.lowest)} (si les dons non verrouillés sont repris)`);
    }
    row(
      "Au plus haut accepté",
      `${price(range.highest)} — capitalisation ${fdv(range.highest)}`,
    );
    row(
      "",
      `(marge de ${formatEth(maxPairWeth - preview.donatedWeth)} pour un don de dernière seconde, ` +
        `${percent(DONATION_TOLERANCE_BPS, 10_000n)} de ton ETH ; au-delà, refus sans rien déplacer)`,
    );
    if (vesting !== undefined && lockedIn !== undefined) {
      row("Ta part", `${formatTokenAmount(vesting.locked)} ${token.symbol} (${percent(vesting.locked, totalSupply)}) bloqués dans ${lockedIn}`);
      const now = BigInt(Math.floor(Date.now() / 1000));
      if (now < vesting.cliff && vesting.released === 0n) {
        row("", `rien avant le ${formatDate(vesting.cliff)}, tout libéré le ${formatDate(vesting.end)} ✔`);
      } else {
        row(
          "",
          `⚠ la falaise (${formatDate(vesting.cliff)}) est passée : ${formatTokenAmount(vesting.released + vesting.releasable)} ` +
            `${token.symbol} sont déjà libérés ; ceux qui sont dans ton wallet restent hors du pool`,
        );
      }
    } else if (share.mode === "unlocked") {
      row(
        "Ta part",
        `${formatTokenAmount(plan.keptTokens)} ${token.symbol} (${percent(plan.keptTokens, totalSupply)}) ` +
          "libres dans ton wallet ⚠ (blocage désactivé) : annonce publiquement pourquoi tu les gardes",
      );
    } else {
      row("Ta part", "aucune : tout va au pool");
    }
    if (communityConfirmed && record?.community !== undefined) {
      row(
        "Réserve communauté",
        `${formatTokenAmount(communityAmount)} ${token.symbol} (${percent(communityAmount, totalSupply)}) dans ${record.community.recipient}`,
      );
    }
    row("Parts LP envoyées à", `${DEAD_ADDRESS} (brûlées, définitif)`);
    row("Frais maximum réservés", formatEth(gasReserve));

    if (profile.isMainnet) {
      await confirmByTypingSymbol(token.symbol, "ouvrir le marché et brûler les LP (action irréversible)");
    }
    console.log("");
    seeder = await deploySeederStep(ctx, uniswap);
    amounts = { ...plan, maxPairWeth };
  }

  const { record: liquidity, outcome } = await seedStep(ctx, token, seeder, amounts);
  const pool = await readPoolStatus(ethers.provider, uniswap, token.address, signer.address);

  heading("Marché ouvert");
  row("Paire", outcome.pair);
  if (pool !== undefined) {
    row("Réserves", `${formatTokenAmount(pool.tokenReserve)} ${token.symbol} / ${formatEth(pool.wethReserve)}`);
  }
  row("Parts LP brûlées", `${formatTokenAmount(outcome.lpBurned)} — toutes celles de ce dépôt, lu dans le reçu ✔`);
  row("Transaction", liquidity.txHash);
  row("Explorateur", explorerLink(profile, "address", outcome.pair) ?? "—");
  row("Journal", journal.location);

  console.log("\nVérification du PoolSeeder sur Blockscout (facultative)…");
  const target = { address: seeder.address, contract: SEEDER_CONTRACT, constructorArgs: [seeder.factory, seeder.weth] };
  if (await verifyOnBlockscout(hre, target, 3)) {
    console.log("  ✔ Code source vérifié.");
  } else {
    console.log(`  À relancer plus tard : ${manualVerifyCommand(networkName, target)}`);
  }
  const kept = (await new Contract(token.address, ERC20_ABI, ethers.provider).balanceOf(signer.address)) as bigint;
  if (kept > 0n) {
    console.log(`\nIl reste ${formatTokenAmount(kept)} ${token.symbol} libres dans ton wallet : annonce-le publiquement.`);
  }
  console.log(`\nSuivi : npm run status:${step}`);
}

await runScript(async () => {
  const connection = await hre.network.create();
  const profile = await resolveNetworkProfile(connection.networkName, connection.ethers.provider, [
    "robinhood",
    "robinhoodTestnet",
  ]);
  const uniswap = profile.uniswapV2;
  if (uniswap === undefined) {
    throw new LaunchError(
      "Uniswap v2 n'est pas référencé sur le testnet de Robinhood Chain.\n" +
        "  Répète l'ouverture du pool sur une copie locale du mainnet : npm run rehearsal",
    );
  }
  // Un seul lancement à la fois sur ce réseau (deux terminaux pourraient sinon signer chacun le leur).
  const releaseLock = await acquireLock(connection.networkName);
  try {
    await openMarket(connection, profile, uniswap);
  } finally {
    await releaseLock();
  }
});
