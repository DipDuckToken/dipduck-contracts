import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect } from "chai";
import hre from "hardhat";

import { parseEther } from "ethers";

import { MAX_WHOLE_TOKENS, UNIT } from "../scripts/lib/constants.ts";
import { buildLaunchPlan, formatDelay, splitSupply, startTickFor, tickPriceWei } from "../scripts/lib/launch.ts";
import { LaunchError } from "../scripts/lib/errors.ts";
import { formatEth, formatRatio, formatTokenAmount, percent } from "../scripts/lib/format.ts";
import { acquireLock, fileJournal } from "../scripts/lib/records.ts";
import { isFeeCapExceeded, isFeeRejection } from "../scripts/lib/tx.ts";
import {
  containsRobinhoodMark,
  parseIsoDate,
  validateCommunityParams,
  validatePoolParams,
  validateTeamParams,
  validateTokenParams,
  validateVestingParams,
  validateVestingPercent,
} from "../scripts/lib/validation.ts";

const STANDARD_ERC20_FUNCTIONS = [
  "allowance",
  "approve",
  "balanceOf",
  "decimals",
  "name",
  "symbol",
  "totalSupply",
  "transfer",
  "transferFrom",
];

function expectInvalid(run: () => unknown, pattern: RegExp): void {
  expect(run).to.throw(LaunchError, pattern);
}

describe("Surface du contrat", function () {
  it("n'expose que les 9 fonctions ERC-20 standard plus la lecture de l'anti-bot : aucune fonction d'administration", async function () {
    const artifact = await hre.artifacts.readArtifact("MemeToken");
    const abi = artifact.abi as Array<{ type: string; name?: string; stateMutability?: string }>;

    const functions = abi.filter((item) => item.type === "function");
    const antiBot = ["LAUNCHER", "LIMIT_DURATION", "OPEN_AT", "PAIR", "walletLimit"];
    expect(functions.map((item) => item.name).sort()).to.deep.equal([...STANDARD_ERC20_FUNCTIONS, ...antiBot].sort());
    // L'anti-bot se lit seulement : rien ne permet de le modifier, le prolonger ou l'arrêter.
    for (const name of antiBot) {
      expect(functions.find((item) => item.name === name)?.stateMutability, name).to.equal("view");
    }

    const events = abi.filter((item) => item.type === "event").map((item) => item.name).sort();
    expect(events).to.deep.equal(["Approval", "Transfer"]);

    expect(abi.some((item) => item.type === "receive" || item.type === "fallback")).to.equal(false);
    const constructor = abi.find((item) => item.type === "constructor");
    expect(constructor?.stateMutability).to.equal("nonpayable");
  });

  it("le lanceur n'a qu'une fonction d'écriture (verser les frais), aucun owner, rien pour retirer la liquidité", async function () {
    const artifact = await hre.artifacts.readArtifact("LaunchPool");
    const abi = artifact.abi as Array<{ type: string; name?: string; stateMutability?: string }>;
    const functions = abi.filter((item) => item.type === "function");
    const writable = functions.filter((item) => item.stateMutability !== "view" && item.stateMutability !== "pure");
    expect(writable.map((item) => item.name)).to.deep.equal(["collectFees"]);
    expect(functions.some((item) => /owner|admin|pause|set|withdraw|remove|transfer/i.test(item.name ?? ""))).to.equal(false);
    expect(abi.some((item) => item.type === "receive" || item.type === "fallback")).to.equal(false);
  });

  it("le contrat de blocage n'offre aucun moyen de retirer plus tôt", async function () {
    const artifact = await hre.artifacts.readArtifact("TokenVesting");
    const abi = artifact.abi as Array<{ type: string; name?: string; stateMutability?: string }>;
    const writable = abi
      .filter((item) => item.type === "function" && item.stateMutability !== "view" && item.stateMutability !== "pure")
      .map((item) => item.name)
      .sort();
    // release() et release(token) versent seulement ce que le calendrier a libéré, au bénéficiaire ;
    // transferOwnership change le bénéficiaire, pas le calendrier ; renounceOwnership est « pure » et échoue toujours.
    expect(writable).to.deep.equal(["release", "release", "transferOwnership"]);
    const renounce = abi.find((item) => item.name === "renounceOwnership");
    expect(renounce?.stateMutability).to.equal("pure");
  });
});

describe("Garde-fous des paramètres", function () {
  const valid = { name: "Mon Chat Volant", symbol: "CHAT", supply: 1_000_000_000n };

  it("accepte des paramètres valides, accents compris", function () {
    validateTokenParams(valid, { allowPlaceholder: false });
    validateTokenParams({ ...valid, name: "Café Étoilé" }, { allowPlaceholder: false });
  });

  it("refuse toute variante de la marque Robinhood, dans le nom comme dans le symbole", function () {
    for (const value of ["Robinhood Cat", "ROBIN HOOD", "Robin-Hood", "h00d", "HOODCAT", "Neighborhood"]) {
      expect(containsRobinhoodMark(value), value).to.equal(true);
    }
    expectInvalid(() => validateTokenParams({ ...valid, name: "Robin Hood Coin" }, { allowPlaceholder: false }), /hood/);
    expectInvalid(() => validateTokenParams({ ...valid, symbol: "HOOD" }, { allowPlaceholder: false }), /hood/);
  });

  it("refuse les valeurs d'exemple hors fork", function () {
    const placeholder = { name: "CHANGE ME", symbol: "CHANGEME", supply: 1n };
    expectInvalid(() => validateTokenParams(placeholder, { allowPlaceholder: false }), /exemple/);
    validateTokenParams(placeholder, { allowPlaceholder: true });
  });

  it("refuse une offre nulle ou au-delà de la borne uint112", function () {
    validateTokenParams({ ...valid, supply: MAX_WHOLE_TOKENS }, { allowPlaceholder: false });
    expectInvalid(() => validateTokenParams({ ...valid, supply: 0n }, { allowPlaceholder: false }), /uint112/);
    expectInvalid(
      () => validateTokenParams({ ...valid, supply: MAX_WHOLE_TOKENS + 1n }, { allowPlaceholder: false }),
      /uint112/,
    );
    // La borne est la plus grande offre qui tient dans un uint112…
    expect(MAX_WHOLE_TOKENS * UNIT <= 2n ** 112n - 1n).to.equal(true);
    expect((MAX_WHOLE_TOKENS + 1n) * UNIT > 2n ** 112n - 1n).to.equal(true);
    // … et tient donc aussi dans un u128 (pont futur vers CosmWasm / Substrate).
    expect(MAX_WHOLE_TOKENS * UNIT <= 2n ** 128n - 1n).to.equal(true);
  });

  it("refuse un symbole mal formé et un nom avec espaces superflus", function () {
    expectInvalid(() => validateTokenParams({ ...valid, symbol: "chat" }, { allowPlaceholder: false }), /symbole/);
    expectInvalid(() => validateTokenParams({ ...valid, symbol: "ABCDEFGHIJKL" }, { allowPlaceholder: false }), /symbole/);
    expectInvalid(() => validateTokenParams({ ...valid, name: " Chat" }, { allowPlaceholder: false }), /espace/);
  });

});

describe("Paramètres du pool", function () {
  const now = 1_800_000_000n;
  const valid = { startMarketCapEth: "3", openAt: "" };
  const iso = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString();
  const options = { supplyWholeTokens: 1_000_000_000n, now, isMainnet: true };

  it("accepte la config par défaut ; tick = plus grand multiple de 200 sous log(capitalisation / offre)", function () {
    const pool = validatePoolParams({ ...valid, openAt: iso(now + 2n * 3600n) }, options);
    expect(pool).to.deep.equal({ startMarketCapWei: parseEther("3"), startTick: -196_400, openAt: now + 2n * 3600n });
    // Le prix réel est sous la cible d'au plus un palier (≈ 2 %).
    const target = parseEther("3") / 1_000_000_000n;
    expect(tickPriceWei(-196_400) <= target).to.equal(true);
    expect(tickPriceWei(-196_200) > target).to.equal(true);
    expect(startTickFor(parseEther("3"), 1_000_000_000n) % 200).to.equal(0);
    expect(parseIsoDate("2026-12-01T20:00:00Z")).to.equal(BigInt(Date.parse("2026-12-01T20:00:00Z") / 1000));
    expect(parseIsoDate("2026-12-01T20:00:00")).to.equal(undefined); // sans fuseau : ambigu
    expect(parseIsoDate("1er décembre")).to.equal(undefined);
  });

  it("exige une heure d'ouverture sur le mainnet : future, au moins 1 h, au plus 30 jours", function () {
    expectInvalid(() => validatePoolParams(valid, options), /obligatoire sur le mainnet/);
    expectInvalid(() => validatePoolParams({ ...valid, openAt: iso(now - 60n) }, options), /déjà passée/);
    expectInvalid(() => validatePoolParams({ ...valid, openAt: iso(now + 1800n) }, options), /trop proche/);
    expectInvalid(() => validatePoolParams({ ...valid, openAt: iso(now + 31n * 86_400n) }, options), /plus de 30 jours/);
    expectInvalid(() => validatePoolParams({ ...valid, openAt: "2026-12-01 20:00" }, options), /date ISO/);
    // Hors mainnet : vide = dans 2 h, et 15 minutes suffisent.
    expect(validatePoolParams(valid, { ...options, isMainnet: false }).openAt).to.equal(now + 7200n);
    expect(validatePoolParams({ ...valid, openAt: iso(now + 1800n) }, { ...options, isMainnet: false }).openAt).to.equal(now + 1800n);
  });

  it("refuse une capitalisation illisible, déraisonnable ou hors des bornes du contrat", function () {
    const openAt = iso(now + 7200n);
    expectInvalid(() => validatePoolParams({ openAt, startMarketCapEth: "abc" }, options), /startMarketCapEth invalide/);
    expectInvalid(() => validatePoolParams({ openAt, startMarketCapEth: "0" }, options), /entre 0.01 et 1000000/);
    expectInvalid(() => validatePoolParams({ openAt, startMarketCapEth: "5000000" }, options), /entre 0.01 et 1000000/);
    // Au moins 1 ETH par token : tick ≥ 0, refusé par le contrat.
    expectInvalid(() => validatePoolParams({ openAt, startMarketCapEth: "2000" }, { ...options, supplyWholeTokens: 1000n }), /bornes du contrat/);
  });
});

describe("Répartition de l'offre et chiffres du pool", function () {
  it("pool + ta part + réserve = offre, à l'unité près (le pool prend les arrondis)", function () {
    expect(splitSupply(1_000_000_000n, 10n, 3n)).to.deep.equal({
      poolWholeTokens: 870_000_000n,
      vestingWholeTokens: 100_000_000n,
      communityWholeTokens: 30_000_000n,
    });
    expect(splitSupply(999n, 10n, 3n)).to.deep.equal({ poolWholeTokens: 871n, vestingWholeTokens: 99n, communityWholeTokens: 29n });
    expect(splitSupply(1_000n, 0n, 0n)).to.deep.equal({ poolWholeTokens: 1_000n, vestingWholeTokens: 0n, communityWholeTokens: 0n });
  });

  it("config par défaut : capitalisation ≈ 2,96 ETH, 0,5 % de l'offre ≈ 0,015 ETH frais compris, 87 % au pool", function () {
    const plan = buildLaunchPlan({
      supplyWholeTokens: 1_000_000_000n,
      split: splitSupply(1_000_000_000n, 10n, 3n),
      startTick: startTickFor(parseEther("3"), 1_000_000_000n),
    });
    const supply = 1_000_000_000n * UNIT;
    expect(plan.poolAmount).to.equal((supply * 87n) / 100n);
    expect(plan.vestingAmount).to.equal(supply / 10n);
    expect(plan.communityAmount).to.equal((supply * 3n) / 100n);
    expect(plan.startFdvWei / 10n ** 16n).to.equal(295n); // 2,95 ETH
    expect(plan.halfPercentCostWei / 10n ** 14n).to.equal(150n); // 0,0150 ETH
  });

  it("ta part n'existe que bloquée, en % entier", function () {
    expect(validateVestingPercent({ percent: 10, enabled: true })).to.equal(10n);
    expect(validateVestingPercent({ percent: 0, enabled: false })).to.equal(0n);
    expectInvalid(() => validateVestingPercent({ percent: 10, enabled: false }), /que bloquée/);
    expectInvalid(() => validateVestingPercent({ percent: 1.5, enabled: true }), /entre 0 et 99/);
  });

  it("affiche un délai lisible", function () {
    expect(formatDelay(1_000n + 3n * 3600n + 5n * 60n, 1_000n)).to.equal("dans 3 h 05 min");
    expect(formatDelay(1_000n + 2n * 86_400n + 4n * 3600n, 1_000n)).to.equal("dans 2 j 4 h");
    expect(formatDelay(1_000n, 1_000n + 720n)).to.equal("passée depuis 12 min");
  });
});

describe("Réserve communauté", function () {
  const deployer = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  const wallet = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
  const valid = { percent: 3, beneficiary: wallet };

  it("accepte une réserve vers un wallet dédié, ou pas de réserve du tout", function () {
    expect(validateCommunityParams(valid, deployer, 10n)).to.deep.equal({ percent: 3n, beneficiary: wallet });
    expect(validateCommunityParams({ ...valid, beneficiary: ` ${wallet} ` }, deployer, 0n).beneficiary).to.equal(wallet);
    // Sans réserve, le Safe reste accepté (il reçoit les frais d'échange).
    expect(validateCommunityParams({ percent: 0, beneficiary: wallet }, deployer, 10n).beneficiary).to.equal(wallet);
    expect(validateCommunityParams({ percent: 0, beneficiary: "" }, deployer, 0n)).to.deep.equal({
      percent: 0n,
      beneficiary: undefined,
    });
  });

  it("refuse un pourcentage invalide ou un total qui dépasse l'offre", function () {
    expectInvalid(() => validateCommunityParams({ ...valid, percent: -1 }, deployer, 10n), /entre 0 et 99/);
    expectInvalid(() => validateCommunityParams({ ...valid, percent: 1.5 }, deployer, 10n), /entre 0 et 99/);
    expectInvalid(() => validateCommunityParams({ ...valid, percent: 100 }, deployer, 0n), /entre 0 et 99/);
    expectInvalid(() => validateCommunityParams({ ...valid, percent: 90 }, deployer, 10n), /dépasse 99/);
  });

  it("exige un wallet dédié (Safe) : ni vide, ni sans casse, ni 0, ni l'adresse morte, ni le déployeur", function () {
    expectInvalid(() => validateCommunityParams({ ...valid, beneficiary: "" }, deployer, 10n), /obligatoire.*Safe 2 sur 3/);
    expectInvalid(() => validateCommunityParams({ ...valid, beneficiary: wallet.toLowerCase() }, deployer, 10n), /majuscules/);
    expectInvalid(
      () => validateCommunityParams({ ...valid, beneficiary: "0x0000000000000000000000000000000000000000" }, deployer, 10n),
      /adresse 0/,
    );
    expectInvalid(
      () => validateCommunityParams({ ...valid, beneficiary: "0x000000000000000000000000000000000000dEaD" }, deployer, 10n),
      /adresse morte/,
    );
    expectInvalid(() => validateCommunityParams({ ...valid, beneficiary: deployer }, deployer, 10n), /wallet de déploiement/);
    expectInvalid(() => validateCommunityParams({ ...valid, beneficiary: "0x1234" }, deployer, 10n), /pas une adresse valide/);
  });

});

describe("Safe de l'équipe (40 % des frais du pool)", function () {
  const deployer = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  const community = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
  const team = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

  it("accepte un Safe dédié et le rend avec sa somme de contrôle", function () {
    expect(validateTeamParams({ safe: ` ${team} ` }, deployer, community)).to.equal(team);
  });

  it("refuse un Safe vide, sans casse, nul, mort, le wallet de déploiement ou le Safe communauté", function () {
    expectInvalid(() => validateTeamParams({ safe: "" }, deployer, community), /team.safe est obligatoire/);
    expectInvalid(() => validateTeamParams({ safe: team.toLowerCase() }, deployer, community), /majuscules/);
    expectInvalid(() => validateTeamParams({ safe: "0x0000000000000000000000000000000000000000" }, deployer, community), /adresse 0/);
    expectInvalid(() => validateTeamParams({ safe: "0x000000000000000000000000000000000000dEaD" }, deployer, community), /adresse morte/);
    expectInvalid(() => validateTeamParams({ safe: deployer }, deployer, community), /wallet de déploiement/);
    expectInvalid(() => validateTeamParams({ safe: community }, deployer, community), /différent du Safe communauté/);
    expectInvalid(() => validateTeamParams({ safe: "0x1234" }, deployer, community), /pas une adresse valide/);
  });
});

describe("Paramètres du blocage (vesting)", function () {
  const deployer = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  const valid = { enabled: true, durationDays: 365, cliffDays: 90, beneficiary: "" };

  it("par défaut, le bénéficiaire est le wallet de déploiement ; les jours deviennent des secondes", function () {
    const vesting = validateVestingParams(valid, deployer.toLowerCase());
    expect(vesting.beneficiary).to.equal(deployer);
    expect(vesting.durationSeconds).to.equal(365n * 86_400n);
    expect(vesting.cliffSeconds).to.equal(90n * 86_400n);
  });

  it("accepte un autre bénéficiaire valide", function () {
    const other = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
    expect(validateVestingParams({ ...valid, beneficiary: ` ${other} ` }, deployer).beneficiary).to.equal(other);
  });

  it("refuse une durée ou une falaise incohérente", function () {
    expectInvalid(() => validateVestingParams({ ...valid, durationDays: 0 }, deployer), /durationDays/);
    expectInvalid(() => validateVestingParams({ ...valid, durationDays: 1.5 }, deployer), /durationDays/);
    expectInvalid(() => validateVestingParams({ ...valid, cliffDays: 400 }, deployer), /cliffDays/);
    expectInvalid(() => validateVestingParams({ ...valid, cliffDays: -1 }, deployer), /cliffDays/);
    // Au moins un jour : rien ne doit pouvoir sortir du contrat avant l'ouverture du pool.
    expectInvalid(() => validateVestingParams({ ...valid, cliffDays: 0 }, deployer), /entre 1 et/);
  });

  it("exige la casse d'origine d'un autre bénéficiaire : une faute de frappe ne passe pas", function () {
    // Tout en minuscules, une faute de frappe (…4293bd au lieu de …4293bc) ne serait pas détectée.
    expectInvalid(
      () => validateVestingParams({ ...valid, beneficiary: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bd" }, deployer),
      /majuscules et minuscules d'origine/,
    );
    expectInvalid(
      () => validateVestingParams({ ...valid, beneficiary: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc" }, deployer),
      /majuscules et minuscules d'origine/,
    );
    // Ton propre wallet de déploiement, lui, est reconnu quelle que soit la casse.
    expect(validateVestingParams({ ...valid, beneficiary: deployer.toLowerCase() }, deployer).beneficiary).to.equal(deployer);
  });

  it("refuse une adresse invalide, mal recopiée, nulle ou morte", function () {
    expectInvalid(() => validateVestingParams({ ...valid, beneficiary: "0x1234" }, deployer), /pas une adresse valide/);
    // Casse modifiée = somme de contrôle fausse : souvent une faute de recopie.
    expectInvalid(
      () => validateVestingParams({ ...valid, beneficiary: "0x3c44CdDdB6a900fa2b585dd299e03d12FA4293BC" }, deployer),
      /pas une adresse valide/,
    );
    expectInvalid(
      () => validateVestingParams({ ...valid, beneficiary: "0x0000000000000000000000000000000000000000" }, deployer),
      /adresse 0/,
    );
    expectInvalid(
      () => validateVestingParams({ ...valid, beneficiary: "0x000000000000000000000000000000000000dEaD" }, deployer),
      /adresse morte/,
    );
  });
});

describe("Refus de diffusion", function () {
  it("re-signe sur des frais trop bas, jamais sur un plafond de frais du RPC", function () {
    for (const message of [
      "max fee per gas less than block base fee",
      "transaction underpriced",
      "Transaction maxFeePerGas (1) is too low for the next block, which has a baseFeePerGas of 2",
      "fee cap too low",
    ]) {
      expect(isFeeRejection(new Error(message)), message).to.equal(true);
    }
    const cap = new Error("tx fee (1.20 ether) exceeds the configured cap (1.00 ether)");
    expect(isFeeCapExceeded(cap)).to.equal(true);
    expect(isFeeRejection(cap)).to.equal(false);
    expect(isFeeRejection(new Error("execution reverted"))).to.equal(false);
  });
});

describe("Journal du lancement", function () {
  it("écrit de façon atomique et relit ce qu'il a écrit", async function () {
    const directory = await mkdtemp(path.join(tmpdir(), "journal-"));
    try {
      const journal = fileJournal("testnet", directory);
      expect(await journal.read()).to.equal(undefined);
      await journal.write({ network: "testnet", chainId: "46630" });
      await journal.write({ network: "testnet", chainId: "46630", token: undefined });
      expect(await journal.read()).to.deep.equal({ network: "testnet", chainId: "46630" });
      expect(await readdir(directory)).to.deep.equal(["testnet.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("un seul lancement à la fois par réseau ; un verrou abandonné est repris", async function () {
    const directory = await mkdtemp(path.join(tmpdir(), "verrou-"));
    try {
      const release = await acquireLock("robinhood", directory);
      try {
        await acquireLock("robinhood", directory);
        expect.fail("Le second verrou aurait dû être refusé.");
      } catch (error) {
        expect(error).to.be.instanceOf(LaunchError);
        expect((error as Error).message).to.match(/Un autre lancement est en cours/);
      }
      const otherNetwork = await acquireLock("robinhoodTestnet", directory);
      await otherNetwork();
      await release();
      expect(await readdir(directory)).to.deep.equal([]);

      // Verrou laissé par un processus disparu (arrêt brutal) : repris sans intervention.
      await writeFile(path.join(directory, "robinhood.lock"), JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: "hier" }));
      const again = await acquireLock("robinhood", directory);
      await again();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("Affichage", function () {
  const supply = 1_000_000_000n * UNIT;

  it("formate les montants sans perte", function () {
    expect(formatTokenAmount(supply)).to.equal(new Intl.NumberFormat("fr-CA").format(1_000_000_000n));
    expect(formatTokenAmount(UNIT + UNIT / 2n)).to.equal("1,5");
    const thousands = new Intl.NumberFormat("fr-CA").format(1234);
    expect(formatEth(1234n * UNIT + UNIT / 2n)).to.equal(`${thousands},5 ETH`);
    expect(formatEth(1n)).to.equal("0,000000000000000001 ETH");
    expect(formatEth(0n)).to.equal("0 ETH");
    expect(formatRatio(5n, 10_000_000_000n)).to.equal("5,000e-10");
    expect(formatRatio(1n, 3n)).to.equal("0,3333");
    expect(percent(1n, 3n)).to.equal("33,33 %");
  });
});
