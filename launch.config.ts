/**
 * Paramètres du lancement. C'est le seul fichier à modifier.
 *
 * Les scripts refusent de déployer sur un vrai réseau tant que le nom et le
 * symbole sont les valeurs d'exemple ci-dessous.
 */
export const launchConfig = {
  token: {
    // Nom affiché par les wallets et les explorateurs (1 à 40 caractères).
    name: "Dip Duck",
    // Ticker : 2 à 11 caractères, lettres majuscules et chiffres.
    symbol: "DIPDUCK",
    // Offre totale en tokens entiers ; le contrat ajoute les 18 décimales.
    // 1 milliard est le standard des memecoins. L'offre ne change pas la
    // capitalisation de départ (fixée par ethAmount), seulement le prix par token.
    // Maximum : 5 192 296 858 534 827 (taille des réserves Uniswap v2, tient aussi en u128).
    supply: 1_000_000_000n,
  },
  liquidity: {
    // ETH apporté au pool Uniswap v2 en face des tokens.
    // Avec 100 % des tokens dans le pool, la capitalisation totale de départ
    // (en ETH) est égale à ce montant ; avec 95 %, elle est de ethAmount / 0,95.
    ethAmount: "0.1",
    // Part de l'offre mise dans le pool (1 à 100). Le reste est partagé entre
    // la réserve communauté (ci-dessous) et ta part : ta part = 100 − tokenPercent − community.percent.
    // 87 avec une réserve de 3 % = tu gardes 10 %, bloqués AVANT l'ouverture du pool (npm run lock:mainnet).
    // 100 = tout dans le pool, rien gardé.
    tokenPercent: 87,
  },
  community: {
    // Réserve communauté (concours de mèmes, récompenses), en % de l'offre (0 à 99).
    // Envoyée par npm run lock:mainnet, AVANT l'ouverture du pool, vers un wallet
    // public dédié : tout le monde voit son solde. 0 = pas de réserve.
    percent: 3,
    // Safe 2 sur 3 dédié à la communauté (app.safe.global, réseau Robinhood Chain) :
    // 3 propriétaires (ex. ton Ledger, un 2e wallet, une personne de confiance), 2 signatures
    // pour chaque envoi. Le wallet de déploiement ne doit PAS en être propriétaire.
    // Sur le mainnet, le script refuse d'envoyer si cette adresse n'est pas un vrai Safe.
    // Obligatoire si percent > 0. Colle-la avec ses majuscules et minuscules d'origine.
    beneficiary: "",
  },
  vesting: {
    // Bloque ta part dans un contrat de vesting AVANT l'ouverture du pool
    // (npm run lock:mainnet, entre le déploiement et la liquidité) : les acheteurs
    // la voient bloquée dès la première seconde. Rien n'est libérable avant la
    // falaise, puis la libération est linéaire jusqu'à la fin. Personne ne peut
    // retirer plus tôt, pas même toi.
    enabled: true,
    // Durée totale du blocage, en jours (365 = un an).
    durationDays: 900,
    // Falaise : rien n'est libérable avant ce délai, en jours (1 à durationDays).
    // Ouvre le pool juste après le blocage, bien avant la falaise.
    // À la falaise, la part correspondant au temps écoulé devient libérable d'un coup
    // (90 jours sur 900 = 10 % exactement), puis le reste se libère chaque seconde jusqu'à la fin.
    cliffDays: 90,
    // Wallet FONDATEUR (Ledger) qui recevra les tokens libérés. Obligatoire sur le mainnet,
    // et différent du wallet de déploiement (Rabby), qui ne garde rien après le lancement.
    // Colle-la avec ses majuscules et minuscules d'origine, et vérifie-la caractère par caractère.
    // Jamais une adresse liée à un autre projet ; garde bien sa clé : sans elle,
    // la part est perdue.
    beneficiary: "0x711C887F1e3f11817eA28B5F0557fCfa4d9E00dA",
  },
  game: {
    // Jeu « Attrape la baisse » (npm run game:deploy:mainnet) : un seul contrat pour toujours,
    // un concours par trimestre. Fichier de genèse partagé avec le site, chemin relatif à ce dossier :
    // { "detectFrom": n, "dips": [[jour, bonus], ...], "histMinSeconds": [...], "recentPrices": [...] }
    // — baisses historiques strictement croissantes, toutes avant detectFrom, bonus 0 à 10 ;
    // (detectFrom + 13) / 30 + 1 temps minimaux non décroissants ; 59 prix bruts (USD × 1e8)
    // des jours detectFrom − 45 à detectFrom + 13. Figé au déploiement.
    genesisFile: "../dipduck-site/seasons/genesis.json",
    // Flux Chainlink BTC/USD (8 décimales) sur Robinhood Chain : un prix par jour est lu ici.
    feed: "0xa2c5184bF03d373Dc9dE4876eb4Bce595B460251",
    // Flux BTC/USD à utiliser sur le testnet (8 décimales). Vide = déploiement testnet refusé.
    testnetFeed: "",
  },
  nft: {
    // Cartes de collection Dip Duck (ERC-721), à déployer APRÈS le lancement du token :
    // npm run nft:deploy:mainnet. Prix (0,001 ETH), offre (3 333 dont 111 de réserve),
    // limite (10 par wallet) et répartition (30 % fondateurs, 40 % communauté, 30 %
    // fondation) sont fixés dans le contrat. Les mints remplissent des cagnottes par
    // période de 30 jours, versées seulement après la fin de chaque période ; la part
    // fondation va au gagnant du vote de la période. Le wallet communauté
    // (community.beneficiary) reçoit sa part et frappe les cartes de réserve.
    // Début du mint et de la première période de 30 jours, date ISO en UTC
    // (ex. "2026-12-01T20:00:00Z"). Obligatoire sur le mainnet.
    mintStart: "",
    // Wallet fondateur (Ledger), le même que vesting.beneficiary : reçoit 30 % des mints.
    // Obligatoire sur le mainnet, différent du wallet de déploiement.
    founders: "0x711C887F1e3f11817eA28B5F0557fCfa4d9E00dA",
    // 2 à 5 fondations candidates au départ : { name: "…", address: "0x…", url: "https://…" }
    // (adresse avec sa casse d'origine, url facultative). Les détenteurs de cartes pourront
    // en proposer d'autres (20 au maximum). Obligatoire sur le mainnet ; sur le testnet,
    // deux candidats d'essai sont utilisés.
    charities: [],
    // Adresse publique des images, terminée par « / » : l'image de la carte 12 est <imageBaseURI>12.png
    imageBaseURI: "https://dipduck.xyz/nft/",
    // Page du site qui affiche une carte : <viewerURI>?id=12
    viewerURI: "https://dipduck.xyz/card.html",
  },
} as const;
