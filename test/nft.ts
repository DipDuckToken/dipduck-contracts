import { expect } from "chai";
import { AbiCoder, Contract, Wallet, ZeroHash, encodeBytes32String, getAddress, getBytes, keccak256, parseEther, toBeHex } from "ethers";
import { network } from "hardhat";

import { LaunchError } from "../scripts/lib/errors.ts";
import { memoryJournal } from "../scripts/lib/records.ts";
import { type StepContext, deployNftStep } from "../scripts/lib/steps.ts";
import { validateNftParams } from "../scripts/lib/validation.ts";
import { localWallet } from "../scripts/lib/wallet.ts";

const connection = await network.create();
const { ethers, networkHelpers } = connection;
const { chainId } = await ethers.provider.getNetwork();

const CARDS_ABI = [
  "function mint(bytes32 name, uint8 mood, uint8 element, uint16 lucky, uint256 quantity) payable",
  "function revealMany(uint256[] tokenIds)",
  "function traitsOf(uint256) view returns (uint8[10] traits, bool revealed)",
  "function tokenURI(uint256) view returns (string)",
  "function totalMinted() view returns (uint256)",
  "function candidate(uint256) view returns (string name, address wallet, string url, uint256 fromRound)",
  "function vote(uint256[] tokenIds, uint256 candidateIndex)",
  "function votesFor(uint256 round, uint256 candidateIndex) view returns (uint256)",
  "function roundCharity(uint256 round) view returns (uint256)",
  "function currentRound() view returns (uint256)",
  "function mintTrophy(address to, bytes32 name, uint8 mood, uint8 element, uint16 lucky)",
  "function cardOf(uint256) view returns (bytes32 name, uint8 mood, uint8 element, uint16 lucky, uint64 commitBlock, bool revealed, bool trophy)",
  "function trophyReceived(address) view returns (bool)",
  "function reservedMinted() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "error OnlyCommunity()",
  "error TrophyNotAllowed()",
  "error NotEligible(uint256 tokenId)",
];

// Poids de base des options (sur 1000), comme dans le contrat et le site (cards.js).
const WEIGHTS = [
  [300, 220, 180, 140, 90, 50, 18, 2],
  [520, 180, 140, 90, 45, 20, 5],
  [450, 200, 150, 90, 60, 40, 10],
  [700, 120, 100, 60, 20],
  [600, 220, 130, 50],
  [500, 200, 150, 100, 40, 10],
  [500, 300, 150, 45, 5],
  [600, 250, 100, 50],
  [500, 180, 130, 80, 60, 30, 20],
  [550, 160, 130, 120, 40],
];
// Score de rareté du site : somme des -log2(probabilité de base).
const rarityScore = (traits: number[]) => traits.reduce((sum, option, t) => sum - Math.log2(WEIGHTS[t][option] / 1000), 0);
// Plancher du tirage Trophée : sans l'option la plus commune (les deux pour le cadre et les joues).
const TROPHY_FLOOR = WEIGHTS.map((_, t) => (t === 6 || t === 7 ? 2 : 1));
// Tirage Trophée hors jackpot : l'option plancher pèse 8 fois plus ; jackpot si le premier octet
// de la graine est < 23 (≈ 9 %) : poids normaux.
const TROPHY_FLOOR_WEIGHT = 8n;
const TROPHY_JACKPOT = 23;

type DrawInput = { name: string; mood: number; element: number; lucky: number; trophy: boolean };

/** Multiplicateur des secrets (en %), copie exacte de `_boost`. */
function boostPercent(card: DrawInput, t: number, i: number): bigint {
  const { mood, element: e, lucky } = card;
  const seven = lucky > 0 && String(lucky).includes("7");
  if (t === 0 && i === 3 && mood === 2) return 200n;
  if (t === 1 && i === 2 && e === 2) return 200n;
  if (t === 1 && i === 5 && card.name.toLowerCase() === "satoshi") return 300n;
  if (t === 2 && i === 3 && mood === 1) return 150n;
  if (t === 2 && i === 4 && mood === 0) return 200n;
  if (t === 3 && i === 1 && e === 1) return 200n;
  if (t === 5 && i === 1 && e === 0) return 200n;
  if (t === 5 && i === 2 && mood === 3) return 200n;
  if (t === 5 && i === 5 && e === 3) return 300n;
  if (t === 6 && (i === 2 || i === 3) && seven) return 150n;
  if (t === 7 && i === 1 && mood === 0) return 150n;
  if (t === 7 && i === 3 && mood === 1) return 200n;
  if (t === 8 && i === 5 && lucky === 777) return 300n;
  if (t === 8 && i === 6 && mood === 3) return 200n;
  if (t === 9 && i === 2 && e === 2) return 200n;
  if (t === 9 && i === 4 && e === 3) return 200n;
  return 100n;
}

/** Les 10 attributs tirés depuis la graine, copie exacte de `_pick` (cartes achetées et Trophées). */
function drawTraits(card: DrawInput, seed: string): number[] {
  const coder = AbiCoder.defaultAbiCoder();
  const floorWeight = card.trophy && getBytes(seed)[0] >= TROPHY_JACKPOT ? TROPHY_FLOOR_WEIGHT : 1n;
  return WEIGHTS.map((options, t) => {
    const floor = card.trophy ? TROPHY_FLOOR[t] : 0;
    const weights = options.map((w, i) =>
      i < floor ? 0n : BigInt(w) * boostPercent(card, t, i) * (i === floor ? floorWeight : 1n),
    );
    const sum = weights.reduce((a, b) => a + b, 0n);
    const hash = BigInt(keccak256(coder.encode(["bytes32", "uint256"], [seed, t])));
    let roll = seed === ZeroHash ? 0n : ((hash & 0xffffffffn) * sum) >> 32n;
    for (let i = floor; i < options.length; i++) {
      if (roll < weights[i]) return i;
      roll -= weights[i];
    }
    return options.length - 1;
  });
}

/** Seuils de score des paliers du site (top 5 % épique, 1 % légendaire, 0,1 % mythique), tirage normal simulé. */
function tierThresholds(samples = 400_000) {
  let state = 2024;
  const random = () => ((state = (Math.imul(state, 1103515245) + 12345) >>> 0) / 2 ** 32);
  const pick = (weights: number[]) => {
    let roll = random() * 1000;
    for (let i = 0; i < weights.length; i++) if ((roll -= weights[i]) < 0) return i;
    return weights.length - 1;
  };
  const scores = Array.from({ length: samples }, () => rarityScore(WEIGHTS.map(pick))).sort((a, b) => b - a);
  return { epic: scores[samples * 0.05], legendary: scores[samples * 0.01], mythic: scores[samples * 0.001] };
}

const CHARITIES = [
  { name: "Fondation A", address: "0x90F79bf6EB2c4f870365E785982E1f101E93b906" },
  { name: "Fondation B", address: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65", url: "https://fondation-b.example" },
];

describe("Cartes NFT : paramètres", function () {
  const deployer = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  const community = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
  const base = { mintStart: "", founders: "", charities: [], imageBaseURI: "", viewerURI: "" };

  it("sur le mainnet, refuse tout ce qui est vide", function () {
    expect(() => validateNftParams(base, { deployer, community: "", isMainnet: true, now: 1n }))
      .to.throw(LaunchError)
      .with.property("message")
      .that.matches(/mintStart/)
      .and.matches(/community\.beneficiary/)
      .and.matches(/charities/)
      .and.matches(/imageBaseURI/);
  });

  it("sur le testnet, remplace les vides par des valeurs d'essai", function () {
    const plan = validateNftParams(base, { deployer, community: "", isMainnet: false, now: 1_000n });
    expect(plan.founders).to.equal(deployer);
    expect(plan.community).to.equal(deployer);
    expect(plan.mintStart).to.equal(1_000n);
    expect(plan.candidateWallets).to.have.length(2);
  });

  it("accepte une configuration complète et refuse une date sans fuseau ou une URL douteuse", function () {
    const full = {
      ...base,
      founders: Wallet.createRandom().address,
      mintStart: "2026-12-01T20:00:00Z",
      charities: CHARITIES,
      imageBaseURI: "https://dipduck.example/cards/",
      viewerURI: "https://dipduck.example/card.html",
    };
    const plan = validateNftParams(full, { deployer, community, isMainnet: true, now: 1n });
    expect(plan.mintStart).to.equal(BigInt(Date.parse("2026-12-01T20:00:00Z") / 1000));
    expect(plan.candidateWallets).to.deep.equal(CHARITIES.map((c) => getAddress(c.address)));
    expect(plan.candidateUrls).to.deep.equal(["", "https://fondation-b.example"]);
    expect(() => validateNftParams({ ...full, mintStart: "2026-12-01 20:00" }, { deployer, community, isMainnet: true, now: 1n })).to.throw(
      /fuseau/,
    );
    expect(() =>
      validateNftParams({ ...full, viewerURI: 'https://x.example/"a' }, { deployer, community, isMainnet: true, now: 1n }),
    ).to.throw(/https/);
  });
});

describe("Cartes NFT : déploiement journalisé, mint, révélation, métadonnées", function () {
  it("déploie, mint, révèle avec revealMany et produit un JSON valide", async function () {
    const wallet = await localWallet(connection);
    const journal = memoryJournal();
    const ctx: StepContext = { ethers, wallet, journal, networkName: "test", chainId, confirm: async () => {}, log: () => {}, receiptTimeoutMs: 1500 };
    const now = BigInt(await networkHelpers.time.latest());
    const plan = validateNftParams(
      {
        mintStart: "",
        founders: "",
        charities: CHARITIES,
        imageBaseURI: "https://dipduck.example/cards/",
        viewerURI: "https://dipduck.example/card.html",
      },
      { deployer: wallet.address, community: "", isMainnet: false, now },
    );
    const record = await deployNftStep(ctx, plan);
    expect(record.status).to.equal("confirmed");
    // Relancer ne redéploie pas : le contrat du journal est relu et réutilisé.
    expect((await deployNftStep(ctx, plan)).address).to.equal(record.address);

    const [, buyer] = await ethers.getSigners();
    const cards = new Contract(record.address, CARDS_ABI, buyer);
    await (await cards.mint(encodeBytes32String("Satoshi"), 3, 1, 777, 3, { value: parseEther("0.003") })).wait();
    expect(await cards.totalMinted()).to.equal(3n);
    expect((await cards.traitsOf(1)).revealed).to.equal(false);

    await networkHelpers.mine(3); // au-delà du bloc cible (REVEAL_DELAY = 2)
    await (await cards.revealMany([1, 2, 3])).wait();
    const [traits, revealed] = (await cards.traitsOf(2)) as [bigint[], boolean];
    expect(revealed).to.equal(true);
    expect(traits).to.have.length(10);

    const uri = (await cards.tokenURI(2)) as string;
    expect(uri.startsWith("data:application/json;base64,")).to.equal(true);
    const json = JSON.parse(Buffer.from(uri.slice(29), "base64").toString("utf8"));
    expect(json.name).to.equal("Dip Duck #2");
    expect(json.image).to.equal("https://dipduck.example/cards/2.png");
    expect(json.animation_url).to.equal("https://dipduck.example/card.html?id=2");
    expect(json.description).to.match(/no value/).and.match(/Not affiliated with Robinhood/);
    const attributes = Object.fromEntries(json.attributes.map((a: { trait_type: string; value: string }) => [a.trait_type, a.value]));
    expect(Object.keys(attributes)).to.have.length(14);
    expect(attributes).to.include({ mood: "hungry", element: "fire", name: "Satoshi", revealed: "yes" });
    expect(attributes.background).to.be.a("string").and.not.equal("unrevealed");

    const [charityName, , charityUrl, fromRound] = (await cards.candidate(1)) as [string, string, string, bigint];
    expect(charityName).to.equal("Fondation B");
    expect(charityUrl).to.equal("https://fondation-b.example");
    expect(fromRound).to.equal(0n);

    // Période en cours : la cagnotte fondation reçoit 30 % du mint, et les cartes votent.
    expect(await cards.currentRound()).to.equal(0n);
    expect(await cards.roundCharity(0)).to.equal((parseEther("0.003") * 30n) / 100n);
    await (await cards.vote([1, 2, 3], 1)).wait();
    expect(await cards.votesFor(0, 1)).to.equal(3n);
  });

  it("édition Trophée : réservée à la communauté, une par wallet de 2 cartes au plus, au moins épique, sans vote", async function () {
    const wallet = await localWallet(connection);
    const ctx: StepContext = { ethers, wallet, journal: memoryJournal(), networkName: "test", chainId, confirm: async () => {}, log: () => {}, receiptTimeoutMs: 1500 };
    const now = BigInt(await networkHelpers.time.latest());
    const plan = validateNftParams(
      { mintStart: "", founders: "", charities: CHARITIES, imageBaseURI: "https://dipduck.example/cards/", viewerURI: "https://dipduck.example/card.html" },
      { deployer: wallet.address, community: "", isMainnet: false, now },
    );
    const record = await deployNftStep(ctx, plan);
    const [, , winner, collector] = await ethers.getSigners();
    const community = new Contract(record.address, CARDS_ABI, await ethers.getSigner(plan.community));
    const asWinner = new Contract(record.address, CARDS_ABI, winner);
    const asCollector = new Contract(record.address, CARDS_ABI, collector);

    // Hors communauté : refusé.
    await expect(asWinner.mintTrophy(winner.address, encodeBytes32String("Champion"), 1, 3, 7)).to.be.revertedWithCustomError(
      asWinner,
      "OnlyCommunity",
    );

    // Le gagnant détient 2 cartes achetées : il reste admissible.
    await (await asWinner.mint(encodeBytes32String("Achat"), 0, 0, 1, 2, { value: parseEther("0.002") })).wait();
    await (await community.mintTrophy(winner.address, encodeBytes32String("Champion"), 1, 3, 7)).wait();
    expect(await community.reservedMinted()).to.equal(1n);
    expect(await community.trophyReceived(winner.address)).to.equal(true);
    const card = await community.cardOf(3);
    expect(card.trophy).to.equal(true);
    expect((await community.cardOf(1)).trophy).to.equal(false);

    // Une seule à vie, et pas pour un wallet de plus de 2 cartes.
    await expect(community.mintTrophy(winner.address, encodeBytes32String("Encore"), 0, 0, 0)).to.be.revertedWithCustomError(
      community,
      "TrophyNotAllowed",
    );
    await (await asCollector.mint(encodeBytes32String("Achat"), 0, 0, 1, 3, { value: parseEther("0.003") })).wait();
    await expect(community.mintTrophy(collector.address, encodeBytes32String("Champion"), 0, 0, 0)).to.be.revertedWithCustomError(
      community,
      "TrophyNotAllowed",
    );

    // Révélée : rareté au moins « épique » et marque dans le JSON.
    await networkHelpers.mine(3);
    await (await asWinner.revealMany([1, 2, 3])).wait();
    const [traits, revealed] = (await community.traitsOf(3)) as [bigint[], boolean];
    expect(revealed).to.equal(true);
    traits.forEach((option, t) => expect(Number(option)).to.be.at.least(TROPHY_FLOOR[t]));
    const json = JSON.parse(Buffer.from(((await community.tokenURI(3)) as string).slice(29), "base64").toString("utf8"));
    const attributes = Object.fromEntries(json.attributes.map((a: { trait_type: string; value: string }) => [a.trait_type, a.value]));
    expect(attributes.edition).to.equal("trophy");
    expect(Object.keys(attributes)).to.have.length(15);
    const paid = JSON.parse(Buffer.from(((await community.tokenURI(1)) as string).slice(29), "base64").toString("utf8"));
    expect(paid.attributes.map((a: { trait_type: string }) => a.trait_type)).to.not.include("edition");

    // Plancher du tirage = top 5 % au pire (palier « épique » du site), sur un tirage normal simulé.
    let state = 12345;
    const random = () => ((state = (Math.imul(state, 1103515245) + 12345) >>> 0) / 2 ** 32);
    const pick = (weights: number[]) => {
      let roll = random() * 1000;
      for (let i = 0; i < weights.length; i++) if ((roll -= weights[i]) < 0) return i;
      return weights.length - 1;
    };
    const scores = Array.from({ length: 50_000 }, () => rarityScore(WEIGHTS.map(pick)));
    const floorScore = rarityScore(TROPHY_FLOOR);
    const above = scores.filter((score) => score > floorScore).length / scores.length;
    expect(above).to.be.below(0.05);
    const drawn = Array.from(traits, (option) => Number(option));
    expect(rarityScore(drawn), `attributs ${drawn}`).to.be.at.least(floorScore);

    // Aucun droit de vote ; les cartes achetées du même wallet votent.
    await expect(asWinner.vote([3], 0)).to.be.revertedWithCustomError(asWinner, "NotEligible").withArgs(3n);
    await (await asWinner.vote([1, 2], 0)).wait();
    expect(await community.votesFor(0, 0)).to.equal(2n);
  });
});

describe("Cartes Trophée : répartition des paliers", function () {
  it("la copie du tirage donne exactement les attributs du contrat (Trophées et cartes achetées)", async function () {
    const wallet = await localWallet(connection);
    const ctx: StepContext = { ethers, wallet, journal: memoryJournal(), networkName: "test", chainId, confirm: async () => {}, log: () => {}, receiptTimeoutMs: 1500 };
    const now = BigInt(await networkHelpers.time.latest());
    const plan = validateNftParams(
      { mintStart: "", founders: "", charities: CHARITIES, imageBaseURI: "https://dipduck.example/cards/", viewerURI: "https://dipduck.example/card.html" },
      { deployer: wallet.address, community: "", isMainnet: false, now },
    );
    const record = await deployNftStep(ctx, plan);
    const abi = [...CARDS_ABI, "event Revealed(uint256 indexed tokenId, bytes32 seed)"];
    const community = new Contract(record.address, abi, await ethers.getSigner(plan.community));
    const signers = await ethers.getSigners();
    const winners = signers.filter((s) => getAddress(s.address) !== getAddress(plan.community)).slice(0, 12);
    const inputs: DrawInput[] = [];
    for (const [k, winner] of winners.entries()) {
      const card = {
        name: k === 0 ? "satoshi" : `Winner${k}`,
        mood: k % 4,
        element: (k >> 2) % 4,
        lucky: k === 1 ? 777 : 70 + k,
        trophy: k % 3 !== 2,
      };
      if (card.trophy) {
        await (await community.mintTrophy(winner.address, encodeBytes32String(card.name), card.mood, card.element, card.lucky)).wait();
      } else {
        const buyer = new Contract(record.address, CARDS_ABI, winner);
        await (await buyer.mint(encodeBytes32String(card.name), card.mood, card.element, card.lucky, 1, { value: parseEther("0.001") })).wait();
      }
      inputs.push(card);
    }
    await networkHelpers.mine(3);
    await (await community.revealMany(inputs.map((_, k) => k + 1))).wait();
    // Les mints révèlent aussi au passage : on relit tous les événements Revealed.
    const seeds = new Map<number, string>();
    for (const event of await community.queryFilter(community.filters.Revealed())) {
      if ("args" in event) seeds.set(Number(event.args.tokenId), event.args.seed as string);
    }
    expect(seeds.size).to.equal(inputs.length);
    for (const [k, card] of inputs.entries()) {
      const [traits] = (await community.traitsOf(k + 1)) as [bigint[], boolean];
      expect(Array.from(traits, Number), `carte ${k + 1}`).to.deep.equal(drawTraits(card, seeds.get(k + 1)!));
      expect((await community.cardOf(k + 1)).trophy).to.equal(card.trophy);
    }
  });

  it("Trophées : ≈ 70 % épiques, 25 % légendaires, 5 % mythiques, jamais sous épique ; achetées : mythique ≈ 0,1 %", function () {
    this.timeout(120_000);
    const { epic, legendary, mythic } = tierThresholds();
    expect(rarityScore(TROPHY_FLOOR)).to.be.above(epic); // Plain et pire tirage Trophée : épique
    const tally = (trophy: boolean, n: number) => {
      const count = { below: 0, epic: 0, legendary: 0, mythic: 0 };
      for (let i = 0; i < n; i++) {
        const seed = keccak256(toBeHex(i + (trophy ? 0 : 1_000_000), 32));
        const card = { name: "Duck", mood: i % 4, element: (i >> 2) % 4, lucky: (i * 37) % 1000, trophy };
        const score = rarityScore(drawTraits(card, seed));
        if (score > mythic) count.mythic++;
        else if (score > legendary) count.legendary++;
        else if (score > epic) count.epic++;
        else count.below++;
      }
      return count;
    };
    const n = 6_000;
    const trophies = tally(true, n);
    expect(trophies.below).to.equal(0);
    expect(trophies.epic / n).to.be.within(0.66, 0.75);
    expect(trophies.legendary / n).to.be.within(0.21, 0.29);
    expect(trophies.mythic / n).to.be.within(0.035, 0.07);
    const paid = tally(false, n);
    expect(paid.mythic / n).to.be.below(0.004); // ≈ 0,1 % (un peu plus avec les secrets)
    expect(paid.below / n).to.be.above(0.9);
  });
});
