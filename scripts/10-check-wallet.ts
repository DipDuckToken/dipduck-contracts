/**
 * Vérification en lecture seule du wallet de déploiement enregistré dans le keystore :
 * affiche son adresse et son solde sur Robinhood Chain. N'envoie aucune transaction.
 *
 *   npm run wallet:mainnet
 */
import hre from "hardhat";

const connection = await hre.network.create();
const { ethers } = connection;
const [signer] = await ethers.getSigners();
const network = await ethers.provider.getNetwork();
const balance = await ethers.provider.getBalance(signer.address);
const nonce = await ethers.provider.getTransactionCount(signer.address);

console.log("");
console.log(`  Réseau             chain ${network.chainId}`);
console.log(`  Wallet du keystore ${signer.address}`);
console.log(`  Solde              ${ethers.formatEther(balance)} ETH`);
console.log(`  Transactions       ${nonce}`);
console.log("\n  Lecture seule : rien n'a été envoyé.");
