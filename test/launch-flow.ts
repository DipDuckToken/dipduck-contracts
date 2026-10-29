import { expect } from "chai";
import { Contract, type ContractRunner, Interface, ZeroAddress, getCreateAddress, parseEther, parseUnits } from "ethers";
import { network } from "hardhat";
import type { NetworkConnection } from "hardhat/types/network";

import { DEAD_ADDRESS, UNISWAP_V2_MINIMUM_LIQUIDITY, UNIT } from "../scripts/lib/constants.ts";
import { LaunchError } from "../scripts/lib/errors.ts";
import type { UniswapV2Deployment } from "../scripts/lib/networks.ts";
import { type Journal, type LiquidityRecord, type TokenRecord, memoryJournal } from "../scripts/lib/records.ts";
import { runRehearsal } from "../scripts/lib/rehearsal.ts";
import {
  type SeedAmounts,
  type StepContext,
  type VestingPlan,
  communityStep,
  deploySeederStep,
  deployTokenStep,
  deployVestingStep,
  lockStep,
  seedStep,
} from "../scripts/lib/steps.ts";
import { SEEDER_CONTRACT, TOKEN_CONTRACT, VESTING_CONTRACT, constructorArgs, vestingConstructorArgs } from "../scripts/lib/token.ts";
import { type TxPayload, broadcastRaw, nextNonce, signTx } from "../scripts/lib/tx.ts";
import {
  ERC20_ABI,
  PAIR_ABI,
  SEEDER_ABI,
  assertUniswapV2Deployment,
  buildLiquidityPlan,
  maxPairWethFor,
  openingRange,
  previewPair,
  readPoolStatus,
  readSeedReceipt,
} from "../scripts/lib/uniswap.ts";
import type { TokenParams } from "../scripts/lib/validation.ts";
import { VESTING_ABI, communityShare, poolBaseAmount, poolShare, readVestingStatus, shareToLock } from "../scripts/lib/vesting.ts";
import { localWallet } from "../scripts/lib/wallet.ts";
import { FACTORY_WRITE_ABI, PAIR_GRIEF_ABI, WETH_ABI, deployLocalUniswapV2 } from "./helpers/uniswap-local.ts";

const connection = await network.create();
const { ethers, networkHelpers } = connection;
const { chainId } = await ethers.provider.getNetwork();

const TOKEN: TokenParams = { name: "Test Token", symbol: "TEST", supply: 1_000_000_000n };
const SUPPLY = TOKEN.supply * UNIT;
const POOL_ETH = parseEther("10");
const seederInterface = new Interface(SEEDER_ABI);
const ROUTER_ADD_LIQUIDITY_ABI = [
  "function addLiquidityETH(address,uint256,uint256,uint256,address,uint256) payable returns (uint256,uint256,uint256)",
];

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

/** Contexte dont le RPC annonce un nombre de transactions périmé (nœud en retard). */
function staleNonceContext(ctx: StepContext): StepContext {
  const provider = withOverrides(ctx.ethers.provider, { getTransactionCount: async () => 0 });
  return { ...ctx, ethers: withOverrides(ctx.ethers, { provider }) };
}

async function balanceOf(token: string, holder: string, conn: NetworkConnection = connection): Promise<bigint> {
  return (await new Contract(token, ERC20_ABI, conn.ethers.provider).balanceOf(holder)) as bigint;
}

async function amountsFor(token: string, holder: string, maxPairWeth = 0n, tokenPercent = 100n): Promise<SeedAmounts> {
  const plan = buildLiquidityPlan({
    deployerTokenBalance: await balanceOf(token, holder),
    tokenTotalSupply: SUPPLY,
    tokenPercent,
    ethAmount: POOL_ETH,
  });
  return { ...plan, maxPairWeth };
}

async function setupFixture() {
  const [deployer, buyer, attacker, operator] = await ethers.getSigners();
  const uniswap = await deployLocalUniswapV2(ethers, operator);
  const wallet = await localWallet(connection);
  expect(wallet.address).to.equal(deployer.address);
  return { deployer, buyer, attacker, uniswap, wallet };
}

/** Token + PoolSeeder lancés par les étapes ; garde une copie du journal obtenu. */
async function deployedFixture() {
  const base = await setupFixture();
  const journal = memoryJournal();
  const ctx = contextFor(connection, base.wallet, journal);
  const token = await deployTokenStep(ctx, TOKEN);
  const seeder = await deploySeederStep(ctx, base.uniswap);
  const snapshot = await journal.read();
  if (snapshot === undefined) throw new Error("journal vide");
  return { ...base, token, seeder, snapshot };
}

/**
 * loadFixture restaure l'état de la chaîne mais rend les mêmes objets JS à
 * chaque test : chaque test repart donc d'un journal neuf, copié de l'instantané.
 */
async function deployed() {
  const fixture = await networkHelpers.loadFixture(deployedFixture);
  const journal = memoryJournal();
  await journal.write(fixture.snapshot);
  return { ...fixture, ctx: contextFor(connection, fixture.wallet, journal) };
}

/** Paire « piégée » : créée par un tiers, avec du WETH donné (et synchronisé si demandé). */
async function griefPair(uniswap: UniswapV2Deployment, token: string, attacker: ContractRunner, sync: boolean) {
  const factory = new Contract(uniswap.factory, FACTORY_WRITE_ABI, attacker);
  if ((await factory.getPair(token, uniswap.weth)) === ZeroAddress) {
    await (await factory.createPair(token, uniswap.weth)).wait();
  }
  const pair = (await factory.getPair(token, uniswap.weth)) as string;
  const weth = new Contract(uniswap.weth, WETH_ABI, attacker);
  await (await weth.deposit({ value: parseEther("1") })).wait();
  await (await weth.transfer(pair, parseEther("1"))).wait();
  if (sync) {
    await (await new Contract(pair, PAIR_GRIEF_ABI, attacker).sync()).wait();
  }
  return pair;
}

describe("Adresses Uniswap", function () {
  it("accepte un déploiement cohérent et refuse une incohérence ou une adresse vide", async function () {
    const { uniswap, buyer } = await networkHelpers.loadFixture(setupFixture);
    await assertUniswapV2Deployment(ethers.provider, uniswap);
    await expectLaunchError(assertUniswapV2Deployment(ethers.provider, { ...uniswap, weth: uniswap.factory }), /annonce le WETH/);
    await expectLaunchError(assertUniswapV2Deployment(ethers.provider, { ...uniswap, factory: uniswap.weth }), /annonce la factory/);
    await expectLaunchError(assertUniswapV2Deployment(ethers.provider, { ...uniswap, router: buyer.address }), /Aucun contrat/);
  });
});

describe("Ouverture atomique du pool (vrai bytecode Uniswap v2)", function () {
  it("ouvre le pool en une transaction et brûle toutes les parts LP de ce dépôt", async function () {
    const { ctx, wallet, uniswap, token, seeder } = await deployed();
    const { record, outcome } = await seedStep(ctx, token, seeder, await amountsFor(token.address, wallet.address));

    expect(record.status).to.equal("confirmed");
    expect(outcome.tokenAmount).to.equal(SUPPLY);
    expect(outcome.ethAmount).to.equal(POOL_ETH);

    const lp = new Contract(outcome.pair, PAIR_ABI, ethers.provider);
    expect(await lp.balanceOf(DEAD_ADDRESS)).to.equal(outcome.lpBurned);
    expect(await lp.balanceOf(ZeroAddress)).to.equal(UNISWAP_V2_MINIMUM_LIQUIDITY);
    expect(await lp.totalSupply()).to.equal(outcome.lpBurned + UNISWAP_V2_MINIMUM_LIQUIDITY);

    const pool = await readPoolStatus(ethers.provider, uniswap, token.address, wallet.address);
    expect(pool?.tokenReserve).to.equal(SUPPLY);
    expect(pool?.wethReserve).to.equal(POOL_ETH);
    expect(pool?.lpHeldBy).to.equal(0n);

    // Rien ne reste nulle part : ni chez le déployeur, ni dans le PoolSeeder.
    expect(await balanceOf(token.address, wallet.address)).to.equal(0n);
    expect(await balanceOf(token.address, seeder.address)).to.equal(0n);
    expect(await balanceOf(uniswap.weth, seeder.address)).to.equal(0n);
    expect(await balanceOf(outcome.pair, seeder.address)).to.equal(0n);
    expect(await ethers.provider.getBalance(seeder.address)).to.equal(0n);
    const tokenContract = new Contract(token.address, ERC20_ABI, ethers.provider);
    expect(await tokenContract.allowance(wallet.address, seeder.address)).to.equal(0n);

    const journal = await ctx.journal.read();
    expect(journal?.token?.status).to.equal("confirmed");
    expect(journal?.seeder?.status).to.equal("confirmed");
    expect(journal?.liquidity?.pair).to.equal(outcome.pair);
  });

  it("garde la part de tokens non mise dans le pool", async function () {
    const { ctx, wallet, token, seeder } = await deployed();
    const amounts = await amountsFor(token.address, wallet.address, 0n, 60n);
    await seedStep(ctx, token, seeder, amounts);
    expect(amounts.tokenAmount).to.equal((SUPPLY * 60n) / 100n);
    expect(await balanceOf(token.address, wallet.address)).to.equal(SUPPLY - amounts.tokenAmount);
  });

  it("accepte un don de WETH déjà présent au moment du plan : il rejoint le pool", async function () {
    const { ctx, wallet, attacker, uniswap, token, seeder } = await deployed();
    await griefPair(uniswap, token.address, attacker, false);
    const { outcome } = await seedStep(ctx, token, seeder, await amountsFor(token.address, wallet.address, parseEther("1")));
    const pool = await readPoolStatus(ethers.provider, uniswap, token.address, wallet.address);
    expect(pool?.wethReserve).to.equal(POOL_ETH + parseEther("1"));
    expect(outcome.lpBurned).to.be.greaterThan(0n);
  });

  it("n'est pas bloquée par un don de WETH synchronisé (l'état qui bloque le routeur officiel)", async function () {
    const { ctx, wallet, deployer, attacker, uniswap, token, seeder } = await deployed();
    const pair = await griefPair(uniswap, token.address, attacker, true);

    const router = new Contract(uniswap.router, ROUTER_ADD_LIQUIDITY_ABI, deployer);
    await (await new Contract(token.address, ERC20_ABI, deployer).approve(uniswap.router, SUPPLY)).wait();
    const deadline = BigInt(await networkHelpers.time.latest()) + 600n;
    let routerFailed = false;
    try {
      await router.addLiquidityETH.staticCall(token.address, SUPPLY, 0n, 0n, DEAD_ADDRESS, deadline, { value: POOL_ETH });
    } catch {
      routerFailed = true;
    }
    expect(routerFailed).to.equal(true);

    const { outcome } = await seedStep(ctx, token, seeder, await amountsFor(token.address, wallet.address, parseEther("1")));
    expect(outcome.pair).to.equal(pair);
    expect(outcome.lpBurned).to.be.greaterThan(0n);
  });

  it("refuse, sans rien ouvrir, un don de WETH arrivé après le plan (prix plus haut que prévu)", async function () {
    const { ctx, wallet, attacker, uniswap, token, seeder } = await deployed();
    const amounts = await amountsFor(token.address, wallet.address, 0n);
    await griefPair(uniswap, token.address, attacker, false);
    await expectLaunchError(seedStep(ctx, token, seeder, amounts), /WETH donné par un tiers/);
    expect((await ctx.journal.read())?.liquidity).to.equal(undefined);
    expect(await balanceOf(token.address, wallet.address)).to.equal(SUPPLY);
  });

  it("un don de 1 wei arrivé après le plan ne bloque pas l'ouverture (marge tolérée de 1 %)", async function () {
    const { ctx, wallet, attacker, uniswap, token, seeder } = await deployed();
    const factory = new Contract(uniswap.factory, FACTORY_WRITE_ABI, attacker);
    await (await factory.createPair(token.address, uniswap.weth)).wait();
    const pair = (await factory.getPair(token.address, uniswap.weth)) as string;
    // Le plan, exactement comme le script : marge calculée sur l'état lu à ce moment-là.
    const preview = await previewPair(ethers.provider, uniswap, token.address);
    const plan = await amountsFor(token.address, wallet.address);
    const amounts = { ...plan, maxPairWeth: maxPairWethFor(preview, plan.ethAmount) };
    expect(amounts.maxPairWeth).to.equal(POOL_ETH / 100n);
    // Pendant que tu tapes le symbole, un tiers ajoute 1 wei (sans synchroniser).
    const weth = new Contract(uniswap.weth, WETH_ABI, attacker);
    await (await weth.deposit({ value: 1n })).wait();
    await (await weth.transfer(pair, 1n)).wait();

    const { outcome } = await seedStep(ctx, token, seeder, amounts);
    expect(outcome.pair).to.equal(pair);
    const pool = await readPoolStatus(ethers.provider, uniswap, token.address, wallet.address);
    expect(pool?.wethReserve).to.equal(POOL_ETH + 1n);
  });

  it("distingue le WETH donné verrouillé (synchronisé) de celui que n'importe qui peut reprendre", async function () {
    const { wallet, attacker, uniswap, token } = await deployed();
    const plan = await amountsFor(token.address, wallet.address);

    await griefPair(uniswap, token.address, attacker, false);
    const unsynced = await previewPair(ethers.provider, uniswap, token.address);
    expect(unsynced.donatedWeth).to.equal(parseEther("1"));
    expect(unsynced.lockedWeth).to.equal(0n);
    const range = openingRange(plan, unsynced, maxPairWethFor(unsynced, plan.ethAmount));
    expect(range.expected.weth).to.equal(POOL_ETH + parseEther("1"));
    expect(range.lowest.weth).to.equal(POOL_ETH); // le don non synchronisé peut disparaître
    expect(range.highest.weth).to.equal(POOL_ETH + parseEther("1") + POOL_ETH / 100n);

    await (await new Contract(unsynced.pair, PAIR_GRIEF_ABI, attacker).sync()).wait();
    const synced = await previewPair(ethers.provider, uniswap, token.address);
    expect(synced.lockedWeth).to.equal(parseEther("1"));
    expect(openingRange(plan, synced, maxPairWethFor(synced, plan.ethAmount)).lowest.weth).to.equal(
      POOL_ETH + parseEther("1"),
    );
  });

  it("refuse, sans rien envoyer, une paire qui a déjà des parts LP", async function () {
    const { ctx, wallet, deployer, attacker, uniswap, token, seeder } = await deployed();
    const erc20 = await ethers.getContractAt(TOKEN_CONTRACT, token.address, deployer);
    await (await erc20.transfer(attacker.address, 1_000n * UNIT)).wait();
    await (await new Contract(token.address, ERC20_ABI, attacker).approve(uniswap.router, 1_000n * UNIT)).wait();
    const router = new Contract(uniswap.router, ROUTER_ADD_LIQUIDITY_ABI, attacker);
    const deadline = BigInt(await networkHelpers.time.latest()) + 600n;
    await (await router.addLiquidityETH(token.address, 1_000n * UNIT, 0n, 0n, attacker.address, deadline, {
      value: parseEther("0.001"),
    })).wait();

    const nonceBefore = await ethers.provider.getTransactionCount(wallet.address, "latest");
    await expectLaunchError(seedStep(ctx, token, seeder, await amountsFor(token.address, wallet.address)), /parts LP existent déjà/);
    // Seule l'autorisation (au PoolSeeder, utilisable par toi seul) a pu partir.
    expect(await ethers.provider.getTransactionCount(wallet.address, "latest")).to.be.at.most(nonceBefore + 1);
    expect((await ctx.journal.read())?.liquidity).to.equal(undefined);
  });

  it("le PoolSeeder refuse les montants nuls et n'accepte pas d'ETH hors dépôt", async function () {
    const { deployer, token, seeder } = await deployed();
    const contract = await ethers.getContractAt(SEEDER_CONTRACT, seeder.address, deployer);
    await expect(contract.seed(token.address, 0n, 0n, { value: 1n })).to.be.revertedWithCustomError(contract, "ZeroAmount");
    await expect(contract.seed(token.address, 1n, 0n)).to.be.revertedWithCustomError(contract, "ZeroAmount");
    await expect(deployer.sendTransaction({ to: seeder.address, value: 1n })).to.revert(ethers);
  });

  it("refuse un reçu qui ne contient pas d'ouverture de pool", async function () {
    const { deployer, token, seeder } = await deployed();
    const receipt = await (await new Contract(token.address, ERC20_ABI, deployer).approve(seeder.address, 1n)).wait();
    if (receipt === null) throw new Error("reçu manquant");
    expect(() => readSeedReceipt(receipt, seeder.address, token.address)).to.throw(LaunchError, /PoolSeeded/);
  });

  it("réutilise le PoolSeeder déjà déployé", async function () {
    const { ctx, wallet, uniswap, seeder } = await deployed();
    const nonce = await ethers.provider.getTransactionCount(wallet.address);
    const again = await deploySeederStep(ctx, uniswap);
    expect(again.address).to.equal(seeder.address);
    expect(await ethers.provider.getTransactionCount(wallet.address)).to.equal(nonce);
  });

  it("répétition complète : un acheteur achète puis revend au montant exact prévu", async function () {
    const { uniswap } = await networkHelpers.loadFixture(setupFixture);
    const report = await runRehearsal(connection, uniswap, {
      token: TOKEN,
      liquidity: { ethAmountWei: POOL_ETH, tokenPercent: 100n },
    });
    expect(report.liquidity.status).to.equal("confirmed");
    expect(report.roundTrip.tokensBought).to.be.greaterThan(0n);
    expect(report.roundTrip.ethBack).to.be.greaterThan(0n);
    expect(report.roundTrip.ethBack).to.be.lessThan(report.roundTrip.ethIn);
  });
});

describe("Reprise après interruption : jamais de double envoi", function () {
  async function deployPayload(params: TokenParams = TOKEN): Promise<TxPayload> {
    const factory = await ethers.getContractFactory(TOKEN_CONTRACT);
    return { data: (await factory.getDeployTransaction(...constructorArgs(params))).data };
  }

  /** Simule un arrêt juste après la signature : la transaction est notée, pas forcément diffusée. */
  async function signedTokenEntry(ctx: StepContext): Promise<TokenRecord> {
    const nonce = await nextNonce(ethers.provider, ctx.wallet.address);
    const signed = await signTx(ethers.provider, ctx.wallet, chainId, await deployPayload(), nonce);
    const entry: TokenRecord = {
      status: "pending",
      from: ctx.wallet.address,
      nonce,
      txHash: signed.hash,
      rawTx: signed.raw,
      preparedAt: new Date().toISOString(),
      address: getCreateAddress({ from: ctx.wallet.address, nonce }),
      name: TOKEN.name,
      symbol: TOKEN.symbol,
      supplyWholeTokens: TOKEN.supply.toString(),
    };
    await ctx.journal.write({ network: "test", chainId: chainId.toString(), token: entry });
    return entry;
  }

  it("signée et notée mais jamais diffusée : diffuse exactement la même transaction", async function () {
    const { wallet } = await networkHelpers.loadFixture(setupFixture);
    const ctx = contextFor(connection, wallet);
    const entry = await signedTokenEntry(ctx);

    const token = await deployTokenStep(ctx, TOKEN);
    expect(token.status).to.equal("confirmed");
    expect(token.txHash).to.equal(entry.txHash);
    expect(token.address).to.equal(entry.address);
    expect(await ethers.provider.getTransactionCount(wallet.address)).to.equal(entry.nonce + 1);
  });

  it("diffusée mais réponse perdue : retrouve le reçu par son hash, sans rediffuser", async function () {
    const { wallet } = await networkHelpers.loadFixture(setupFixture);
    const ctx = contextFor(connection, wallet);
    const entry = await signedTokenEntry(ctx);
    await broadcastRaw(ethers.provider, entry.rawTx);

    const token = await deployTokenStep(ctx, TOKEN);
    expect(token.status).to.equal("confirmed");
    expect(token.blockNumber).to.be.a("number");
    expect(await ethers.provider.getTransactionCount(wallet.address)).to.equal(entry.nonce + 1);
  });

  it("encore en attente sur le réseau : s'arrête sans rien changer, puis confirme", async function () {
    const { wallet } = await networkHelpers.loadFixture(setupFixture);
    const ctx = contextFor(connection, wallet);
    const entry = await signedTokenEntry(ctx);

    await ethers.provider.send("evm_setAutomine", [false]);
    try {
      await broadcastRaw(ethers.provider, entry.rawTx);
      await expectLaunchError(deployTokenStep(ctx, TOKEN), /Pas de reçu/);
      expect((await ctx.journal.read())?.token?.status).to.equal("pending");
    } finally {
      await ethers.provider.send("evm_setAutomine", [true]);
    }
    await networkHelpers.mine();

    const token = await deployTokenStep(ctx, TOKEN);
    expect(token.status).to.equal("confirmed");
    expect(await ethers.provider.getTransactionCount(wallet.address)).to.equal(entry.nonce + 1);
  });

  it("nonce pris par une autre transaction : s'arrête sans rien effacer ni renvoyer", async function () {
    const { wallet, buyer } = await networkHelpers.loadFixture(setupFixture);
    const ctx = contextFor(connection, wallet);
    const entry = await signedTokenEntry(ctx);
    const other = await signTx(ethers.provider, wallet, chainId, { to: buyer.address, data: "0x", value: 1n }, entry.nonce);
    await broadcastRaw(ethers.provider, other.raw);

    await expectLaunchError(deployTokenStep(ctx, TOKEN), /déjà utilisé/);
    expect((await ctx.journal.read())?.token?.txHash).to.equal(entry.txHash);
    expect(await ethers.provider.getCode(entry.address)).to.equal("0x");
  });

  it("frais devenus trop bas : re-signe avec le même nonce, un seul contrat", async function () {
    const { wallet } = await networkHelpers.loadFixture(setupFixture);
    const ctx = contextFor(connection, wallet);
    const entry = await signedTokenEntry(ctx);
    await networkHelpers.setNextBlockBaseFeePerGas(parseUnits("1000", "gwei"));
    await networkHelpers.mine();

    const token = await deployTokenStep(ctx, TOKEN);
    expect(token.status).to.equal("confirmed");
    expect(token.txHash).to.not.equal(entry.txHash);
    expect(token.replacedTxHashes).to.deep.equal([entry.txHash]);
    expect(token.address).to.equal(entry.address);
    expect(await ethers.provider.getTransactionCount(wallet.address)).to.equal(entry.nonce + 1);
  });

  it("version précédente minée après une re-signature : le journal garde le hash réellement miné", async function () {
    const { wallet } = await networkHelpers.loadFixture(setupFixture);
    const ctx = contextFor(connection, wallet);
    const mined = await signedTokenEntry(ctx);
    await broadcastRaw(ethers.provider, mined.rawTx);
    // Une version re-signée (même nonce) notée comme courante, mais jamais diffusée.
    await networkHelpers.setNextBlockBaseFeePerGas(parseUnits("5", "gwei"));
    await networkHelpers.mine();
    const other = await signTx(ethers.provider, wallet, chainId, await deployPayload(), mined.nonce);
    expect(other.hash).to.not.equal(mined.txHash);
    await ctx.journal.write({
      network: "test",
      chainId: chainId.toString(),
      token: { ...mined, txHash: other.hash, rawTx: other.raw, replacedTxHashes: [mined.txHash] },
    });

    const token = await deployTokenStep(ctx, TOKEN);
    expect(token.status).to.equal("confirmed");
    expect(token.txHash).to.equal(mined.txHash);
  });

  async function signedSeedEntry(ctx: StepContext, token: TokenRecord, seeder: string, amounts: SeedAmounts): Promise<LiquidityRecord> {
    await (await new Contract(token.address, ERC20_ABI, await ethers.getSigner(ctx.wallet.address)).approve(seeder, amounts.tokenAmount)).wait();
    const payload: TxPayload = {
      to: seeder,
      data: seederInterface.encodeFunctionData("seed", [token.address, amounts.tokenAmount, amounts.maxPairWeth]),
      value: amounts.ethAmount,
    };
    const nonce = await nextNonce(ethers.provider, ctx.wallet.address);
    const signed = await signTx(ethers.provider, ctx.wallet, chainId, payload, nonce);
    const entry: LiquidityRecord = {
      status: "pending",
      from: ctx.wallet.address,
      nonce,
      txHash: signed.hash,
      rawTx: signed.raw,
      preparedAt: new Date().toISOString(),
      seeder,
      tokenAmount: amounts.tokenAmount.toString(),
      ethAmountWei: amounts.ethAmount.toString(),
      maxPairWeth: amounts.maxPairWeth.toString(),
      lpRecipient: DEAD_ADDRESS,
    };
    const record = await ctx.journal.read();
    await ctx.journal.write({ ...record!, liquidity: entry });
    return entry;
  }

  it("ouverture du pool diffusée mais réponse perdue : la retrouve par son hash, sans rouvrir", async function () {
    const { ctx, wallet, token, seeder } = await deployed();
    const amounts = await amountsFor(token.address, wallet.address);
    const entry = await signedSeedEntry(ctx, token, seeder.address, amounts);
    await broadcastRaw(ethers.provider, entry.rawTx);

    const { record } = await seedStep(ctx, token, seeder, amounts);
    expect(record.status).to.equal("confirmed");
    expect(record.txHash).to.equal(entry.txHash);
    expect(await ethers.provider.getTransactionCount(wallet.address)).to.equal(entry.nonce + 1);
  });

  it("ouverture du pool notée mais jamais diffusée : la diffuse une seule fois", async function () {
    const { ctx, wallet, token, seeder } = await deployed();
    const amounts = await amountsFor(token.address, wallet.address);
    const entry = await signedSeedEntry(ctx, token, seeder.address, amounts);

    const { record, outcome } = await seedStep(ctx, token, seeder, amounts);
    expect(record.txHash).to.equal(entry.txHash);
    expect(outcome.tokenAmount).to.equal(amounts.tokenAmount);
    await expectLaunchError(seedStep(ctx, token, seeder, amounts), /déjà ouvert/);
  });

  it("réponse perdue à la diffusion alors que la transaction est arrivée : la suit sans re-signer", async function () {
    const { wallet } = await networkHelpers.loadFixture(setupFixture);
    const ctx = flakyBroadcastContext(contextFor(connection, wallet), true);
    const token = await deployTokenStep(ctx, TOKEN);
    expect(token.status).to.equal("confirmed");
    expect(token.replacedTxHashes).to.equal(undefined);
    expect(await ethers.provider.getTransactionCount(wallet.address)).to.equal(token.nonce + 1);
  });

  it("RPC muet à la diffusion (rien n'est arrivé) : s'arrête, puis la relance diffuse la même transaction", async function () {
    const { wallet } = await networkHelpers.loadFixture(setupFixture);
    const journal = memoryJournal();
    await expectLaunchError(
      deployTokenStep(flakyBroadcastContext(contextFor(connection, wallet, journal), false), TOKEN),
      /impossible pour l'instant/,
    );
    const pending = (await journal.read())?.token;
    expect(pending?.status).to.equal("pending");
    expect(await ethers.provider.getTransactionCount(wallet.address)).to.equal(pending?.nonce);

    const token = await deployTokenStep(contextFor(connection, wallet, journal), TOKEN);
    expect(token.txHash).to.equal(pending?.txHash);
    expect(token.status).to.equal("confirmed");
  });

  it("RPC en retard sur le nonce : l'autorisation et l'ouverture prennent quand même les bons nonces", async function () {
    const { ctx, wallet, token, seeder } = await deployed();
    const stale = staleNonceContext(ctx);
    expect(await stale.ethers.provider.getTransactionCount(wallet.address)).to.equal(0);

    const { record } = await seedStep(stale, token, seeder, await amountsFor(token.address, wallet.address));
    expect(record.status).to.equal("confirmed");
    expect(record.nonce).to.equal(seeder.nonce + 2); // autorisation au nonce du PoolSeeder + 1, ouverture au suivant
    expect(await ethers.provider.getTransactionCount(wallet.address)).to.equal(record.nonce + 1);
  });

  it("autorisation minée mais encore invisible (RPC en retard) : son nonce est retenu, la relance n'en réutilise aucun", async function () {
    const { ctx, wallet, token, seeder } = await deployed();
    const amounts = await amountsFor(token.address, wallet.address, POOL_ETH / 100n);
    const real = ethers.provider;
    const allowanceSelector = new Interface(ERC20_ABI).getFunction("allowance")!.selector;

    // Exécution 1 : le nœud qui répond aux lectures de contrat est en retard (autorisation lue à 0).
    const staleReads = withOverrides(real, {
      call: async (tx: { data?: string }) =>
        typeof tx.data === "string" && tx.data.startsWith(allowanceSelector) ? `0x${"0".repeat(64)}` : await real.call(tx as never),
    });
    await expectLaunchError(
      seedStep({ ...ctx, ethers: withOverrides(ethers, { provider: staleReads }) }, token, seeder, amounts),
      /minée mais le RPC ne la voit pas/,
    );
    const afterRun1 = await ctx.journal.read();
    expect(afterRun1?.approval?.status).to.equal("confirmed");
    expect(afterRun1?.nonceFloor).to.equal(seeder.nonce + 2);

    // Exécution 2 : lectures à jour, mais nombre de transactions en retard d'une.
    const laggingCount = withOverrides(real, {
      getTransactionCount: async (address: string, tag?: string) => (await real.getTransactionCount(address, tag)) - 1,
    });
    const { record } = await seedStep({ ...ctx, ethers: withOverrides(ethers, { provider: laggingCount }) }, token, seeder, amounts);
    expect(record.status).to.equal("confirmed");
    expect(record.nonce).to.equal(seeder.nonce + 2);
  });

  it("autorisation signée et notée mais jamais diffusée : la même est diffusée, puis le pool s'ouvre", async function () {
    const { ctx, wallet, token, seeder } = await deployed();
    const amounts = await amountsFor(token.address, wallet.address, POOL_ETH / 100n);
    const nonce = await nextNonce(ethers.provider, wallet.address);
    const payload: TxPayload = {
      to: token.address,
      data: new Interface(ERC20_ABI).encodeFunctionData("approve", [seeder.address, amounts.tokenAmount]),
    };
    const signed = await signTx(ethers.provider, wallet, chainId, payload, nonce);
    const record = await ctx.journal.read();
    await ctx.journal.write({
      ...record!,
      approval: {
        status: "pending",
        from: wallet.address,
        nonce,
        txHash: signed.hash,
        rawTx: signed.raw,
        preparedAt: new Date().toISOString(),
        token: token.address,
        spender: seeder.address,
        amount: amounts.tokenAmount.toString(),
      },
    });

    const { record: liquidity } = await seedStep(ctx, token, seeder, amounts);
    const journal = await ctx.journal.read();
    expect(journal?.approval?.txHash).to.equal(signed.hash);
    expect(journal?.approval?.status).to.equal("confirmed");
    expect(liquidity.nonce).to.equal(nonce + 1);
    expect(await ethers.provider.getTransactionCount(wallet.address)).to.equal(nonce + 2);
  });

  it("solde insuffisant au moment de diffuser : s'arrête sans re-signer, puis diffuse la même transaction", async function () {
    const { wallet } = await networkHelpers.loadFixture(setupFixture);
    const ctx = contextFor(connection, wallet);
    const entry = await signedTokenEntry(ctx);
    const funds = await ethers.provider.getBalance(wallet.address);
    await networkHelpers.setBalance(wallet.address, 1n);

    await expectLaunchError(deployTokenStep(ctx, TOKEN), /Solde ETH insuffisant/);
    const kept = (await ctx.journal.read())?.token;
    expect(kept?.txHash).to.equal(entry.txHash);
    expect(kept?.replacedTxHashes).to.equal(undefined);

    await networkHelpers.setBalance(wallet.address, funds);
    const token = await deployTokenStep(ctx, TOKEN);
    expect(token.txHash).to.equal(entry.txHash);
    expect(token.status).to.equal("confirmed");
  });
});

describe("Blocage de ta part (vesting), avant l'ouverture du pool", function () {
  const DAY = 86_400n;
  const KEPT = (SUPPLY * 5n) / 100n;

  /** Token et PoolSeeder déployés, rien d'autre : c'est le moment de bloquer ta part. */
  async function readyToLock() {
    const fixture = await deployed();
    const plan: VestingPlan = {
      token: fixture.token.address,
      beneficiary: fixture.wallet.address,
      start: BigInt(await networkHelpers.time.latest()),
      durationSeconds: 365n * DAY,
      cliffSeconds: 90n * DAY,
    };
    return { ...fixture, plan };
  }

  it("bloque ta part avant l'ouverture ; le pool reçoit ensuite tout le reste", async function () {
    const { ctx, wallet, uniswap, token, seeder, plan } = await readyToLock();
    expect(shareToLock(SUPPLY, 95n)).to.equal(KEPT);
    const vesting = await deployVestingStep(ctx, plan);
    const lock = await lockStep(ctx, vesting, KEPT);

    expect(lock.status).to.equal("confirmed");
    expect(await balanceOf(token.address, vesting.address)).to.equal(KEPT);
    expect(await balanceOf(token.address, wallet.address)).to.equal(SUPPLY - KEPT);
    const status = await readVestingStatus(ethers.provider, vesting.address, token.address);
    expect(status.beneficiary).to.equal(wallet.address);
    expect(status.releasable).to.equal(0n);
    expect(status.cliff).to.equal(plan.start + plan.cliffSeconds);
    expect(status.end).to.equal(plan.start + plan.durationSeconds);

    // Part bloquée : le pool prend 100 % de ce qui reste, quel que soit tokenPercent.
    const share = poolShare({ tokenPercent: 95n, vestingEnabled: true, lockConfirmed: true, lockCommand: "—" });
    expect(share).to.deep.equal({ poolPercent: 100n, mode: "locked" });
    const { outcome } = await seedStep(ctx, token, seeder, await amountsFor(token.address, wallet.address, 0n, share.poolPercent));
    expect(outcome.tokenAmount).to.equal(SUPPLY - KEPT);
    expect(await balanceOf(token.address, wallet.address)).to.equal(0n);
    expect(await balanceOf(token.address, vesting.address)).to.equal(KEPT);
    const pool = await readPoolStatus(ethers.provider, uniswap, token.address, wallet.address);
    expect(pool?.tokenReserve).to.equal(SUPPLY - KEPT);

    const journal = await ctx.journal.read();
    expect(journal?.vesting?.status).to.equal("confirmed");
    expect(journal?.lock?.status).to.equal("confirmed");
    expect(journal?.liquidity?.status).to.equal("confirmed");
    await expectLaunchError(lockStep(ctx, vesting, KEPT), /déjà bloquée/);
  });

  it("bloquée avant l'ouverture, ta part ne peut servir à personne : rien n'en sort avant la falaise", async function () {
    const { ctx, wallet, buyer, uniswap, token, seeder, plan } = await readyToLock();
    const vesting = await deployVestingStep(ctx, plan);
    await lockStep(ctx, vesting, KEPT);
    // Un inconnu déclenche le versement avant la falaise : rien ne bouge.
    await (await new Contract(vesting.address, VESTING_ABI, buyer).release(token.address)).wait();
    expect(await balanceOf(token.address, vesting.address)).to.equal(KEPT);
    expect(await balanceOf(token.address, buyer.address)).to.equal(0n);
    // Aucune part LP n'a pu être créée entre-temps : l'ouverture se fait normalement.
    const preview = await previewPair(ethers.provider, uniswap, token.address);
    expect(preview.lpTotalSupply).to.equal(0n);
    const { outcome } = await seedStep(ctx, token, seeder, await amountsFor(token.address, wallet.address, 0n, 100n));
    expect(outcome.lpBurned).to.be.greaterThan(0n);
  });

  it("se libère selon le calendrier, toujours au bénéficiaire, même déclenché par un inconnu", async function () {
    const { ctx, wallet, buyer, token, plan } = await readyToLock();
    const vesting = await deployVestingStep(ctx, plan);
    await lockStep(ctx, vesting, KEPT);
    const asStranger = new Contract(vesting.address, VESTING_ABI, buyer);
    const before = await balanceOf(token.address, wallet.address);

    await networkHelpers.time.increaseTo(plan.start + plan.cliffSeconds - 10n);
    await (await asStranger.release(token.address)).wait();
    expect(await balanceOf(token.address, wallet.address)).to.equal(before);

    await networkHelpers.time.increaseTo(plan.start + plan.cliffSeconds);
    await (await asStranger.release(token.address)).wait();
    const atCliff = (await balanceOf(token.address, wallet.address)) - before;
    expect(atCliff).to.be.greaterThanOrEqual((KEPT * plan.cliffSeconds) / plan.durationSeconds);
    expect(atCliff).to.be.lessThan(KEPT / 3n);
    expect(await balanceOf(token.address, buyer.address)).to.equal(0n);

    await networkHelpers.time.increaseTo(plan.start + plan.durationSeconds);
    await (await asStranger.release(token.address)).wait();
    expect((await balanceOf(token.address, wallet.address)) - before).to.equal(KEPT);
    expect(await balanceOf(token.address, vesting.address)).to.equal(0n);
  });

  it("falaise passée avant l'ouverture : le pool reçoit exactement l'offre moins ta part", async function () {
    const { ctx, wallet, buyer, token, seeder, plan } = await readyToLock();
    const vesting = await deployVestingStep(ctx, { ...plan, cliffSeconds: DAY });
    const lock = await lockStep(ctx, vesting, KEPT);
    await networkHelpers.time.increase(30n * DAY);
    await (await new Contract(vesting.address, VESTING_ABI, buyer).release(token.address)).wait();
    const released = (await balanceOf(token.address, wallet.address)) - (SUPPLY - KEPT);
    expect(released).to.be.greaterThan(0n);

    const share = poolShare({ tokenPercent: 95n, vestingEnabled: true, lockConfirmed: true, lockCommand: "—" });
    const poolBase = poolBaseAmount({
      mode: share.mode,
      totalSupply: SUPPLY,
      lockedAmount: BigInt(lock.amount),
      balance: await balanceOf(token.address, wallet.address),
    });
    const plan100 = buildLiquidityPlan({ deployerTokenBalance: poolBase, tokenTotalSupply: SUPPLY, tokenPercent: 100n, ethAmount: POOL_ETH });
    const { outcome } = await seedStep(ctx, token, seeder, { ...plan100, maxPairWeth: 0n });
    expect(outcome.tokenAmount).to.equal(SUPPLY - KEPT);
    // Les tokens déjà libérés restent dans ton wallet, hors du pool.
    expect(await balanceOf(token.address, wallet.address)).to.equal(released);
  });

  it("le bénéficiaire peut transmettre son rôle : le contrat noté reste reconnu", async function () {
    const { ctx, deployer, buyer, plan } = await readyToLock();
    const vesting = await deployVestingStep(ctx, plan);
    const asBeneficiary = await ethers.getContractAt(VESTING_CONTRACT, vesting.address, deployer);
    await (await asBeneficiary.transferOwnership(buyer.address)).wait();
    const again = await deployVestingStep(ctx, plan);
    expect(again.address).to.equal(vesting.address);
    const lock = await lockStep(ctx, again, KEPT);
    expect(lock.status).to.equal("confirmed");
  });

  it("personne ne peut retirer plus tôt ni faire perdre la part", async function () {
    const { ctx, deployer, buyer, plan } = await readyToLock();
    const vesting = await deployVestingStep(ctx, plan);
    await lockStep(ctx, vesting, KEPT);
    const asBeneficiary = await ethers.getContractAt(VESTING_CONTRACT, vesting.address, deployer);
    await expect(asBeneficiary.renounceOwnership()).to.be.revertedWithCustomError(asBeneficiary, "RenounceDisabled");
    const asStranger = await ethers.getContractAt(VESTING_CONTRACT, vesting.address, buyer);
    await expect(asStranger.transferOwnership(buyer.address)).to.be.revertedWithCustomError(
      asStranger,
      "OwnableUnauthorizedAccount",
    );
  });

  it("contrat de blocage signé et noté mais jamais diffusé : le même est diffusé, une seule fois", async function () {
    const { ctx, wallet, plan } = await readyToLock();
    const factory = await ethers.getContractFactory(VESTING_CONTRACT);
    const fields = {
      token: plan.token,
      beneficiary: plan.beneficiary,
      start: plan.start.toString(),
      durationSeconds: plan.durationSeconds.toString(),
      cliffSeconds: plan.cliffSeconds.toString(),
    };
    const payload: TxPayload = { data: (await factory.getDeployTransaction(...vestingConstructorArgs(fields))).data };
    const nonce = await nextNonce(ethers.provider, wallet.address);
    const signed = await signTx(ethers.provider, wallet, chainId, payload, nonce);
    const record = await ctx.journal.read();
    await ctx.journal.write({
      ...record!,
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
    const vesting = await deployVestingStep(ctx, { ...plan, durationSeconds: 10n * DAY, cliffSeconds: 0n });
    expect(vesting.txHash).to.equal(signed.hash);
    expect(vesting.durationSeconds).to.equal(plan.durationSeconds.toString());
    expect(await ethers.provider.getTransactionCount(wallet.address)).to.equal(nonce + 1);
  });

  it("blocage diffusé mais réponse perdue : retrouvé par son hash, sans second transfert", async function () {
    const { ctx, wallet, token, plan } = await readyToLock();
    const vesting = await deployVestingStep(ctx, plan);
    const lock = await lockStep(flakyBroadcastContext(ctx, true), vesting, KEPT);
    expect(lock.status).to.equal("confirmed");
    expect(lock.replacedTxHashes).to.equal(undefined);
    expect(await balanceOf(token.address, vesting.address)).to.equal(KEPT);
    expect(await ethers.provider.getTransactionCount(wallet.address)).to.equal(lock.nonce + 1);
  });

  it("RPC muet au moment du blocage : s'arrête, puis la relance diffuse le même transfert", async function () {
    const { ctx, token, plan } = await readyToLock();
    const vesting = await deployVestingStep(ctx, plan);
    await expectLaunchError(lockStep(flakyBroadcastContext(ctx, false), vesting, KEPT), /impossible pour l'instant/);
    const pending = (await ctx.journal.read())?.lock;
    expect(pending?.status).to.equal("pending");

    const lock = await lockStep(ctx, vesting, 1n); // le montant passé est ignoré : la reprise suit le journal
    expect(lock.txHash).to.equal(pending?.txHash);
    expect(await balanceOf(token.address, vesting.address)).to.equal(KEPT);
  });

  it("répétition avec une falaise égale à la durée : le temps n'avance jamais à rebours", async function () {
    const { uniswap, wallet } = await networkHelpers.loadFixture(setupFixture);
    const report = await runRehearsal(connection, uniswap, {
      token: TOKEN,
      liquidity: { ethAmountWei: POOL_ETH, tokenPercent: 95n },
      vesting: { enabled: true, durationSeconds: 30n * DAY, cliffSeconds: 30n * DAY, beneficiary: wallet.address },
    });
    expect(report.vesting?.releasedAtCliff).to.equal(KEPT);
    expect(report.vesting?.releasedAtEnd).to.equal(KEPT);
  });

  it("répétition complète : part bloquée avant l'ouverture, pool avec le reste, libération entière à la fin", async function () {
    const { uniswap, wallet } = await networkHelpers.loadFixture(setupFixture);
    const report = await runRehearsal(connection, uniswap, {
      token: TOKEN,
      liquidity: { ethAmountWei: POOL_ETH, tokenPercent: 95n },
      vesting: { enabled: true, durationSeconds: 365n * DAY, cliffSeconds: 90n * DAY, beneficiary: wallet.address },
    });
    expect(report.vesting?.locked).to.equal(KEPT);
    expect(report.pool.tokenReserve).to.equal(SUPPLY - KEPT);
    expect(report.outcome.tokenAmount).to.equal(SUPPLY - KEPT);
    // Le blocage est noté avant l'ouverture du pool : son nonce précède celui du pool.
    expect(report.vesting?.lock.nonce).to.be.lessThan(report.liquidity.nonce);
    expect(report.vesting?.releasedAtCliff).to.be.greaterThan(0n);
    expect(report.vesting?.releasedAtEnd).to.equal(KEPT);
  });
});

describe("Réserve communauté, envoyée avant l'ouverture du pool", function () {
  const DAY = 86_400n;
  const TEAM = (SUPPLY * 10n) / 100n;
  const RESERVE = (SUPPLY * 3n) / 100n;
  const POOL = SUPPLY - TEAM - RESERVE;

  /** Token et PoolSeeder déployés, ta part bloquée : il reste à envoyer la réserve. */
  async function readyForReserve() {
    const fixture = await deployed();
    const recipient = (await ethers.getSigners())[5].address;
    const vesting = await deployVestingStep(fixture.ctx, {
      token: fixture.token.address,
      beneficiary: fixture.wallet.address,
      start: BigInt(await networkHelpers.time.latest()),
      durationSeconds: 900n * DAY,
      cliffSeconds: 90n * DAY,
    });
    const lock = await lockStep(fixture.ctx, vesting, shareToLock(SUPPLY, 87n, 3n));
    return { ...fixture, recipient, vesting, lock };
  }

  it("équipe bloquée, réserve envoyée, pool avec exactement le reste : montants lus dans les reçus", async function () {
    const { ctx, wallet, uniswap, token, seeder, recipient, vesting, lock } = await readyForReserve();
    expect(BigInt(lock.amount)).to.equal(TEAM);
    expect(communityShare(SUPPLY, 3n)).to.equal(RESERVE);

    const community = await communityStep(ctx, { token: token.address, recipient, amount: RESERVE });
    expect(community.status).to.equal("confirmed");
    expect(community.recipient).to.equal(recipient);
    expect(community.nonce).to.be.greaterThan(lock.nonce);
    expect(await balanceOf(token.address, recipient)).to.equal(RESERVE);
    expect(await balanceOf(token.address, vesting.address)).to.equal(TEAM);
    expect(await balanceOf(token.address, wallet.address)).to.equal(POOL);

    const share = poolShare({
      tokenPercent: 87n,
      vestingEnabled: true,
      lockConfirmed: true,
      lockCommand: "—",
      communityPercent: 3n,
      communityConfirmed: true,
    });
    expect(share).to.deep.equal({ poolPercent: 100n, mode: "locked" });
    const base = poolBaseAmount({
      mode: share.mode,
      totalSupply: SUPPLY,
      lockedAmount: TEAM,
      balance: await balanceOf(token.address, wallet.address),
      communityAmount: RESERVE,
    });
    expect(base).to.equal(POOL);
    const { outcome } = await seedStep(ctx, token, seeder, await amountsFor(token.address, wallet.address, 0n, share.poolPercent));
    expect(outcome.tokenAmount).to.equal(POOL);
    const pool = await readPoolStatus(ethers.provider, uniswap, token.address, wallet.address);
    expect(pool?.tokenReserve).to.equal(POOL);
    expect(await balanceOf(token.address, recipient)).to.equal(RESERVE);

    const journal = await ctx.journal.read();
    expect(journal?.community?.status).to.equal("confirmed");
    expect(journal?.liquidity?.nonce).to.be.greaterThan(community.nonce);
    await expectLaunchError(communityStep(ctx, { token: token.address, recipient, amount: RESERVE }), /déjà envoyée/);
  });

  it("refuse d'ouvrir le pool tant que la réserve n'est pas envoyée, et les configurations incohérentes", async function () {
    const base = { vestingEnabled: true, lockCommand: "npm run lock:mainnet", communityPercent: 3n };
    expect(() => poolShare({ ...base, tokenPercent: 87n, lockConfirmed: true, communityConfirmed: false })).to.throw(
      LaunchError,
      /réserve communauté/,
    );
    // Rien de bloqué ni d'envoyé : c'est le blocage qui est demandé en premier (même commande).
    expect(() => poolShare({ ...base, tokenPercent: 87n, lockConfirmed: false, communityConfirmed: false })).to.throw(
      LaunchError,
      /Bloque d'abord ta part/,
    );
    // Pas de part gardée (97 + 3 = 100) : seule la réserve compte, puis tout le reste va au pool.
    expect(() => poolShare({ ...base, vestingEnabled: false, tokenPercent: 97n, lockConfirmed: false })).to.throw(
      LaunchError,
      /réserve communauté/,
    );
    expect(
      poolShare({ ...base, vestingEnabled: false, tokenPercent: 97n, lockConfirmed: false, communityConfirmed: true }),
    ).to.deep.equal({ poolPercent: 100n, mode: "none" });
    // Part gardée sans blocage + réserve : tokenPercent s'appliquerait au mauvais solde, refus.
    expect(() =>
      poolShare({ ...base, vestingEnabled: false, tokenPercent: 87n, lockConfirmed: false, communityConfirmed: true }),
    ).to.throw(LaunchError, /vesting.enabled: true/);
  });

  it("réserve diffusée mais réponse perdue : retrouvée par son hash, sans second transfert", async function () {
    const { ctx, wallet, token, recipient } = await readyForReserve();
    const community = await communityStep(flakyBroadcastContext(ctx, true), { token: token.address, recipient, amount: RESERVE });
    expect(community.status).to.equal("confirmed");
    expect(community.replacedTxHashes).to.equal(undefined);
    expect(await balanceOf(token.address, recipient)).to.equal(RESERVE);
    expect(await ethers.provider.getTransactionCount(wallet.address)).to.equal(community.nonce + 1);
  });

  it("RPC muet au moment de l'envoi : s'arrête, puis la relance diffuse le même transfert", async function () {
    const { ctx, token, recipient } = await readyForReserve();
    await expectLaunchError(
      communityStep(flakyBroadcastContext(ctx, false), { token: token.address, recipient, amount: RESERVE }),
      /impossible pour l'instant/,
    );
    const pending = (await ctx.journal.read())?.community;
    expect(pending?.status).to.equal("pending");

    // Le montant et le destinataire passés sont ignorés : la reprise suit le journal.
    const community = await communityStep(ctx, { token: token.address, recipient: token.address, amount: 1n });
    expect(community.txHash).to.equal(pending?.txHash);
    expect(await balanceOf(token.address, recipient)).to.equal(RESERVE);
  });

  it("un envoi de la réserve miné en échec remet le journal à l'étape précédente, nonce compté", async function () {
    const lenient = await network.create({ override: { throwOnTransactionFailures: false, throwOnCallFailures: false } });
    const lethers = lenient.ethers;
    const wallet = await localWallet(lenient);
    const ctx = contextFor(lenient, wallet);
    const token = await deployTokenStep(ctx, TOKEN);
    const recipient = (await lethers.getSigners())[5].address;

    // Envoi de plus que le solde : signé avec une limite de gas fixe (l'estimation échouerait), puis miné en échec.
    const tooMuch = SUPPLY + 1n;
    const payload: TxPayload = {
      to: token.address,
      data: new Interface(ERC20_ABI).encodeFunctionData("transfer", [recipient, tooMuch]),
    };
    const nonce = await nextNonce(lethers.provider, wallet.address);
    const signed = await signTx(lethers.provider, wallet, chainId, payload, nonce, 100_000n);
    const record = await ctx.journal.read();
    await ctx.journal.write({
      ...record!,
      community: {
        status: "pending",
        from: wallet.address,
        nonce,
        txHash: signed.hash,
        rawTx: signed.raw,
        preparedAt: new Date().toISOString(),
        token: token.address,
        recipient,
        amount: tooMuch.toString(),
      },
    });

    await expectLaunchError(communityStep(ctx, { token: token.address, recipient, amount: 0n }), /a échoué/);
    const after = await ctx.journal.read();
    expect(after?.community).to.equal(undefined);
    expect(after?.token?.status).to.equal("confirmed");
    expect(after?.nonceFloor).to.equal(nonce + 1);
    expect(await balanceOf(token.address, wallet.address, lenient)).to.equal(SUPPLY);
    expect(await balanceOf(token.address, recipient, lenient)).to.equal(0n);
  });

  it("répétition complète : part bloquée, réserve envoyée, pool avec le reste, dans cet ordre", async function () {
    const { uniswap, wallet } = await networkHelpers.loadFixture(setupFixture);
    const recipient = (await ethers.getSigners())[5].address;
    const report = await runRehearsal(connection, uniswap, {
      token: TOKEN,
      liquidity: { ethAmountWei: POOL_ETH, tokenPercent: 87n },
      vesting: { enabled: true, durationSeconds: 900n * DAY, cliffSeconds: 90n * DAY, beneficiary: wallet.address },
      community: { percent: 3n, beneficiary: recipient },
    });
    expect(report.vesting?.locked).to.equal(TEAM);
    expect(BigInt(report.community?.amount ?? "0")).to.equal(RESERVE);
    expect(report.outcome.tokenAmount).to.equal(POOL);
    expect(report.pool.tokenReserve).to.equal(POOL);
    expect(await balanceOf(report.token.address, recipient)).to.equal(RESERVE);
    expect(report.vesting?.lock.nonce).to.be.lessThan(report.community?.nonce ?? 0);
    expect(report.community?.nonce).to.be.lessThan(report.liquidity.nonce);
    expect(report.vesting?.releasedAtEnd).to.equal(TEAM);
  });
});

describe("Échecs définitifs : seul le reçu de NOTRE transaction autorise à revenir en arrière", function () {
  it("une ouverture de pool minée en échec remet le journal à l'étape précédente", async function () {
    // Réseau où, comme sur une vraie chaîne, une transaction qui échoue est minée au lieu d'être refusée.
    const lenient = await network.create({ override: { throwOnTransactionFailures: false, throwOnCallFailures: false } });
    const lethers = lenient.ethers;
    const [, , attacker, operator] = await lethers.getSigners();
    const uniswap = await deployLocalUniswapV2(lethers, operator);
    const wallet = await localWallet(lenient);
    const ctx = contextFor(lenient, wallet);
    const token = await deployTokenStep(ctx, TOKEN);
    const seeder = await deploySeederStep(ctx, uniswap);

    const amounts: SeedAmounts = { tokenAmount: SUPPLY, ethAmount: POOL_ETH, maxPairWeth: 0n };
    await (await new Contract(token.address, ERC20_ABI, await lethers.getSigner(wallet.address)).approve(seeder.address, SUPPLY)).wait();
    const payload: TxPayload = {
      to: seeder.address,
      data: seederInterface.encodeFunctionData("seed", [token.address, SUPPLY, 0n]),
      value: POOL_ETH,
    };
    const nonce = await nextNonce(lethers.provider, wallet.address);
    const signed = await signTx(lethers.provider, wallet, chainId, payload, nonce);
    const record = await ctx.journal.read();
    await ctx.journal.write({
      ...record!,
      liquidity: {
        status: "pending",
        from: wallet.address,
        nonce,
        txHash: signed.hash,
        rawTx: signed.raw,
        preparedAt: new Date().toISOString(),
        seeder: seeder.address,
        tokenAmount: SUPPLY.toString(),
        ethAmountWei: POOL_ETH.toString(),
        maxPairWeth: "0",
        lpRecipient: DEAD_ADDRESS,
      },
    });
    // Un don arrive entre la signature et la diffusion : la transaction échouera sur la chaîne.
    await griefPair(uniswap, token.address, attacker, false);

    await expectLaunchError(seedStep(ctx, token, seeder, amounts), /a échoué/);
    const after = await ctx.journal.read();
    expect(after?.liquidity).to.equal(undefined);
    expect(after?.seeder?.status).to.equal("confirmed");
    expect(await balanceOf(token.address, wallet.address, lenient)).to.equal(SUPPLY);
  });

  it("après une ouverture minée en échec, un RPC en retard ne fait pas réutiliser le nonce consommé", async function () {
    const lenient = await network.create({ override: { throwOnTransactionFailures: false, throwOnCallFailures: false } });
    const lethers = lenient.ethers;
    const [, , attacker, operator] = await lethers.getSigners();
    const uniswap = await deployLocalUniswapV2(lethers, operator);
    const wallet = await localWallet(lenient);
    const ctx = contextFor(lenient, wallet);
    const token = await deployTokenStep(ctx, TOKEN);
    const seeder = await deploySeederStep(ctx, uniswap);

    // Essai 1 : signé avec maxPairWeth = 0, un don arrive avant la diffusion → minée en échec.
    await (await new Contract(token.address, ERC20_ABI, await lethers.getSigner(wallet.address)).approve(seeder.address, SUPPLY)).wait();
    const payload: TxPayload = {
      to: seeder.address,
      data: seederInterface.encodeFunctionData("seed", [token.address, SUPPLY, 0n]),
      value: POOL_ETH,
    };
    const failedNonce = await nextNonce(lethers.provider, wallet.address);
    const signed = await signTx(lethers.provider, wallet, chainId, payload, failedNonce);
    const before = await ctx.journal.read();
    await ctx.journal.write({
      ...before!,
      liquidity: {
        status: "pending",
        from: wallet.address,
        nonce: failedNonce,
        txHash: signed.hash,
        rawTx: signed.raw,
        preparedAt: new Date().toISOString(),
        seeder: seeder.address,
        tokenAmount: SUPPLY.toString(),
        ethAmountWei: POOL_ETH.toString(),
        maxPairWeth: "0",
        lpRecipient: DEAD_ADDRESS,
      },
    });
    await griefPair(uniswap, token.address, attacker, false);
    await expectLaunchError(seedStep(ctx, token, seeder, { tokenAmount: SUPPLY, ethAmount: POOL_ETH, maxPairWeth: 0n }), /a échoué/);
    expect((await ctx.journal.read())?.nonceFloor).to.equal(failedNonce + 1);

    // Essai 2, aussitôt, avec un RPC en retard d'une transaction.
    const real = lethers.provider;
    const lagging = withOverrides(real, {
      getTransactionCount: async (address: string, tag?: string) => (await real.getTransactionCount(address, tag)) - 1,
    });
    const laggingCtx = { ...ctx, ethers: withOverrides(lethers, { provider: lagging }) };
    const preview = await previewPair(real, uniswap, token.address);
    const { record } = await seedStep(laggingCtx, token, seeder, {
      tokenAmount: SUPPLY,
      ethAmount: POOL_ETH,
      maxPairWeth: maxPairWethFor(preview, POOL_ETH),
    });
    expect(record.status).to.equal("confirmed");
    expect(record.nonce).to.equal(failedNonce + 1);
  });

  it("un blocage miné en échec remet le journal à l'étape précédente, nonce compté", async function () {
    const lenient = await network.create({ override: { throwOnTransactionFailures: false, throwOnCallFailures: false } });
    const lethers = lenient.ethers;
    const wallet = await localWallet(lenient);
    const ctx = contextFor(lenient, wallet);
    const token = await deployTokenStep(ctx, TOKEN);
    const vesting = await deployVestingStep(ctx, {
      token: token.address,
      beneficiary: wallet.address,
      start: BigInt(await lenient.networkHelpers.time.latest()),
      durationSeconds: 365n * 86_400n,
      cliffSeconds: 0n,
    });

    // Transfert de plus que le solde : signé avec une limite de gas fixe (l'estimation échouerait), puis miné en échec.
    const tooMuch = SUPPLY + 1n;
    const payload: TxPayload = {
      to: token.address,
      data: new Interface(ERC20_ABI).encodeFunctionData("transfer", [vesting.address, tooMuch]),
    };
    const nonce = await nextNonce(lethers.provider, wallet.address);
    const signed = await signTx(lethers.provider, wallet, chainId, payload, nonce, 100_000n);
    const record = await ctx.journal.read();
    await ctx.journal.write({
      ...record!,
      lock: {
        status: "pending",
        from: wallet.address,
        nonce,
        txHash: signed.hash,
        rawTx: signed.raw,
        preparedAt: new Date().toISOString(),
        token: token.address,
        vesting: vesting.address,
        amount: tooMuch.toString(),
      },
    });

    await expectLaunchError(lockStep(ctx, vesting, 0n), /a échoué/);
    const after = await ctx.journal.read();
    expect(after?.lock).to.equal(undefined);
    expect(after?.vesting?.status).to.equal("confirmed");
    expect(after?.nonceFloor).to.equal(nonce + 1);
    expect(await balanceOf(token.address, wallet.address, lenient)).to.equal(SUPPLY);
  });

  it("frais devenus trop bas ET don arrivé entre-temps : re-signée avec sa limite de gas d'origine, minée en échec, journal remis", async function () {
    const lenient = await network.create({ override: { throwOnTransactionFailures: false, throwOnCallFailures: false } });
    const lethers = lenient.ethers;
    const [, , attacker, operator] = await lethers.getSigners();
    const uniswap = await deployLocalUniswapV2(lethers, operator);
    const wallet = await localWallet(lenient);
    const logs: string[] = [];
    const ctx = { ...contextFor(lenient, wallet), log: (message: string) => logs.push(message) };
    const token = await deployTokenStep(ctx, TOKEN);
    const seeder = await deploySeederStep(ctx, uniswap);

    await (await new Contract(token.address, ERC20_ABI, await lethers.getSigner(wallet.address)).approve(seeder.address, SUPPLY)).wait();
    const payload: TxPayload = {
      to: seeder.address,
      data: seederInterface.encodeFunctionData("seed", [token.address, SUPPLY, 0n]),
      value: POOL_ETH,
    };
    const nonce = await nextNonce(lethers.provider, wallet.address);
    const signed = await signTx(lethers.provider, wallet, chainId, payload, nonce);
    const record = await ctx.journal.read();
    await ctx.journal.write({
      ...record!,
      liquidity: {
        status: "pending",
        from: wallet.address,
        nonce,
        txHash: signed.hash,
        rawTx: signed.raw,
        preparedAt: new Date().toISOString(),
        seeder: seeder.address,
        tokenAmount: SUPPLY.toString(),
        ethAmountWei: POOL_ETH.toString(),
        maxPairWeth: "0",
        lpRecipient: DEAD_ADDRESS,
      },
    });
    await griefPair(uniswap, token.address, attacker, false);
    await lenient.networkHelpers.setNextBlockBaseFeePerGas(parseUnits("1000", "gwei"));
    await lenient.networkHelpers.mine();

    await expectLaunchError(
      seedStep(ctx, token, seeder, { tokenAmount: SUPPLY, ethAmount: POOL_ETH, maxPairWeth: 0n }),
      /a échoué/,
    );
    expect(logs.some((line) => line.startsWith("Diffusion refusée"))).to.equal(true);
    expect((await ctx.journal.read())?.liquidity).to.equal(undefined);
    expect(await lethers.provider.getTransactionCount(wallet.address)).to.equal(nonce + 1);
    expect(await balanceOf(token.address, wallet.address, lenient)).to.equal(SUPPLY);
  });
});
