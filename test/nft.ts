import { expect } from "chai";
import { Contract, encodeBytes32String, getAddress, parseEther } from "ethers";
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
];

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
});
