// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title DipDuckCards
/// @notice Cartes de collection Dip Duck (ERC-721). Ce sont des objets de
///         collection pour le plaisir : aucune valeur, aucun droit, aucune
///         promesse. Non affilié à Robinhood.
/// @dev Pas d'owner, rien de modifiable après le déploiement.
///
///      Mint : le joueur choisit un nom, une humeur, un élément et un nombre
///      porte-bonheur, et paie le prix exact. Chaque mint payant crédite les
///      cagnottes de la période de 30 jours en cours : 30 % fondateurs, 30 %
///      fondation, le reste à la communauté. Rien ne sort avant la fin de la
///      période ; ensuite, n'importe qui déclenche les versements vers des
///      adresses fixées au déploiement (fondateurs, communauté) ou vers la
///      fondation gagnante de la période.
///
///      Rareté (commit-reveal) : la graine d'une carte dépend du hachage d'un
///      bloc FUTUR au moment du mint (`commitBlock + REVEAL_DELAY`), inconnu
///      quand on paie. Sur Robinhood Chain (Arbitrum Nitro), `block.number` est
///      une estimation du numéro de bloc Ethereum (≈ 12 s) et `blockhash(n)` un
///      hachage pseudo-aléatoire de ce numéro (en pratique, celui du dernier bloc
///      L2 de ce bloc L1) : 2 blocs ≈ 24 s avant la révélation, et 256 blocs
///      ≈ 51 minutes pour la faire. Passé ce délai, la graine n'est plus
///      lisible : la carte devient « Plain » (tous les attributs au plus
///      commun), donc attendre n'avantage jamais personne.
///
///      Limite assumée : ce hasard est pseudo-aléatoire et NON certifié. Le
///      séquenceur de la chaîne pourrait en théorie le prévoir ou l'orienter.
///      Aucun service de hasard vérifiable (Chainlink VRF) n'est déployé sur
///      Robinhood Chain ; pour des objets de collection sans valeur, ce compromis
///      est acceptable. `prevrandao` est constant sur cette chaîne : il n'est pas utilisé.
///
///      Vote : à chaque période, 1 carte = 1 voix pour choisir la fondation qui
///      reçoit la cagnotte de cette période (sans voix, elle est reportée).
///      Les détenteurs proposent de nouvelles fondations ; une proposition
///      approuvée par vote devient candidate à partir de la période suivante.
contract DipDuckCards is ERC721 {
    using Strings for uint256;

    uint256 public constant MAX_SUPPLY = 3333;
    /// @notice Cartes gratuites pour les gagnants des concours, comptées dans MAX_SUPPLY.
    uint256 public constant RESERVED = 111;
    uint256 public constant PRICE = 0.001 ether;
    uint256 public constant MAX_PER_WALLET = 10;
    /// @notice Délai entre le mint et la révélation, en blocs (`block.number`).
    uint256 public constant REVEAL_DELAY = 2;
    /// @notice Durée d'une période de vote et de cagnotte.
    uint256 public constant ROUND_DURATION = 30 days;
    /// @notice Voix minimales (pour + contre) pour qu'une proposition puisse être approuvée.
    uint256 public constant PROPOSAL_QUORUM = 10;
    uint256 public constant MAX_CANDIDATES = 20;
    /// @notice Nombre de périodes consécutives sans aucune voix avant la règle de secours.
    uint256 public constant FALLBACK_AFTER = 3;

    uint256 private constant FOUNDERS_PERCENT = 30;
    uint256 private constant CHARITY_PERCENT = 30;
    uint256 private constant TRAIT_COUNT = 10;
    uint256 private constant MAX_NAME_LENGTH = 20;
    /// @dev Révélations faites au passage par chaque mint (cartes des autres prêtes).
    uint256 private constant AUTO_REVEALS = 3;

    // Poids des options (sur 1000), uint16 big-endian, dans l'ordre des attributs :
    // bg (8), duck (7), hat (7), eyes (5), neck (4), aura (6), frame (5), cheeks (4), item (7), weather (5).
    bytes private constant WEIGHTS =
        hex"012c00dc00b4008c005a003200120002020800b4008c005a002d0014000501c200c80096005a003c0028000a02bc00780064003c0014025800dc0082003201f400c8009600640028000a01f4012c0096002d0005025800fa0064003201f400b400820050003c001e0014022600a0008200780028";
    // Début de chaque attribut dans WEIGHTS / OPTION_NAMES (en options), et fin.
    bytes private constant OFFSETS = hex"00080f161b1f25292e353a";
    bytes private constant OPTION_NAMES =
        "pond,sunset,candles,night,crash,vault,cosmic,diamond,"
        "classic,midnight,ice,ember,shadow,golden,alien,"
        "none,cap,party,crown,halo,wizard,tophat,"
        "none,laser,stars,hearts,diamond,"
        "none,chain,bowtie,diamondchain,"
        "none,bubbles,coins,sparkles,holo,lightning,"
        "bronze,silver,gold,holo,obsidian,"
        "none,blush,freckles,warpaint,"
        "none,coin,rocket,diamond,trophy,moon,egg,"
        "none,rain,snow,confetti,meteor,";
    bytes private constant TRAIT_TYPES = "background,duck,hat,eyes,neck,aura,frame,cheeks,item,weather,";
    bytes private constant MOODS = "calm,brave,sleepy,hungry,";
    bytes private constant ELEMENTS = "water,fire,ice,thunder,";

    uint8 private constant PENDING = 0;
    uint8 private constant REVEALED = 1;
    uint8 private constant PLAIN = 2;

    // Statuts d'une proposition.
    uint8 private constant OPEN = 0;
    uint8 private constant APPROVED = 1;
    uint8 private constant REJECTED = 2;
    uint8 private constant FULL = 3;

    /// @dev Tient en deux emplacements de stockage : le nom, puis tout le reste.
    struct Card {
        bytes32 name;
        address minter;
        uint56 commitBlock;
        uint16 lucky;
        uint8 mood;
        uint8 element;
        uint8 status;
    }

    /// @dev Une fondation candidate : votable à partir de la période `fromRound`.
    struct Candidate {
        string name;
        address wallet;
        string url;
        uint64 fromRound;
    }

    /// @dev Une proposition de fondation, votée pendant la période où elle est créée.
    struct Proposal {
        string name;
        address wallet;
        string url;
        string description;
        address proposer;
        uint64 round;
        uint32 yes;
        uint32 no;
        uint8 status;
    }

    address public immutable FOUNDERS;
    address public immutable COMMUNITY;
    uint64 public immutable MINT_START;

    string public imageBaseURI;
    string public viewerURI;

    Candidate[] private _candidates;
    Proposal[] private _proposals;

    mapping(uint256 tokenId => Card) private _cards;
    mapping(uint256 tokenId => bytes32) private _seeds;
    mapping(address minter => uint256) public mintedBy;

    uint256 public totalMinted;
    uint256 public reservedMinted;
    /// @dev Prochaine carte que les mints essaient de révéler au passage.
    uint256 private _nextToReveal = 1;

    // Cagnottes par période de 30 jours.
    mapping(uint256 round => uint256) public roundCharity;
    mapping(uint256 round => uint256) private _roundFounders;
    mapping(uint256 round => uint256) private _roundCommunity;
    mapping(uint256 round => bool) public roundPaid;
    /// @dev Première période pas encore versée aux fondateurs / à la communauté.
    uint256 private _foundersNextRound;
    uint256 private _communityNextRound;
    uint256 public foundersPaid;
    uint256 public communityPaid;
    uint256 public charityReleased;
    /// @dev Dernière période où quelqu'un a voté, et si un vote a déjà eu lieu.
    uint256 private _lastVotedRound;
    bool private _anyVote;

    // Ce que `releaseCharity` ferait pour une période (voir `charityPlan`).
    uint8 private constant PLAN_NOTHING = 0;
    uint8 private constant PLAN_WINNER = 1;
    uint8 private constant PLAN_ROLLOVER = 2;
    uint8 private constant PLAN_LAST_WINNER = 3;
    uint8 private constant PLAN_EQUAL_SPLIT = 4;

    // Votes : par période pour les candidats, par proposition pour les propositions.
    mapping(uint256 round => mapping(uint256 tokenId => bool)) public hasVoted;
    mapping(uint256 round => mapping(uint256 candidateIndex => uint256)) public votesFor;
    mapping(uint256 proposalId => mapping(uint256 tokenId => bool)) public hasVotedProposal;
    mapping(address proposer => mapping(uint256 round => bool)) private _proposedIn;
    mapping(address wallet => bool) private _openProposalWallet;

    event Revealed(uint256 indexed tokenId, bytes32 seed);
    event Voted(address indexed voter, uint256 indexed round, uint256 indexed candidateIndex, uint256 cards);
    event CharityReleased(uint256 indexed round, uint256 indexed candidateIndex, address wallet, uint256 amount);
    event CharityRolledOver(uint256 indexed fromRound, uint256 indexed toRound, uint256 amount);
    event CharityFallback(uint256 indexed round, uint8 kind, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event Proposed(uint256 indexed id, address indexed proposer, address wallet, uint256 round);
    event ProposalVoted(uint256 indexed id, address indexed voter, bool support, uint256 cards);
    event ProposalFinalized(uint256 indexed id, uint8 status);

    error InvalidConfig();
    error MintNotStarted();
    error InvalidQuantity();
    error WrongPayment(uint256 expected);
    error SoldOut();
    error WalletLimit();
    error InvalidChoice();
    error InvalidName();
    error OnlyCommunity();
    error NotReady(uint256 tokenId);
    error AlreadyRevealed(uint256 tokenId);
    error NotCardOwner(uint256 tokenId);
    error AlreadyVoted(uint256 tokenId);
    error InvalidCandidate();
    error RoundNotOver(uint256 round);
    error AlreadyPaid(uint256 round);
    error NotHolder();
    error InvalidProposal();
    error AlreadyCandidate();
    error AlreadyProposed();
    error ProposalClosed();
    error NothingToSend();
    error TransferFailed();

    constructor(
        address founders,
        address community,
        uint64 mintStart,
        string memory imageBaseURI_,
        string memory viewerURI_,
        string[] memory candidateNames,
        address[] memory candidateWallets,
        string[] memory candidateUrls
    ) ERC721("Dip Duck Cards", "DDCARD") {
        uint256 count = candidateNames.length;
        if (
            founders == address(0) || community == address(0) || count < 2 || count > 5
                || candidateWallets.length != count || candidateUrls.length != count
        ) {
            revert InvalidConfig();
        }
        for (uint256 i = 0; i < count; i++) {
            if (candidateWallets[i] == address(0) || bytes(candidateNames[i]).length == 0) revert InvalidConfig();
            for (uint256 j = 0; j < i; j++) {
                if (candidateWallets[j] == candidateWallets[i]) revert InvalidConfig();
            }
            _candidates.push(Candidate(candidateNames[i], candidateWallets[i], candidateUrls[i], 0));
        }
        FOUNDERS = founders;
        COMMUNITY = community;
        MINT_START = mintStart;
        imageBaseURI = imageBaseURI_;
        viewerURI = viewerURI_;
    }

    // --- Mint --------------------------------------------------------------------

    /// @notice Mint payant : `quantity` cartes (1 à 10) au prix exact.
    function mint(bytes32 name, uint8 mood, uint8 element, uint16 lucky, uint256 quantity) external payable {
        if (block.timestamp < MINT_START) revert MintNotStarted();
        if (quantity == 0 || quantity > MAX_PER_WALLET) revert InvalidQuantity();
        if (msg.value != PRICE * quantity) revert WrongPayment(PRICE * quantity);
        if (totalMinted - reservedMinted + quantity > MAX_SUPPLY - RESERVED) revert SoldOut();
        if (mintedBy[msg.sender] + quantity > MAX_PER_WALLET) revert WalletLimit();
        mintedBy[msg.sender] += quantity;

        uint256 round = currentRound();
        uint256 founders = (msg.value * FOUNDERS_PERCENT) / 100;
        uint256 charity = (msg.value * CHARITY_PERCENT) / 100;
        _roundFounders[round] += founders;
        roundCharity[round] += charity;
        _roundCommunity[round] += msg.value - founders - charity;

        _autoReveal();
        _mintCards(msg.sender, quantity, name, mood, element, lucky);
    }

    /// @notice Cartes gratuites de la réserve (concours), seulement depuis le wallet communauté.
    function mintReserved(address to, uint256 quantity, bytes32 name, uint8 mood, uint8 element, uint16 lucky)
        external
    {
        if (msg.sender != COMMUNITY) revert OnlyCommunity();
        if (quantity == 0) revert InvalidQuantity();
        if (reservedMinted + quantity > RESERVED) revert SoldOut();
        reservedMinted += quantity;
        _mintCards(to, quantity, name, mood, element, lucky);
    }

    function _mintCards(address to, uint256 quantity, bytes32 name, uint8 mood, uint8 element, uint16 lucky)
        private
    {
        if (mood > 3 || element > 3 || lucky > 999) revert InvalidChoice();
        _checkName(name);
        uint256 first = totalMinted + 1;
        totalMinted += quantity;
        for (uint256 id = first; id < first + quantity; id++) {
            _cards[id] = Card({
                name: name,
                minter: to,
                commitBlock: uint56(block.number),
                lucky: lucky,
                mood: mood,
                element: element,
                status: PENDING
            });
            _mint(to, id); // pas de rappel vers le destinataire : aucune réentrance possible pendant le mint
        }
    }

    /// @dev 0 à 20 caractères [A-Za-z0-9 espace - _ .], puis uniquement des zéros :
    ///      le nom peut être recopié tel quel dans le JSON des métadonnées.
    function _checkName(bytes32 name) private pure {
        bool ended;
        for (uint256 i = 0; i < 32; i++) {
            bytes1 c = name[i];
            if (c == 0) {
                ended = true;
                continue;
            }
            bool allowed = (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == " "
                || c == "-" || c == "_" || c == ".";
            if (ended || i >= MAX_NAME_LENGTH || !allowed) revert InvalidName();
        }
    }

    // --- Révélation --------------------------------------------------------------

    /// @notice Révèle une carte dont le bloc cible est passé.
    function reveal(uint256 tokenId) external {
        _requireOwned(tokenId);
        if (_cards[tokenId].status != PENDING) revert AlreadyRevealed(tokenId);
        if (!_ready(tokenId)) revert NotReady(tokenId);
        _reveal(tokenId);
    }

    /// @notice Révèle toutes les cartes prêtes de la liste ; ignore, sans erreur,
    ///         celles déjà révélées, pas encore prêtes ou inexistantes.
    function revealMany(uint256[] calldata tokenIds) external {
        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 id = tokenIds[i];
            if (id != 0 && id <= totalMinted && _cards[id].status == PENDING && _ready(id)) _reveal(id);
        }
    }

    function _ready(uint256 tokenId) private view returns (bool) {
        return block.number > uint256(_cards[tokenId].commitBlock) + REVEAL_DELAY;
    }

    function _reveal(uint256 tokenId) private {
        Card storage card = _cards[tokenId];
        bytes32 hash = blockhash(uint256(card.commitBlock) + REVEAL_DELAY);
        if (hash == 0) {
            // Plus de 256 blocs : la graine est perdue, la carte reste la plus commune.
            card.status = PLAIN;
            emit Revealed(tokenId, 0);
            return;
        }
        bytes32 seed = keccak256(
            abi.encode(card.name, card.mood, card.element, card.lucky, tokenId, card.minter, hash)
        );
        _seeds[tokenId] = seed;
        card.status = REVEALED;
        emit Revealed(tokenId, seed);
    }

    /// @dev Chaque mint révèle au passage jusqu'à 3 cartes prêtes, dans l'ordre des numéros.
    function _autoReveal() private {
        uint256 id = _nextToReveal;
        uint256 done;
        while (done < AUTO_REVEALS && id <= totalMinted) {
            if (_cards[id].status == PENDING) {
                if (!_ready(id)) break; // les suivantes ont été mintées après : pas prêtes non plus
                _reveal(id);
                done++;
            }
            id++;
        }
        _nextToReveal = id;
    }

    // --- Attributs ---------------------------------------------------------------

    /// @notice Les 10 attributs (index dans les tables ci-dessus) et si la carte est révélée.
    ///         Pas encore révélée : des zéros et `false`. Une carte « Plain » (révélation
    ///         trop tardive) renvoie aussi des zéros, avec `true`.
    function traitsOf(uint256 tokenId) public view returns (uint8[10] memory traits, bool revealed) {
        _requireOwned(tokenId);
        Card memory card = _cards[tokenId];
        revealed = card.status != PENDING;
        if (card.status != REVEALED) return (traits, revealed);
        bytes32 seed = _seeds[tokenId];
        for (uint256 t = 0; t < TRAIT_COUNT; t++) {
            traits[t] = _pick(card, seed, t);
        }
    }

    function cardOf(uint256 tokenId)
        external
        view
        returns (bytes32 name, uint8 mood, uint8 element, uint16 lucky, uint64 commitBlock, bool revealed)
    {
        _requireOwned(tokenId);
        Card memory card = _cards[tokenId];
        return (card.name, card.mood, card.element, card.lucky, uint64(card.commitBlock), card.status != PENDING);
    }

    function _pick(Card memory card, bytes32 seed, uint256 t) internal pure returns (uint8) {
        uint256 start = uint8(OFFSETS[t]);
        uint256 count = uint8(OFFSETS[t + 1]) - start;
        uint256[8] memory weights;
        uint256 sum;
        for (uint256 i = 0; i < count; i++) {
            uint256 base = (uint256(uint8(WEIGHTS[(start + i) * 2])) << 8) | uint8(WEIGHTS[(start + i) * 2 + 1]);
            weights[i] = base * _boost(card, t, i);
            sum += weights[i];
        }
        uint256 roll = (uint256(uint32(uint256(keccak256(abi.encode(seed, t))))) * sum) >> 32;
        for (uint256 i = 0; i < count; i++) {
            if (roll < weights[i]) return uint8(i);
            roll -= weights[i];
        }
        return uint8(count - 1);
    }

    /// @dev Les « secrets » : multiplicateur (en %) d'une option selon les choix du joueur.
    function _boost(Card memory card, uint256 t, uint256 i) internal pure returns (uint256 m) {
        m = 100;
        uint8 e = card.element; // 0 eau, 1 feu, 2 glace, 3 foudre
        uint8 mood = card.mood; // 0 calme, 1 courageux, 2 endormi, 3 affamé
        if (t == 0 && i == 3 && mood == 2) m = (m * 200) / 100; // bg.night
        if (t == 1 && i == 2 && e == 2) m = (m * 200) / 100; // duck.ice
        if (t == 1 && i == 5 && _isSatoshi(card.name)) m = (m * 300) / 100; // duck.golden
        if (t == 2 && i == 3 && mood == 1) m = (m * 150) / 100; // hat.crown
        if (t == 2 && i == 4 && mood == 0) m = (m * 200) / 100; // hat.halo
        if (t == 3 && i == 1 && e == 1) m = (m * 200) / 100; // eyes.laser
        if (t == 5 && i == 1 && e == 0) m = (m * 200) / 100; // aura.bubbles
        if (t == 5 && i == 2 && mood == 3) m = (m * 200) / 100; // aura.coins
        if (t == 5 && i == 5 && e == 3) m = (m * 300) / 100; // aura.lightning
        if (t == 6 && (i == 2 || i == 3) && _hasSeven(card.lucky)) m = (m * 150) / 100; // frame.gold / holo
        if (t == 7 && i == 1 && mood == 0) m = (m * 150) / 100; // cheeks.blush
        if (t == 7 && i == 3 && mood == 1) m = (m * 200) / 100; // cheeks.warpaint
        if (t == 8 && i == 5 && card.lucky == 777) m = (m * 300) / 100; // item.moon
        if (t == 8 && i == 6 && mood == 3) m = (m * 200) / 100; // item.egg
        if (t == 9 && i == 2 && e == 2) m = (m * 200) / 100; // weather.snow
        if (t == 9 && i == 4 && e == 3) m = (m * 200) / 100; // weather.meteor
    }

    function _hasSeven(uint16 lucky) private pure returns (bool) {
        if (lucky == 0) return false;
        for (uint256 n = lucky; n > 0; n /= 10) {
            if (n % 10 == 7) return true;
        }
        return false;
    }

    /// @dev « satoshi », sans tenir compte des majuscules.
    function _isSatoshi(bytes32 name) private pure returns (bool) {
        bytes7 target = "satoshi";
        if (name[7] != 0) return false;
        for (uint256 i = 0; i < 7; i++) {
            bytes1 c = name[i];
            if (c >= "A" && c <= "Z") c = bytes1(uint8(c) + 32);
            if (c != target[i]) return false;
        }
        return true;
    }

    // --- Périodes et cagnottes --------------------------------------------------

    /// @notice Période en cours : 0 jusqu'à la fin des 30 premiers jours après MINT_START, puis 1, 2…
    function currentRound() public view returns (uint256) {
        return block.timestamp < MINT_START ? 0 : (block.timestamp - MINT_START) / ROUND_DURATION;
    }

    /// @notice Fin (horodatage Unix) de la période `round`.
    function roundEnd(uint256 round) public view returns (uint64) {
        return uint64(MINT_START + (round + 1) * ROUND_DURATION);
    }

    /// @notice Part des fondateurs des périodes terminées, pas encore versée.
    function foundersAvailable() public view returns (uint256 amount) {
        uint256 current = currentRound();
        for (uint256 r = _foundersNextRound; r < current; r++) {
            amount += _roundFounders[r];
        }
    }

    /// @notice Part de la communauté des périodes terminées, pas encore versée.
    function communityAvailable() public view returns (uint256 amount) {
        uint256 current = currentRound();
        for (uint256 r = _communityNextRound; r < current; r++) {
            amount += _roundCommunity[r];
        }
    }

    /// @notice Verse aux fondateurs leur part des périodes terminées (rien avant la fin d'une période).
    function withdrawFounders() external {
        uint256 amount = foundersAvailable();
        if (amount == 0) revert NothingToSend();
        _foundersNextRound = currentRound();
        foundersPaid += amount;
        _send(FOUNDERS, amount);
    }

    /// @notice Verse à la communauté sa part des périodes terminées.
    function withdrawCommunity() external {
        uint256 amount = communityAvailable();
        if (amount == 0) revert NothingToSend();
        _communityNextRound = currentRound();
        communityPaid += amount;
        _send(COMMUNITY, amount);
    }

    /// @notice Ce que `releaseCharity(round)` ferait maintenant : 0 rien (déjà versée, cagnotte vide
    ///         ou période pas terminée), 1 gagnante de la période (`index`), 2 report sur la période
    ///         en cours, 3 dernière gagnante (`index`), 4 partage égal entre les candidates (`index` 0).
    /// @dev Règle de secours : quand la période n'a aucune voix et qu'aucune voix n'a été donnée
    ///      depuis FALLBACK_AFTER périodes (ou jamais, en comptant depuis la période 0), la
    ///      cagnotte ne repart pas en report : elle va à la dernière gagnante, ou est partagée à
    ///      parts égales si personne n'a jamais voté.
    function charityPlan(uint256 round) public view returns (uint8 kind, uint256 index) {
        uint256 current = currentRound();
        if (round >= current || roundPaid[round] || roundCharity[round] == 0) return (PLAN_NOTHING, 0);
        bool hasWinner;
        (hasWinner, index) = winnerOf(round);
        if (hasWinner) return (PLAN_WINNER, index);
        uint256 streak;
        if (!_anyVote) {
            streak = round + 1;
        } else if (_lastVotedRound > round || _lastVotedRound >= current) {
            return (PLAN_ROLLOVER, 0); // des voix plus récentes : report comme d'habitude
        } else {
            streak = round - _lastVotedRound;
        }
        if (streak < FALLBACK_AFTER) return (PLAN_ROLLOVER, 0);
        if (!_anyVote) return (PLAN_EQUAL_SPLIT, 0);
        (, index) = winnerOf(_lastVotedRound);
        return (PLAN_LAST_WINNER, index);
    }

    /// @notice Après la fin de la période `round` : verse sa cagnotte fondation selon
    ///         `charityPlan` — à la gagnante de la période, en report sur la période en cours si
    ///         personne n'a voté, ou selon la règle de secours après FALLBACK_AFTER périodes sans voix.
    function releaseCharity(uint256 round) external {
        uint256 current = currentRound();
        if (round >= current) revert RoundNotOver(round);
        if (roundPaid[round]) revert AlreadyPaid(round);
        uint256 amount = roundCharity[round];
        if (amount == 0) revert NothingToSend();
        (uint8 kind, uint256 index) = charityPlan(round);
        roundPaid[round] = true;
        roundCharity[round] = 0;
        if (kind == PLAN_ROLLOVER) {
            roundCharity[current] += amount;
            emit CharityRolledOver(round, current, amount);
            return;
        }
        charityReleased += amount;
        if (kind != PLAN_WINNER) emit CharityFallback(round, kind, amount);
        if (kind != PLAN_EQUAL_SPLIT) {
            _payCharity(round, index, amount);
            return;
        }
        // Partage égal entre les candidates admises à cette période ; le reste de la division à la première.
        uint256 eligible;
        for (uint256 i = 0; i < _candidates.length; i++) {
            if (_candidates[i].fromRound <= round) eligible++;
        }
        uint256 share = amount / eligible;
        uint256 remainder = amount - share * eligible;
        for (uint256 i = 0; i < _candidates.length; i++) {
            if (_candidates[i].fromRound > round) continue;
            _payCharity(round, i, share + remainder);
            remainder = 0;
        }
    }

    function _payCharity(uint256 round, uint256 index, uint256 amount) private {
        address wallet = _candidates[index].wallet;
        emit CharityReleased(round, index, wallet, amount);
        _send(wallet, amount);
    }

    // --- Vote de la fondation ----------------------------------------------------

    /// @notice Pendant la période en cours : une voix par carte et par période pour un candidat.
    function vote(uint256[] calldata tokenIds, uint256 candidateIndex) external {
        uint256 round = currentRound();
        if (tokenIds.length == 0 || candidateIndex >= _candidates.length || _candidates[candidateIndex].fromRound > round) {
            revert InvalidCandidate();
        }
        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 id = tokenIds[i];
            if (ownerOf(id) != msg.sender) revert NotCardOwner(id);
            if (hasVoted[round][id]) revert AlreadyVoted(id);
            hasVoted[round][id] = true;
        }
        votesFor[round][candidateIndex] += tokenIds.length;
        _lastVotedRound = round;
        _anyVote = true;
        emit Voted(msg.sender, round, candidateIndex, tokenIds.length);
    }

    /// @notice Gagnant de la période : le plus de voix, le plus petit index en cas d'égalité ;
    ///         `hasWinner` est faux si personne n'a voté.
    function winnerOf(uint256 round) public view returns (bool hasWinner, uint256 index) {
        uint256 best;
        for (uint256 i = 0; i < _candidates.length; i++) {
            uint256 votes = votesFor[round][i];
            if (votes > best) {
                best = votes;
                index = i;
            }
        }
        hasWinner = best > 0;
    }

    function candidateCount() external view returns (uint256) {
        return _candidates.length;
    }

    function candidate(uint256 i)
        external
        view
        returns (string memory name, address wallet, string memory url, uint256 fromRound)
    {
        Candidate storage c = _candidates[i];
        return (c.name, c.wallet, c.url, c.fromRound);
    }

    // --- Propositions de fondations ---------------------------------------------
    // Le nom, le lien et la description sont du texte libre, non filtré : le site doit
    // toujours les afficher comme du texte brut, jamais comme du HTML.

    /// @notice Propose une fondation (détenteur d'au moins une carte, une proposition par
    ///         adresse et par période). Elle se vote pendant la période en cours.
    function propose(string calldata name, address wallet, string calldata url, string calldata description)
        external
    {
        if (balanceOf(msg.sender) == 0) revert NotHolder();
        uint256 nameLength = bytes(name).length;
        uint256 descriptionLength = bytes(description).length;
        if (
            nameLength == 0 || nameLength > 40 || bytes(url).length > 120 || descriptionLength == 0
                || descriptionLength > 280 || wallet == address(0) || wallet.code.length != 0
        ) {
            revert InvalidProposal();
        }
        if (_openProposalWallet[wallet]) revert AlreadyProposed();
        for (uint256 i = 0; i < _candidates.length; i++) {
            if (_candidates[i].wallet == wallet) revert AlreadyCandidate();
        }
        uint256 round = currentRound();
        if (_proposedIn[msg.sender][round]) revert AlreadyProposed();
        _proposedIn[msg.sender][round] = true;
        _openProposalWallet[wallet] = true;
        _proposals.push(Proposal(name, wallet, url, description, msg.sender, uint64(round), 0, 0, OPEN));
        emit Proposed(_proposals.length - 1, msg.sender, wallet, round);
    }

    /// @notice Pour ou contre une proposition, pendant sa période : une voix par carte.
    function voteProposal(uint256 id, uint256[] calldata tokenIds, bool support) external {
        Proposal storage p = _proposals[id];
        if (p.status != OPEN || currentRound() != p.round) revert ProposalClosed();
        if (tokenIds.length == 0) revert InvalidQuantity();
        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 tokenId = tokenIds[i];
            if (ownerOf(tokenId) != msg.sender) revert NotCardOwner(tokenId);
            if (hasVotedProposal[id][tokenId]) revert AlreadyVoted(tokenId);
            hasVotedProposal[id][tokenId] = true;
        }
        if (support) p.yes += uint32(tokenIds.length);
        else p.no += uint32(tokenIds.length);
        emit ProposalVoted(id, msg.sender, support, tokenIds.length);
    }

    /// @notice Après la fin de sa période : approuvée si plus de « pour » que de « contre » et au
    ///         moins PROPOSAL_QUORUM voix ; elle devient alors candidate pour la période suivante.
    function finalizeProposal(uint256 id) external {
        Proposal storage p = _proposals[id];
        if (p.status != OPEN) revert ProposalClosed();
        if (currentRound() <= p.round) revert RoundNotOver(p.round);
        _openProposalWallet[p.wallet] = false;
        if (p.yes <= p.no || uint256(p.yes) + p.no < PROPOSAL_QUORUM) {
            p.status = REJECTED;
        } else if (_candidates.length >= MAX_CANDIDATES) {
            p.status = FULL;
        } else {
            p.status = APPROVED;
            _candidates.push(Candidate(p.name, p.wallet, p.url, p.round + 1));
        }
        emit ProposalFinalized(id, p.status);
    }

    function proposalCount() external view returns (uint256) {
        return _proposals.length;
    }

    function proposal(uint256 id)
        external
        view
        returns (
            string memory name,
            address wallet,
            string memory url,
            string memory description,
            address proposer,
            uint256 round,
            uint256 yes,
            uint256 no,
            uint8 status
        )
    {
        Proposal storage p = _proposals[id];
        return (p.name, p.wallet, p.url, p.description, p.proposer, p.round, p.yes, p.no, p.status);
    }

    // --- Versements ---------------------------------------------------------------

    /// @dev Appelé après la mise à jour des comptes (vérifications, effets, puis interaction).
    function _send(address to, uint256 amount) private {
        emit Withdrawn(to, amount);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // --- Lecture -----------------------------------------------------------------

    function tokensOfOwner(address owner) external view returns (uint256[] memory ids) {
        ids = new uint256[](balanceOf(owner));
        uint256 found;
        for (uint256 id = 1; id <= totalMinted && found < ids.length; id++) {
            if (_ownerOf(id) == owner) ids[found++] = id;
        }
    }

    /// @notice Métadonnées JSON en base64, entièrement sur la chaîne (hors image).
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        (uint8[10] memory traits, bool revealed) = traitsOf(tokenId);
        Card memory card = _cards[tokenId];
        string memory id = tokenId.toString();
        bytes memory attributes;
        for (uint256 t = 0; t < TRAIT_COUNT; t++) {
            string memory value =
                revealed ? _item(OPTION_NAMES, uint8(OFFSETS[t]) + traits[t]) : "unrevealed";
            attributes = abi.encodePacked(attributes, _attribute(_item(TRAIT_TYPES, t), value), ",");
        }
        attributes = abi.encodePacked(
            attributes,
            _attribute("mood", _item(MOODS, card.mood)),
            ",",
            _attribute("element", _item(ELEMENTS, card.element)),
            ",",
            _attribute("name", _nameString(card.name)),
            ",",
            _attribute("revealed", revealed ? "yes" : "no")
        );
        bytes memory json = abi.encodePacked(
            '{"name":"Dip Duck #',
            id,
            '","description":"Dip Duck Cards are collectibles for fun: no value, no rights, no promise. Not affiliated with Robinhood.",',
            '"image":"',
            imageBaseURI,
            id,
            '.png","animation_url":"',
            viewerURI,
            "?id=",
            id,
            '","attributes":[',
            attributes,
            "]}"
        );
        return string.concat("data:application/json;base64,", Base64.encode(json));
    }

    function _attribute(string memory traitType, string memory value) private pure returns (bytes memory) {
        return abi.encodePacked('{"trait_type":"', traitType, '","value":"', value, '"}');
    }

    /// @dev n-ième élément d'une liste « a,b,c, ».
    function _item(bytes memory list, uint256 n) private pure returns (string memory) {
        uint256 start;
        uint256 index;
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == ",") {
                if (index == n) {
                    bytes memory out = new bytes(i - start);
                    for (uint256 j = 0; j < out.length; j++) {
                        out[j] = list[start + j];
                    }
                    return string(out);
                }
                index++;
                start = i + 1;
            }
        }
        return "";
    }

    function _nameString(bytes32 name) private pure returns (string memory) {
        uint256 length;
        while (length < 32 && name[length] != 0) length++;
        bytes memory out = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            out[i] = name[i];
        }
        return string(out);
    }
}
