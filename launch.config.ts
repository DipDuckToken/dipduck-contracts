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
    // capitalisation de départ (fixée par pool.startMarketCapEth), seulement le prix par token.
    // Maximum : 5 192 296 858 534 827 (tient dans un uint112, donc aussi en u128).
    supply: 1_000_000_000n,
  },
  pool: {
    // Lancement Uniswap v3 « d'un seul côté » (LaunchPool) : tu n'apportes AUCUN ETH.
    // Au déploiement, tout ce qui n'est ni ta part ni la réserve (≈ 87 % de l'offre) est placé
    // dans un pool Uniswap v3 TOKEN/WETH à 1 % de frais, à partir d'un prix de départ et
    // jusqu'à l'infini. Chaque achat fait monter le prix, l'ETH des acheteurs reste dans le
    // pool, et chacun peut revendre à tout moment. La liquidité est verrouillée à vie (le
    // lanceur n'a aucune fonction pour la retirer). Le pool est visible et échangeable sur
    // Uniswap, DEXTools et GeckoTerminal dès l'ouverture. Rien n'est modifiable ensuite.
    //
    // Capitalisation de départ voulue, en ETH : elle fixe le prix de départ (capitalisation
    // ÷ offre). Le script arrondit au palier Uniswap inférieur (au plus 2 % sous la cible)
    // et affiche le prix et la capitalisation réels. 3 ETH ⇒ 0,5 % de l'offre (la limite de
    // la 1re heure) coûte ≈ 0,015 ETH, plus 1 % de frais : un robot paie dès la première
    // seconde un vrai prix.
    // Les frais d'échange (1 % de chaque achat et revente dans la position) sont partagés :
    // 60 % au Safe communauté (community.beneficiary), 40 % au Safe de l'équipe (team.safe).
    // N'importe qui peut déclencher le versement avec npm run fees:mainnet.
    startMarketCapEth: "3",
    // Heure d'ouverture des échanges, date ISO en UTC (ex. "2026-12-01T20:00:00Z"), entre le
    // déploiement et 30 jours après (au moins 1 h après sur le mainnet) : laisse le temps de
    // vérifier les contrats et d'annoncer l'heure. Avant, personne ne peut acheter. C'est aussi
    // le début du calendrier du blocage. Obligatoire sur le mainnet.
    openAt: "2026-11-12T00:00:00Z",
  },
  community: {
    // Réserve communauté (concours de mèmes, récompenses), en % de l'offre (0 à 99).
    // Versée au Safe ci-dessous au déploiement (elle ne peut pas bouger avant l'ouverture) :
    // tout le monde voit son solde. 0 = pas de réserve.
    percent: 3,
    // Safe 2 sur 3 dédié à la communauté (app.safe.global, réseau Robinhood Chain) :
    // 3 propriétaires (ex. ton Ledger, un 2e wallet, une personne de confiance), 2 signatures
    // pour chaque envoi. Le wallet de déploiement ne doit PAS en être propriétaire.
    // Il reçoit aussi 60 % des frais d'échange du pool. Le Safe doit EXISTER avant npm run deploy:mainnet :
    // le script refuse de déployer si cette adresse n'est pas un vrai Safe (elle est gravée dans
    // le lanceur). Obligatoire. Colle-la avec ses majuscules et minuscules d'origine.
    beneficiary: "0x14aaC4b3072022142a2Fd597ED29FDC7bF602CFF",
  },
  team: {
    // Safe 2 sur 3 de l'équipe (app.safe.global, réseau Robinhood Chain), avec les MÊMES 3 clés
    // que le Safe communauté, mais une adresse différente : il reçoit 40 % des frais d'échange
    // du pool (le Safe communauté reçoit les 60 % restants). Le wallet de déploiement ne doit PAS
    // en être propriétaire. Il doit EXISTER avant npm run deploy:mainnet : le script vérifie que
    // c'est un vrai Safe (son adresse est gravée dans le lanceur). Obligatoire sur le mainnet ;
    // vide pour la répétition = un Safe d'essai. Colle-la avec ses majuscules et minuscules d'origine.
    safe: "0x64bAC8D0b36C3c4c0749904ac1b9fF2508cb4002",
  },
  vesting: {
    // Ta part va dans un contrat de vesting déployé par npm run deploy:mainnet juste AVANT le
    // lanceur, qui le remplit au déploiement. Ton wallet ne détient jamais ces tokens. Le
    // calendrier commence à pool.openAt : rien n'est libérable avant la falaise, puis la
    // libération est linéaire jusqu'à la fin. Personne ne peut retirer plus tôt, pas même toi.
    // Doit rester true si tu gardes une part.
    enabled: true,
    // Ta part, en % de l'offre (0 à 99). 10 avec une réserve de 3 % = ≈ 87 % dans le pool.
    percent: 10,
    // Durée totale du blocage, en jours (365 = un an).
    durationDays: 900,
    // Falaise : rien n'est libérable avant ce délai après pool.openAt, en jours (1 à durationDays).
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
    founders: "0x64bAC8D0b36C3c4c0749904ac1b9fF2508cb4002",
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
