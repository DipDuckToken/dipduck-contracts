import { expect } from "chai";
import { Contract, MaxUint256, ZeroAddress, getCreateAddress, parseUnits, zeroPadValue } from "ethers";
import { network } from "hardhat";
import type { NetworkConnection } from "hardhat/types/network";

import { UNIT } from "../scripts/lib/constants.ts";
import { LAUNCHER_ABI, buildLaunchPlan, readLaunchStatus, splitSupply, startTickFor } from "../scripts/lib/launch.ts";
import { LaunchError } from "../scripts/lib/errors.ts";
import type { UniswapV3Deployment } from "../scripts/lib/networks.ts";
import { type Journal, type TokenRecord, memoryJournal } from "../scripts/lib/records.ts";
import { runRehearsal } from "../scripts/lib/rehearsal.ts";
import {
  type LaunchParams,
  type StepContext,
  type VestingPlan,
  deployTokenStep,
  deployVestingStep,
  launchParamsOf,
} from "../scripts/lib/steps.ts";
import {
  LAUNCHER_CONTRACT,
  VESTING_CONTRACT,
  launcherConstructorArgs,
  predictTokenAddress,
  vestingConstructorArgs,
} from "../scripts/lib/token.ts";
import { type TxPayload, broadcastRaw, nextNonce, signTx } from "../scripts/lib/tx.ts";
import { ERC20_ABI, V3_POSITION_MANAGER_ABI, assertUniswapV3Deployment, swapperFor } from "../scripts/lib/uniswap.ts";
import type { TokenParams } from "../scripts/lib/validation.ts";
import { VESTING_ABI, readVestingStatus } from "../scripts/lib/vesting.ts";
import { localWallet } from "../scripts/lib/wallet.ts";
import { deployLocalUniswapV3 } from "./helpers/uniswap-v3-local.ts";

const connection = await network.create();
const { ethers, networkHelpers } = connection;
const { chainId } = await ethers.provider.getNetwork();

const TOKEN: TokenParams = { name: "Test Token", symbol: "TEST", supply: 1_000_000_000n };
const SUPPLY = TOKEN.supply * UNIT;
const START_TICK = startTickFor(3n * UNIT, TOKEN.supply);
const HOUR = 3_600n;
const DAY = 86_400n;

async function expectLaunchError(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).to.be.instanceOf(LaunchError);
    expect((error as Error).message).to.match(pattern);
    return;
  }
  expect.fail("Une LaunchError était attendue.");
}

function contextFor(conn: NetworkConnection, wallet: StepContext["wallet"], journal: Journal = memoryJournal()): StepContext {
  return {
    ethers: conn.ethers,
    wallet,
    journal,
    networkName: "test",
    chainId,
    confirm: async () => {},
    log: () => {},
    receiptTimeoutMs: 1500,
  };
}

/** Délègue tout à la cible, sauf les propriétés remplacées (méthodes liées à la cible). */
function withOverrides<T extends object>(target: T, overrides: Partial<Record<keyof T, unknown>>): T {
  return new Proxy(target, {
    get(obj, prop) {
      if (Object.hasOwn(overrides, prop)) return overrides[prop as keyof T];
      const value = Reflect.get(obj, prop, obj);
      return typeof value === "function" ? value.bind(obj) : value;
    },
  });
}

/**
 * Contexte dont la diffusion échoue côté client : soit la réponse se perd
 * après que le nœud a reçu la transaction (`delivered`), soit rien n'arrive.
 */
function flakyBroadcastContext(ctx: StepContext, delivered: boolean): StepContext {
  const real = ctx.ethers.provider;
  let failed = false;
  const send = async (method: string, params: unknown[]) => {
    if (method === "eth_sendRawTransaction" && !failed) {
      failed = true;
      if (delivered) await real.send(method, params);
      throw new Error("socket hang up");
    }
    return await real.send(method, params);
  };
  return { ...ctx, ethers: withOverrides(ctx.ethers, { provider: withOverrides(real, { send }) }) };
}

/** Contexte dont le RPC annonce un nombre de transactions en retard (nœud à la traîne). */
function laggingContext(ctx: StepContext, lag: number): StepContext {
  const real = ctx.ethers.provider;
  const provider = withOverrides(real, {
    getTransactionCount: async (address: string, tag?: string) => Math.max(0, (await real.getTransactionCount(address, tag)) - lag),
  });
  return { ...ctx, ethers: withOverrides(ctx.ethers, { provider }) };
}

async function balanceOf(token: string, holder: string, conn: NetworkConnection = connection): Promise<bigint> {
  return (await new Contract(token, ERC20_ABI, conn.ethers.provider).balanceOf(holder)) as bigint;
}

async function latest(conn: NetworkConnection = connection): Promise<bigint> {
  return BigInt(await conn.networkHelpers.time.latest());
}

/** Safe d'essai 2 sur 3 (déployé par un autre compte : le nonce du wallet de lancement ne bouge pas). */
async function deployFakeSafe(conn: NetworkConnection): Promise<string> {
  const signers = await conn.ethers.getSigners();
  const singleton = await conn.ethers.deployContract("MockSafeSingleton", ["1.4.1"], signers[3]);
  const safe = await conn.ethers.deployContract(
    "MockSafe",
    [await singleton.getAddress(), [signers[10].address, signers[11].address, signers[12].address], 2],
    signers[3],
  );
  return await safe.getAddress();
}

/** Paramètres du lanceur : par défaut tout dans le pool, frais au Safe, ni part ni réserve. */
function launchParams(
  uniswap: UniswapV3Deployment,
  safe: string,
  openAt: bigint,
  share?: { vesting?: string; vestingPercent?: bigint; communityPercent?: bigint; salt?: string },
): LaunchParams {
  const split = splitSupply(TOKEN.supply, share?.vestingPercent ?? 0n, share?.communityPercent ?? 0n);
  return {
    ...TOKEN,
    positionManager: uniswap.positionManager,
    factory: uniswap.factory,
    weth: uniswap.weth,
    startTick: START_TICK,
    openAt,
    vesting: share?.vesting ?? ZeroAddress,
    vestingWholeTokens: split.vestingWholeTokens,
    community: split.communityWholeTokens > 0n ? safe : ZeroAddress,
    communityWholeTokens: split.communityWholeTokens,
    feeRecipient: safe,
    salt: share?.salt,
  };
}

async function setupFixture() {
  const [deployer, buyer, attacker, operator] = await ethers.getSigners();
  const uniswap = await deployLocalUniswapV3(ethers, operator);
  const safe = await deployFakeSafe(connection);
  const wallet = await localWallet(connection);
  expect(wallet.address).to.equal(deployer.address);
  return { deployer, buyer, attacker, uniswap, safe, wallet };
}

async function setup() {
  const fixture = await networkHelpers.loadFixture(setupFixture);
  return { ...fixture, openAt: (await latest()) + 2n * HOUR };
}

describe("Adresses Uniswap v3", function () {
  it("accepte un déploiement cohérent et refuse une incohérence ou une adresse vide", async function () {
    const { uniswap, buyer } = await setup();
    await assertUniswapV3Deployment(ethers.provider, uniswap);
    await expectLaunchError(assertUniswapV3Deployment(ethers.provider, { ...uniswap, weth: uniswap.factory }), /annonce le WETH/);
    await expectLaunchError(assertUniswapV3Deployment(ethers.provider, { ...uniswap, factory: uniswap.weth }), /annonce la factory/);
    await expectLaunchError(assertUniswapV3Deployment(ethers.provider, { ...uniswap, swapRouter: buyer.address }), /Aucun contrat/);
  });
});

describe("Déploiement du lanceur (vrai bytecode Uniswap v3)", function () {
  it("crée le token, le pool et la position d'un seul côté ; adresses prévues avant diffusion", async function () {
    const { wallet, uniswap, safe, openAt } = await setup();
    const ctx = contextFor(connection, wallet);
    const nonce = await ethers.provider.getTransactionCount(wallet.address);
    const token = await deployTokenStep(ctx, launchParams(uniswap, safe, openAt));

    const launcherAddress = getCreateAddress({ from: wallet.address, nonce });
    expect(token.status).to.equal("confirmed");
    expect(token.launcher).to.equal(launcherAddress);
    expect(token.salt).to.match(/^0x[0-9a-f]{64}$/);
    expect(token.address).to.equal(await predictTokenAddress(ethers, launcherAddress, token));
    expect(await ethers.provider.getTransactionCount(wallet.address)).to.equal(nonce + 1);
    expect(await balanceOf(token.address, wallet.address)).to.equal(0n);

    const status = await readLaunchStatus(ethers.provider, token.launcher);
    expect(status.token).to.equal(token.address);
    expect(status.pool).to.equal(token.pool);
    expect(status.positionId.toString()).to.equal(token.positionId);
    expect(status.feeRecipient).to.equal(safe);
    expect(status.state.tokenBalance).to.equal(status.poolTokens);
    expect(status.state.wethBalance).to.equal(0n);
    expect(status.walletLimit).to.equal(MaxUint256); // pas de limite avant l'heure (et aucun achat possible)
    const npm = new Contract(uniswap.positionManager, V3_POSITION_MANAGER_ABI, ethers.provider);
    expect(await npm.ownerOf(status.positionId)).to.equal(token.launcher);

    // Le prix affiché par le plan est celui du pool (à l'arrondi d'affichage près).
    const plan = buildLaunchPlan({ supplyWholeTokens: TOKEN.supply, split: splitSupply(TOKEN.supply, 0n, 0n), startTick: START_TICK });
    const gap = plan.startPriceWei > status.state.priceWei ? plan.startPriceWei - status.state.priceWei : status.state.priceWei - plan.startPriceWei;
    expect(gap * 1_000_000n <= plan.startPriceWei).to.equal(true);

    await expectLaunchError(deployTokenStep(ctx, launchParams(uniswap, safe, openAt)), /déjà déployé/);
    expect(await ethers.provider.getTransactionCount(wallet.address)).to.equal(nonce + 1);
  });

  it("refuse une heure d'ouverture passée, imminente ou à plus de 30 jours, sans rien envoyer", async function () {
    const { wallet, uniswap, safe } = await setup();
    const ctx = contextFor(connection, wallet);
    const nonce = await ethers.provider.getTransactionCount(wallet.address);
    const now = await latest();
    await expectLaunchError(deployTokenStep(ctx, launchParams(uniswap, safe, now - 10n)), /passée ou imminente/);
    await expectLaunchError(deployTokenStep(ctx, launchParams(uniswap, safe, now + 30n)), /passée ou imminente/);
    await expectLaunchError(deployTokenStep(ctx, launchParams(uniswap, safe, now + 31n * DAY)), /plus de 30 jours/);
    expect(await ctx.journal.read()).to.equal(undefined);
    expect(await ethers.provider.getTransactionCount(wallet.address)).to.equal(nonce);
  });

  it("refuse, par simulation et sans rien envoyer, un contrat de blocage sans code ou un tick invalide", async function () {
    const { wallet, buyer, uniswap, safe, openAt } = await setup();
    const ctx = contextFor(connection, wallet);
    const nonce = await ethers.provider.getTransactionCount(wallet.address);
    await expectLaunchError(
      deployTokenStep(ctx, launchParams(uniswap, safe, openAt, { vesting: buyer.address, vestingPercent: 10n })),
      /simulation.*refuse ses paramètres/,
    );
    await expectLaunchError(deployTokenStep(ctx, { ...launchParams(uniswap, safe, openAt), startTick: START_TICK + 1 }), /simulation/);
    expect(await ctx.journal.read()).to.equal(undefined);
    expect(await ethers.provider.getTransactionCount(wallet.address)).to.equal(nonce);
  });

  it("répétition complète sans part ni réserve : achats, revente, 24 h, frais au Safe", async function () {
    const { uniswap, safe, openAt } = await setup();
    const report = await runRehearsal(connection, uniswap, {
      token: TOKEN,
      pool: { startMarketCapWei: 3n * UNIT, startTick: START_TICK, openAt },
      vestingPercent: 0n,
      community: { percent: 0n, beneficiary: safe },
    });
    expect(report.antiBot.buyBeforeOpenBlocked).to.equal(true);
    expect(report.antiBot.bigBuyBlocked).to.equal(true);
    expect(report.antiBot.limitAtOpen).to.equal(SUPPLY / 200n);
    expect(report.distribution.deployer).to.equal(0n);
    expect(report.fees.weth).to.be.greaterThan(0n);
    expect(report.resale.ethOut).to.be.greaterThan(0n);
    expect(report.status.state.wethBalance).to.be.greaterThan(0n);
  });
});

describe("Reprise après interruption : jamais de double envoi", function () {
  const SALT = zeroPadValue("0x01", 32);

  /** Simule un arrêt juste après la signature : la transaction est notée, pas forcément diffusée. */
  async function signedTokenEntry(ctx: StepContext, params: LaunchParams): Promise<TokenRecord> {
    const factory = await ethers.getContractFactory(LAUNCHER_CONTRACT);
    const nonce = await nextNonce(ethers.provider, ctx.wallet.address);
    const launcher = getCreateAddress({ from: ctx.wallet.address, nonce });
    const fields = {
      name: params.name,
      symbol: params.symbol,
      supplyWholeTokens: params.supply.toString(),
      positionManager: params.positionManager,
      factory: params.factory,
      weth: params.weth,
      salt: params.salt ?? SALT,
      vesting: params.vesting,
      vestingWholeTokens: params.vestingWholeTokens.toString(),
      community: params.community,
      communityWholeTokens: params.communityWholeTokens.toString(),
      feeRecipient: params.feeRecipient,
      startTick: params.startTick,
      openAt: params.openAt.toString(),
    };
    const payload: TxPayload = { data: (await factory.getDeployTransaction(...launcherConstructorArgs(fields))).data };
    const signed = await signTx(ethers.provider, ctx.wallet, chainId, payload, nonce);
    const entry: TokenRecord = {
      status: "pending",
      from: ctx.wallet.address,
      nonce,
      txHash: signed.hash,
      rawTx: signed.raw,
      preparedAt: new Date().toISOString(),
      address: await predictTokenAddress(ethers, launcher, fields),
      launcher,
      ...fields,
    };
    const record = await ctx.journal.read();
    await ctx.journal.write({ ...(record ?? { network: "test", chainId: chainId.toString() }), token: entry });
    return entry;
  }

  it("signée et notée mais jamais diffusée : diffuse exactement la même transaction (même sel)", async function () {
    const { wallet, uniswap, safe, openAt } = await setup();
    const ctx = contextFor(connection, wallet);
    const entry = await signedTokenEntry(ctx, launchParams(uniswap, safe, openAt));

    // D'autres paramètres dans l'appel : la reprise suit le journal.
    const token = await deployTokenStep(ctx, launchParams(uniswap, safe, openAt + DAY));
    expect(token.status).to.equal("confirmed");
    expect(token.txHash).to.equal(entry.txHash);
    expect(token.address).to.equal(entry.address);
    expect(token.salt).to.equal(SALT);
    expect(token.openAt).to.equal(openAt.toString());
    expect(await ethers.provider.getTransactionCount(wallet.address)).to.equal(entry.nonce + 1);
  });

  it("diffusée mais réponse perdue : retrouve le reçu par son hash, sans rediffuser ni redéployer", async function () {
    const { wallet, uniswap, safe, openAt } = await setup();
    const ctx = contextFor(connection, wallet);
    const entry = await signedTokenEntry(ctx, launchParams(uniswap, safe, openAt));
    await broadcastRaw(ethers.provider, entry.rawTx);

    const token = await deployTokenStep(ctx, launchParamsOf(entry));
    expect(token.status).to.equal("confirmed");
    expect(token.blockNumber).to.be.a("number");
    expect(await ethers.provider.getTransactionCount(wallet.address)).to.equal(entry.nonce + 1);
    await expectLaunchError(deployTokenStep(ctx, launchParamsOf(entry)), /déjà déployé/);
  });

  it("encore en attente sur le réseau : s'arrête sans rien changer, puis confirme", async function () {
    const { wallet, uniswap, safe, openAt } = await setup();
    const ctx = contextFor(connection, wallet);
    const entry = await signedTokenEntry(ctx, launchParams(uniswap, safe, openAt));

    await ethers.provider.send("evm_setAutomine", [false]);
    try {
      await broadcastRaw(ethers.provider, entry.rawTx);
      await expectLaunchError(deployTokenStep(ctx, launchParamsOf(entry)), /Pas de reçu/);
      expect((await ctx.journal.read())?.token?.status).to.equal("pending");
    } finally {
      await ethers.provider.send("evm_setAutomine", [true]);
    }
    await networkHelpers.mine();

    const token = await deployTokenStep(ctx, launchParamsOf(entry));
    expect(token.status).to.equal("confirmed");
    expect(await ethers.provider.getTransactionCount(wallet.address)).to.equal(entry.nonce + 1);
  });

  it("nonce pris par une autre transaction : s'arrête sans rien effacer ni renvoyer", async function () {
    const { wallet, buyer, uniswap, safe, openAt } = await setup();
    const ctx = contextFor(connection, wallet);
    const entry = await signedTokenEntry(ctx, launchParams(uniswap, safe, openAt));
    const other = await signTx(ethers.provider, wallet, chainId, { to: buyer.address, data: "0x", value: 1n }, entry.nonce);
    await broadcastRaw(ethers.provider, other.raw);

    await expectLaunchError(deployTokenStep(ctx, launchParamsOf(entry)), /déjà utilisé/);
    expect((await ctx.journal.read())?.token?.txHash).to.equal(entry.txHash);
    expect(await ethers.provider.getCode(entry.launcher)).to.equal("0x");
  });

  it("frais devenus trop bas : re-signe avec le même nonce et le même sel, un seul lanceur", async function () {
    const { wallet, uniswap, safe, openAt } = await setup();
    const ctx = contextFor(connection, wallet);
    const entry = await signedTokenEntry(ctx, launchParams(uniswap, safe, openAt));
    await networkHelpers.setNextBlockBaseFeePerGas(parseUnits("1000", "gwei"));
    await networkHelpers.mine();

    const token = await deployTokenStep(ctx, launchParamsOf(entry));
    expect(token.status).to.equal("confirmed");
    expect(token.txHash).to.not.equal(entry.txHash);
    expect(token.replacedTxHashes).to.deep.equal([entry.txHash]);
    expect(token.launcher).to.equal(entry.launcher);
    expect(token.address).to.equal(entry.address);
    expect(await ethers.provider.getTransactionCount(wallet.address)).to.equal(entry.nonce + 1);
  });

  it("version précédente minée après une re-signature : le journal garde le hash réellement miné", async function () {
    const { wallet, uniswap, safe, openAt } = await setup();
    const ctx = contextFor(connection, wallet);
    const mined = await signedTokenEntry(ctx, launchParams(uniswap, safe, openAt));
    await broadcastRaw(ethers.provider, mined.rawTx);
    await networkHelpers.setNextBlockBaseFeePerGas(parseUnits("5", "gwei"));
    await networkHelpers.mine();
    // Une version re-signée (même nonce) notée comme courante, mais jamais diffusée.
    const factory = await ethers.getContractFactory(LAUNCHER_CONTRACT);
    const payload = { data: (await factory.getDeployTransaction(...launcherConstructorArgs(mined))).data };
    const other = await signTx(ethers.provider, wallet, chainId, payload, mined.nonce, 10_000_000n);
    expect(other.hash).to.not.equal(mined.txHash);
    await ctx.journal.write({
      network: "test",
      chainId: chainId.toString(),
      token: { ...mined, txHash: other.hash, rawTx: other.raw, replacedTxHashes: [mined.txHash] },
    });

    const token = await deployTokenStep(ctx, launchParamsOf(mined));
    expect(token.status).to.equal("confirmed");
    expect(token.txHash).to.equal(mined.txHash);
  });

  it("réponse perdue à la diffusion alors que la transaction est arrivée : la suit sans re-signer", async function () {
    const { wallet, uniswap, safe, openAt } = await setup();
    const ctx = flakyBroadcastContext(contextFor(connection, wallet), true);
    const token = await deployTokenStep(ctx, launchParams(uniswap, safe, openAt));
    expect(token.status).to.equal("confirmed");
    expect(token.replacedTxHashes).to.equal(undefined);
    expect(await ethers.provider.getTransactionCount(wallet.address)).to.equal(token.nonce + 1);
  });

  it("RPC muet à la diffusion (rien n'est arrivé) : s'arrête, puis la relance diffuse la même transaction", async function () {
    const { wallet, uniswap, safe, openAt } = await setup();
    const journal = memoryJournal();
    await expectLaunchError(
      deployTokenStep(flakyBroadcastContext(contextFor(connection, wallet, journal), false), launchParams(uniswap, safe, openAt)),
      /impossible pour l'instant/,
    );
    const pending = (await journal.read())?.token;
    expect(pending?.status).to.equal("pending");
    expect(await ethers.provider.getTransactionCount(wallet.address)).to.equal(pending?.nonce);

    // Nouveau sel dans l'appel : ignoré, la relance diffuse la transaction notée.
    const token = await deployTokenStep(contextFor(connection, wallet, journal), launchParams(uniswap, safe, openAt));
    expect(token.txHash).to.equal(pending?.txHash);
    expect(token.salt).to.equal(pending?.salt);
    expect(token.status).to.equal("confirmed");
  });

  it("solde insuffisant au moment de diffuser : s'arrête sans re-signer, puis diffuse la même transaction", async function () {
    const { wallet, uniswap, safe, openAt } = await setup();
    const ctx = contextFor(connection, wallet);
    const entry = await signedTokenEntry(ctx, launchParams(uniswap, safe, openAt));
    const funds = await ethers.provider.getBalance(wallet.address);
    await networkHelpers.setBalance(wallet.address, 1n);

    await expectLaunchError(deployTokenStep(ctx, launchParamsOf(entry)), /Solde ETH insuffisant/);
    const kept = (await ctx.journal.read())?.token;
    expect(kept?.txHash).to.equal(entry.txHash);
    expect(kept?.replacedTxHashes).to.equal(undefined);

    await networkHelpers.setBalance(wallet.address, funds);
    const token = await deployTokenStep(ctx, launchParamsOf(entry));
    expect(token.txHash).to.equal(entry.txHash);
    expect(token.status).to.equal("confirmed");
  });

  it("RPC en retard sur le nonce : le blocage puis le lanceur prennent les bons nonces, adresse du token juste", async function () {
    const { wallet, uniswap, safe, openAt } = await setup();
    const ctx = contextFor(connection, wallet);
    const first = await ethers.provider.getTransactionCount(wallet.address);
    const vesting = await deployVestingStep(ctx, {
      beneficiary: wallet.address,
      start: openAt,
      durationSeconds: 365n * DAY,
      cliffSeconds: 90n * DAY,
    });
    // Le nœud qui répond annonce encore l'ancien compte : le journal sait que le nonce est pris.
    const token = await deployTokenStep(
      laggingContext(ctx, 1),
      launchParams(uniswap, safe, openAt, { vesting: vesting.address, vestingPercent: 10n }),
    );
    expect(vesting.nonce).to.equal(first);
    expect(token.nonce).to.equal(first + 1);
    expect(token.status).to.equal("confirmed");
    expect(await balanceOf(token.address, vesting.address)).to.equal(SUPPLY / 10n);
  });
});

describe("Ta part et la réserve : blocage et Safe avant le lanceur, servis au déploiement", function () {
  const TEAM = (SUPPLY * 10n) / 100n;
  const RESERVE = (SUPPLY * 3n) / 100n;

  async function launched() {
    const fixture = await setup();
    const ctx = contextFor(connection, fixture.wallet);
    const plan: VestingPlan = {
      beneficiary: fixture.wallet.address,
      start: fixture.openAt,
      durationSeconds: 900n * DAY,
      cliffSeconds: 90n * DAY,
    };
    const vesting = await deployVestingStep(ctx, plan);
    const token = await deployTokenStep(
      ctx,
      launchParams(fixture.uniswap, fixture.safe, fixture.openAt, { vesting: vesting.address, vestingPercent: 10n, communityPercent: 3n }),
    );
    return { ...fixture, ctx, plan, vesting, token };
  }

  it("le blocage est déployé AVANT le lanceur ; part, réserve et pool servis au déploiement, montants exacts", async function () {
    const { wallet, safe, vesting, token } = await launched();
    expect(vesting.nonce).to.be.lessThan(token.nonce);
    expect(token.vesting).to.equal(vesting.address);
    expect(BigInt(token.vestingWholeTokens) * UNIT).to.equal(TEAM);
    expect(BigInt(token.communityWholeTokens) * UNIT).to.equal(RESERVE);
    // Le wallet de déploiement ne détient jamais de tokens.
    expect(await balanceOf(token.address, wallet.address)).to.equal(0n);
    expect(await balanceOf(token.address, vesting.address)).to.equal(TEAM);
    expect(await balanceOf(token.address, safe)).to.equal(RESERVE);
    const status = await readLaunchStatus(ethers.provider, token.launcher);
    expect(status.vestingTokens).to.equal(TEAM);
    expect(status.communityTokens).to.equal(RESERVE);
    expect(status.state.tokenBalance).to.equal(status.poolTokens);
    expect(SUPPLY - TEAM - RESERVE - status.poolTokens < 10n ** 9n).to.equal(true); // arrondis brûlés
  });

  it("se libère selon le calendrier (début = ouverture des échanges), toujours au bénéficiaire", async function () {
    const { wallet, buyer, plan, vesting, token } = await launched();
    const asStranger = new Contract(vesting.address, VESTING_ABI, buyer);
    const status = await readVestingStatus(ethers.provider, vesting.address, token.address);
    expect(status.cliff).to.equal(plan.start + plan.cliffSeconds);
    expect(status.locked).to.equal(TEAM);

    await networkHelpers.time.increaseTo(plan.start + plan.cliffSeconds - 10n);
    await (await asStranger.release(token.address)).wait();
    expect(await balanceOf(token.address, wallet.address)).to.equal(0n);

    await networkHelpers.time.increaseTo(plan.start + plan.cliffSeconds);
    await (await asStranger.release(token.address)).wait();
    const atCliff = await balanceOf(token.address, wallet.address);
    expect(atCliff).to.be.greaterThanOrEqual((TEAM * plan.cliffSeconds) / plan.durationSeconds);
    expect(atCliff).to.be.lessThan(TEAM / 5n);
    expect(await balanceOf(token.address, buyer.address)).to.equal(0n);

    await networkHelpers.time.increaseTo(plan.start + plan.durationSeconds);
    await (await asStranger.release(token.address)).wait();
    expect(await balanceOf(token.address, wallet.address)).to.equal(TEAM);
    expect(await balanceOf(token.address, vesting.address)).to.equal(0n);
  });

  it("le bénéficiaire peut transmettre son rôle : le contrat noté reste reconnu", async function () {
    const { ctx, deployer, buyer, plan, vesting } = await launched();
    const asBeneficiary = await ethers.getContractAt(VESTING_CONTRACT, vesting.address, deployer);
    await (await asBeneficiary.transferOwnership(buyer.address)).wait();
    const again = await deployVestingStep(ctx, plan);
    expect(again.address).to.equal(vesting.address);
  });

  it("personne ne peut retirer plus tôt ni faire perdre la part", async function () {
    const { deployer, buyer, vesting } = await launched();
    const asBeneficiary = await ethers.getContractAt(VESTING_CONTRACT, vesting.address, deployer);
    await expect(asBeneficiary.renounceOwnership()).to.be.revertedWithCustomError(asBeneficiary, "RenounceDisabled");
    const asStranger = await ethers.getContractAt(VESTING_CONTRACT, vesting.address, buyer);
    await expect(asStranger.transferOwnership(buyer.address)).to.be.revertedWithCustomError(
      asStranger,
      "OwnableUnauthorizedAccount",
    );
  });

  it("contrat de blocage signé et noté mais jamais diffusé : le même est diffusé, une seule fois", async function () {
    const { wallet, openAt } = await setup();
    const ctx = contextFor(connection, wallet);
    const factory = await ethers.getContractFactory(VESTING_CONTRACT);
    const fields = {
      beneficiary: wallet.address,
      start: openAt.toString(),
      durationSeconds: (365n * DAY).toString(),
      cliffSeconds: (90n * DAY).toString(),
    };
    const payload: TxPayload = { data: (await factory.getDeployTransaction(...vestingConstructorArgs(fields))).data };
    const nonce = await nextNonce(ethers.provider, wallet.address);
    const signed = await signTx(ethers.provider, wallet, chainId, payload, nonce);
    await ctx.journal.write({
      network: "test",
      chainId: chainId.toString(),
      vesting: {
        status: "pending",
        from: wallet.address,
        nonce,
        txHash: signed.hash,
        rawTx: signed.raw,
        preparedAt: new Date().toISOString(),
        address: getCreateAddress({ from: wallet.address, nonce }),
        ...fields,
      },
    });

    // Un autre calendrier dans l'appel : la reprise l'ignore et diffuse celui du journal.
    const vesting = await deployVestingStep(ctx, { beneficiary: wallet.address, start: openAt, durationSeconds: 10n * DAY, cliffSeconds: DAY });
    expect(vesting.txHash).to.equal(signed.hash);
    expect(vesting.durationSeconds).to.equal(fields.durationSeconds);
    expect(await ethers.provider.getTransactionCount(wallet.address)).to.equal(nonce + 1);
  });

  it("répétition complète : blocage puis lanceur, Safe d'essai, frais au Safe, libération entière", async function () {
    const { uniswap, wallet, openAt } = await setup();
    const report = await runRehearsal(connection, uniswap, {
      token: TOKEN,
      pool: { startMarketCapWei: 3n * UNIT, startTick: START_TICK, openAt },
      vestingPercent: 10n,
      vesting: { enabled: true, durationSeconds: 900n * DAY, cliffSeconds: 90n * DAY, beneficiary: wallet.address },
      community: { percent: 3n, beneficiary: undefined },
    });
    expect(report.communitySafe.fakeSafe).to.equal(true);
    expect(report.vestingRecord?.nonce).to.be.lessThan(report.token.nonce);
    expect(report.distribution.inVesting).to.equal(TEAM);
    expect(report.distribution.inCommunity).to.equal(RESERVE);
    expect(report.fees.weth).to.be.greaterThan(0n);
    expect(report.vesting?.releasedAtCliff).to.be.greaterThan(0n);
    expect(report.vesting?.releasedAtEnd).to.equal(TEAM);
  });
});

describe("Échecs définitifs : seul le reçu de NOTRE transaction autorise à revenir en arrière", function () {
  /** Réseau où, comme sur une vraie chaîne, une transaction qui échoue est minée au lieu d'être refusée. */
  async function lenientSetup() {
    const lenient = await network.create({ override: { throwOnTransactionFailures: false, throwOnCallFailures: false } });
    const [, , , operator] = await lenient.ethers.getSigners();
    const uniswap = await deployLocalUniswapV3(lenient.ethers, operator);
    const safe = await deployFakeSafe(lenient);
    const wallet = await localWallet(lenient);
    return { lenient, uniswap, safe, wallet };
  }

  /** Lanceur signé et noté avec une ouverture dans 3 min, puis le temps passe : il échouera sur la chaîne. */
  async function staleLauncherEntry(lenient: NetworkConnection, ctx: StepContext, uniswap: UniswapV3Deployment, safe: string) {
    const params = launchParams(uniswap, safe, (await latest(lenient)) + 180n);
    const fields = {
      name: params.name,
      symbol: params.symbol,
      supplyWholeTokens: params.supply.toString(),
      positionManager: params.positionManager,
      factory: params.factory,
      weth: params.weth,
      salt: zeroPadValue("0x02", 32),
      vesting: params.vesting,
      vestingWholeTokens: params.vestingWholeTokens.toString(),
      community: params.community,
      communityWholeTokens: params.communityWholeTokens.toString(),
      feeRecipient: params.feeRecipient,
      startTick: params.startTick,
      openAt: params.openAt.toString(),
    };
    const factory = await lenient.ethers.getContractFactory(LAUNCHER_CONTRACT);
    const payload: TxPayload = { data: (await factory.getDeployTransaction(...launcherConstructorArgs(fields))).data };
    const nonce = await nextNonce(lenient.ethers.provider, ctx.wallet.address);
    const signed = await signTx(lenient.ethers.provider, ctx.wallet, chainId, payload, nonce);
    const launcher = getCreateAddress({ from: ctx.wallet.address, nonce });
    const entry: TokenRecord = {
      status: "pending",
      from: ctx.wallet.address,
      nonce,
      txHash: signed.hash,
      rawTx: signed.raw,
      preparedAt: new Date().toISOString(),
      address: await predictTokenAddress(lenient.ethers, launcher, fields),
      launcher,
      ...fields,
    };
    await ctx.journal.write({ network: "test", chainId: chainId.toString(), token: entry });
    await lenient.networkHelpers.time.increase(600);
    return entry;
  }

  it("un lanceur miné en échec remet le journal à l'étape précédente, nonce compté ; la relance prend le suivant", async function () {
    const { lenient, uniswap, safe, wallet } = await lenientSetup();
    const ctx = contextFor(lenient, wallet);
    const entry = await staleLauncherEntry(lenient, ctx, uniswap, safe);

    await expectLaunchError(deployTokenStep(ctx, launchParamsOf(entry)), /a échoué/);
    const after = await ctx.journal.read();
    expect(after?.token).to.equal(undefined);
    expect(after?.nonceFloor).to.equal(entry.nonce + 1);
    expect(await lenient.ethers.provider.getCode(entry.launcher)).to.equal("0x");

    // Aussitôt, avec un RPC en retard d'une transaction : le nonce consommé n'est pas réutilisé.
    const token = await deployTokenStep(laggingContext(ctx, 1), launchParams(uniswap, safe, (await latest(lenient)) + 2n * HOUR));
    expect(token.status).to.equal("confirmed");
    expect(token.nonce).to.equal(entry.nonce + 1);
  });

  it("frais devenus trop bas ET heure d'ouverture passée entre-temps : re-signé avec sa limite de gas d'origine, miné en échec, journal remis", async function () {
    const { lenient, uniswap, safe, wallet } = await lenientSetup();
    const logs: string[] = [];
    const ctx = { ...contextFor(lenient, wallet), log: (message: string) => logs.push(message) };
    const entry = await staleLauncherEntry(lenient, ctx, uniswap, safe);
    await lenient.networkHelpers.setNextBlockBaseFeePerGas(parseUnits("1000", "gwei"));
    await lenient.networkHelpers.mine();

    await expectLaunchError(deployTokenStep(ctx, launchParamsOf(entry)), /a échoué/);
    expect(logs.some((line) => line.startsWith("Diffusion refusée"))).to.equal(true);
    expect((await ctx.journal.read())?.token).to.equal(undefined);
    expect(await lenient.ethers.provider.getTransactionCount(wallet.address)).to.equal(entry.nonce + 1);
  });
});

describe("Après l'ouverture : achats, reventes et frais", function () {
  it("aucun échange avant l'heure ; ensuite achat puis revente contre de l'ETH aux montants exacts du quoter, sans taxe", async function () {
    const { wallet, uniswap, safe, openAt } = await setup();
    const token = await deployTokenStep(contextFor(connection, wallet), launchParams(uniswap, safe, openAt));
    const trader = (await ethers.getSigners())[9];
    const swapper = await swapperFor(ethers.provider, uniswap);
    const ethIn = 10n ** 16n;
    await expect(swapper.buy(trader, token.address, ethIn, 0n)).to.be.revert(ethers);

    await networkHelpers.time.increaseTo(openAt);
    const out = await swapper.quoteBuy(token.address, ethIn);
    await (await swapper.buy(trader, token.address, ethIn, out)).wait();
    expect(await balanceOf(token.address, trader.address)).to.equal(out);

    await (await new Contract(token.address, ERC20_ABI, trader).approve(swapper.router, out)).wait();
    const back = await swapper.quoteSell(token.address, out);
    const before = await ethers.provider.getBalance(trader.address);
    const receipt = await (await swapper.sell(trader, token.address, out, back)).wait();
    expect((await ethers.provider.getBalance(trader.address)) - before + (receipt?.fee ?? 0n)).to.equal(back);
    expect(await balanceOf(token.address, trader.address)).to.equal(0n);
    expect(back).to.be.lessThan(ethIn); // 2 × 1 % de frais
  });

  it("les frais d'échange vont au Safe, appelés par n'importe qui ; la liquidité reste", async function () {
    const { wallet, buyer, uniswap, safe, openAt } = await setup();
    const token = await deployTokenStep(contextFor(connection, wallet), launchParams(uniswap, safe, openAt));
    const swapper = await swapperFor(ethers.provider, uniswap);
    await networkHelpers.time.increaseTo(openAt);
    await (await swapper.buy(buyer, token.address, 10n ** 16n, 0n)).wait();
    const status = await readLaunchStatus(ethers.provider, token.launcher);
    const pending = status.pendingFees?.weth ?? 0n;
    expect(pending > 10n ** 14n - 10n && pending <= 10n ** 14n).to.equal(true); // 1 % de l'achat, à l'arrondi près
    const weth = new Contract(uniswap.weth, ERC20_ABI, ethers.provider);
    await (await new Contract(token.launcher, LAUNCHER_ABI, buyer).collectFees()).wait();
    expect(await weth.balanceOf(safe)).to.equal(pending);
    const npm = new Contract(uniswap.positionManager, V3_POSITION_MANAGER_ABI, ethers.provider);
    expect(await npm.ownerOf(status.positionId)).to.equal(token.launcher);
  });
});
