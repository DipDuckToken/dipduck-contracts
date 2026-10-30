# Memecoin sur Robinhood Chain — kit de lancement

Un token ERC-20 minimal et les scripts pour le lancer proprement sur Robinhood Chain avec
une **courbe de lancement** (à la pump.fun) : tu n'apportes aucun ETH, la courbe vend le
token à prix croissant à partir d'une heure annoncée, puis ouvre **toute seule** le pool
Uniswap v2 quand elle a réuni sa cible, et brûle les parts LP. Ta part est versée à un
contrat de blocage (vesting) et la réserve communauté à un Safe, au même moment.
Vérification du code sur Blockscout et répétition générale sur une copie locale du
mainnet comprises.

Utilise un wallet neuf, dédié à ce token.

---

## Les contrats

### `contracts/LaunchCurve.sol` — la courbe de lancement

C'est elle que tu déploies. Elle crée le token (elle en est le seul `LAUNCHER`) et en garde
**100 %** : le wallet de déploiement ne détient jamais aucun token.

- **Prix** : produit constant avec des réserves **virtuelles** (`virtualEth`) : le premier
  acheteur paie déjà un vrai prix, sans que personne n'ait mis d'ETH réel. Le prix monte à
  chaque achat et redescend à chaque revente.
- **Achat et revente** (`buy`, `sell`) : à partir de l'heure d'ouverture (`openAt`), tout
  le monde peut acheter et revendre à la courbe (au plus ce qu'elle a vendu), avec un
  minimum reçu et une date limite (anti-sandwich). Pas de frais, pas d'owner, rien de
  modifiable.
- **Ouverture du pool (graduation)** : l'achat qui atteint la cible (`targetEth`) est
  plafonné à l'ETH manquant (le surplus est rendu). Dans la même transaction, la courbe
  verse ta part au contrat de blocage et la réserve au Safe communauté, brûle les arrondis,
  puis met **tout l'ETH réuni** et le reste des tokens dans la paire Uniswap v2 au prix
  exact de fin de courbe, et envoie les parts LP à `0x000000000000000000000000000000000000dEaD`.
- **Personne ne peut ouvrir le pool avant elle** : le token refuse tout envoi vers la paire
  qui ne vient pas de la courbe tant que le pool n'est pas ouvert. Une paire créée d'avance
  par un tiers, ou un don de WETH, ne bloque rien.
- **Cible jamais atteinte** : la courbe continue simplement de fonctionner ; ta part et la
  réserve restent dedans (personne ne peut les revendre).

**Anti-bot** : pendant les 24 h qui suivent `openAt`, un wallet ne peut pas détenir plus de
**0,5 %** de l'offre (1re heure), puis 1 % (jusqu'à 6 h), puis 2 % (jusqu'à 24 h) en
achetant sur la courbe. Après l'ouverture du pool, le token applique à son tour les mêmes
24 h de limite sur Uniswap. Avec la config par défaut, 0,5 % de l'offre coûte ≈ 0,0097 ETH
au premier achat : un robot paie dès la première seconde un vrai prix, et ne peut pas tout
rafler.

### `contracts/MemeToken.sol` — le token

Il hérite de l'ERC-20 d'OpenZeppelin 5.6.1, créé par la courbe.

| Ce qu'il fait | Ce qu'il ne fait pas |
| --- | --- |
| Émet toute l'offre une seule fois, à sa création, vers la courbe | Pas d'owner, aucune fonction d'administration |
| 18 décimales, nom et symbole fixés au déploiement | Pas d'émission après le déploiement (pas de `mint`) |
| Offre bornée à `2^112 - 1` unités de base | Pas de pause, pas de liste noire, pas de taxe |
| Limite par wallet pendant les 24 h qui suivent l'ouverture du pool, puis plus rien | N'accepte pas d'ETH (rien ne peut y rester bloqué) |
| Avant l'ouverture, seule la courbe peut envoyer des tokens à la paire | |

Pourquoi si peu : les scanners de risque (honeypot, rug) signalent toute fonction
d'administration, et un contrat immuable ne peut être modifié par personne.

Pourquoi `2^112` : c'est la taille des réserves d'une paire Uniswap v2. Au-delà, toute
l'offre ne pourrait pas entrer dans le pool, et de grosses ventes échoueraient. La borne
tient aussi dans un u128 (CW20 en `Uint128`, `Balance` Substrate en `u128`), ce qui garde
la porte ouverte à un pont lock-and-mint. Maximum : 5 192 296 858 534 827 tokens.

### `contracts/TokenVesting.sol` — le blocage de ta part

Le `VestingWalletCliff` d'OpenZeppelin 5.6.1, sans modification sauf une (voir plus bas).
Il est déployé **juste avant la courbe** (il ne dépend pas du token) et reçoit ta part à
l'ouverture du pool. Son calendrier, fixé une fois pour toutes, **commence à `openAt`** :
- rien n'est libérable avant la **falaise** (par défaut 90 jours, au moins 1) ;
- à la falaise, la part correspondant au temps écoulé devient libérable d'un coup
  (90 jours sur 900 = 10 %), puis le reste se libère seconde par seconde jusqu'à la
  **fin** (par défaut 900 jours) ;
- n'importe qui peut déclencher le versement (`release`), mais les tokens vont toujours
  au **bénéficiaire** (ton wallet fondateur, `vesting.beneficiary`).

Aucune fonction ne permet de retirer plus tôt, pas même au bénéficiaire. La seule
modification : `renounceOwnership` est désactivée. Sans propriétaire, les tokens libérés
partiraient vers l'adresse 0, ce que l'ERC-20 refuse : ta part resterait bloquée pour
toujours. Le bénéficiaire peut seulement se faire remplacer par une autre adresse
(`transferOwnership`), ce qui ne change ni le calendrier ni les montants.

---

## Prérequis

- Node.js 22 LTS et npm.
- Un **wallet neuf** pour le déploiement. Jamais une clé liée à un autre projet.
- Un peu d'ETH sur Robinhood Chain pour les **frais seulement** (deux déploiements) : tu
  n'apportes aucun ETH au pool. Ponts listés dans la doc :
  <https://docs.robinhood.com/chain/bridging> (pont Arbitrum officiel, Relay, Across, etc.).
- Le **Safe communauté** (2 sur 3, sur app.safe.global, réseau Robinhood Chain) créé
  **avant** le déploiement : son adresse est gravée dans la courbe.
- Recommandé pour le jour J : une clé RPC Alchemy (le RPC public est limité en débit).

```bash
npm install
npm test
```

---

## Configuration

### 1. Les paramètres du lancement — `launch.config.ts`

C'est le seul fichier à modifier.

```ts
token: {
  name: "Dip Duck",        // 1 à 40 caractères
  symbol: "DIPDUCK",       // 2 à 11 caractères, majuscules et chiffres
  supply: 1_000_000_000n,  // offre en tokens entiers
},
curve: {
  tokenPercent: 87,        // part de l'offre confiée à la courbe (vendue + pool)
  virtualEth: "4",         // réserve d'ETH virtuelle : fixe le prix de départ
  targetEth: "3",          // ETH à réunir pour ouvrir le pool (il y va en entier)
  openAt: "",              // heure d'ouverture des achats, ISO en UTC (obligatoire sur le mainnet)
},
community: {
  percent: 3,              // réserve communauté (concours, récompenses), 0 = aucune
  beneficiary: "",         // Safe 2 sur 3 dédié (obligatoire si percent > 0)
},
vesting: {
  enabled: true,           // ta part ne peut exister que bloquée
  durationDays: 900,       // durée totale du blocage, à partir de openAt
  cliffDays: 90,           // rien n'est libérable avant (au moins 1 jour)
  beneficiary: "0x…",      // wallet fondateur (Ledger) qui reçoit les tokens libérés
},
```

**Les chiffres de la courbe** (config par défaut, offre de 1 milliard) — le script de
déploiement les recalcule avec les formules exactes du contrat et les affiche avant tout
envoi :

| | Valeur |
| --- | --- |
| Confiés à la courbe | 87 % : ≈ 55,4 % vendus sur la courbe, ≈ 31,6 % mis dans le pool, le reste (arrondis) brûlé |
| Prix de départ | ≈ 0,0000000031 ETH par token (capitalisation de départ ≈ 3,10 ETH) |
| 0,5 % de l'offre au premier achat | ≈ 0,0155 ETH |
| Prix à l'ouverture du pool | × 3,06 (capitalisation ≈ 9,48 ETH) |
| ETH dans le pool | 3 ETH, tout ce que la courbe a réuni |

`virtualEth` fixe le prix de départ (plus il est haut, plus un robot paie cher dès la
première seconde) ; `targetEth` fixe la taille du pool et le prix de fin (prix multiplié
par `((virtualEth + targetEth) / virtualEth)²`). Les scripts refusent `virtualEth` hors de
0,01–1 000 ETH, `targetEth` hors de 0,01–10 000 ETH, les valeurs d'exemple sur un vrai
réseau et tout nom ou symbole contenant « hood » (voir *Marque*).

**L'heure d'ouverture (`openAt`)** : une date ISO avec fuseau, par exemple
`"2026-12-01T20:00:00Z"` (UTC). Le contrat exige qu'elle soit dans le futur et à 30 jours
au plus du déploiement ; sur le mainnet, le script demande en plus **au moins 1 h** de
marge, pour vérifier les contrats et annoncer l'heure. C'est aussi le début du calendrier
du blocage. Annonce l'heure et l'adresse de la **courbe** : c'est là qu'on achète, pas sur
Uniswap.

**Combien de tokens ?** 1 milliard (la valeur par défaut) est le standard des memecoins :
1 % de l'offre = 10 millions de tokens, facile à lire. L'offre ne change pas la
capitalisation, seulement le prix affiché par token : c'est `virtualEth` qui fixe la
valeur de départ.

**Combien garder ?** Ta part vaut `100 − tokenPercent − community.percent`. Par défaut :
87 % à la courbe, 3 % de réserve communauté, 10 % pour toi. Tout le monde voit les plus
gros détenteurs sur Blockscout et DexScreener : au-delà de 10 %, une part de créateur est
vue comme un risque. Ta part ne peut exister que **bloquée** (`vesting.enabled: true`) ;
avec `tokenPercent + community.percent` égal à 100, tu ne gardes rien et aucun contrat de
blocage n'est déployé.

**La réserve communauté** va au Safe communauté à l'ouverture du pool : annonce son
adresse, tout le monde peut suivre son solde. Le script vérifie sur la chaîne, avant de
déployer, que c'est un vrai Safe (version officielle, au moins 2 signatures sur 3
propriétaires, sans module ni garde) dont le wallet de déploiement n'est **pas**
propriétaire.

### 2. Les secrets — keystore chiffré de Hardhat

Rien dans un fichier `.env`, rien dans le dépôt. Le keystore chiffre les valeurs avec un
mot de passe demandé à chaque lancement.

```bash
npx hardhat keystore set DEPLOYER_PRIVATE_KEY
# Optionnel mais recommandé : ton URL Alchemy Robinhood Chain
npx hardhat keystore set ROBINHOOD_RPC_URL
```

Sans `ROBINHOOD_RPC_URL`, le RPC public de la doc est utilisé
(`https://rpc.mainnet.chain.robinhood.com`). Pour le testnet, même principe avec
`ROBINHOOD_TESTNET_RPC_URL`.

---

## Le lancement, étape par étape

| # | Commande | Réseau | Ce qui se passe |
| --- | --- | --- | --- |
| 1 | `npm test` | local | Tests Solidity (dont fuzzing) et tests du lancement complet |
| 2 | `npm run rehearsal` | copie locale du mainnet | Lancement complet avec les vrais contrats Uniswap : blocage, courbe, achats, revente, cible atteinte, pool ouvert, achat sur Uniswap |
| 3 | `npm run deploy:mainnet` | **mainnet** | Contrat de blocage, puis courbe (qui crée le token), + vérification Blockscout des trois |
| 4 | — | — | Annonce l'heure d'ouverture et l'adresse de la courbe. À `openAt`, les achats s'ouvrent tout seuls ; à la cible, le pool aussi |
| 5 | `npm run status:mainnet` | mainnet, lecture seule | État de la courbe (ETH réuni, % vendu, prix, limite par wallet), de ta part, de la réserve et du pool |
| plus tard | `npm run release:mainnet` | mainnet | Après la falaise : verse au bénéficiaire ce qui est libéré |

Il n'y a plus d'étape de blocage ni d'étape de liquidité séparées : le contrat de blocage
est déployé par la même commande, juste avant la courbe, et c'est la courbe qui le
remplit et qui ouvre le pool. Ton wallet ne détient jamais de tokens.

La répétition (étape 2) avance le temps sur sa copie locale : ouverture, 24 h de limite,
cible, puis falaise et fin du blocage. Sans Safe communauté dans la config, elle déploie
un Safe d'essai 2 sur 3 sur sa copie locale.

Sur le mainnet, le script affiche d'abord son plan complet (répartition, prix,
capitalisations, heure d'ouverture, calendrier du blocage, frais estimés). Rien n'est
envoyé tant que tu n'as pas **retapé le symbole du token** ; toute autre réponse annule.

**Testnet.** Uniswap v2 n'est pas référencé sur le testnet de Robinhood Chain, et la
courbe en a besoin : `npm run deploy:testnet` refuse donc de partir et renvoie vers la
répétition (étape 2), qui couvre tout le lancement sur l'état réel du mainnet.

**Pendant tout le lancement**, n'utilise ce wallet nulle part ailleurs (pas de MetaMask
en parallèle) : les scripts gèrent eux-mêmes l'ordre de ses transactions (nonces).

---

## Ce que les scripts vérifient pour toi

**Avant tout envoi**
- Le réseau est le bon et le RPC répond avec le bon chain ID (4663 mainnet, 46630 testnet).
- Nom, symbole et offre sont valides ; aucune marque Robinhood ; pas de valeurs d'exemple.
- Les paramètres de la courbe sont raisonnables et acceptés par le contrat (mêmes
  formules), l'heure d'ouverture est dans la fenêtre permise.
- Les adresses Uniswap pointent vers de vrais contrats, et le routeur officiel annonce
  bien la factory et le WETH attendus.
- Le Safe communauté est un vrai Safe 2 sur 3 sans le wallet de déploiement. Le
  bénéficiaire du blocage est un wallet ordinaire, avec sa casse d'origine, différent du
  wallet de déploiement sur le mainnet.
- Le solde couvre les frais. Le plan signale si le wallet a déjà envoyé des transactions
  (donc s'il n'est pas neuf).
- Le déploiement de la courbe est **simulé** à l'identique juste avant la signature, et
  l'heure d'ouverture recontrôlée.

**Après**
- La courbe et le token sont relus sur la chaîne (adresse du token, heure d'ouverture,
  ETH virtuel, cible, nom, symbole, offre) avant de noter le déploiement confirmé.
- Les codes de la courbe, du token (créé par la courbe) et du contrat de blocage sont
  vérifiés sur Blockscout : tout le monde peut lire les règles.

**Journal et reprise : jamais de double envoi**
- Chaque transaction (contrat de blocage, courbe) est **signée sur ton ordinateur, puis
  notée** dans `deployments/<réseau>.json` — octets signés et hash compris — **avant**
  d'être diffusée (écriture atomique). Le hash, l'adresse de la courbe et celle du token
  sont donc connus avant que quoi que ce soit parte sur le réseau.
- Si un script est interrompu à n'importe quel moment (coupure, erreur RPC, Ctrl-C),
  relance **la même commande**. Pour une transaction notée, elle :
  - cherche son reçu par hash : s'il existe, elle confirme ;
  - sinon, rediffuse **exactement les mêmes octets** : la même transaction, jamais une
    seconde ;
  - si le réseau la refuse parce que les frais ont monté entre-temps, la re-signe avec
    **le même nonce** (deux versions ne peuvent pas passer toutes les deux), après une
    nouvelle confirmation sur le mainnet ;
  - ne remet le journal à l'étape précédente que sur la preuve d'un échec : le reçu de
    *ta* transaction, en échec (par exemple une courbe diffusée après son heure
    d'ouverture). Un reçu introuvable, un RPC muet ou en retard ne font jamais rien
    effacer : le script s'arrête et la relance reprend le suivi.
- Le nonce de chaque nouvelle transaction n'est jamais inférieur à ce que le journal sait
  déjà utilisé (`nonceFloor` : transactions réussies et en échec) : un RPC public en
  retard ne peut pas faire réutiliser un nonce.
- Un verrou (`deployments/<réseau>.lock`) empêche deux lancements simultanés sur le même
  réseau, par exemple depuis deux terminaux. Un verrou laissé par un script arrêté
  brutalement est repris automatiquement.
- Si le contrat de blocage est confirmé mais pas la courbe, la relance le réutilise (il
  est vide) à condition que `curve.openAt` n'ait pas changé : son calendrier commence à
  cette heure-là.

> **Tant qu'une entrée du journal est `"pending"`, le fichier contient une transaction
> signée prête à partir.** Ne le publie pas dans cet état (pas de `git push`). Pour
> abandonner volontairement une entrée `"pending"` : envoie n'importe quelle transaction
> depuis ce wallet (par exemple 0 ETH à toi-même) — elle prend ce nonce et rend la
> transaction notée inutilisable — puis retire **seulement cette entrée** du fichier
> (`"vesting"` ou `"token"`), en gardant les autres. Une fois `"confirmed"`, les octets
> notés ne peuvent plus servir (nonce consommé).

---

## Le jour J : à savoir

- **Snipers.** Le séquenceur traite les transactions dans l'ordre d'arrivée et payer plus
  de frais ne fait pas passer devant. Des bots achèteront dès l'heure d'ouverture : la
  courbe leur fait payer un vrai prix dès le premier achat et les limite à 0,5 % de
  l'offre par wallet la première heure (puis 1 %, puis 2 %, jusqu'à 24 h). Un robot peut
  utiliser plusieurs wallets : la limite rend l'accaparement plus cher, pas impossible.
- **Rien à faire à l'heure d'ouverture** : les achats s'ouvrent tout seuls, et le pool
  aussi quand la cible est atteinte (l'acheteur qui l'atteint paie le gas de l'ouverture).
  `npm run status:mainnet` montre où en est la courbe.
- **Frais.** Les montants de gas affichés par la répétition sont ceux de l'exécution ; sur
  Robinhood Chain, chaque transaction paie aussi une part « données L1 ».
- **Après le lancement.** Ajoute logo, description et liens (section suivante). Annonce
  ta part et l'adresse de son contrat de blocage : tout le monde peut y lire le calendrier,
  et `npm run status:mainnet` montre combien reste bloqué.

---

## Ta part bloquée : suivi et versements

- **Suivi** : `npm run status:mainnet` affiche ce qui reste bloqué, ce qui a été versé, ce
  qui est libérable maintenant, et les dates de falaise et de fin.
- **Versement** : après la falaise, `npm run release:mainnet` verse au bénéficiaire ce que
  le calendrier a libéré. Tu peux le relancer quand tu veux (chaque mois, par exemple) :
  chaque appel ne verse que ce qui s'est libéré depuis le précédent. Il refuse de partir
  tant qu'une étape du lancement est en attente. On peut aussi le faire
  depuis Blockscout (onglet *Write contract* du contrat de blocage, fonction
  `release(address token)` avec l'adresse du token), avec n'importe quel wallet.
- **Le bénéficiaire** : garde précieusement sa clé. Sans elle, les tokens libérés arrivent
  sur une adresse que plus personne ne contrôle. Sur le mainnet, c'est obligatoirement ton
  wallet fondateur (Ledger), jamais le wallet de déploiement : tu en auras besoin pendant
  toute la durée du blocage. Le bénéficiaire peut transmettre son rôle à une autre
  adresse (`transferOwnership` sur Blockscout), jamais le calendrier.
- **Avant l'ouverture du pool**, le contrat de blocage est vide : ta part est encore dans
  la courbe, qui la lui verse à la cible. Si la cible n'est jamais atteinte, elle y reste.
- **Vendre ta part libérée** se fait dans le même pool que tout le monde : vends
  progressivement et en toute transparence. À la revente, c'est imposable (gain en capital
  ou revenu d'entreprise selon ton activité).

---

## Logo, description et liens

Le logo n'est pas dans le contrat : un ERC-20 n'a pas de champ « logo ». Il s'ajoute
après le déploiement, sur les sites qui affichent le token. Rien à coder.

**À préparer avant le jour J**
- **Le logo** : une image carrée originale — ni personnage connu, ni marque, et rien qui
  rappelle Robinhood (les conditions de la chaîne l'interdisent aussi dans le logo).
  PNG à fond transparent, 512 × 512 px, lisible même en tout petit : explorateurs et
  wallets l'affichent vers 32–48 px. Héberge-le à une adresse publique (ton site, par
  exemple) : Blockscout demande une URL.
- **Une bannière** large pour DexScreener (le formulaire en indique le format).
- **Une description** courte et factuelle (2 ou 3 phrases), avec la mention « Non
  affilié à Robinhood », sans promesse de rendement ni feuille de route.
- **Un site** (une page suffit) et un compte X ; Telegram si tu animes une communauté.

**Blockscout (gratuit)** — l'explorateur officiel de la chaîne :
1. Le code du token doit être vérifié : le déploiement s'en charge (sinon, relance la
   commande qu'il affiche).
2. Connecte-toi sur <https://robinhoodchain.blockscout.com> avec le **wallet de
   déploiement**. Une fois le pool ouvert, tu peux importer sa clé dans MetaMask pour
   ça — pas avant : pendant le lancement, ce wallet ne sert qu'aux scripts.
3. Page du token → menu « ⋮ » → *Add Token Info* : URL du logo (48 × 48, SVG ou PNG),
   description, liens.
4. L'équipe Blockscout relit la demande : gratuit, sans délai garanti. Une option express
   payante existe (99 USDC ou USDT, 1 à 7 jours ouvrables, non remboursable).

**DexScreener** — là où les acheteurs regardent. Il suit déjà Robinhood Chain : ta paire
y apparaît d'elle-même dès l'ouverture du pool, mais sans logo. La fiche complète
(*Enhanced Token Info* : logo, bannière, description, liens) est payante — 299 $ US au
moment d'écrire ces lignes, traitée en quelques minutes à 12 h. Facultatif, mais une
fiche vide fait mauvaise impression.

**Wallets et Uniswap** : ils reprennent les logos des listes de tokens et des
agrégateurs, plus tard, quand le token a du volume. Rien à faire au lancement.

---

## Adresses utilisées

| Contrat | Adresse (Robinhood Chain, 4663) | Source |
| --- | --- | --- |
| Uniswap V2 Factory | `0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f` | `@uniswap/sdk-core` 7.19.4 |
| Uniswap V2 Router02 | `0x89e5DB8B5aA49aA85AC63f691524311AEB649eba` | `@uniswap/sdk-core` 7.19.4 |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | `@uniswap/sdk-core` 7.19.4 et doc Robinhood Chain |

Elles sont dans `scripts/lib/networks.ts` et revérifiées sur la chaîne à chaque lancement.
Le routeur ne sert qu'à ce contrôle et aux achats de la répétition. Les adresses de la
courbe, du token, de la paire et du contrat de blocage sont notées dans
`deployments/robinhood.json`.

Explorateurs : <https://robinhoodchain.blockscout.com> (mainnet) et
<https://explorer.testnet.chain.robinhood.com> (testnet).

---

## Vérification du code sur Blockscout

Le déploiement la tente automatiquement pour la courbe, le token (créé par la courbe,
avec ses propres arguments) et le contrat de blocage (3 essais chacun, Blockscout met
quelques secondes à indexer). En cas d'échec, le script affiche la commande exacte à
relancer, du type :

```bash
npx hardhat verify blockscout --network robinhood 0xADRESSE_COURBE "Nom" "SYMBOLE" '["1000000000","0xBLOCAGE",…]'
npx hardhat verify blockscout --network robinhood 0xADRESSE_TOKEN "Nom" "SYMBOLE" 1000000000 0xFACTORY 0xWETH
npx hardhat verify blockscout --network robinhood 0xADRESSE_BLOCAGE 0xBENEFICIAIRE DEBUT DUREE FALAISE
```

Les profils de compilation `default` et `production` ont des réglages identiques, donc le
bytecode déployé correspond toujours à celui que Blockscout recompile.

---

## Tests

- `contracts/MemeToken.t.sol` : tests unitaires et de fuzzing (offre, borne uint112,
  transferts au montant exact, autorisations, refus de l'ETH).
- `contracts/LaunchCurve.t.sol` : paramètres, prix, achats, reventes, limites anti-bot,
  ouverture du pool (prix continu, dons, blocage de la paire), part et réserve versées à
  la cible, réentrance, fuzzing des invariants (la courbe ne doit jamais plus d'ETH
  qu'elle n'en a, aucun aller-retour gagnant).
- `test/curve.ts` : la courbe contre le vrai bytecode Uniswap v2 (ouverture au prix de fin
  de courbe, LP brûlées, snipers limités sur Uniswap, paire piégée d'avance).
- `contracts/TokenVesting.t.sol` : calendrier du blocage (rien avant la falaise,
  libération linéaire, tout à la fin), versement toujours au bénéficiaire quel que soit
  l'appelant, `renounceOwnership` désactivée ; fuzzing du montant libéré (jamais en
  baisse, jamais plus que la part).
- `contracts/DipDuckCards.t.sol` : mint (prix exact, limites, début), édition Trophée (communauté
  seulement, 111 au plus, une par wallet à vie, 2 cartes ou moins, tirage à part et jackpot,
  Plain au plancher, jamais de vote), 5 cadres et 4 joues, commit-reveal
  (avant le bloc cible, après, expiration → Plain, `revealMany`, révélation au passage),
  attributs déterministes, secrets, noms (fuzzing) ; périodes de 30 jours, cagnottes et
  répartition exacte, rien avant la fin d'une période, vote par période, gagnant et report,
  clôture et versements en mode pull (un destinataire qui refuse l'ETH ne bloque personne),
  propositions : dépôt rendu ou confisqué, snapshot (un mint de dernière minute ne vote pas),
  fenêtre de 7 jours, 2/3, quorum, 3 approbations par période, expiration après 6 périodes,
  wallet communauté sans vote, limite de 20.
- `contracts/DipDuckGame.t.sol` : genèse (validation, lecture), enregistrement des
  clôtures officielles (jours terminés seulement, mauvais round refusé, réponse invalide,
  changement de phase, panne du flux de 5 jours puis rattrapage, `startRun` pendant la panne,
  rattrapage de 200 jours avec le vrai prix de chaque jour), détection des baisses sur des séries construites (V net,
  palier plat, rebond et pic aux seuils exacts, espacement, bonus), temps minimal (table
  historique, cumul jour par jour, passage d'année, plafond 690), trimestres (frontières, id,
  `finishDay`, `ContestNotReady`, `DataBehind`), rejeu écrit à la main (parfait, bien, raté, saut et
  pièces, saut en l'air ignoré, touche en l'air jugée, pièces jamais deux fois, fin de course),
  `InvalidTaps`, `NoRun`, `RunExpired`, `TooFast`, `NotBetter`, départage complet, top 50 ;
  fuzzing : rejeu comparé à une implémentation de référence écrite d'après la règle, formule
  du temps minimal, trimestres.
- `test/game.ts` : fichier de genèse (validation), flux de prix (code, 8 décimales),
  déploiement journalisé depuis un JSON, partie soumise, déploiement de la vraie genèse du
  site s'il existe (125/125 baisses et 185/185 pièces atteignables) et gas (`recordDay` avec
  les rounds du flux d'essai, `startRun`, `submit` d'une partie complète).
- `test/nft.ts` : paramètres des cartes, déploiement journalisé, mint, révélation et JSON
  des métadonnées décodé.
- `test/guards.ts` : surface des contrats (les 9 fonctions ERC-20 plus la lecture de
  l'anti-bot pour le token ; seulement `buy` et `sell` en écriture pour la courbe),
  garde-fous des paramètres (courbe, heure d'ouverture, réserve, blocage), répartition de
  l'offre et chiffres de la courbe, journal et verrou, formats d'affichage.
- `test/launch-flow.ts` : le lancement complet contre le **vrai bytecode Uniswap v2**
  (artefacts npm officiels), avec les mêmes fonctions que les scripts :
  - déploiement de la courbe : adresses de la courbe et du token prévues avant diffusion,
    100 % de l'offre dans la courbe, chiffres du plan identiques aux vues du contrat, pas
    de second déploiement ; refus d'une heure d'ouverture passée, imminente ou à plus de
    30 jours, et d'un contrat de blocage ou d'un Safe sans code, sans rien envoyer ;
  - ouverture du pool à la cible, au prix de fin de courbe, LP toutes brûlées ;
  - reprises après interruption : transaction signée mais jamais diffusée (courbe,
    contrat de blocage), réponse du RPC perdue, transaction encore en attente, RPC
    muet, nonce pris par une autre transaction, frais devenus trop bas (re-signature au
    même nonce), version précédente minée après une re-signature, solde insuffisant au
    moment de diffuser, RPC en retard sur le nonce ;
  - échec définitif (courbe diffusée après son heure d'ouverture) : seul le reçu en échec
    de ta transaction remet le journal en arrière, et son nonce reste compté ;
  - blocage et réserve : contrat de blocage déployé avant la courbe, tout reste dans la
    courbe jusqu'à la cible, puis ta part au blocage et la réserve au Safe aux montants
    exacts ; cible jamais atteinte : rien ne sort ; libération dans le temps (falaise
    puis fin), personne ne peut retirer plus tôt ;
  - répétitions complètes (sans part, avec blocage et Safe d'essai) ;
  - achat puis revente sur Uniswap après l'ouverture, sans taxe.

```bash
npm test               # tout
npx hardhat test solidity
npx hardhat test mocha
npm run typecheck
```

---

## Après le lancement : les cartes NFT Dip Duck

`contracts/DipDuckCards.sol` — cartes de collection ERC-721 (« Dip Duck Cards », `DDCARD`).
Ce sont des objets de collection pour le plaisir : **aucune valeur, aucun droit, aucune
promesse**, et rien ne va dans le pool du token. À déployer 2 à 4 semaines après DIPDUCK.

| Ce qui est fixé dans le contrat | Valeur |
| --- | --- |
| Offre | 3 333 cartes, dont 111 de réserve : l'édition Trophée (gratuites, frappées par le wallet communauté pour les concours) |
| Prix | 0,001 ETH par carte, prix exact ; 10 cartes au maximum par wallet |
| Répartition de chaque mint | 30 % fondateurs, 30 % fondation, le reste (40 %) communauté, dans les cagnottes de la **période de 30 jours** en cours |
| Versements (mode pull) | **rien avant la fin d'une période** ; ensuite n'importe qui la clôture (`closeRounds(max)`, dans l'ordre) : les parts sont **créditées** en soldes dus (`owed(adresse)`) aux adresses fixées au déploiement et à la fondation gagnante. Puis n'importe qui déclenche `withdraw(destinataire)`, qui n'envoie qu'à ce destinataire son dû. S'il refuse l'ETH, la transaction réussit, son solde reste crédité (`WithdrawFailed`) et personne d'autre n'est bloqué. Événements : `RoundClosed`, `Credited`, `CharityReleased`, `Withdrawn`… (traçables sur Blockscout) |
| Vote de la fondation | à chaque période, 1 carte = 1 voix (une carte revote à chaque période) ; la cagnotte fondation de la période va au gagnant ; égalité → le plus petit index ; sans aucune voix, elle est reportée sur la période en cours |
| Nouvelles fondations | un détenteur propose (`propose`) avec un **dépôt de 0,005 ETH**, un nom (40 octets), la description (280) et le lien `https://` (200 octets) de la **page officielle de dons qui affiche l'adresse** ; **snapshot** : seules les cartes n° 1 à `totalMinted` au moment de la proposition votent, oui ou non, une fois chacune, pendant **7 jours pleins** (indépendants des périodes) ; ensuite n'importe qui finalise : approuvée si oui ≥ 2/3 des voix exprimées **et** oui + non ≥ quorum = max(25, 10 % des cartes du snapshot, arrondi au-dessus). Approuvée : candidate dès la période suivante, dépôt rendu (crédité). Refusée : dépôt versé à la cagnotte communauté de la période en cours. **3 approbations au plus par période** et 20 fondations actives au plus : au-delà, la proposition finit « sans place » (`FULL`), dépôt rendu, et elle peut être reproposée. Une fondation approuvée qui ne gagne **aucune période pendant 6 périodes de suite** expire et libère sa place (les fondations de départ n'expirent pas). Une seule proposition ouverte par wallet de fondation ; le dépôt remplace l'ancienne limite d'une proposition par adresse et par période |
| Édition Trophée (réserve) | les 111 cartes de réserve sont des prix de concours gratuits, frappés par le wallet communauté (`mintTrophy(to, nom, humeur, élément, nombre)`, une par appel) : **une seule par wallet à vie** (`trophyReceived`), seulement pour un wallet qui détient **2 cartes ou moins** au moment du mint, jamais pour le wallet communauté. Tirage à part : sans l'option la plus commune de chaque attribut (sans les deux plus communes pour le cadre et les joues), donc au moins « épique » sur le site (top 3,6 % au pire, aussi pour une carte Plain) ; l'option plancher pèse 8 fois plus, sauf « jackpot » (premier octet de la graine < 23, ≈ 9 %) où les poids restent normaux. Résultat visé et simulé : ≈ 70 % épiques, 25 % légendaires, 5 % mythiques (≈ 6 sur 111). Paliers du site, sur le score des cartes achetées : épique top 5 %, légendaire top 1 %, **mythique top 0,1 %** (≈ 3 à 4 cartes achetées sur 3 222). Les tirages des cartes achetées ne changent pas. `cardOf` renvoie `trophy`, et le JSON porte l'attribut `edition: trophy`. **Une carte Trophée ne vote jamais** (ni période, ni propositions, même transférée) ; le wallet communauté ne vote pas et ne propose pas |
| Métadonnées | JSON entièrement sur la chaîne (`tokenURI`), image `<imageBaseURI><numéro>.png`, page `<viewerURI>?id=<numéro>` |

Pas d'owner, rien de modifiable après le déploiement. Le vote, une proposition et une
finalisation clôturent au passage les périodes terminées (12 au plus), pour que la liste des
fondations soit à jour ; `closeRounds` reste appelable par tous.

**Règle de secours (3 périodes sans voix).** Une cagnotte sans voix est normalement reportée sur la période en cours. Mais si personne n'a voté depuis 3 périodes (`FALLBACK_AFTER`), ou jamais depuis le début en comptant la période 0, elle n'est plus reportée : elle va à la **dernière gagnante** (si elle est encore dans la liste), ou, si personne n'a jamais voté (ou si elle a expiré), elle est **partagée à parts égales** entre les fondations admises à cette période (le reste de la division à la première). Le site lit `charityPlan(période)` pour afficher ce qui se passera : 0 rien, 1 gagnante, 2 report, 3 dernière gagnante, 4 partage égal.

**Le tirage (commit-reveal).** Au mint, le joueur choisit nom, humeur, élément et nombre
porte-bonheur ; la carte note le bloc. Deux blocs plus tard (≈ 24 s), n'importe qui peut la
révéler (`reveal`, ou `revealMany` pour plusieurs cartes en une transaction ; chaque mint en
révèle aussi jusqu'à 3 au passage). La graine dépend du hachage d'un bloc **futur** au moment
du paiement : impossible de re-tirer jusqu'à une Légendaire. Après ≈ 51 minutes sans
révélation, ce hachage n'est plus lisible : la carte devient « Plain » (tout au plus commun),
donc attendre n'avantage jamais.

**Limite assumée : ce hasard est pseudo-aléatoire, non certifié.** Sur Robinhood Chain
(Arbitrum Nitro), `block.number` est une estimation du bloc Ethereum et `blockhash` un hachage
pseudo-aléatoire : le séquenceur de la chaîne pourrait en théorie le prévoir. Aucun service de
hasard vérifiable (Chainlink VRF) n'est déployé sur ce réseau. Pour des objets sans valeur, ce
compromis est acceptable ; annonce-le tel quel.

**Texte libre des propositions.** Le nom, le lien et la description d'une proposition ne sont
pas filtrés par le contrat (le lien doit seulement commencer par `https://`) : le site les
affiche toujours comme du **texte brut**, montre le nom de domaine en clair avec « lien externe
non vérifié », ne rend le lien cliquable qu'une fois la proposition approuvée, et affiche
l'adresse bénéficiaire **complète** (contre l'empoisonnement d'adresse).

**Configuration** — bloc `nft` de `launch.config.ts` : date de début du mint et de la première
période (`mintStart`, ISO en UTC), wallet des fondateurs (vide = wallet de déploiement), 2 à 5
fondations de départ `{ name, address, url }`, adresses publiques des images et de la page d'une
carte. Le wallet communauté est `community.beneficiary`. Sur le mainnet, tout est obligatoire.

```bash
npm run nft:deploy:testnet
npm run nft:deploy:mainnet   # plan, puis retape le symbole du token
```

Même mécanique que les autres étapes : transaction notée dans le journal (entrée `"nft"`)
avant sa diffusion, reprise sans doublon, vérification Blockscout. Mets ensuite l'adresse
affichée dans la `CONFIG` du site.

Pendant la vente, laisse tourner le robot de révélation sur ton PC :

```bash
npm run nft:reveal:mainnet   # toutes les 5 min, révèle les cartes prêtes (Ctrl+C pour arrêter)
```

Une carte non révélée dans les 256 blocs qui suivent son bloc cible reste « Plain » pour
toujours (une carte Trophée tombe au plancher épique). Les mints et le site en révèlent déjà ;
le robot couvre une page fermée ou une période creuse. Il ne paie que le gas de `revealMany`.

Avant le mainnet : un avocat (statut des cartes, vote, dons) et un comptable (revenus de
mint). Vérifie aussi qu'un marché NFT accepte Robinhood Chain : sinon, les cartes se voient
dans les wallets et sur Blockscout, mais s'échangent difficilement.

---

## Jeu « Attrape la baisse »

`contracts/DipDuckGame.sol` — le mini-jeu du site, **un seul contrat pour toujours** : le
canard glisse sur la courbe du Bitcoin depuis 2010 et doit attraper les baisses. Pas d'owner,
pas d'ETH, aucune fonction d'administration : **public et permanent**, personne (pas même
toi) ne peut changer une baisse ni effacer un résultat.

- **La courbe (prix décalé).** L'historique (baisses, bonus, temps minimaux) est figé au
  déploiement depuis la genèse du site. Ensuite, la courbe **s'arrête à hier** :
  `recordDay(roundIds)` (appelable par tous) n'enregistre que des jours UTC terminés, chacun à
  sa **clôture officielle** Chainlink BTC/USD. L'appelant fournit un round par jour ; le
  contrat vérifie avec `getRoundData` que ce round a été publié au plus tard à minuit de fin du
  jour et que le round suivant l'a été après (même phase : `roundId + 1`, avec
  `roundId = phaseId << 64 | numéro` ; changement d'agrégateur juste après : premier round de
  la phase suivante, `(phaseId + 1) << 64 | 1`). Un seul round convient par jour : l'appelant
  ne choisit rien. Tant que le round suivant n'existe pas, le jour est refusé (`DayNotFinal`) ;
  un mauvais round ou une réponse ≤ 0 aussi (`BadRound`). Plus de remplissage à plat : après
  une panne, chaque jour est rattrapé avec sa vraie clôture (60 jours au plus par appel,
  `closeOf(jour, round)` pour vérifier gratuitement). Le site calcule les rounds (recherche
  par paliers sur `getRoundData`, environ 3 lots de 16 lectures par jour). Le contrat
  **détecte lui-même les nouvelles baisses** avec
  une règle fixe : creux du prix lissé (médiane sur 3 jours), au moins 10 % sous le pic des 30
  jours précédents, rebond d'au moins 5 % dans les 14 jours suivants, 8 jours au moins après
  la baisse précédente. `priceAt`, `pricesFrom`, `dipCount`, `dipAt` : lecture libre.
- **Concours.** Un par trimestre civil UTC, automatique (`currentContest()`, id =
  (année − 2026) × 4 + trimestre − 1). La course d'un concours s'arrête 16 jours avant le
  début de son trimestre (`contestFinishDay`), quand toutes ses baisses sont connues.
  Classement : le plus loin, puis le plus de baisses attrapées, puis de pièces, puis le
  meilleur score ; à égalité, le plus ancien. Top 50 et meilleur résultat par joueur, par
  concours (`topList`, `topCount`, `best`). Pseudo : 16 caractères au plus, `A-Z a-z 0-9
  espace _ - .`.
- **Parties vérifiées.** Le joueur envoie ses touches ; le contrat **rejoue la partie** avec
  les règles entières du site (`verify(touches, finishDay)`, lisible gratuitement) : baisses
  (parfait, bien, raté), sauts de 216 pixels et pièces (une tous les 20 jours, jamais de 2 jours avant à 14 jours après une baisse, ramassées au sommet du saut, en x + 108 à 24 pixels près : toutes atteignables), 3 vies. `startRun()` note l'heure et le concours ;
  `startRun` ne lit aucun prix (il marche pendant une panne du flux) : il exige seulement que
  les prix couvrent la course (`finishDay + 15` enregistré), sinon `DataBehind` — le site
  appelle alors `recordDay` d'abord (en pratique au début de chaque trimestre).
  **Flux de secours** (`game.backupFeed`, facultatif, figé au déploiement) : si le flux principal
  n'a rien publié depuis 2 jours, `recordDayBackup` enregistre les jours avec le secours, mêmes
  vérifications. **Mode dégradé** : si, 14 jours après le début d'un trimestre, les prix ne
  couvrent toujours pas sa course, le concours se joue sur ce qui est connu (arrivée au dernier
  jour évaluable, `lastRecordedDay − 15`), figée au premier départ (`ContestFrozen`) et pour
  toujours pour ce concours. Le jeu ne se bloque donc jamais, même si Chainlink retire son flux.
  Le jeu est **pour le plaisir, sans prix** : une partie parfaite se calcule d'avance.
  `submit(touches, pseudo)` refuse une partie plus rapide que le vrai jeu (`TooFast`, temps
  minimal `minTimeFor` : table historique, puis cumul jour par jour calculé par la chaîne),
  plus vieille que 3 heures (`RunExpired`) ou sans départ (`NoRun`).
- **Ce qui reste possible :** un programme qui joue vraiment, en temps réel. Le contrat
  garantit que chaque résultat correspond à une partie jouable à vitesse réelle, pas qu'un
  humain l'a jouée. **Risque résiduel assumé :** la course ne contient que des jours passés,
  donc une partie parfaite est calculable hors ligne ; la rejouer à la vitesse du jeu revient
  exactement au cas du programme ci-dessus (pas un risque de plus). Annonce-le tel quel ; aucun
  prix à la clé.

La genèse vient du fichier partagé avec le site (`game.genesisFile` dans `launch.config.ts`,
par défaut `../dipduck-site/seasons/genesis.json`, format `{ "detectFrom": n, "dips":
[[jour, bonus], ...], "histMinSeconds": [...], "recentPrices": [...] }`). Le script la valide
avec les règles du contrat et contrôle le flux (`game.feed` sur le mainnet,
`game.testnetFeed` sur le testnet : code présent, 8 décimales, `getRoundData` qui répond)
avant tout envoi. Le flux d'essai (`MockAggregator`) garde l'historique de ses rounds et
simule les phases.

```bash
npm run game:deploy:testnet
npm run game:deploy:mainnet   # plan, puis retape le symbole du token
```

Indépendant du token. Même mécanique que les autres étapes : transaction notée dans le
journal (entrée `"game"`, genèse comprise) avant sa diffusion, reprise sans doublon,
vérification Blockscout. Mets ensuite l'adresse affichée dans la `CONFIG` du site.

---

## Marque et conformité

- Les conditions de Robinhood Chain interdisent leurs marques (ou une marque qui y
  ressemble) dans un nom, un ticker, un logo ou les métadonnées d'un token, ainsi que
  toute référence à `$HOOD`. Elles exigent aussi une autorisation écrite pour utiliser
  ces marques « en lien avec une émission de token » (section 5.11). Le plus sûr : ne
  citer le réseau que comme information technique (« réseau : Robinhood Chain,
  chain ID 4663 »), sans logo et sans en faire un argument de promotion, avec la mention
  que le projet n'est ni affilié à Robinhood ni approuvé par Robinhood.
- Aucune promesse : pas de feuille de route financée par la vente, pas de rendement,
  pas d'annonce de migration vers un autre projet. C'est ce qui rapproche un token d'un
  placement au sens des lois sur les valeurs mobilières. Ce kit n'est pas un avis
  juridique : au Québec, un avocat en valeurs mobilières reste le bon interlocuteur.

---

## Plus tard : un pont vers une autre chaîne

Rien à changer dans le contrat. Un pont lock-and-mint verrouille les tokens dans un coffre
sur Robinhood Chain et émet l'équivalent de l'autre côté ; il fonctionne avec n'importe
quel ERC-20 standard, sans owner. L'offre tient déjà dans un u128.

---

## Structure

```
contracts/
  MemeToken.sol          le token
  MemeToken.t.sol        tests Solidity (unitaires + fuzzing)
  LaunchCurve.sol        courbe de lancement : crée le token, vend, ouvre le pool, LP brûlées
  LaunchCurve.t.sol      tests Solidity de la courbe
  TokenVesting.sol       blocage de ta part (VestingWalletCliff d'OpenZeppelin)
  TokenVesting.t.sol     tests Solidity du blocage
  DipDuckCards.sol       cartes de collection NFT (après le lancement)
  DipDuckCards.t.sol     tests Solidity des cartes
  DipDuckGame.sol        jeu « Attrape la baisse » : clôtures Chainlink, baisses, concours, rejeu
  DipDuckGame.t.sol      tests Solidity du jeu
  mocks/MockAggregator.sol flux de prix d'essai (tests uniquement)
scripts/
  00-rehearsal-fork.ts   répétition générale sur copie locale du mainnet
  01-deploy.ts           contrat de blocage puis courbe (qui crée le token) + vérification Blockscout
  04-status.ts           état du lancement (lecture seule)
  05-release.ts          versement de ta part libérée au bénéficiaire
  06-deploy-nft.ts       déploiement des cartes NFT + vérification Blockscout
  07-deploy-game.ts      déploiement du jeu (genèse du site) + vérification Blockscout
  lib/                   étapes, journal, contrôles : partagés par les scripts et les tests
test/                    tests TypeScript (Mocha)
deployments/             journal du lancement, créé au premier envoi
launch.config.ts         tes paramètres
hardhat.config.ts        réseaux, compilateur, Blockscout
```

---

## Dépannage

| Message | Que faire |
| --- | --- |
| « chain ID … attendu 4663 » | L'URL RPC du keystore pointe vers une autre chaîne : corrige `ROBINHOOD_RPC_URL`. |
| « Confirmation impossible » | Lance la commande dans un vrai terminal (pas depuis un outil non interactif). |
| « Pas de reçu … après 600 s » | La transaction est en route : attends un peu et relance la même commande. |
| « Diffusion … impossible pour l'instant » | Le RPC n'a pas répondu. Relance la même commande : la transaction notée sera retrouvée ou rediffusée telle quelle. |
| « re-signer … avec des frais à jour » | Les frais du réseau ont monté depuis la signature. Retape le symbole : même nonce, donc aucun doublon possible. |
| « ses frais maximum dépassent le plafond » | Le RPC impose un plafond de frais par transaction. Enregistre une autre URL (`npx hardhat keystore set ROBINHOOD_RPC_URL`, Alchemy par exemple) et relance : la même transaction sera diffusée. |
| « Solde ETH insuffisant pour diffuser » | Ajoute de l'ETH au wallet et relance : la même transaction sera diffusée. |
| « Le nonce N est déjà utilisé » | Souvent un RPC en retard de quelques secondes : relance. Si le message persiste, ce wallet a envoyé une autre transaction avec ce nonce (utilisé ailleurs pendant le lancement). Vérifie sur l'explorateur que le hash noté dans le journal (et ceux de `replacedTxHashes`) n'existe pas, puis retire seulement l'entrée `"pending"` concernée et relance. |
| « … a échoué » (avec un hash) | Le reçu de ta transaction montre un échec : rien n'a bougé hors frais, le journal est revenu à l'étape précédente. Relance pour voir le nouveau plan. |
| « Un autre lancement est en cours » | Un autre terminal exécute déjà un script sur ce réseau : attends qu'il se termine. Si ce n'est pas le cas, supprime le fichier `.lock` indiqué. |
| « Erreur inattendue » | Le message résume l'erreur ; les détails techniques suivent. Le journal n'a pas été abîmé : relance la même commande. |
| « curve.openAt est obligatoire » / « déjà passée » / « trop proche » / « plus de 30 jours » | Mets dans `curve.openAt` une date ISO en UTC entre 1 h et 30 jours après maintenant. |
| « L'heure d'ouverture des achats … est passée ou imminente » | Le temps a passé depuis le plan : choisis une nouvelle heure et relance. Rien n'a été envoyé. |
| « Le contrat de blocage déjà déployé … commence le … » | Remets dans `curve.openAt` l'heure de la première exécution, ou retire seulement l'entrée `"vesting"` du journal (ce contrat est vide) pour en déployer un neuf. |
| « Ta part … ne peut exister que bloquée » | Mets `vesting.enabled: true`, ou règle `curve.tokenPercent + community.percent` à 100. |
| « … n'est pas un Safe valide » | Crée le Safe communauté sur app.safe.global (2 signatures sur 3 propriétaires, sans le wallet de déploiement) et colle son adresse dans `community.beneficiary`. |
| « La simulation du déploiement de la courbe a échoué » | Le message donne la raison ; rien n'a été envoyé. |
| « La courbe de lancement a besoin d'Uniswap v2 » (testnet) | Répète le lancement sur la copie locale du mainnet : `npm run rehearsal`. |
| « Le token est déjà lancé sur ce réseau » | C'est fait : `npm run status:mainnet` montre où en est la courbe. |
| « Rien à libérer avant la falaise » | Le calendrier ne libère rien avant cette date : relance `npm run release:mainnet` après. |
| « doit être recopiée avec ses majuscules et minuscules d'origine » | Copie l'adresse du bénéficiaire depuis ton wallet, telle quelle (c'est ce qui permet de détecter une faute de frappe), ou laisse `vesting.beneficiary` vide (hors mainnet seulement) pour utiliser le wallet de déploiement. |
| « Le bénéficiaire … est un contrat » | Choisis l'adresse d'un wallet ordinaire dont tu as la clé (ton Ledger fondateur). |
| Vérification Blockscout échouée | Relance la commande `npx hardhat verify blockscout …` affichée par le script. |
| La répétition est lente ou échoue (« missing trie node », limite de débit) | La copie d'état demande un nœud complet : mets une URL Alchemy (archive) dans `ROBINHOOD_RPC_URL`. |
| La répétition ne démarre pas (erreur de décodage d'un bloc ou d'une transaction Arbitrum) | Le simulateur n'arrive pas à copier l'état de cette chaîne. `npm test` couvre déjà tout le lancement contre le vrai bytecode Uniswap v2 ; essaie une URL Alchemy, sinon passe cette étape. |
| Mot de passe du keystore | `npx hardhat keystore list` pour voir les clés enregistrées. |

`npm run status:*` ne charge aucune clé privée ; le mot de passe du keystore peut quand
même être demandé si ton URL RPC y est enregistrée.

Les commandes sont identiques sous Windows (PowerShell), macOS et Linux.
