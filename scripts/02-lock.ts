/**
 * Étape 2 — Bloque ta part (ce que le pool ne recevra pas) dans un contrat de
 * vesting OpenZeppelin, puis envoie la réserve communauté à son wallet dédié,
 * AVANT l'ouverture du pool : dès la première seconde de trading, les acheteurs
 * voient ta part bloquée et la réserve à part. Rien n'est libérable avant la
 * falaise, puis la libération est linéaire jusqu'à la fin. Personne ne peut
 * retirer plus tôt, pas même toi.
 *
 *   npm run lock:mainnet     (après npm run deploy:mainnet, avant npm run liquidity:mainnet)
 *   npm run lock:testnet     (répétition sur le testnet)
 *
 * Bloquer avant l'ouverture ne crée aucun risque : le contrat de blocage ne
 * peut que verser au bénéficiaire, selon le calendrier ; il ne peut pas ouvrir
 * un pool avant toi.
 *
 * Sur le mainnet, le plan s'affiche d'abord et rien n'est envoyé tant que tu
 * n'as pas retapé le symbole. Comme aux autres étapes, chaque transaction est
 * signée puis notée avant d'être diffusée : relancer la même commande reprend
 * le suivi sans jamais bloquer ni envoyer deux fois.
 */
import { Contract, getAddress } from "ethers";
import hre from "hardhat";
import type { NetworkConnection } from "hardhat/types/network";

import { launchConfig } from "../launch.config.ts";
import { LaunchError, runScript } from "./lib/errors.ts";
import {
  confirmByTypingSymbol,
  formatDate,
  formatDays,
  formatTokenAmount,
  heading,
  percent,
  row,
} from "./lib/format.ts";
import { type NetworkProfile, explorerLink, resolveNetworkProfile } from "./lib/networks.ts";
import { type CommunityRecord, type LockRecord, type VestingRecord, acquireLock, fileJournal } from "./lib/records.ts";
import { type StepContext, type VestingPlan, communityStep, deployVestingStep, lockStep } from "./lib/steps.ts";
import { VESTING_CONTRACT, vestingConstructorArgs } from "./lib/token.ts";
import { ERC20_ABI } from "./lib/uniswap.ts";
import { assertSafe } from "./lib/safe.ts";
import { validateCommunityParams, validateLiquidityParams, validateVestingParams } from "./lib/validation.ts";
import { manualVerifyCommand, verifyOnBlockscout } from "./lib/verify.ts";
import { assertCliffAhead, communityShare, readVestingStatus, shareToLock } from "./lib/vesting.ts";
import { assertSameAccount, localWallet } from "./lib/wallet.ts";

/** Calendrier noté dans le journal (reprise ou contrat déjà déployé). */
function planFromJournal(vesting: VestingRecord): VestingPlan {
  return {
    token: vesting.token,
    beneficiary: vesting.beneficiary,
    start: BigInt(vesting.start),
    durationSeconds: BigInt(vesting.durationSeconds),
    cliffSeconds: BigInt(vesting.cliffSeconds),
  };
}

async function lockShare(connection: NetworkConnection, profile: NetworkProfile): Promise<void> {
  const { ethers, networkName } = connection;
  const step = profile.isMainnet ? "mainnet" : "testnet";
  const journal = fileJournal(networkName);
  const record = await journal.read();
  const token = record?.token;
  if (record === undefined || token === undefined || token.status !== "confirmed") {
    throw new LaunchError(`Aucun token confirmé dans le journal (${journal.location}). Lance d'abord l'étape 1.`);
  }
  if ([record.seeder, record.approval, record.liquidity].some((entry) => entry !== undefined && entry.status !== "confirmed")) {
    throw new LaunchError(
      "Une étape de l'ouverture du pool est notée mais pas encore confirmée : relance d'abord " +
        "npm run liquidity:mainnet pour reprendre son suivi. Rien n'a été envoyé.",
    );
  }
  if (record.lock !== undefined && record.vesting?.status !== "confirmed") {
    throw new LaunchError("Journal incohérent : un blocage est noté sans contrat de blocage confirmé.");
  }
  const poolOpen = record.liquidity?.status === "confirmed";

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
  const tokenContract = new Contract(token.address, ERC20_ABI, ethers.provider);

  // 1. Ce qui a déjà été signé passe en premier, quelle que soit la config
  //    actuelle : ces octets-là existent, la seule issue sûre est de les mener au bout.
  let vesting: VestingRecord | undefined = record.vesting?.status === "confirmed" ? record.vesting : undefined;
  let lock: LockRecord | undefined = record.lock?.status === "confirmed" ? record.lock : undefined;
  let community: CommunityRecord | undefined = record.community?.status === "confirmed" ? record.community : undefined;
  let resumed = false;
  if (record.lock?.status === "pending" && record.vesting !== undefined) {
    vesting = await deployVestingStep(ctx, planFromJournal(record.vesting)); // confirmé : simple relecture
    lock = await lockStep(ctx, vesting, BigInt(record.lock.amount));
    resumed = true;
  } else if (record.vesting?.status === "pending") {
    vesting = await deployVestingStep(ctx, planFromJournal(record.vesting));
  }
  if (record.community?.status === "pending") {
    const pending = record.community;
    community = await communityStep(ctx, { token: pending.token, recipient: pending.recipient, amount: BigInt(pending.amount) });
    resumed = true;
  }

  // 2. Nouvelles signatures : seulement ce que launch.config.ts demande encore.
  const [totalSupply, balance, latest] = await Promise.all([
    tokenContract.totalSupply() as Promise<bigint>,
    tokenContract.balanceOf(signer.address) as Promise<bigint>,
    ethers.provider.getBlock("latest"),
  ]);
  const nextStep = poolOpen
    ? `Suivi : npm run status:${step}`
    : profile.isMainnet
      ? "Étape suivante : npm run liquidity:mainnet"
      : "Répète ensuite l'ouverture du pool sur le fork : npm run rehearsal";
  const liquidity = validateLiquidityParams(launchConfig.liquidity);
  const reserve = validateCommunityParams(launchConfig.community, signer.address, liquidity.tokenPercent);

  // La réserve communauté part avant l'ouverture du pool, jamais après coup.
  let communityAmount = 0n;
  if (community === undefined && reserve.percent > 0n) {
    if (poolOpen) {
      console.log("\n  ⚠ Le pool est déjà ouvert : la réserve communauté se décide avant l'ouverture, elle n'est pas envoyée.");
    } else {
      communityAmount = communityShare(totalSupply, reserve.percent);
    }
  }
  // Ta part : avant l'ouverture, ce que le pool et la réserve ne recevront pas.
  // Pool déjà ouvert (blocage décidé après coup) : ce qui reste dans ton wallet.
  const teamAmount =
    lock !== undefined ? 0n : poolOpen ? balance : shareToLock(totalSupply, liquidity.tokenPercent, reserve.percent);
  if (teamAmount > 0n && !launchConfig.vesting.enabled) {
    if (communityAmount > 0n) {
      throw new LaunchError(
        "Une réserve communauté demande que ta part soit bloquée (vesting.enabled: true), ou que " +
          "tokenPercent + community.percent fasse 100. Rien n'a été envoyé.",
      );
    }
    if (vesting !== undefined) {
      console.log(`\nContrat de blocage déployé (${vesting.address}), mais vide : le blocage est désactivé dans launch.config.ts.`);
      console.log(nextStep);
      return;
    }
    throw new LaunchError("Le blocage est désactivé dans launch.config.ts (vesting.enabled vaut false).");
  }

  if (teamAmount === 0n && communityAmount === 0n) {
    if (lock === undefined && community === undefined) {
      const reason = poolOpen
        ? "il ne reste aucun token dans ce wallet"
        : "tokenPercent vaut 100 dans launch.config.ts (tout va au pool, tu ne gardes rien)";
      if (vesting !== undefined) {
        console.log(`\nContrat de blocage déployé (${vesting.address}), mais vide : ${reason}.`);
        console.log(nextStep);
        return;
      }
      throw new LaunchError(`Rien à bloquer : ${reason}.`);
    }
    if (!resumed) {
      throw new LaunchError(
        lock !== undefined
          ? `Ta part est déjà bloquée dans ${lock.vesting}. Suivi : npm run status:${step}`
          : `La réserve communauté est déjà envoyée. Suivi : npm run status:${step}`,
      );
    }
  } else {
    if (balance < teamAmount + communityAmount) {
      throw new LaunchError(
        `Ton wallet ne détient que ${formatTokenAmount(balance)} ${token.symbol} : impossible d'en bloquer ou d'en envoyer ` +
          `${formatTokenAmount(teamAmount + communityAmount)}. Des tokens ont-ils quitté ce wallet ? Rien n'a été envoyé.`,
      );
    }
    if (latest === null) {
      throw new LaunchError("Impossible de lire le dernier bloc. Rien n'a été envoyé.");
    }

    // Calendrier : celui du contrat déjà déployé, sinon celui de launch.config.ts.
    let plan: VestingPlan | undefined;
    if (teamAmount > 0n && vesting !== undefined) {
      plan = planFromJournal(vesting);
      assertCliffAhead({ ...plan, now: BigInt(latest.timestamp), vesting: vesting.address });
    } else if (teamAmount > 0n) {
      const config = validateVestingParams(launchConfig.vesting, signer.address, {
        requireSeparateWallet: profile.isMainnet,
      });
      if ((await ethers.provider.getCode(config.beneficiary)) !== "0x") {
        throw new LaunchError(
          `Le bénéficiaire ${config.beneficiary} est un contrat sur cette chaîne : choisis l'adresse d'un wallet ` +
            "ordinaire dont tu as la clé (ou laisse vesting.beneficiary vide). Rien n'a été envoyé.",
        );
      }
      plan = {
        token: token.address,
        beneficiary: config.beneficiary,
        start: BigInt(latest.timestamp),
        durationSeconds: config.durationSeconds,
        cliffSeconds: config.cliffSeconds,
      };
    }
    const recipient = communityAmount > 0n ? reserve.beneficiary : undefined;
    if (communityAmount > 0n) {
      if (recipient === undefined) {
        throw new LaunchError("community.beneficiary manque dans launch.config.ts. Rien n'a été envoyé.");
      }
      if (profile.isMainnet) {
        // Sur le mainnet, la réserve va dans un Safe 2 sur 3, jamais dans un wallet à clé unique.
        await assertSafe(ethers.provider, recipient, signer.address, "Le wallet communauté");
      } else if ((await ethers.provider.getCode(recipient)) !== "0x") {
        await assertSafe(ethers.provider, recipient, signer.address, "Le wallet communauté");
      }
    }

    heading(`${plan === undefined ? "Réserve communauté" : "Blocage de ta part"} — ${profile.label}`);
    row("Token", `${token.symbol} — ${token.address}`);
    if (plan !== undefined) {
      const isDeployer = getAddress(plan.beneficiary) === getAddress(signer.address);
      row("Part bloquée", `${formatTokenAmount(teamAmount)} ${token.symbol} (${percent(teamAmount, totalSupply)} de l'offre)`);
      row("Bénéficiaire", isDeployer ? `${plan.beneficiary} (ton wallet de déploiement)` : plan.beneficiary);
      if (!isDeployer) {
        row("", "⚠ vérifie cette adresse caractère par caractère : elle seule recevra ta part, et sans sa clé la part est perdue");
      }
      row("Début", formatDate(plan.start));
      row("Falaise", `${formatDate(plan.start + plan.cliffSeconds)} — rien n'est libérable avant (${formatDays(plan.cliffSeconds)})`);
      row("Fin", `${formatDate(plan.start + plan.durationSeconds)} — tout est libéré (${formatDays(plan.durationSeconds)} au total)`);
      row("Entre les deux", "libération linéaire, seconde par seconde");
      row("Retrait anticipé", "impossible, pour personne (toi compris)");
      row("Contrat de blocage", vesting === undefined ? "déployé par cette étape" : `${vesting.address} (déjà déployé)`);
    }
    if (recipient !== undefined) {
      row("Réserve communauté", `${formatTokenAmount(communityAmount)} ${token.symbol} (${percent(communityAmount, totalSupply)} de l'offre)`);
      row("Wallet communauté", recipient);
      row("", "⚠ vérifie cette adresse caractère par caractère et garde bien sa clé : sans elle, la réserve est perdue");
    }
    if (!poolOpen) {
      const forPool = balance - teamAmount - communityAmount;
      row(
        "Pour le pool, ensuite",
        `${formatTokenAmount(forPool)} ${token.symbol} (${percent(forPool, totalSupply)})` +
          (profile.isMainnet ? " : npm run liquidity:mainnet" : " (sur le testnet, l'ouverture se répète avec npm run rehearsal)"),
      );
      row("Ensuite", "ouvre le pool sans attendre, bien avant la falaise");
    }
    if (profile.isMainnet) {
      const actions: string[] = [];
      if (plan !== undefined) {
        actions.push(`bloquer ${formatTokenAmount(teamAmount)} ${token.symbol} jusqu'au ${formatDate(plan.start + plan.durationSeconds)}`);
      }
      if (recipient !== undefined) {
        actions.push(`envoyer ${formatTokenAmount(communityAmount)} ${token.symbol} au wallet communauté`);
      }
      await confirmByTypingSymbol(token.symbol, `${actions.join(", puis ")} (irréversible)`);
    }
    console.log("");
    if (plan !== undefined) {
      vesting = await deployVestingStep(ctx, plan);
      lock = await lockStep(ctx, vesting, teamAmount);
    }
    if (recipient !== undefined) {
      community = await communityStep(ctx, { token: token.address, recipient, amount: communityAmount });
    }
  }

  if (lock !== undefined) {
    if (vesting === undefined) {
      throw new LaunchError("Journal incohérent : un blocage est noté sans contrat de blocage.");
    }
    const status = await readVestingStatus(ethers.provider, vesting.address, token.address);
    heading("Part bloquée");
    row("Contrat de blocage", vesting.address);
    row("Dans le contrat", `${formatTokenAmount(status.locked)} ${token.symbol} — lu sur la chaîne ✔`);
    row("Libérable à partir du", formatDate(status.cliff));
    row("Entièrement libéré le", formatDate(status.end));
    row("Transaction", lock.txHash);
    row("Explorateur", explorerLink(profile, "address", vesting.address) ?? "—");
    row("Journal", journal.location);

    console.log("\nVérification du contrat de blocage sur Blockscout (tout le monde pourra lire le calendrier)…");
    const target = { address: vesting.address, contract: VESTING_CONTRACT, constructorArgs: vestingConstructorArgs(vesting) };
    if (await verifyOnBlockscout(hre, target, 3)) {
      console.log("  ✔ Code source vérifié.");
    } else {
      console.log(`  À relancer plus tard : ${manualVerifyCommand(networkName, target)}`);
    }
  }
  if (community !== undefined) {
    const held = (await tokenContract.balanceOf(community.recipient)) as bigint;
    heading("Réserve communauté");
    row("Wallet communauté", community.recipient);
    row("Solde", `${formatTokenAmount(held)} ${token.symbol} — lu sur la chaîne ✔`);
    row("Transaction", community.txHash);
    row("Explorateur", explorerLink(profile, "address", community.recipient) ?? "—");
  }

  console.log(
    "\nAnnonce publiquement l'adresse du contrat de blocage" +
      (community === undefined ? "" : " et celle du wallet communauté") +
      " : tout le monde peut les suivre.",
  );
  if (poolOpen) {
    console.log(`Suivi : npm run status:${step} ; après la falaise : npm run release:${step}`);
  } else if (profile.isMainnet) {
    console.log("Étape suivante, sans attendre : npm run liquidity:mainnet (ta part y apparaîtra déjà bloquée).");
  } else {
    console.log("Testnet validé. Répète l'ouverture du pool sur le fork (npm run rehearsal), puis passe au mainnet.");
  }
}

await runScript(async () => {
  const connection = await hre.network.create();
  const profile = await resolveNetworkProfile(connection.networkName, connection.ethers.provider, [
    "robinhood",
    "robinhoodTestnet",
  ]);
  // Un seul lancement à la fois sur ce réseau (deux terminaux pourraient sinon signer chacun le leur).
  const releaseLock = await acquireLock(connection.networkName);
  try {
    await lockShare(connection, profile);
  } finally {
    await releaseLock();
  }
});
