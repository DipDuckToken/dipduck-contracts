import { expect } from "chai";
import {
  AbiCoder,
  Contract,
  type Signer,
  getCreate2Address,
  getCreateAddress,
  keccak256,
  parseEther,
  solidityPacked,
  toBeHex,
  zeroPadValue,
} from "ethers";
import { network } from "hardhat";

import { DEAD_ADDRESS } from "../scripts/lib/constants.ts";
import {
  V3_FACTORY_ABI,
  V3_POOL_ABI,
  V3_POSITION_MANAGER_ABI,
  V3_ROUTER_ABI,
  deployLocalUniswapV3,
} from "./helpers/uniswap-v3-local.ts";

const { ethers, networkHelpers } = await network.create();

const SUPPLY = 1_000_000_000n;
const TEAM = 100_000_000n;
const COMMUNITY = 30_000_000n;
const UNIT = 10n ** 18n;
const FEE = 10_000;
/** Prix de départ ≈ 3,08e-9 ETH par token (capitalisation ≈ 3,1 ETH). */
const START_TICK = -196_000;
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function transfer(address, uint256) returns (bool)",
] as const;

async function fixture() {
  const [deployer, alice, bob, attacker, operator] = await ethers.getSigners();
  const uniswap = await deployLocalUniswapV3(ethers, operator);
  const vesting = await ethers.deployContract("MockSafeSingleton", ["1.4.1"]);
  const community = await ethers.deployContract("MockSafeSingleton", ["1.4.1"]);
  const openAt = BigInt(await networkHelpers.time.latest()) + 3600n;
  return {
    deployer,
    alice,
    bob,
    attacker,
    uniswap,
    openAt,
    vesting: await vesting.getAddress(),
    community: await community.getAddress(),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function configOf(f: Fixture) {
  return {
    supply: SUPPLY,
    vesting: f.vesting,
    vestingTokens: TEAM,
    community: f.community,
    communityTokens: COMMUNITY,
    feeRecipient: f.community,
    startTick: START_TICK,
    openAt: f.openAt,
    positionManager: f.uniswap.positionManager,
  };
}

/** Adresse du token que créera la courbe (CREATE2 depuis le lanceur, sel donné). */
async function predictToken(f: Fixture, launcher: string, salt: string): Promise<string> {
  const factory = await ethers.getContractFactory("MemeToken");
  const args = AbiCoder.defaultAbiCoder().encode(
    ["string", "string", "uint256", "address", "address", "uint24", "uint256"],
    ["Dip Duck", "DIPDUCK", SUPPLY, f.uniswap.factory, f.uniswap.weth, FEE, f.openAt],
  );
  return getCreate2Address(launcher, salt, keccak256(solidityPacked(["bytes", "bytes"], [factory.bytecode, args])));
}

/** Premier sel qui place le token avant (token0) ou après (token1) le WETH. */
async function saltFor(f: Fixture, launcher: string, tokenIsToken0: boolean): Promise<string> {
  for (let i = 1; ; i++) {
    const salt = zeroPadValue(toBeHex(i), 32);
    const token = await predictToken(f, launcher, salt);
    if (BigInt(token) < BigInt(f.uniswap.weth) === tokenIsToken0) return salt;
  }
}

async function launch(f: Fixture, tokenIsToken0: boolean) {
  const nonce = await ethers.provider.getTransactionCount(f.deployer.address);
  const launcherAddress = getCreateAddress({ from: f.deployer.address, nonce });
  const salt = await saltFor(f, launcherAddress, tokenIsToken0);
  const launcher = await ethers.deployContract("LaunchPool", ["Dip Duck", "DIPDUCK", configOf(f), salt]);
  expect(await launcher.getAddress()).to.equal(launcherAddress);
  const token = await ethers.getContractAt("MemeToken", await launcher.TOKEN());
  const pool = new Contract(await launcher.POOL(), V3_POOL_ABI, ethers.provider);
  return { launcher, token, pool, salt };
}

async function buy(f: Fixture, buyer: Signer, token: string, eth: bigint) {
  const router = new Contract(f.uniswap.router, V3_ROUTER_ABI, buyer);
  const deadline = BigInt(await networkHelpers.time.latest()) + 600n;
  return router.exactInputSingle(
    {
      tokenIn: f.uniswap.weth,
      tokenOut: token,
      fee: FEE,
      recipient: await buyer.getAddress(),
      deadline,
      amountIn: eth,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0,
    },
    { value: eth },
  );
}

async function sell(f: Fixture, seller: Signer, token: string, amount: bigint) {
  await (await new Contract(token, ERC20_ABI, seller).approve(f.uniswap.router, amount)).wait();
  const router = new Contract(f.uniswap.router, V3_ROUTER_ABI, seller);
  const deadline = BigInt(await networkHelpers.time.latest()) + 600n;
  return router.exactInputSingle({
    tokenIn: token,
    tokenOut: f.uniswap.weth,
    fee: FEE,
    recipient: await seller.getAddress(),
    deadline,
    amountIn: amount,
    amountOutMinimum: 0,
    sqrtPriceLimitX96: 0,
  });
}

for (const tokenIsToken0 of [true, false]) {
  describe(`Lancement Uniswap v3 d'un seul côté (vrai bytecode, token en ${tokenIsToken0 ? "token0" : "token1"})`, function () {
    it("répartit l'offre, place la liquidité au prix de départ et garde la position pour toujours", async function () {
      const f = await networkHelpers.loadFixture(fixture);
      const { launcher, token, pool } = await launch(f, tokenIsToken0);
      expect(((await pool.token0()) as string) === (await token.getAddress())).to.equal(tokenIsToken0);
      expect(await token.balanceOf(f.vesting)).to.equal(TEAM * UNIT);
      expect(await token.balanceOf(f.community)).to.equal(COMMUNITY * UNIT);
      expect(await token.balanceOf(f.deployer.address)).to.equal(0n);
      expect(await token.balanceOf(await launcher.getAddress())).to.equal(0n);
      const inPool = (await token.balanceOf(await pool.getAddress())) as bigint;
      expect(inPool).to.equal(await launcher.POOL_TOKENS());
      const dust = (SUPPLY - TEAM - COMMUNITY) * UNIT - inPool;
      expect(dust < 10n ** 9n).to.equal(true); // arrondis brûlés
      expect(await token.balanceOf(DEAD_ADDRESS)).to.equal(dust);

      const [, tick] = (await pool.slot0()) as [bigint, bigint];
      expect(tick).to.equal(BigInt(tokenIsToken0 ? START_TICK : -START_TICK));
      const npm = new Contract(f.uniswap.positionManager, V3_POSITION_MANAGER_ABI, ethers.provider);
      expect(await npm.ownerOf(await launcher.POSITION_ID())).to.equal(await launcher.getAddress());
      // Le lanceur n'expose aucune fonction pour retirer la liquidité.
      const functions = launcher.interface.fragments.filter((x) => x.type === "function").map((x) => x.format());
      expect(functions.filter((x) => !/^[A-Z_]+\(\)$/.test(x))).to.deep.equal(["collectFees()"]);
    });

    it("refuse tout achat avant l'heure, limite les wallets 24 h, permet de revendre, envoie les frais au Safe", async function () {
      const f = await networkHelpers.loadFixture(fixture);
      const { launcher, token } = await launch(f, tokenIsToken0);
      const tokenAddress = await token.getAddress();

      await expect(buy(f, f.alice, tokenAddress, parseEther("0.001"))).to.be.revert(ethers);
      await networkHelpers.time.increaseTo(f.openAt);
      // 0,5 % de l'offre coûte ≈ 0,0155 ETH (+ 1 % de frais) : 0,05 ETH dépasse la limite.
      await expect(buy(f, f.alice, tokenAddress, parseEther("0.05"))).to.be.revert(ethers);
      await (await buy(f, f.alice, tokenAddress, parseEther("0.01"))).wait();
      const got = (await token.balanceOf(f.alice.address)) as bigint;
      expect(got > (SUPPLY * UNIT) / 400n && got < (SUPPLY * UNIT) / 200n).to.equal(true);

      // Revente d'une moitié : l'ETH des acheteurs reste dans le pool pour payer les vendeurs.
      await (await sell(f, f.alice, tokenAddress, got / 2n)).wait();
      expect(await token.balanceOf(f.alice.address)).to.equal(got - got / 2n);

      await networkHelpers.time.increaseTo(f.openAt + 86_400n);
      await (await buy(f, f.bob, tokenAddress, parseEther("1"))).wait();
      expect(((await token.balanceOf(f.bob.address)) as bigint) > (SUPPLY * UNIT) / 50n).to.equal(true);

      const weth = new Contract(f.uniswap.weth, ERC20_ABI, ethers.provider);
      const before = (await weth.balanceOf(f.community)) as bigint;
      await (await launcher.connect(f.attacker).collectFees()).wait();
      const wethFees = ((await weth.balanceOf(f.community)) as bigint) - before;
      expect(wethFees > 0n && wethFees < parseEther("0.0102") + 1n).to.equal(true); // 1 % des achats
    });
  });
}

describe("Lancement Uniswap v3 : pool impossible à piéger", function () {
  it("refuse un pool créé d'avance (le sel aurait fuité) et ne laisse personne d'autre déposer avant l'heure", async function () {
    const f = await networkHelpers.loadFixture(fixture);
    const nonce = await ethers.provider.getTransactionCount(f.deployer.address);
    const launcherAddress = getCreateAddress({ from: f.deployer.address, nonce });
    const salt = await saltFor(f, launcherAddress, true);
    const predicted = await predictToken(f, launcherAddress, salt);
    const factory = new Contract(f.uniswap.factory, V3_FACTORY_ABI, f.attacker);
    await (await factory.createPool(predicted, f.uniswap.weth, FEE)).wait();
    await expect(ethers.deployContract("LaunchPool", ["Dip Duck", "DIPDUCK", configOf(f), salt])).to.be.revert(ethers);

    // Avec un autre sel, tout va bien ; la réserve (Safe) ne peut pas déposer dans le pool avant l'heure.
    const { token, pool } = await launch(f, false);
    await networkHelpers.impersonateAccount(f.community);
    await networkHelpers.setBalance(f.community, parseEther("1"));
    const safe = await ethers.getSigner(f.community);
    await expect(token.connect(safe).transfer(await pool.getAddress(), 1n)).to.be.revertedWithCustomError(token, "PoolNotOpen");
  });

  it("refuse des paramètres invalides", async function () {
    const f = await networkHelpers.loadFixture(fixture);
    const factory = await ethers.getContractFactory("LaunchPool");
    const salt = zeroPadValue("0x01", 32);
    const bad = [
      { ...configOf(f), openAt: 1n },
      { ...configOf(f), openAt: f.openAt + 31n * 86_400n },
      { ...configOf(f), startTick: -196_001 },
      { ...configOf(f), startTick: 0 },
      { ...configOf(f), vesting: f.alice.address },
      { ...configOf(f), community: f.vesting },
      { ...configOf(f), feeRecipient: "0x0000000000000000000000000000000000000000" },
      { ...configOf(f), vestingTokens: SUPPLY },
      { ...configOf(f), positionManager: f.alice.address },
    ];
    for (const config of bad) {
      await expect(factory.deploy("Dip Duck", "DIPDUCK", config, salt)).to.be.revertedWithCustomError(factory, "InvalidParams");
    }
  });
});
