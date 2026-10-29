import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect } from "chai";
import hre from "hardhat";

import { MAX_WHOLE_TOKENS, UNIT } from "../scripts/lib/constants.ts";
import { LaunchError } from "../scripts/lib/errors.ts";
import { formatEth, formatRatio, formatTokenAmount, percent } from "../scripts/lib/format.ts";
import { acquireLock, fileJournal } from "../scripts/lib/records.ts";
import { isFeeCapExceeded, isFeeRejection } from "../scripts/lib/tx.ts";
import { buildLiquidityPlan } from "../scripts/lib/uniswap.ts";
import { assertCliffAhead, communityShare, poolBaseAmount, poolShare, shareToLock } from "../scripts/lib/vesting.ts";
import {
  containsRobinhoodMark,
  validateCommunityParams,
  validateLiquidityParams,
  validateTokenParams,
  validateVestingParams,
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
  it("n'expose que les 9 fonctions ERC-20 standard : aucune fonction d'administration", async function () {
    const artifact = await hre.artifacts.readArtifact("MemeToken");
    const abi = artifact.abi as Array<{ type: string; name?: string; stateMutability?: string }>;

    const functions = abi.filter((item) => item.type === "function").map((item) => item.name).sort();
    expect(functions).to.deep.equal(STANDARD_ERC20_FUNCTIONS);

    const events = abi.filter((item) => item.type === "event").map((item) => item.name).sort();
    expect(events).to.deep.equal(["Approval", "Transfer"]);

    expect(abi.some((item) => item.type === "receive" || item.type === "fallback")).to.equal(false);
    const constructor = abi.find((item) => item.type === "constructor");
    expect(constructor?.stateMutability).to.equal("nonpayable");
  });

  it("le PoolSeeder n'a qu'une fonction d'écriture et aucun owner", async function () {
    const artifact = await hre.artifacts.readArtifact("PoolSeeder");
    const abi = artifact.abi as Array<{ type: string; name?: string; stateMutability?: string }>;
    const functions = abi.filter((item) => item.type === "function");
    expect(functions.map((item) => item.name).sort()).to.deep.equal(["DEAD", "FACTORY", "WETH", "seed"]);
    const writable = functions.filter((item) => item.stateMutability !== "view" && item.stateMutability !== "pure");
    expect(writable.map((item) => item.name)).to.deep.equal(["seed"]);
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

  it("refuse une offre nulle ou au-delà de la borne uint112 (réserves Uniswap v2)", function () {
    validateTokenParams({ ...valid, supply: MAX_WHOLE_TOKENS }, { allowPlaceholder: false });
    expectInvalid(() => validateTokenParams({ ...valid, supply: 0n }, { allowPlaceholder: false }), /uint112/);
    expectInvalid(
      () => validateTokenParams({ ...valid, supply: MAX_WHOLE_TOKENS + 1n }, { allowPlaceholder: false }),
      /uint112/,
    );
    // La borne est la plus grande offre qui tient dans les réserves uint112 d'Uniswap v2…
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

  it("valide les paramètres de liquidité", function () {
    expect(validateLiquidityParams({ ethAmount: "0.5", tokenPercent: 100 })).to.deep.equal({
      ethAmountWei: 500_000_000_000_000_000n,
      tokenPercent: 100n,
    });
    expectInvalid(() => validateLiquidityParams({ ethAmount: "abc", tokenPercent: 100 }), /ethAmount/);
    expectInvalid(() => validateLiquidityParams({ ethAmount: "0", tokenPercent: 100 }), /positif/);
    expectInvalid(() => validateLiquidityParams({ ethAmount: "1", tokenPercent: 0 }), /tokenPercent/);
    expectInvalid(() => validateLiquidityParams({ ethAmount: "1", tokenPercent: 50.5 }), /tokenPercent/);
  });
});

describe("Ta part et le pool", function () {
  const supply = 1_000_000_000n * UNIT;

  it("ta part = ce que le pool ne recevra pas, arrondi en faveur de ta part", function () {
    expect(shareToLock(supply, 95n)).to.equal(supply / 20n);
    expect(shareToLock(supply, 100n)).to.equal(0n);
    expect(shareToLock(999n, 95n)).to.equal(50n); // le pool reçoit 949 (arrondi inférieur)
  });

  it("part bloquée : le pool reçoit tout le reste, même si tokenPercent a changé depuis", function () {
    for (const tokenPercent of [95n, 90n, 100n]) {
      expect(poolShare({ tokenPercent, vestingEnabled: true, lockConfirmed: true, lockCommand: "x" })).to.deep.equal({
        poolPercent: 100n,
        mode: "locked",
      });
    }
  });

  it("blocage activé mais pas encore fait : refuse d'ouvrir le pool", function () {
    expectInvalid(
      () => poolShare({ tokenPercent: 95n, vestingEnabled: true, lockConfirmed: false, lockCommand: "npm run lock:mainnet" }),
      /Bloque d'abord ta part : npm run lock:mainnet/,
    );
  });

  it("part bloquée : le pool reçoit l'offre moins ta part, même si des tokens libérés sont revenus", function () {
    const share = supply / 20n;
    expect(poolBaseAmount({ mode: "locked", totalSupply: supply, lockedAmount: share, balance: supply - share + 123n })).to.equal(
      supply - share,
    );
    expect(poolBaseAmount({ mode: "unlocked", totalSupply: supply, lockedAmount: 0n, balance: supply })).to.equal(supply);
  });

  it("sans part, ou blocage désactivé : tokenPercent s'applique tel quel", function () {
    expect(poolShare({ tokenPercent: 100n, vestingEnabled: true, lockConfirmed: false, lockCommand: "x" })).to.deep.equal({
      poolPercent: 100n,
      mode: "none",
    });
    expect(poolShare({ tokenPercent: 95n, vestingEnabled: false, lockConfirmed: false, lockCommand: "x" })).to.deep.equal({
      poolPercent: 95n,
      mode: "unlocked",
    });
  });
});

describe("Réserve communauté", function () {
  const deployer = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  const wallet = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
  const valid = { percent: 3, beneficiary: wallet };

  it("accepte une réserve vers un wallet dédié, ou pas de réserve du tout", function () {
    expect(validateCommunityParams(valid, deployer, 87n)).to.deep.equal({ percent: 3n, beneficiary: wallet });
    expect(validateCommunityParams({ ...valid, beneficiary: ` ${wallet} ` }, deployer, 97n).beneficiary).to.equal(wallet);
    expect(validateCommunityParams({ percent: 0, beneficiary: "" }, deployer, 100n)).to.deep.equal({
      percent: 0n,
      beneficiary: undefined,
    });
  });

  it("refuse un pourcentage invalide ou un total qui dépasse l'offre", function () {
    expectInvalid(() => validateCommunityParams({ ...valid, percent: -1 }, deployer, 87n), /entre 0 et 99/);
    expectInvalid(() => validateCommunityParams({ ...valid, percent: 1.5 }, deployer, 87n), /entre 0 et 99/);
    expectInvalid(() => validateCommunityParams({ ...valid, percent: 100 }, deployer, 0n), /entre 0 et 99/);
    expectInvalid(() => validateCommunityParams({ ...valid, percent: 14 }, deployer, 87n), /dépasse 100/);
  });

  it("exige un wallet neuf : ni vide, ni sans casse, ni 0, ni l'adresse morte, ni le déployeur", function () {
    expectInvalid(() => validateCommunityParams({ ...valid, beneficiary: "" }, deployer, 87n), /obligatoire.*wallet neuf/);
    expectInvalid(() => validateCommunityParams({ ...valid, beneficiary: wallet.toLowerCase() }, deployer, 87n), /majuscules/);
    expectInvalid(
      () => validateCommunityParams({ ...valid, beneficiary: "0x0000000000000000000000000000000000000000" }, deployer, 87n),
      /adresse 0/,
    );
    expectInvalid(
      () => validateCommunityParams({ ...valid, beneficiary: "0x000000000000000000000000000000000000dEaD" }, deployer, 87n),
      /adresse morte/,
    );
    expectInvalid(() => validateCommunityParams({ ...valid, beneficiary: deployer }, deployer, 87n), /wallet de déploiement/);
    expectInvalid(() => validateCommunityParams({ ...valid, beneficiary: "0x1234" }, deployer, 87n), /pas une adresse valide/);
  });

  it("pool + réserve + ta part = offre, à l'unité près (arrondis inférieurs, ta part prend le reste)", function () {
    const supply = 1_000_000_000n * UNIT;
    expect(communityShare(supply, 3n)).to.equal(30_000_000n * UNIT);
    expect(shareToLock(supply, 87n, 3n)).to.equal(100_000_000n * UNIT);
    expect(shareToLock(supply, 97n, 3n)).to.equal(0n);
    // Offre non divisible : pool 869, réserve 29, ta part 101 (= 999 − 869 − 29).
    expect(communityShare(999n, 3n)).to.equal(29n);
    expect(shareToLock(999n, 87n, 3n)).to.equal(101n);
    const pool = poolBaseAmount({ mode: "locked", totalSupply: 999n, lockedAmount: 101n, balance: 898n, communityAmount: 29n });
    expect(pool).to.equal(869n);
    expect(pool).to.equal((999n * 87n) / 100n);
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

  it("refuse de remplir un contrat déjà déployé dont la falaise est passée ou imminente", function () {
    const vesting = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
    const start = 1_000_000n;
    const cliffSeconds = 90n * 86_400n;
    expect(() => assertCliffAhead({ start, cliffSeconds, now: start + 86_400n, vesting })).to.not.throw();
    expectInvalid(() => assertCliffAhead({ start, cliffSeconds, now: start + 100n * 86_400n, vesting }), /falaise/);
    expectInvalid(() => assertCliffAhead({ start, cliffSeconds, now: start + cliffSeconds - 60n, vesting }), /moins d'une heure/);
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

describe("Plan de liquidité", function () {
  const supply = 1_000_000_000n * UNIT;

  it("avec 100 % dans le pool, la capitalisation de départ égale l'ETH apporté", function () {
    const plan = buildLiquidityPlan({
      deployerTokenBalance: supply,
      tokenTotalSupply: supply,
      tokenPercent: 100n,
      ethAmount: 500_000_000_000_000_000n,
    });
    expect(plan.tokenAmount).to.equal(supply);
    expect(plan.keptTokens).to.equal(0n);
    expect(plan.impliedFdvWei).to.equal(500_000_000_000_000_000n);
  });

  it("avec 50 % dans le pool, la capitalisation de départ double", function () {
    const plan = buildLiquidityPlan({
      deployerTokenBalance: supply,
      tokenTotalSupply: supply,
      tokenPercent: 50n,
      ethAmount: 500_000_000_000_000_000n,
    });
    expect(plan.keptTokens).to.equal(supply / 2n);
    expect(plan.impliedFdvWei).to.equal(1_000_000_000_000_000_000n);
  });

  it("refuse un solde vide", function () {
    expectInvalid(
      () => buildLiquidityPlan({ deployerTokenBalance: 0n, tokenTotalSupply: supply, tokenPercent: 100n, ethAmount: 1n }),
      /solde/,
    );
  });

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
