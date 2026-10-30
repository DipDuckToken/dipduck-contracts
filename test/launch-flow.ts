import { expect } from "chai";
import { Contract, MaxUint256, ZeroAddress, getCreateAddress, parseEther, parseUnits } from "ethers";
import { network } from "hardhat";
import type { NetworkConnection } from "hardhat/types/network";

import { DEAD_ADDRESS, UNISWAP_V2_MINIMUM_LIQUIDITY, UNIT } from "../scripts/lib/constants.ts";
import { CURVE_ABI, buildCurvePlan, readCurveStatus, splitSupply } from "../scripts/lib/curve.ts";
import { LaunchError } from "../scripts/lib/errors.ts";
import type { UniswapV2Deployment } from "../scripts/lib/networks.ts";
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
import { CURVE_CONTRACT, VESTING_CONTRACT, curveConstructorArgs, vestingConstructorArgs } from "../scripts/lib/token.ts";
import { type TxPayload, broadcastRaw, nextNonce, signTx } from "../scripts/lib/tx.ts";
import { ERC20_ABI, PAIR_ABI, ROUTER_ABI, assertUniswapV2Deployment, readPoolStatus } from "../scripts/lib/uniswap.ts";
import type { TokenParams } from "../scripts/lib/validation.ts";
import { VESTING_ABI, readVestingStatus } from "../scripts/lib/vesting.ts";
import { localWallet } from "../scripts/lib/wallet.ts";
import { deployLocalUniswapV2 } from "./helpers/uniswap-local.ts";

const connection = await network.create();
const { ethers, networkHelpers } = connection;
const { chainId } = await ethers.provider.getNetwork();

const TOKEN: TokenParams = { name: "Test Token", symbol: "TEST", supply: 1_000_000_000n };
const SUPPLY = TOKEN.supply * UNIT;
const VIRTUAL = parseEther("2");
const TARGET = parseEther("3");
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

/** Paramètres de la courbe : par défaut 100 % de l'offre sur la courbe, ni part ni réserve. */
function launchParams(
  uniswap: UniswapV2Deployment,
  openAt: bigint,
  share?: { vesting?: string; community?: string; tokenPercent?: bigint; communityPercent?: bigint },
): LaunchParams {
  const tokenPercent = share?.tokenPercent ?? 100n;
  const split = splitSupply(TOKEN.supply, tokenPercent, share?.communityPercent ?? 0n);
  return {
    ...TOKEN,
    factory: uniswap.factory,
    weth: uniswap.weth,
    curveTokenPercent: tokenPercent,
    curveWholeTokens: split.curveWholeTokens,
    virtualEthWei: VIRTUAL,
    targetEthWei: TARGET,
    openAt,
    vesting: share?.vesting ?? ZeroAddress,
    vestingWholeTokens: split.vestingWholeTokens,
    community: share?.community ?? ZeroAddress,
    communityWholeTokens: split.communityWholeTokens,
  };
}

async function setupFixture() {
  const [deployer, buyer, attacker, operator] = await ethers.getSigners();
  const uniswap = await deployLocalUniswapV2(ethers, operator);
  const safe = await deployFakeSafe(connection);
  const wallet = await localWallet(connection);
  expect(wallet.address).to.equal(deployer.address);
  return { deployer, buyer, attacker, uniswap, safe, wallet };
}

async function setup() {
  const fixture = await networkHelpers.loadFixture(setupFixture);
  return { ...fixture, openAt: (await latest()) + 2n * HOUR };
}

/** Achète jusqu'à la cible (après les 24 h de limite) : le pool s'ouvre. */
async function graduate(curve: string, conn: NetworkConnection = connection): Promise<void> {
  const status = await readCurveStatus(conn.ethers.provider, curve);
  const now = await latest(conn);
  if (now < status.openAt + DAY) await conn.networkHelpers.time.increaseTo(status.openAt + DAY);
  const whale = (await conn.ethers.getSigners())[8];
  const asWhale = new Contract(curve, CURVE_ABI, whale);
  await (await asWhale.buy(0n, (await latest(conn)) + 600n, { value: status.targetEth - status.ethReserve })).wait();
}

describe("Adresses Uniswap", function () {
  it("accepte un déploiement cohérent et refuse une incohérence ou une adresse vide", async function () {
    const { uniswap, buyer } = await setup();
    await assertUniswapV2Deployment(ethers.provider, uniswap);
    await expectLaunchError(assertUniswapV2Deployment(ethers.provider, { ...uniswap, weth: uniswap.factory }), /annonce le WETH/);
    await expectLaunchError(assertUniswapV2Deployment(ethers.provider, { ...uniswap, factory: uniswap.weth }), /annonce la factory/);
    await expectLaunchError(assertUniswapV2Deployment(ethers.provider, { ...uniswap, router: buyer.address }), /Aucun contrat/);
  });
});

describe("Déploiement de la courbe (vrai bytecode Uniswap v2)", function () {
  it("déploie la courbe, qui crée le token et garde 100 % de l'offre ; adresses prévues avant diffusion", async function () {
    const { wallet, uniswap, openAt } = await setup();
    const ctx = contextFor(connection, wallet);
    const nonce = await ethers.provider.getTransactionCount(wallet.address);
    const token = await deployTokenStep(ctx, launchParams(uniswap, openAt));

    const curveAddress = getCreateAddress({ from: wallet.address, nonce });
    expect(token.status).to.equal("confirmed");
    expect(token.curve).to.equal(curveAddress);
    expect(token.address).to.equal(getCreateAddress({ from: curveAddress, nonce: 1 }));
    expect(token.openAt).to.equal(openAt.toString());
    expect(await balanceOf(token.address, token.curve)).to.equal(SUPPLY);
    expect(await balanceOf(token.address, wallet.address)).to.equal(0n);
    expect(await ethers.provider.getTransactionCount(wallet.address)).to.equal(nonce + 1);

    const status = await readCurveStatus(ethers.provider, token.curve);
    expect(status.token).to.equal(token.address);
    expect(status.pair).to.equal(token.pair);
    expect(status.graduated).to.equal(false);
    expect(status.walletLimit).to.equal(0n); // achats pas encore ouverts

    // Les chiffres affichés par le script sont ceux du contrat.
    const plan = buildCurvePlan({
      supplyWholeTokens: TOKEN.supply,
      split: splitSupply(TOKEN.supply, 100n, 0n),
      virtualEthWei: VIRTUAL,
      targetEthWei: TARGET,
    });
    expect(status.virtualTokens).to.equal(plan.virtualTokens);
    expect(status.curveTokens).to.equal(plan.soldTokens);
    expect(status.lpTokens).to.equal(plan.lpTokens);
    expect(status.price).to.equal(plan.startPriceWei);

    await expectLaunchError(deployTokenStep(ctx, launchParams(uniswap, openAt)), /déjà déployé/);
    expect(await ethers.provider.getTransactionCount(wallet.address)).to.equal(nonce + 1);
  });

  it("refuse une heure d'ouverture passée, imminente ou à plus de 30 jours, sans rien envoyer", async function () {
    const { wallet, uniswap } = await setup();
    const ctx = contextFor(connection, wallet);
    const nonce = await ethers.provider.getTransactionCount(wallet.address);
    const now = await latest();
    await expectLaunchError(deployTokenStep(ctx, launchParams(uniswap, now - 10n)), /passée ou imminente/);
    await expectLaunchError(deployTokenStep(ctx, launchParams(uniswap, now + 30n)), /passée ou imminente/);
    await expectLaunchError(deployTokenStep(ctx, launchParams(uniswap, now + 31n * DAY)), /plus de 30 jours/);
    expect(await ctx.journal.read()).to.equal(undefined);
    expect(await ethers.provider.getTransactionCount(wallet.address)).to.equal(nonce);
  });

  it("refuse, par simulation et sans rien envoyer, un contrat de blocage ou un Safe sans code", async function () {
    const { wallet, buyer, uniswap, openAt } = await setup();
    const ctx = contextFor(connection, wallet);
    const nonce = await ethers.provider.getTransactionCount(wallet.address);
    await expectLaunchError(
      deployTokenStep(ctx, launchParams(uniswap, openAt, { vesting: buyer.address, tokenPercent: 90n })),
      /simulation.*refuse ses paramètres/,
    );
    await expectLaunchError(
      deployTokenStep(ctx, launchParams(uniswap, openAt, { community: buyer.address, tokenPercent: 97n, communityPercent: 3n })),
      /simulation/,
    );
    expect(await ctx.journal.read()).to.equal(undefined);
    expect(await ethers.provider.getTransactionCount(wallet.address)).to.equal(nonce);
  });

  it("le pool s'ouvre tout seul à la cible, au prix de fin de courbe, LP toutes brûlées", async function () {
    const { wallet, uniswap, openAt } = await setup();
    const token = await deployTokenStep(contextFor(connection, wallet), launchParams(uniswap, openAt));
    await graduate(token.curve);

    const status = await readCurveStatus(ethers.provider, token.curve);
    expect(status.graduated).to.equal(true);
    const pool = await readPoolStatus(ethers.provider, uniswap, token.address, wallet.address);
    expect(pool?.pair).to.equal(token.pair);
    expect(pool?.wethReserve).to.equal(TARGET);
    expect(pool?.tokenReserve).to.equal(status.lpTokens);
    expect(pool?.lpHeldBy).to.equal(0n);
    const lp = new Contract(token.pair as string, PAIR_ABI, ethers.provider);
    expect(await lp.balanceOf(DEAD_ADDRESS)).to.equal(((await lp.totalSupply()) as bigint) - UNISWAP_V2_MINIMUM_LIQUIDITY);
    expect(await balanceOf(token.address, token.curve)).to.equal(0n);
    expect(await ethers.provider.getBalance(token.curve)).to.equal(0n);
  });

  it("répétition complète, sans part ni réserve : courbe, achats, revente, cible, achat Uniswap", async function () {
    const { uniswap, openAt } = await setup();
    const report = await runRehearsal(connection, uniswap, {
      token: TOKEN,
      curve: { tokenPercent: 100n, curveWholeTokens: TOKEN.supply, virtualEthWei: VIRTUAL, targetEthWei: TARGET, openAt },
    });
    expect(report.antiBot.buyBeforeOpenBlocked).to.equal(true);
    expect(report.antiBot.bigBuyBlocked).to.equal(true);
    expect(report.antiBot.limitAtOpen).to.equal(SUPPLY / 200n);
    expect(report.antiBot.poolBigBuyBlocked).to.equal(true);
    expect(report.graduation.ethInPool).to.equal(TARGET);
    expect(report.graduation.refunded).to.be.greaterThan(0n);
    expect(report.pool.lpHeldBy).to.equal(0n);
    expect(report.routerBuy.tokensOut).to.be.greaterThan(0n);
    expect(report.resale.ethOut).to.be.greaterThan(0n);
  });
});

describe("Reprise après interruption : jamais de double envoi", function () {
  /** Simule un arrêt juste après la signature : la transaction est notée, pas forcément diffusée. */
  async function signedTokenEntry(ctx: StepContext, params: LaunchParams): Promise<TokenRecord> {
    const factory = await ethers.getContractFactory(CURVE_CONTRACT);
    const nonce = await nextNonce(ethers.provider, ctx.wallet.address);
    const curve = getCreateAddress({ from: ctx.wallet.address, nonce });
    const fields = {
      name: params.name,
      symbol: params.symbol,
      supplyWholeTokens: params.supply.toString(),
      factory: params.factory,
      weth: params.weth,
      curveTokenPercent: Number(params.curveTokenPercent),
      curveWholeTokens: params.curveWholeTokens.toString(),
      vesting: params.vesting,
      vestingWholeTokens: params.vestingWholeTokens.toString(),
      community: params.community,
      communityWholeTokens: params.communityWholeTokens.toString(),
      virtualEthWei: params.virtualEthWei.toString(),
      targetEthWei: params.targetEthWei.toString(),
      openAt: params.openAt.toString(),
    };
    const payload: TxPayload = { data: (await factory.getDeployTransaction(...curveConstructorArgs(fields))).data };
    const signed = await signTx(ethers.provider, ctx.wallet, chainId, payload, nonce);
    const entry: TokenRecord = {
      status: "pending",
      from: ctx.wallet.address,
      nonce,
      txHash: signed.hash,
      rawTx: signed.raw,
      preparedAt: new Date().toISOString(),
      address: getCreateAddress({ from: curve, nonce: 1 }),
      curve,
      ...fields,
    };
    const record = await ctx.journal.read();
    await ctx.journal.write({ ...(record ?? { network: "test", chainId: chainId.toString() }), token: entry });
    return entry;
  }

  it("signée et notée mais jamais diffusée : diffuse exactement la même transaction", async function () {
    const { wallet, uniswap, openAt } = await setup();
    const ctx = contextFor(connection, wallet);
    const entry = await signedTokenEntry(ctx, launchParams(uniswap, openAt));

    // D'autres paramètres dans l'appel : la reprise suit le journal.
    const token = await deployTokenStep(ctx, launchParams(uniswap, openAt + DAY));
    expect(token.status).to.equal("confirmed");
    expect(token.txHash).to.equal(entry.txHash);
    expect(token.address).to.equal(entry.address);
    expect(token.openAt).to.equal(openAt.toString());
    expect(await ethers.provider.getTransactionCount(wallet.address)).to.equal(entry.nonce + 1);
  });

  it("diffusée mais réponse perdue : retrouve le reçu par son hash, sans rediffuser ni redéployer", async function () {
    const { wallet, uniswap, openAt } = await setup();
    const ctx = contextFor(connection, wallet);
    const entry = await signedTokenEntry(ctx, launchParams(uniswap, openAt));
    await broadcastRaw(ethers.provider, entry.rawTx);

    const token = await deployTokenStep(ctx, launchParamsOf(entry));
    expect(token.status).to.equal("confirmed");
    expect(token.blockNumber).to.be.a("number");
    expect(await ethers.provider.getTransactionCount(wallet.address)).to.equal(entry.nonce + 1);
    await expectLaunchError(deployTokenStep(ctx, launchParamsOf(entry)), /déjà déployé/);
  });

  it("encore en attente sur le réseau : s'arrête sans rien changer, puis confirme", async function () {
    const { wallet, uniswap, openAt } = await setup();
    const ctx = contextFor(connection, wallet);
    const entry = await signedTokenEntry(ctx, launchParams(uniswap, openAt));

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
    const { wallet, buyer, uniswap, openAt } = await setup();
    const ctx = contextFor(connection, wallet);
    const entry = await signedTokenEntry(ctx, launchParams(uniswap, openAt));
    const other = await signTx(ethers.provider, wallet, chainId, { to: buyer.address, data: "0x", value: 1n }, entry.nonce);
    await broadcastRaw(ethers.provider, other.raw);

    await expectLaunchError(deployTokenStep(ctx, launchParamsOf(entry)), /déjà utilisé/);
    expect((await ctx.journal.read())?.token?.txHash).to.equal(entry.txHash);
    expect(await ethers.provider.getCode(entry.curve)).to.equal("0x");
  });

  it("frais devenus trop bas : re-signe avec le même nonce, une seule courbe", async function () {
    const { wallet, uniswap, openAt } = await setup();
    const ctx = contextFor(connection, wallet);
    const entry = await signedTokenEntry(ctx, launchParams(uniswap, openAt));
    await networkHelpers.setNextBlockBaseFeePerGas(parseUnits("1000", "gwei"));
    await networkHelpers.mine();

    const token = await deployTokenStep(ctx, launchParamsOf(entry));
    expect(token.status).to.equal("confirmed");
    expect(token.txHash).to.not.equal(entry.txHash);
    expect(token.replacedTxHashes).to.deep.equal([entry.txHash]);
    expect(token.curve).to.equal(entry.curve);
    expect(token.address).to.equal(entry.address);
    expect(await ethers.provider.getTransactionCount(wallet.address)).to.equal(entry.nonce + 1);
  });

  it("version précédente minée après une re-signature : le journal garde le hash réellement miné", async function () {
    const { wallet, uniswap, openAt } = await setup();
    const ctx = contextFor(connection, wallet);
    const mined = await signedTokenEntry(ctx, launchParams(uniswap, openAt));
    await broadcastRaw(ethers.provider, mined.rawTx);
    await networkHelpers.setNextBlockBaseFeePerGas(parseUnits("5", "gwei"));
    await networkHelpers.mine();
    // Une version re-signée (même nonce) notée comme courante, mais jamais diffusée.
    const factory = await ethers.getContractFactory(CURVE_CONTRACT);
    const payload = { data: (await factory.getDeployTransaction(...curveConstructorArgs(mined))).data };
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
    const { wallet, uniswap, openAt } = await setup();
    const ctx = flakyBroadcastContext(contextFor(connection, wallet), true);
    const token = await deployTokenStep(ctx, launchParams(uniswap, openAt));
    expect(token.status).to.equal("confirmed");
    expect(token.replacedTxHashes).to.equal(undefined);
    expect(await ethers.provider.getTransactionCount(wallet.address)).to.equal(token.nonce + 1);
  });

  it("RPC muet à la diffusion (rien n'est arrivé) : s'arrête, puis la relance diffuse la même transaction", async function () {
    const { wallet, uniswap, openAt } = await setup();
    const journal = memoryJournal();
    await expectLaunchError(
      deployTokenStep(flakyBroadcastContext(contextFor(connection, wallet, journal), false), launchParams(uniswap, openAt)),
      /impossible pour l'instant/,
    );
    const pending = (await journal.read())?.token;
    expect(pending?.status).to.equal("pending");
    expect(await ethers.provider.getTransactionCount(wallet.address)).to.equal(pending?.nonce);

    const token = await deployTokenStep(contextFor(connection, wallet, journal), launchParams(uniswap, openAt));
    expect(token.txHash).to.equal(pending?.txHash);
    expect(token.status).to.equal("confirmed");
  });

  it("solde insuffisant au moment de diffuser : s'arrête sans re-signer, puis diffuse la même transaction", async function () {
    const { wallet, uniswap, openAt } = await setup();
    const ctx = contextFor(connection, wallet);
    const entry = await signedTokenEntry(ctx, launchParams(uniswap, openAt));
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

  it("RPC en retard sur le nonce : le blocage puis la courbe prennent quand même les bons nonces", async function () {
    const { wallet, uniswap, openAt } = await setup();
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
      launchParams(uniswap, openAt, { vesting: vesting.address, tokenPercent: 90n }),
    );
    expect(vesting.nonce).to.equal(first);
    expect(token.nonce).to.equal(first + 1);
    expect(token.status).to.equal("confirmed");
  });
});

describe("Ta part et la réserve : contrat de blocage et Safe avant la courbe, versés à l'ouverture du pool", function () {
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
      launchParams(fixture.uniswap, fixture.openAt, {
        vesting: vesting.address,
        community: fixture.safe,
        tokenPercent: 87n,
        communityPercent: 3n,
      }),
    );
    return { ...fixture, ctx, plan, vesting, token };
  }

  it("le blocage est déployé AVANT la courbe ; tout reste dans la courbe jusqu'à la cible", async function () {
    const { wallet, safe, vesting, token } = await launched();
    expect(vesting.nonce).to.be.lessThan(token.nonce);
    expect(token.vesting).to.equal(vesting.address);
    expect(token.community).to.equal(safe);
    expect(BigInt(token.vestingWholeTokens) * UNIT).to.equal(TEAM);
    expect(BigInt(token.communityWholeTokens) * UNIT).to.equal(RESERVE);
    // Le wallet de déploiement ne détient jamais de tokens ; part et réserve attendent dans la courbe.
    expect(await balanceOf(token.address, wallet.address)).to.equal(0n);
    expect(await balanceOf(token.address, vesting.address)).to.equal(0n);
    expect(await balanceOf(token.address, safe)).to.equal(0n);
    expect(await balanceOf(token.address, token.curve)).to.equal(SUPPLY);
    const status = await readCurveStatus(ethers.provider, token.curve);
    expect(status.vesting).to.equal(vesting.address);
    expect(status.vestingTokens).to.equal(TEAM);
    expect(status.community).to.equal(safe);
    expect(status.communityTokens).to.equal(RESERVE);
  });

  it("à la cible : ta part va au blocage, la réserve au Safe, le reste au pool, montants exacts", async function () {
    const { wallet, uniswap, safe, vesting, token } = await launched();
    await graduate(token.curve);
    expect(await balanceOf(token.address, vesting.address)).to.equal(TEAM);
    expect(await balanceOf(token.address, safe)).to.equal(RESERVE);
    expect(await balanceOf(token.address, wallet.address)).to.equal(0n);
    const status = await readCurveStatus(ethers.provider, token.curve);
    const pool = await readPoolStatus(ethers.provider, uniswap, token.address, wallet.address);
    expect(pool?.tokenReserve).to.equal(status.lpTokens);
    expect(await balanceOf(token.address, token.curve)).to.equal(0n);
  });

  it("se libère selon le calendrier (début = ouverture des achats), toujours au bénéficiaire", async function () {
    const { wallet, buyer, plan, vesting, token } = await launched();
    await graduate(token.curve);
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

  it("cible jamais atteinte : ta part et la réserve restent dans la courbe, personne ne peut les revendre", async function () {
    const { wallet, buyer, safe, vesting, token } = await launched();
    await networkHelpers.time.increaseTo(BigInt(token.openAt) + DAY);
    const asBuyer = new Contract(token.curve, CURVE_ABI, buyer);
    await (await asBuyer.buy(0n, (await latest()) + 600n, { value: parseEther("0.5") })).wait();
    await networkHelpers.time.increase(365n * DAY);
    expect(await balanceOf(token.address, vesting.address)).to.equal(0n);
    expect(await balanceOf(token.address, safe)).to.equal(0n);
    expect(await balanceOf(token.address, wallet.address)).to.equal(0n);
    // Revente plafonnée à ce que la courbe a vendu : part et réserve n'en font pas partie.
    const status = await readCurveStatus(ethers.provider, token.curve);
    expect(await balanceOf(token.address, token.curve)).to.equal(SUPPLY - status.tokensSold);
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

  it("répétition complète : blocage puis courbe, Safe d'essai, part et réserve versées à la cible, libération entière", async function () {
    const { uniswap, wallet, openAt } = await setup();
    const report = await runRehearsal(connection, uniswap, {
      token: TOKEN,
      curve: { tokenPercent: 87n, curveWholeTokens: 870_000_000n, virtualEthWei: VIRTUAL, targetEthWei: TARGET, openAt },
      vesting: { enabled: true, durationSeconds: 900n * DAY, cliffSeconds: 90n * DAY, beneficiary: wallet.address },
      community: { percent: 3n, beneficiary: undefined },
    });
    expect(report.communitySafe?.fakeSafe).to.equal(true);
    expect(report.vestingRecord?.nonce).to.be.lessThan(report.token.nonce);
    expect(report.graduation.vestingReceived).to.equal(TEAM);
    expect(report.graduation.communityReceived).to.equal(RESERVE);
    expect(report.vesting?.releasedAtCliff).to.be.greaterThan(0n);
    expect(report.vesting?.releasedAtEnd).to.equal(TEAM);
  });

  it("répétition avec une falaise égale à la durée : le temps n'avance jamais à rebours", async function () {
    const { uniswap, wallet, openAt } = await setup();
    const report = await runRehearsal(connection, uniswap, {
      token: TOKEN,
      curve: { tokenPercent: 95n, curveWholeTokens: 950_000_000n, virtualEthWei: VIRTUAL, targetEthWei: TARGET, openAt },
      vesting: { enabled: true, durationSeconds: 30n * DAY, cliffSeconds: 30n * DAY, beneficiary: wallet.address },
    });
    expect(report.vesting?.releasedAtCliff).to.equal((SUPPLY * 5n) / 100n);
    expect(report.vesting?.releasedAtEnd).to.equal((SUPPLY * 5n) / 100n);
  });
});

describe("Échecs définitifs : seul le reçu de NOTRE transaction autorise à revenir en arrière", function () {
  /** Réseau où, comme sur une vraie chaîne, une transaction qui échoue est minée au lieu d'être refusée. */
  async function lenientSetup() {
    const lenient = await network.create({ override: { throwOnTransactionFailures: false, throwOnCallFailures: false } });
    const [, , , operator] = await lenient.ethers.getSigners();
    const uniswap = await deployLocalUniswapV2(lenient.ethers, operator);
    const wallet = await localWallet(lenient);
    return { lenient, uniswap, wallet };
  }

  /** Courbe signée et notée avec une ouverture dans 3 min, puis le temps passe : elle échouera sur la chaîne. */
  async function staleCurveEntry(lenient: NetworkConnection, ctx: StepContext, uniswap: UniswapV2Deployment) {
    const openAt = (await latest(lenient)) + 180n;
    const params = launchParams(uniswap, openAt);
    const fields = {
      name: params.name,
      symbol: params.symbol,
      supplyWholeTokens: params.supply.toString(),
      factory: params.factory,
      weth: params.weth,
      curveTokenPercent: Number(params.curveTokenPercent),
      curveWholeTokens: params.curveWholeTokens.toString(),
      vesting: params.vesting,
      vestingWholeTokens: params.vestingWholeTokens.toString(),
      community: params.community,
      communityWholeTokens: params.communityWholeTokens.toString(),
      virtualEthWei: params.virtualEthWei.toString(),
      targetEthWei: params.targetEthWei.toString(),
      openAt: params.openAt.toString(),
    };
    const factory = await lenient.ethers.getContractFactory(CURVE_CONTRACT);
    const payload: TxPayload = { data: (await factory.getDeployTransaction(...curveConstructorArgs(fields))).data };
    const nonce = await nextNonce(lenient.ethers.provider, ctx.wallet.address);
    const signed = await signTx(lenient.ethers.provider, ctx.wallet, chainId, payload, nonce);
    const curve = getCreateAddress({ from: ctx.wallet.address, nonce });
    const entry: TokenRecord = {
      status: "pending",
      from: ctx.wallet.address,
      nonce,
      txHash: signed.hash,
      rawTx: signed.raw,
      preparedAt: new Date().toISOString(),
      address: getCreateAddress({ from: curve, nonce: 1 }),
      curve,
      ...fields,
    };
    await ctx.journal.write({ network: "test", chainId: chainId.toString(), token: entry });
    await lenient.networkHelpers.time.increase(600);
    return entry;
  }

  it("une courbe minée en échec remet le journal à l'étape précédente, nonce compté ; la relance prend le suivant", async function () {
    const { lenient, uniswap, wallet } = await lenientSetup();
    const ctx = contextFor(lenient, wallet);
    const entry = await staleCurveEntry(lenient, ctx, uniswap);

    await expectLaunchError(deployTokenStep(ctx, launchParamsOf(entry)), /a échoué/);
    const after = await ctx.journal.read();
    expect(after?.token).to.equal(undefined);
    expect(after?.nonceFloor).to.equal(entry.nonce + 1);
    expect(await lenient.ethers.provider.getCode(entry.curve)).to.equal("0x");

    // Aussitôt, avec un RPC en retard d'une transaction : le nonce consommé n'est pas réutilisé.
    const token = await deployTokenStep(laggingContext(ctx, 1), launchParams(uniswap, (await latest(lenient)) + 2n * HOUR));
    expect(token.status).to.equal("confirmed");
    expect(token.nonce).to.equal(entry.nonce + 1);
  });

  it("frais devenus trop bas ET heure d'ouverture passée entre-temps : re-signée avec sa limite de gas d'origine, minée en échec, journal remis", async function () {
    const { lenient, uniswap, wallet } = await lenientSetup();
    const logs: string[] = [];
    const ctx = { ...contextFor(lenient, wallet), log: (message: string) => logs.push(message) };
    const entry = await staleCurveEntry(lenient, ctx, uniswap);
    await lenient.networkHelpers.setNextBlockBaseFeePerGas(parseUnits("1000", "gwei"));
    await lenient.networkHelpers.mine();

    await expectLaunchError(deployTokenStep(ctx, launchParamsOf(entry)), /a échoué/);
    expect(logs.some((line) => line.startsWith("Diffusion refusée"))).to.equal(true);
    expect((await ctx.journal.read())?.token).to.equal(undefined);
    expect(await lenient.ethers.provider.getTransactionCount(wallet.address)).to.equal(entry.nonce + 1);
  });
});

describe("Après l'ouverture du pool : le token se revend sans taxe sur Uniswap", function () {
  it("achat puis revente via le routeur, aux montants exacts annoncés", async function () {
    const { wallet, uniswap, openAt } = await setup();
    const token = await deployTokenStep(contextFor(connection, wallet), launchParams(uniswap, openAt));
    await graduate(token.curve);
    const trader = (await ethers.getSigners())[9];
    const router = new Contract(uniswap.router, ROUTER_ABI, trader);
    const deadline = (await latest()) + 600n;
    const buyPath = [uniswap.weth, token.address];
    const [, out] = (await router.getAmountsOut(parseEther("0.01"), buyPath)) as [bigint, bigint];
    await (await router.swapExactETHForTokens(out, buyPath, trader.address, deadline, { value: parseEther("0.01") })).wait();
    expect(await balanceOf(token.address, trader.address)).to.equal(out);
    await (await new Contract(token.address, ERC20_ABI, trader).approve(uniswap.router, out)).wait();
    const sellPath = [token.address, uniswap.weth];
    const [, back] = (await router.getAmountsOut(out, sellPath)) as [bigint, bigint];
    await (await router.swapExactTokensForETH(out, back, sellPath, trader.address, deadline)).wait();
    expect(await balanceOf(token.address, trader.address)).to.equal(0n);
    expect(await new Contract(token.address, ["function walletLimit() view returns (uint256)"], ethers.provider).walletLimit()).to.not.equal(
      MaxUint256,
    );
  });
});
