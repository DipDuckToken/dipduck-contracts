import { expect } from "chai";
import { Wallet } from "ethers";
import { network } from "hardhat";

import { LaunchError } from "../scripts/lib/errors.ts";
import { assertSafe } from "../scripts/lib/safe.ts";
import { validateNftParams, validateVestingParams } from "../scripts/lib/validation.ts";

const { ethers } = await network.create();

async function expectLaunchError(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).to.be.instanceOf(LaunchError);
    expect((error as Error).message).to.match(pattern);
    return;
  }
  expect.fail(`LaunchError attendue (${pattern})`);
}

describe("Réserve communauté : vrai Safe 2 sur 3", function () {
  const owners = [Wallet.createRandom().address, Wallet.createRandom().address, Wallet.createRandom().address];

  async function deploySafe(version: string, safeOwners: string[], threshold: number): Promise<string> {
    const singleton = await ethers.deployContract("MockSafeSingleton", [version]);
    const safe = await ethers.deployContract("MockSafe", [await singleton.getAddress(), safeOwners, threshold]);
    return await safe.getAddress();
  }

  it("accepte un Safe officiel 2 sur 3 dont le wallet de déploiement n'est pas propriétaire", async function () {
    const [deployer] = await ethers.getSigners();
    const address = await deploySafe("1.4.1", owners, 2);
    const info = await assertSafe(ethers.provider, address, deployer.address, "Le wallet communauté");
    expect(info.threshold).to.equal(2n);
    expect(info.owners).to.deep.equal(owners);
    expect(info.version).to.equal("1.4.1");
  });

  it("refuse un wallet ordinaire, une version inconnue, 1 signature, 2 propriétaires ou le déployeur propriétaire", async function () {
    const [deployer, other] = await ethers.getSigners();
    const label = "Le wallet communauté";
    await expectLaunchError(assertSafe(ethers.provider, other.address, deployer.address, label), /aucun contrat/);
    await expectLaunchError(
      assertSafe(ethers.provider, await deploySafe("9.9.9", owners, 2), deployer.address, label),
      /version du contrat Safe inconnue/,
    );
    await expectLaunchError(
      assertSafe(ethers.provider, await deploySafe("1.4.1", owners, 1), deployer.address, label),
      /il en faut au moins 2/,
    );
    await expectLaunchError(
      assertSafe(ethers.provider, await deploySafe("1.4.1", owners.slice(0, 2), 2), deployer.address, label),
      /2 propriétaire\(s\), il en faut au moins 3/,
    );
    await expectLaunchError(
      assertSafe(ethers.provider, await deploySafe("1.4.1", [deployer.address, ...owners.slice(0, 2)], 2), deployer.address, label),
      /wallet de déploiement en est propriétaire/,
    );
    // Un contrat quelconque (pas un proxy Safe) est refusé aussi.
    const notSafe = await ethers.deployContract("MockSafeSingleton", ["1.4.1"]);
    await expectLaunchError(assertSafe(ethers.provider, await notSafe.getAddress(), deployer.address, label), /pas un proxy Safe|version|propriétaires/);
  });

  it("refuse un Safe avec un module ou un garde (ils contournent les signatures)", async function () {
    const [deployer, other] = await ethers.getSigners();
    const label = "Le wallet communauté";
    const withModule = await deploySafe("1.4.1", owners, 2);
    await (await ethers.getContractAt("MockSafe", withModule)).enableModule(other.address);
    await expectLaunchError(assertSafe(ethers.provider, withModule, deployer.address, label), /un module est activé/);

    const withGuard = await deploySafe("1.4.1", owners, 2);
    await ethers.provider.send("hardhat_setStorageAt", [
      withGuard,
      "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8",
      ethers.zeroPadValue(other.address, 32),
    ]);
    await expectLaunchError(assertSafe(ethers.provider, withGuard, deployer.address, label), /garde de transactions/);
  });
});

describe("Deux wallets : déploiement et fondateur", function () {
  const deployer = Wallet.createRandom().address;
  const ledger = Wallet.createRandom().address;
  const vesting = { enabled: true, durationDays: 900, cliffDays: 90 };

  it("sur le mainnet, la part bloquée va au wallet fondateur, jamais au wallet de déploiement", function () {
    expect(() => validateVestingParams({ ...vesting, beneficiary: "" }, deployer, { requireSeparateWallet: true })).to.throw(
      LaunchError,
      /obligatoire sur le mainnet/,
    );
    expect(() => validateVestingParams({ ...vesting, beneficiary: deployer }, deployer, { requireSeparateWallet: true })).to.throw(
      LaunchError,
      /pas le wallet de déploiement/,
    );
    const ok = validateVestingParams({ ...vesting, beneficiary: ledger }, deployer, { requireSeparateWallet: true });
    expect(ok.beneficiary).to.equal(ledger);
    // Testnet et répétition : vide reste permis (le wallet de déploiement).
    expect(validateVestingParams({ ...vesting, beneficiary: "" }, deployer).beneficiary).to.equal(deployer);
  });

  it("sur le mainnet, les revenus NFT fondateurs vont au wallet fondateur", function () {
    const base = {
      mintStart: "2026-12-01T20:00:00Z",
      charities: [
        { name: "Fondation A", address: Wallet.createRandom().address },
        { name: "Fondation B", address: Wallet.createRandom().address },
      ],
      imageBaseURI: "https://dipduck.xyz/nft/",
      viewerURI: "https://dipduck.xyz/card.html",
    };
    const options = { deployer, community: Wallet.createRandom().address, isMainnet: true, now: 0n };
    expect(() => validateNftParams({ ...base, founders: "" }, options)).to.throw(LaunchError, /nft.founders est obligatoire/);
    expect(() => validateNftParams({ ...base, founders: deployer }, options)).to.throw(LaunchError, /pas le wallet de déploiement/);
    expect(validateNftParams({ ...base, founders: ledger }, options).founders).to.equal(ledger);
  });
});
