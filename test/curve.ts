import { expect } from "chai";
import { Contract, ZeroAddress, getCreateAddress, parseEther } from "ethers";
import { network } from "hardhat";

import { DEAD_ADDRESS } from "../scripts/lib/constants.ts";
import { FACTORY_WRITE_ABI, PAIR_GRIEF_ABI, WETH_ABI, deployLocalUniswapV2 } from "./helpers/uniswap-local.ts";

const { ethers, networkHelpers } = await network.create();

const SUPPLY = 1_000_000_000n;
const TEAM = 100_000_000n;
const COMMUNITY = 30_000_000n;
const VIRTUAL = parseEther("2");
const TARGET = parseEther("3");
const UNIT = 10n ** 18n;

const ROUTER_ABI = [
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
] as const;
const PAIR_ABI = [
  "function getReserves() view returns (uint112, uint112, uint32)",
  "function token0() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
] as const;

async function fixture() {
  const [deployer, alice, bob, attacker, operator] = await ethers.getSigners();
  const uniswap = await deployLocalUniswapV2(ethers, operator);
  const now = BigInt(await networkHelpers.time.latest());
  const openAt = now + 3600n;
  return { deployer, alice, bob, attacker, uniswap, openAt };
}

async function deployCurve(f: Awaited<ReturnType<typeof fixture>>) {
  // Blocage et Safe : deux contrats quelconques (ils doivent seulement avoir du code).
  const vesting = await ethers.deployContract("MockSafeSingleton", ["1.4.1"]);
  const community = await ethers.deployContract("MockSafeSingleton", ["1.4.1"]);
  const curve = await ethers.deployContract("LaunchCurve", [
    "Dip Duck",
    "DIPDUCK",
    {
      supply: SUPPLY,
      vesting: await vesting.getAddress(),
      vestingTokens: TEAM,
      community: await community.getAddress(),
      communityTokens: COMMUNITY,
      virtualEth: VIRTUAL,
      targetEth: TARGET,
      openAt: f.openAt,
      factory: f.uniswap.factory,
      weth: f.uniswap.weth,
    },
  ]);
  const token = await ethers.getContractAt("MemeToken", await curve.TOKEN());
  return { curve, token, vesting: await vesting.getAddress(), community: await community.getAddress() };
}

describe("Courbe de lancement (vrai bytecode Uniswap v2)", function () {
  it("ouvre le pool au prix de fin de courbe, brûle les LP, puis le token limite les snipers 24 h", async function () {
    const f = await networkHelpers.loadFixture(fixture);
    const { curve, token, vesting, community } = await deployCurve(f);
    expect(await token.balanceOf(await curve.getAddress())).to.equal(SUPPLY * UNIT);
    expect(await token.balanceOf(f.deployer.address)).to.equal(0n);

    await networkHelpers.time.increaseTo(f.openAt + 86_400n); // après la limite de la courbe
    await (await curve.connect(f.alice).buy(0, f.openAt + 200_000n, { value: parseEther("1") })).wait();
    await (await curve.connect(f.bob).buy(0, f.openAt + 200_000n, { value: parseEther("5") })).wait();
    expect(await curve.graduated()).to.equal(true);
    expect(await token.balanceOf(vesting)).to.equal(TEAM * UNIT);
    expect(await token.balanceOf(community)).to.equal(COMMUNITY * UNIT);

    const pair = new Contract(await curve.PAIR(), PAIR_ABI, ethers.provider);
    const [r0, r1] = (await pair.getReserves()) as [bigint, bigint];
    const tokenIsToken0 = (await pair.token0()) === (await token.getAddress());
    const [tokenReserve, wethReserve] = tokenIsToken0 ? [r0, r1] : [r1, r0];
    expect(wethReserve).to.equal(TARGET);
    expect(tokenReserve).to.equal(await curve.LP_TOKENS());
    expect(await pair.balanceOf(DEAD_ADDRESS)).to.equal(((await pair.totalSupply()) as bigint) - 1000n);

    // Prix du pool = prix de fin de courbe (x / y), à 1 ppb près.
    const endY = ((await curve.VIRTUAL_TOKENS()) as bigint) - ((await curve.CURVE_TOKENS()) as bigint);
    const endPrice = ((VIRTUAL + TARGET) * 10n ** 36n) / endY;
    const poolPrice = (wethReserve * 10n ** 36n) / tokenReserve;
    const gap = poolPrice > endPrice ? poolPrice - endPrice : endPrice - poolPrice;
    expect(gap * 10n ** 9n <= endPrice).to.equal(true);

    // Juste après l'ouverture : un sniper ne peut pas prendre plus de 0,5 % sur Uniswap.
    const router = new Contract(f.uniswap.router, ROUTER_ABI, f.attacker);
    const path = [f.uniswap.weth, await token.getAddress()];
    const deadline = BigInt(await networkHelpers.time.latest()) + 600n;
    await expect(router.swapExactETHForTokens(0, path, f.attacker.address, deadline, { value: parseEther("1") })).to.be.revert(ethers);
    await (await router.swapExactETHForTokens(0, path, f.attacker.address, deadline, { value: parseEther("0.01") })).wait();
    expect((await token.balanceOf(f.attacker.address)) > 0n).to.equal(true);
  });

  it("une paire créée d'avance avec du WETH synchronisé ne bloque pas l'ouverture, et personne d'autre n'y met de tokens", async function () {
    const f = await networkHelpers.loadFixture(fixture);
    // L'attaquant prédit l'adresse du token (1er contrat créé par la courbe) et piège la paire.
    const nonce = await ethers.provider.getTransactionCount(f.deployer.address);
    // deployCurve déploie d'abord le faux blocage et le faux Safe (2 transactions).
    const predictedCurve = getCreateAddress({ from: f.deployer.address, nonce: nonce + 2 });
    const predictedToken = getCreateAddress({ from: predictedCurve, nonce: 1 });
    const factory = new Contract(f.uniswap.factory, FACTORY_WRITE_ABI, f.attacker);
    await (await factory.createPair(predictedToken, f.uniswap.weth)).wait();
    const pairAddress = (await factory.getPair(predictedToken, f.uniswap.weth)) as string;
    const weth = new Contract(f.uniswap.weth, WETH_ABI, f.attacker);
    await (await weth.deposit({ value: parseEther("1") })).wait();
    await (await weth.transfer(pairAddress, parseEther("1"))).wait();

    const { curve, token } = await deployCurve(f);
    expect(await token.getAddress()).to.equal(predictedToken);
    expect(await curve.PAIR()).to.equal(pairAddress);
    // Le token existe : le WETH donné peut maintenant être synchronisé dans les réserves.
    await (await new Contract(pairAddress, PAIR_GRIEF_ABI, f.attacker).sync()).wait();

    await networkHelpers.time.increaseTo(f.openAt + 86_400n);
    await (await curve.connect(f.attacker).buy(0, f.openAt + 200_000n, { value: parseEther("0.5") })).wait();
    // Ajout de liquidité avant la courbe : refusé par le token.
    await expect(token.connect(f.attacker).transfer(pairAddress, 1n)).to.be.revertedWithCustomError(token, "PoolNotOpen");

    await (await curve.connect(f.bob).buy(0, f.openAt + 200_000n, { value: parseEther("5") })).wait();
    expect(await curve.graduated()).to.equal(true);
    const pair = new Contract(pairAddress, PAIR_ABI, ethers.provider);
    expect(((await pair.balanceOf(DEAD_ADDRESS)) as bigint) > 0n).to.equal(true);
    expect(await pair.balanceOf(f.attacker.address)).to.equal(0n);
    expect(await ethers.provider.getBalance(await curve.getAddress())).to.equal(0n);
    expect(await curve.PAIR()).to.not.equal(ZeroAddress);
  });
});
