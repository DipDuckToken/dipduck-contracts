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
    // capitalisation de départ (fixée par curve.virtualEth), seulement le prix par token.
    // Maximum : 5 192 296 858 534 827 (taille des réserves Uniswap v2, tient aussi en u128).
    supply: 1_000_000_000n,
  },
  curve: {
    // Courbe de lancement (LaunchCurve, à la pump.fun) : tu n'apportes AUCUN ETH.
    // La courbe vend les tokens à prix croissant ; quand elle a réuni targetEth, elle ouvre
    // TOUTE SEULE le pool Uniswap v2 avec cet ETH et le reste de sa part, au prix de fin de
    // courbe, et brûle les parts LP. Rien n'est modifiable après le déploiement.
    //
    // Part de l'offre confiée à la courbe (vendue + pool), 1 à 100. Le reste est partagé
    // entre la réserve communauté (ci-dessous) et ta part : ta part = 100 − tokenPercent − community.percent.
    // 87 avec une réserve de 3 % = tu gardes 10 %. La courbe garde 100 % de l'offre jusqu'à
    // l'ouverture du pool, puis verse ta part au contrat de blocage et la réserve au Safe.
    tokenPercent: 87,
    // Réserve d'ETH VIRTUELLE (personne ne la paie) : elle fixe le prix de départ.
    // 4 ETH ≈ capitalisation de départ de 3,1 ETH : 0,5 % de l'offre coûte ≈ 0,016 ETH
    // (au lieu de 0,0006 ETH avec un pool de 0,1 ETH), soit ≈ 25 fois plus cher pour un robot.
    virtualEth: "4",
    // ETH à réunir pour ouvrir le pool Uniswap (il y va en entier, avec ≈ 31,6 % de l'offre).
    // 3 ETH : ≈ 55,4 % de l'offre vendus sur la courbe, prix × 3,06 entre le début et la fin,
    // capitalisation ≈ 9,5 ETH à l'ouverture du pool.
    targetEth: "3",
    // Heure d'ouverture des achats, date ISO en UTC (ex. "2026-12-01T20:00:00Z"), entre le
    // déploiement et 30 jours après (au moins 1 h après sur le mainnet) : laisse le temps de
    // vérifier les contrats et d'annoncer l'heure. C'est aussi le début du calendrier du blocage.
    // Obligatoire sur le mainnet.
    openAt: "",
  },
  community: {
    // Réserve communauté (concours de mèmes, récompenses), en % de l'offre (0 à 99).
    // Gardée par la courbe, puis versée au Safe ci-dessous à l'ouverture du pool (rien si la
    // cible n'est jamais atteinte) : tout le monde voit son solde. 0 = pas de réserve.
    percent: 3,
    // Safe 2 sur 3 dédié à la communauté (app.safe.global, réseau Robinhood Chain) :
    // 3 propriétaires (ex. ton Ledger, un 2e wallet, une personne de confiance), 2 signatures
    // pour chaque envoi. Le wallet de déploiement ne doit PAS en être propriétaire.
    // Le Safe doit EXISTER avant npm run deploy:mainnet : le script refuse de déployer si cette
    // adresse n'est pas un vrai Safe (son adresse est gravée dans la courbe). Obligatoire si percent > 0. Colle-la avec ses majuscules et minuscules d'origine.
    beneficiary: "",
  },
  vesting: {
    // Ta part va dans un contrat de vesting déployé par npm run deploy:mainnet juste AVANT la
    // courbe ; la courbe le remplit à l'ouverture du pool (rien si la cible n'est jamais
    // atteinte). Ton wallet ne détient jamais ces tokens. Le calendrier commence à curve.openAt :
    // rien n'est libérable avant la falaise, puis la libération est linéaire jusqu'à la fin.
    // Personne ne peut retirer plus tôt, pas même toi. Doit rester true si tu gardes une part.
    enabled: true,
    // Durée totale du blocage, en jours (365 = un an).
    durationDays: 900,
    // Falaise : rien n'est libérable avant ce délai après curve.openAt, en jours (1 à durationDays).
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
    // Flux BTC/USD de secours sur Robinhood Chain (8 décimales, interface Chainlink), facultatif :
    // utilisé seulement si le flux principal ne publie plus rien depuis 2 jours. Vide = aucun.
    // Sans secours, le jeu ne bloque quand même jamais : 14 jours après le début d'un trimestre
    // sans prix, le concours se joue sur les jours déjà connus (mode dégradé).
    backupFeed: "",
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
    // Reçoit 30 % des mints, adresse gravée à vie dans le contrat. Recommandé : le Safe fondateur
    // (2 sur 3, mêmes clés que le Safe communauté), vérifié par le script ; sinon le Ledger fondateur.
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
