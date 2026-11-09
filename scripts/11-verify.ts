/**
 * Vérifie sur Blockscout le lanceur et le contrat de blocage notés dans deployments/<réseau>.json.
 * Lecture seule côté chaîne : aucune transaction, aucune clé utilisée.
 *
 *   npx hardhat run --network robinhood scripts/11-verify.ts
 */
import hre from "hardhat";

import { LAUNCHER_CONTRACT, VESTING_CONTRACT, launcherConstructorArgs, vestingConstructorArgs } from "./lib/token.ts";
import { verifyOnBlockscout } from "./lib/verify.ts";
import fs from "node:fs";

const connection = await hre.network.create();
const record = JSON.parse(fs.readFileSync(`deployments/${connection.networkName}.json`, "utf8"));
const targets = [
  { label: "lanceur", address: record.token.launcher, contract: LAUNCHER_CONTRACT, constructorArgs: launcherConstructorArgs(record.token) as unknown[] },
  { label: "contrat de blocage", address: record.vesting.address, contract: VESTING_CONTRACT, constructorArgs: vestingConstructorArgs(record.vesting) as unknown[] },
];
for (const { label, ...target } of targets) {
  console.log(`${label} : ${(await verifyOnBlockscout(hre, target, 3)) ? "✔ vérifié" : "✖ échec"}`);
}
