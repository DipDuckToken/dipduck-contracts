import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "chai";
import { Contract, encodeBytes32String } from "ethers";
import { network } from "hardhat";

import { launchConfig } from "../launch.config.ts";
import { LaunchError } from "../scripts/lib/errors.ts";
import { type Genesis, loadGenesisFile, resolveGenesisPath, validateGenesis } from "../scripts/lib/genesis.ts";
import { memoryJournal } from "../scripts/lib/records.ts";
import { type StepContext, checkFeed, deployGameStep } from "../scripts/lib/steps.ts";
import { MOCK_FEED_CONTRACT } from "../scripts/lib/token.ts";
import { localWallet } from "../scripts/lib/wallet.ts";

const connection = await network.create();
const { ethers, networkHelpers } = connection;
const { chainId } = await ethers.provider.getNetwork();

const GAME_ABI = [
  "function DETECT_FROM() view returns (uint32)",
  "function FEED() view returns (address)",
  "function dipCount() view returns (uint256)",
  "function dipAt(uint256 i) view returns (uint16 day, uint8 bonus)",
  "function lastRecordedDay() view returns (uint32)",
  "function priceAt(uint32 day) view returns (uint64)",
  "function minTimeFor(uint32 day) view returns (uint256)",
  "function currentContest() view returns (uint32 id, uint64 startTs, uint64 endTs, uint32 finishDay)",
  "function verify(uint32[] taps, uint32 finishDay) view returns (uint32 day, uint32 caught, uint32 coins, uint32 score, uint32 finalX)",
  "function recordDay(uint80[] roundIds)",
  "function daysBehind() view returns (uint256)",
  "function startRun()",
  "function runOf(address player) view returns (uint64 start, uint32 contest)",
  "function contestFinishDay(uint32 id) view returns (uint32)",
  "function submit(uint32[] taps, bytes32 nickname)",
  "function best(uint32 contest, address player) view returns (uint32 day, uint32 caught, uint32 coins, uint32 score, bytes32 nickname, uint64 at)",
  "function topCount(uint32 contest) view returns (uint256)",
];

const FEED_ABI = [
  "function setAnswer(int256 answer, uint256 updatedAt)",
  "function latestRound() view returns (uint80)",
];
const DATA_START = 1282089600n;
const DAY = 86400n;

/** Jour du jeu de l'horloge de la chaîne. */
async function today(): Promise<bigint> {
  return (BigInt(await networkHelpers.time.latest()) - DATA_START) / DAY;
}

/**
 * Publie sur le flux d'essai un round par jour, des jours `from` à `to` inclus (à 0 h 00 min 01 s
 * UTC), au prix `price`. Renvoie le round de chaque jour : c'est sa clôture officielle.
 */
async function publishRounds(feedAddress: string, from: bigint, to: bigint, price = 7_000_000_000_000n): Promise<Map<bigint, bigint>> {
  const [signer] = await ethers.getSigners();
  const feed = new Contract(feedAddress, FEED_ABI, signer);
  const ids = new Map<bigint, bigint>();
  for (let d = from; d <= to; d += 1n) {
    await (await feed.setAnswer(price, DATA_START + d * DAY + 1n)).wait();
    ids.set(d, (await feed.latestRound()) as bigint);
  }
  return ids;
}

/** Enregistre jusqu'au jour `to` inclus, 60 jours au plus par appel ; renvoie le gas de chaque appel. */
async function recordUpTo(game: Contract, ids: Map<bigint, bigint>, to: bigint): Promise<bigint[]> {
  const gas: bigint[] = [];
  for (;;) {
    const last = (await game.lastRecordedDay()) as bigint;
    if (last >= to) return gas;
    const count = to - last > 60n ? 60n : to - last;
    const batch = Array.from({ length: Number(count) }, (_, i) => ids.get(last + 1n + BigInt(i)) as bigint);
    gas.push(((await (await game.recordDay(batch)).wait())?.gasUsed ?? 0n) as bigint);
  }
}

/** Publie les rounds manquants (jusqu'à aujourd'hui) et enregistre tous les jours terminés. */
async function catchUp(game: Contract, feedAddress: string): Promise<void> {
  const now = await today();
  const last = (await game.lastRecordedDay()) as bigint;
  if (last + 1n >= now) return;
  await recordUpTo(game, await publishRounds(feedAddress, last + 1n, now), now - 1n);
}

/** La promesse doit échouer avec une LaunchError. */
async function expectLaunchError(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).to.be.instanceOf(LaunchError);
}

async function context(): Promise<StepContext> {
  const wallet = await localWallet(connection);
  return { ethers, wallet, journal: memoryJournal(), networkName: "test", chainId, confirm: async () => {}, log: () => {}, receiptTimeoutMs: 1500 };
}

/** Flux d'essai BTC/USD (prix toujours frais). */
async function mockFeed(price = 7_000_000_000_000n): Promise<string> {
  const factory = await ethers.getContractFactory(MOCK_FEED_CONTRACT);
  const feed = await factory.deploy(price);
  await feed.waitForDeployment();
  return feed.getAddress();
}

/** Genèse JSON d'essai : 4 baisses, détection à partir du jour 5900 (2026-10-13). */
function sampleJson(detectFrom = 5900): Record<string, unknown> {
  const buckets = Math.floor((detectFrom + 13) / 30) + 1;
  return {
    detectFrom,
    dips: [
      [100, 0],
      [110, 2],
      [200, 0],
      [300, 5],
    ],
    histMinSeconds: Array.from({ length: buckets }, (_, k) => k),
    recentPrices: Array.from({ length: 59 }, () => "10000000000"),
  };
}

/** Baisses prises en compte par une course qui finit au jour finishDay. */
function countedDips(dipDays: number[], finishDay: number): number[] {
  return dipDays.filter((day) => day * 12 + 33 <= finishDay * 12);
}

/**
 * Pièces de la course, d'après la règle du contrat : c % 20 == 15, c × 12 − 132 >= 528,
 * c × 12 < finishX, et aucune baisse prise en compte d avec d − 2 <= c <= d + 14.
 */
function coinDays(dipDays: number[], finishDay: number): number[] {
  const counted = countedDips(dipDays, finishDay);
  const coins: number[] = [];
  for (let c = 15; c * 12 < finishDay * 12; c += 20) {
    if (c * 12 - 132 < 528) continue;
    if (counted.some((d) => d - 2 <= c && c <= d + 14)) continue;
    coins.push(c);
  }
  return coins;
}

/**
 * Partie complète : chaque baisse touchée au fond (x = jour × 12, parfaite) et, pour chaque
 * pièce, un saut au plus tôt (x = pièce × 12 − 132).
 */
function fullTaps(dipDays: number[], finishDay: number): number[] {
  const taps = [
    ...countedDips(dipDays, finishDay).map((day) => day * 12),
    ...coinDays(dipDays, finishDay).map((c) => c * 12 - 132),
  ];
  return taps.filter((x) => x >= 528 && x < finishDay * 12).sort((a, b) => a - b);
}

describe("Jeu « Attrape la baisse » : genèse, déploiement journalisé et parties vérifiées", function () {
  let dir: string;
  before(async function () {
    dir = await mkdtemp(join(tmpdir(), "dipduck-genesis-"));
  });
  after(async function () {
    await rm(dir, { recursive: true, force: true });
  });

  it("valide un fichier de genèse avec les règles du contrat", function () {
    const ok = { ...sampleJson(100), dips: [] };
    const expected: Genesis = {
      detectFrom: 100,
      dipDays: [],
      dipBonus: [],
      histMinSeconds: [0, 1, 2, 3], // (100 + 13) / 30 + 1 tranches
      recentPrices: Array.from({ length: 59 }, () => 10_000_000_000n),
    };
    expect(validateGenesis({ ...ok, comment: "ignoré" })).to.deep.equal(expected);
    const g = validateGenesis({
      ...ok,
      dips: [
        [50, 0],
        [99, 10],
      ],
      recentPrices: Array.from({ length: 59 }, (_, i) => (i === 0 ? 123 : "18446744073709551615")),
    });
    expect(g.dipDays).to.deep.equal([50, 99]);
    expect(g.dipBonus).to.deep.equal([0, 10]);
    expect(g.histMinSeconds).to.have.length(4); // (100 + 13) / 30 + 1
    expect(g.recentPrices[0]).to.equal(123n);
    expect(g.recentPrices[58]).to.equal((1n << 64n) - 1n);
    const prices = (value: unknown) => Array.from({ length: 59 }, (_, i) => (i === 7 ? value : "1"));
    const bad: unknown[] = [
      null,
      [],
      { ...ok, detectFrom: 44 },
      { ...ok, detectFrom: 65521 },
      { ...ok, detectFrom: "100" },
      { ...ok, dips: "x" },
      { ...ok, dips: [[100, 0]] }, // pas avant detectFrom
      { ...ok, dips: [[50, 11]] }, // bonus > 10
      { ...ok, dips: [[50, 0], [50, 1]] }, // pas strictement croissant
      { ...ok, dips: [[60, 0], [50, 1]] },
      { ...ok, dips: [[50]] },
      { ...ok, histMinSeconds: [0, 1, 2] }, // longueur
      { ...ok, histMinSeconds: [0, 1, 2, 3, 4] },
      { ...ok, histMinSeconds: [0, 2, 1, 3] }, // décroissante
      { ...ok, histMinSeconds: [0, 1, 2, 65536] }, // > 16 bits
      { ...ok, recentPrices: Array.from({ length: 58 }, () => "1") },
      { ...ok, recentPrices: prices("0") },
      { ...ok, recentPrices: prices(-1) },
      { ...ok, recentPrices: prices("1.5") },
      { ...ok, recentPrices: prices("18446744073709551616") }, // 2^64
      { ...ok, recentPrices: prices(1e17) }, // nombre non sûr
      { ...ok, recentPrices: prices({}) },
    ];
    for (const raw of bad) expect(() => validateGenesis(raw), JSON.stringify(raw)).to.throw(LaunchError);
  });

  it("déploie depuis un fichier JSON une seule fois, puis vérifie une partie", async function () {
    const file = join(dir, "genesis.json");
    await writeFile(file, JSON.stringify(sampleJson()));
    const genesis = await loadGenesisFile(file);
    const feed = await mockFeed();
    const ctx = await context();
    const record = await deployGameStep(ctx, genesis, feed);
    expect(record.status).to.equal("confirmed");
    expect([record.detectFrom, record.dipDays.length, record.recentPrices[0]]).to.deep.equal([5900, 4, "10000000000"]);
    // Relancer ne redéploie pas : le contrat du journal est relu et réutilisé.
    expect((await deployGameStep(ctx, genesis, feed)).address).to.equal(record.address);
    expect((await ctx.journal.read())?.game?.address).to.equal(record.address);
    // Une autre genèse, ou un autre flux, avec le même journal : refusé, rien n'est envoyé.
    await expectLaunchError(deployGameStep(ctx, { ...genesis, dipBonus: [0, 2, 0, 4] }, feed));
    await expectLaunchError(deployGameStep(ctx, genesis, await mockFeed()));

    const [signer] = await ethers.getSigners();
    const game = new Contract(record.address, GAME_ABI, signer);
    expect(await game.DETECT_FROM()).to.equal(5900n);
    expect(await game.FEED()).to.equal(feed);
    expect(await game.dipCount()).to.equal(4n);
    expect(await game.dipAt(3)).to.deep.equal([300n, 5n]);
    expect(await game.lastRecordedDay()).to.equal(5913n);

    // Partie parfaite : les jours terminés sont enregistrés d'abord (startRun ne lit aucun prix).
    await catchUp(game, feed);
    expect(await game.daysBehind()).to.equal(0n);
    await (await game.startRun()).wait();
    const [, contest] = (await game.runOf(signer.address)) as [bigint, bigint];
    const finishDay = (await game.contestFinishDay(contest)) as bigint;
    const taps = [1200, 1320, 2400, 3600];
    const [day, caught, coins, score] = (await game.verify(taps, finishDay)) as bigint[];
    expect([day, caught, coins, score]).to.deep.equal([finishDay, 4n, 0n, 19n]);
    await networkHelpers.time.increase((await game.minTimeFor(day)) as bigint);
    await (await game.submit(taps, encodeBytes32String("Satoshi"))).wait();
    const best = (await game.best(contest, signer.address)) as unknown[];
    expect(best.slice(0, 5)).to.deep.equal([finishDay, 4n, 0n, 19n, encodeBytes32String("Satoshi")]);
    expect(await game.topCount(contest)).to.equal(1n);
  });

  it("refuse un flux sans code ou qui ne répond pas comme Chainlink", async function () {
    const [signer] = await ethers.getSigners();
    const ctx = await context();
    await expectLaunchError(checkFeed(ctx, signer.address));
    const genesis = validateGenesis(sampleJson());
    await expectLaunchError(deployGameStep(ctx, genesis, signer.address));
    expect((await ctx.journal.read())?.game).to.equal(undefined);
    const { price } = await checkFeed(ctx, await mockFeed(123n));
    expect(price).to.equal(123n);
  });

  it("refuse un fichier de genèse absent ou invalide", async function () {
    await expectLaunchError(loadGenesisFile(join(dir, "absent.json")));
    const file = join(dir, "broken.json");
    await writeFile(file, "{ pas du json");
    await expectLaunchError(loadGenesisFile(file));
    await expectLaunchError(loadGenesisFile(""));
  });

  it("vraie genèse, course jusqu'au jour 5872 : 100 % des baisses et 100 % des pièces atteignables", async function () {
    const file = resolveGenesisPath(launchConfig.game.genesisFile);
    if (!existsSync(file)) this.skip();
    const genesis = await loadGenesisFile(file);
    const record = await deployGameStep(await context(), genesis, await mockFeed());
    const game = new Contract(record.address, GAME_ABI, ethers.provider);
    const finishDay = 5872;
    const dips = countedDips(genesis.dipDays, finishDay).length;
    const coins = coinDays(genesis.dipDays, finishDay).length;
    expect([dips, coins]).to.deep.equal([125, 185]);
    const [day, caught, got, , finalX] = (await game.verify(fullTaps(genesis.dipDays, finishDay), finishDay)) as bigint[];
    expect([day, caught, got, finalX]).to.deep.equal([5872n, 125n, 185n, 5872n * 12n]);
  });

  it("rattrape 200 jours de retard en 4 appels de recordDay plafonnés, avec le vrai prix de chaque jour", async function () {
    const file = resolveGenesisPath(launchConfig.game.genesisFile);
    const genesis = existsSync(file) ? await loadGenesisFile(file) : validateGenesis(sampleJson());
    const feed = await mockFeed();
    const record = await deployGameStep(await context(), genesis, feed);
    const [signer] = await ethers.getSigners();
    const game = new Contract(record.address, GAME_ABI, signer);
    const behind = (await game.daysBehind()) as bigint;
    await networkHelpers.time.increase((200n - behind) * DAY);
    expect(await game.daysBehind()).to.equal(200n);
    const last = (await game.lastRecordedDay()) as bigint;
    const ids = await publishRounds(feed, last + 1n, last + 201n);
    const gas = await recordUpTo(game, ids, last + 200n);
    expect(gas).to.have.length(4);
    expect(await game.daysBehind()).to.equal(0n);
    const max = gas.reduce((a, b) => (a > b ? a : b));
    expect(max < 4_000_000n).to.equal(true);
    console.log(`      recordDay plafonné (60 jours, 2 lectures du flux par jour, évaluations) : ${gas.join(", ")} gas`);
  });

  it("déploie la vraie genèse du site (launch.config.ts) et mesure le gas", async function () {
    const file = resolveGenesisPath(launchConfig.game.genesisFile);
    if (!existsSync(file)) this.skip();
    const genesis = await loadGenesisFile(file);
    const record = await deployGameStep(await context(), genesis, await mockFeed());
    const [signer] = await ethers.getSigners();
    const game = new Contract(record.address, GAME_ABI, signer);
    expect(await game.dipCount()).to.equal(BigInt(genesis.dipDays.length));
    expect(await game.priceAt(genesis.detectFrom + 13)).to.equal(genesis.recentPrices[58]);
    const deployReceipt = await ethers.provider.getTransactionReceipt(record.txHash);

    // Rattrapage jusqu'à avant-hier (60 jours par appel), puis un jour seul, puis le dernier jour
    // terminé (avec une évaluation). Le test précédent a avancé l'horloge.
    if (((await game.daysBehind()) as bigint) < 2n) await networkHelpers.time.increase(2n * DAY);
    const now = await today();
    const ids = await publishRounds((await game.FEED()) as string, ((await game.lastRecordedDay()) as bigint) + 1n, now);
    await recordUpTo(game, ids, now - 3n);
    const [record1] = await recordUpTo(game, ids, now - 2n);
    const [record2] = await recordUpTo(game, ids, now - 1n);
    const start = await (await game.startRun()).wait();

    const [, contest] = (await game.runOf(signer.address)) as [bigint, bigint];
    const finishDay = Number((await game.contestFinishDay(contest)) as bigint);
    const taps = fullTaps(genesis.dipDays, finishDay);
    const counted = countedDips(genesis.dipDays, finishDay).length;
    const [day, caught, coins] = (await game.verify(taps, finishDay)) as bigint[];
    expect(day).to.equal(BigInt(finishDay));
    expect(caught).to.equal(BigInt(counted));
    expect(coins).to.equal(BigInt(coinDays(genesis.dipDays, finishDay).length));
    await networkHelpers.time.increase((await game.minTimeFor(day)) as bigint);
    const submit = await (await game.submit(taps, encodeBytes32String("Gas"))).wait();
    console.log(
      `      déploiement ${deployReceipt?.gasUsed} ; recordDay 1 jour ${record1}, ` +
        `1 jour + évaluation ${record2} ; startRun ${start?.gasUsed} ; ` +
        `submit ${submit?.gasUsed} (${counted} baisses, ${coins} pièces, ${taps.length} touches)`,
    );
  });
});
