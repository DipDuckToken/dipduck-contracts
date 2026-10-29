import { type BaseWallet, HDNodeWallet, Wallet, getAddress } from "ethers";
import type { NetworkConnection } from "hardhat/types/network";

import { LaunchError } from "./errors.ts";

/**
 * Le wallet qui signe les transactions du lancement, construit à partir de la
 * configuration du réseau (clé du keystore, ou comptes de test en local).
 * Les scripts signent eux-mêmes pour connaître le hash de chaque transaction
 * avant de la diffuser ; la clé ne quitte jamais la mémoire du processus.
 */
export async function localWallet(connection: NetworkConnection, index = 0): Promise<BaseWallet> {
  const accounts = connection.networkConfig.accounts;
  if (accounts === "remote") {
    throw new LaunchError(
      `Le réseau "${connection.networkName}" utilise des comptes « remote » : les scripts ont besoin ` +
        "de la clé du wallet (DEPLOYER_PRIVATE_KEY dans le keystore) pour signer eux-mêmes.",
    );
  }
  if (Array.isArray(accounts)) {
    const entry = accounts[index];
    if (entry === undefined) {
      throw new LaunchError(`Aucun compte n°${index} configuré pour le réseau "${connection.networkName}".`);
    }
    const variable = "privateKey" in entry ? entry.privateKey : entry;
    return new Wallet(await variable.getHexString());
  }
  const mnemonic = await accounts.mnemonic.get();
  const passphrase = await accounts.passphrase.get();
  return HDNodeWallet.fromPhrase(mnemonic, passphrase, `${accounts.path}/${accounts.initialIndex + index}`);
}

/** Vérifie que le wallet reconstruit est bien le premier compte que Hardhat expose. */
export function assertSameAccount(wallet: BaseWallet, expected: string): void {
  if (getAddress(wallet.address) !== getAddress(expected)) {
    throw new LaunchError(`Le wallet reconstruit (${wallet.address}) ne correspond pas au compte ${expected}.`);
  }
}
