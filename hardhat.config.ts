import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { configVariable, defineConfig } from "hardhat/config";

// Mêmes réglages pour les deux profils : le bytecode déployé est identique à
// celui que Blockscout recompile au moment de la vérification.
// evmVersion "cancun" : supporté par les chaînes Arbitrum depuis ArbOS 20.
const compiler = {
  version: "0.8.34",
  settings: {
    evmVersion: "cancun",
    optimizer: { enabled: true, runs: 200 },
  },
};

// RPC publics de la doc Robinhood Chain (limités en débit). Pour le jour J,
// mets plutôt une URL Alchemy dans le keystore : voir le README.
const PUBLIC_MAINNET_RPC = "https://rpc.mainnet.chain.robinhood.com";
const PUBLIC_TESTNET_RPC = "https://rpc.testnet.chain.robinhood.com";

export default defineConfig({
  plugins: [hardhatToolboxMochaEthersPlugin],
  solidity: {
    profiles: {
      default: compiler,
      production: compiler,
    },
  },
  networks: {
    // Mainnet : la clé et l'URL viennent du keystore chiffré de Hardhat.
    robinhood: {
      type: "http",
      chainType: "generic",
      chainId: 4663,
      url: configVariable("ROBINHOOD_RPC_URL", { default: PUBLIC_MAINNET_RPC }),
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
    robinhoodTestnet: {
      type: "http",
      chainType: "generic",
      chainId: 46630,
      url: configVariable("ROBINHOOD_TESTNET_RPC_URL", { default: PUBLIC_TESTNET_RPC }),
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
    // Copie locale de l'état du mainnet pour la répétition générale :
    // les vrais contrats Uniswap, des comptes de test, rien n'est envoyé.
    robinhoodFork: {
      type: "edr-simulated",
      chainType: "generic",
      hardfork: "cancun",
      forking: {
        url: configVariable("ROBINHOOD_RPC_URL", { default: PUBLIC_MAINNET_RPC }),
      },
    },
  },
  // hardforkHistory : indispensable à la copie locale (fork). Le simulateur
  // ne connaît pas l'historique de cette chaîne et refuse sinon d'exécuter
  // quoi que ce soit sur l'état copié. Les règles Cancun suffisent aux
  // contrats du kit (compilés pour Cancun) et à Uniswap v3.
  chainDescriptors: {
    4663: {
      name: "Robinhood Chain",
      chainType: "generic",
      hardforkHistory: { cancun: { blockNumber: 0 } },
      blockExplorers: {
        blockscout: {
          name: "Blockscout",
          url: "https://robinhoodchain.blockscout.com",
          apiUrl: "https://robinhoodchain.blockscout.com/api",
        },
      },
    },
    46630: {
      name: "Robinhood Chain Testnet",
      chainType: "generic",
      hardforkHistory: { cancun: { blockNumber: 0 } },
      blockExplorers: {
        blockscout: {
          name: "Blockscout",
          url: "https://explorer.testnet.chain.robinhood.com",
          apiUrl: "https://explorer.testnet.chain.robinhood.com/api",
        },
      },
    },
  },
  verify: {
    blockscout: { enabled: true },
    etherscan: { enabled: false },
    sourcify: { enabled: false },
  },
});
