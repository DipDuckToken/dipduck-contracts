// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @dev Interface minimale d'un flux de prix Chainlink (AggregatorV3Interface).
interface IAggregatorV3 {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title DipDuckGame
/// @notice Jeu « Attrape la baisse » du site Dip Duck, pour toujours : le canard glisse sur la
///         courbe du Bitcoin depuis 2010. L'historique est figé au déploiement, puis la chaîne
///         ajoute elle-même un prix par jour (flux Chainlink BTC/USD) et y détecte les nouvelles
///         baisses avec une règle fixe. Un concours par trimestre civil UTC, automatique : le
///         gagnant va le plus loin, puis attrape le plus de baisses, puis ramasse le plus de
///         pièces, puis marque le plus de points ; à égalité, le plus ancien. Pour le plaisir :
///         aucune récompense, aucune valeur. Non affilié à Robinhood.
/// @dev Pas d'owner, pas d'administration, pas d'ETH : rien n'est modifiable, personne ne peut
///      effacer un résultat ni changer une baisse.
///
///      Parties vérifiées : le joueur envoie ses touches (positions horizontales du canard, en
///      pixels) et le contrat REJOUE la partie avec les règles entières du site (`verify`).
///      `startRun` note l'heure de départ et le concours ; `submit` refuse une partie plus rapide
///      que le vrai jeu (`minTimeFor`) ou plus vieille que MAX_RUN. Reste possible : un programme
///      qui joue vraiment, en temps réel.
///
///      Données : baisses historiques et table des temps minimaux historiques dans le code d'un
///      petit contrat de données créé par le constructeur (premier octet 0x00 = STOP, rien
///      d'exécutable ; 3 octets par baisse : jour sur 16 bits, bonus sur 8 ; puis 2 octets par
///      tranche de 30 jours). Baisses trouvées ensuite : tableau `uint24` en stockage. Prix et
///      cumul des temps minimaux : 4 valeurs de 64 bits par emplacement de stockage.
///
///      Top 50 d'un concours : une entrée = un uint256,
///      `jour (20 bits) | attrapées (16) | pièces (16) | score (16) | ~numéro (28) | adresse (160)`.
///      Comparer deux entrées revient à comparer deux uint256. Bornes : jour < 2^20 (an 4880),
///      attrapées et pièces <= 1 500 touches, score <= 13 × 1 500, 2^28 − 1 soumissions par
///      concours au plus.
contract DipDuckGame {
    // --- Constantes du jeu (identiques à celles du site) ----------------------------------

    /// @notice Jour 0 des données du jeu : 2010-08-18 00:00 UTC.
    uint64 public constant DATA_START = 1282089600;
    /// @notice Pixels par jour : la baisse du jour d est en x = d × 12.
    uint256 public constant PX_PER_DAY = 12;
    /// @notice Écart maximal (pixels) d'une touche « parfaite » : 3 points + bonus.
    uint256 public constant PERFECT = 12;
    /// @notice Écart maximal (pixels) d'une « bonne » touche : 1 point + bonus.
    uint256 public constant GOOD = 32;
    /// @notice Une touche vise la première baisse non jouée à moins de WINDOW pixels.
    uint256 public constant WINDOW = 96;
    /// @notice Vies au départ ; chaque erreur en coûte une.
    uint256 public constant LIVES = 3;
    /// @notice Position de départ du canard (jour 44).
    uint256 public constant START_X = 528;
    /// @notice Durée d'un saut, en pixels : une touche sans cible pendant un saut ne fait rien.
    uint256 public constant JUMP_SPAN = 216;
    /// @notice Un saut en x ramasse la pièce dont x + COIN_FROM <= coinX <= x + COIN_TO :
    ///         au sommet du saut (x + 108), à 24 pixels près.
    uint256 public constant COIN_FROM = 84;
    uint256 public constant COIN_TO = 132;
    /// @notice Une pièce tous les COIN_EVERY jours, aux jours c % COIN_EVERY == COIN_PHASE, si
    ///         c × 12 − COIN_TO >= START_X (le saut peut partir après le départ) et c × 12 < finishX.
    uint256 public constant COIN_EVERY = 20;
    uint256 public constant COIN_PHASE = 15;
    /// @notice Pas de pièce au jour c si une baisse d prise en compte vérifie
    ///         d − COIN_CLEAR_BEFORE <= c <= d + COIN_CLEAR_AFTER : toutes les pièces restantes
    ///         sont atteignables (saut au plus tôt, sans baisse en attente à moins de WINDOW).
    uint256 public constant COIN_CLEAR_BEFORE = 2;
    uint256 public constant COIN_CLEAR_AFTER = 14;
    /// @notice Jour de départ du canard (START_X / 12).
    uint256 public constant GAME_START_DAY = 44;
    /// @notice Durée maximale entre `startRun` et `submit`.
    uint256 public constant MAX_RUN = 3 hours;
    /// @notice Nombre maximal d'entrées du classement d'un concours.
    uint256 public constant TOP_SIZE = 50;
    /// @notice La course d'un concours s'arrête FINISH_LAG + 1 jours avant le début de son trimestre.
    uint256 public constant FINISH_LAG = 15;
    /// @notice Âge maximal du prix Chainlink accepté par `recordDay`.
    uint256 public constant MAX_STALE = 26 hours;
    /// @notice Largeur (en jours) d'une tranche de la table historique des temps minimaux.
    uint256 public constant MIN_TIME_BUCKET_DAYS = 30;
    /// @notice Jours enregistrés au plus par appel de `recordDay` (gas borné) ; le retard
    ///         restant est rattrapé par les appels suivants.
    uint256 public constant MAX_DAYS_PER_CALL = 60;

    /// @dev Au plus 1 500 touches par partie.
    uint256 private constant MAX_TAPS = 1500;
    /// @dev Bonus maximal d'une baisse.
    uint256 private constant MAX_BONUS = 10;
    /// @dev Longueur maximale d'un pseudo, en octets.
    uint256 private constant NICKNAME_MAX = 16;
    /// @dev Prix fournis au déploiement : jours detectFrom − 45 … detectFrom + 13.
    uint256 private constant RECENT_BEFORE = 45;
    uint256 private constant RECENT_AFTER = 13;
    uint256 private constant RECENT_COUNT = 59;
    /// @dev Un jour c est évalué quand c + EVAL_LAG est enregistré (rebond sur 14 jours + médiane).
    uint256 private constant EVAL_LAG = 15;
    /// @dev Jour Unix (depuis 1970-01-01) du jour 0 du jeu.
    uint256 private constant UNIX_DAY0 = 14839;
    uint256 private constant FIRST_YEAR = 2026;
    uint256 private constant MASK64 = type(uint64).max;
    uint256 private constant SEQ_MASK = (1 << 28) - 1;

    /// @notice Flux Chainlink BTC/USD (8 décimales).
    address public immutable FEED;
    /// @notice Premier jour évalué par la chaîne ; toutes les baisses historiques sont avant.
    uint32 public immutable DETECT_FROM;
    /// @dev Contrat de données : 0x00, 3 octets par baisse historique, 2 octets par tranche.
    address private immutable _DATA;
    uint256 private immutable _HIST_DIPS;
    uint256 private immutable _BUCKETS;
    /// @dev Temps minimal au dernier jour historique (detectFrom + 13) : dernière tranche.
    uint256 private immutable _HIST_LAST_SECONDS;

    /// @dev État de l'enregistrement, un seul emplacement.
    struct State {
        uint32 lastRecorded;
        /// @dev Prochain jour à évaluer.
        uint32 nextEval;
        /// @dev Jour de la dernière baisse connue (valable si hasDip).
        uint32 lastDip;
        bool hasDip;
    }

    /// @dev Meilleur résultat d'un joueur dans un concours (2 emplacements).
    struct Result {
        uint32 day;
        uint32 caught;
        uint32 coins;
        uint32 score;
        /// @dev Numéro de la soumission dans le concours (à partir de 1), pour l'ancienneté.
        uint32 seq;
        /// @dev Horodatage du bloc de la soumission ; 0 = jamais joué.
        uint64 at;
        bytes32 nickname;
    }

    /// @dev Classement d'un concours : entrées compactées triées par valeur décroissante.
    struct Board {
        uint256[TOP_SIZE] top;
        uint256 count;
        uint256 seq;
    }

    /// @dev État d'un rejeu (en mémoire).
    struct Replay {
        uint256 lives;
        /// @dev Les baisses jouées (attrapées, ratées, passées) forment exactement [0, next).
        uint256 next;
        /// @dev Position de fin de partie ; 0 = partie en cours (une fin est toujours >= 33).
        uint256 endX;
        uint256 score;
        uint256 caught;
        uint256 coins;
        uint256 airborneUntil;
        /// @dev Jour de la dernière pièce ramassée (les sauts avancent : jamais deux fois).
        uint256 lastCoin;
        /// @dev Première baisse dont le jour + COIN_CLEAR_AFTER >= dernière pièce examinée.
        uint256 cp;
    }

    State private _state;
    /// @dev Baisses trouvées par la chaîne : `jour << 8 | bonus`.
    uint24[] private _found;
    /// @dev Prix bruts (USD × 1e8) : jour / 4 → 4 × 64 bits (jour % 4 = rang).
    mapping(uint256 => uint256) private _prices;
    /// @dev Cumul (µs) des temps minimaux des jours detectFrom + 14 … jour inclus, même rangement.
    mapping(uint256 => uint256) private _cumul;
    /// @dev Partie en cours : départ (64 bits) | concours << 64. 0 = aucune.
    mapping(address player => uint256) private _runs;
    mapping(uint32 contest => mapping(address player => Result)) private _best;
    mapping(uint32 contest => Board) private _boards;

    event DayRecorded(uint32 day, uint64 price);
    event DipFound(uint32 day, uint8 bonus);
    event RunStarted(address indexed player, uint32 contest);
    event ScoreSubmitted(
        address indexed player, uint32 contest, uint32 day, uint32 caught, uint32 coins, uint32 score, bytes32 nickname
    );

    error InvalidGenesis();
    error StalePrice();
    error ContestNotReady();
    error InvalidTaps();
    error NoRun();
    error RunExpired();
    error TooFast();
    error InvalidNickname();
    error NotBetter();
    error DipOutOfRange();

    /// @param feed Flux Chainlink BTC/USD (8 décimales).
    /// @param dipDays Jours des baisses historiques, strictement croissants, tous < detectFrom.
    /// @param dipBonus Bonus de chaque baisse (0 à 10), même longueur que `dipDays`.
    /// @param histMinSeconds Temps minimal (s) au début de chaque tranche de 30 jours, du jour 0
    ///        à la tranche du jour detectFrom + 13 incluse : (detectFrom + 13) / 30 + 1 valeurs
    ///        non décroissantes.
    /// @param detectFrom Premier jour évalué par la chaîne (>= 45).
    /// @param recentPrices Prix bruts (USD × 1e8, > 0) des jours detectFrom − 45 … detectFrom + 13.
    constructor(
        address feed,
        uint16[] memory dipDays,
        uint8[] memory dipBonus,
        uint16[] memory histMinSeconds,
        uint32 detectFrom,
        uint64[] memory recentPrices
    ) {
        if (feed.code.length == 0) revert InvalidGenesis();
        uint256 from = detectFrom;
        // Les baisses trouvées tiennent sur 16 bits : on garde de la marge (an 2190).
        if (from < RECENT_BEFORE || from + EVAL_LAG > type(uint16).max) revert InvalidGenesis();
        uint256 n = dipDays.length;
        uint256 lastHist = from + RECENT_AFTER;
        uint256 buckets = lastHist / MIN_TIME_BUCKET_DAYS + 1;
        if (dipBonus.length != n || histMinSeconds.length != buckets || recentPrices.length != RECENT_COUNT) {
            revert InvalidGenesis();
        }
        bytes memory data = new bytes(1 + 3 * n + 2 * buckets); // data[0] = 0x00 (STOP)
        for (uint256 i; i < n; ++i) {
            uint256 day = dipDays[i];
            if ((i > 0 && day <= dipDays[i - 1]) || day >= from || dipBonus[i] > MAX_BONUS) revert InvalidGenesis();
            data[1 + 3 * i] = bytes1(uint8(day >> 8));
            data[2 + 3 * i] = bytes1(uint8(day));
            data[3 + 3 * i] = bytes1(dipBonus[i]);
        }
        for (uint256 k; k < buckets; ++k) {
            uint256 secs = histMinSeconds[k];
            if (k > 0 && secs < histMinSeconds[k - 1]) revert InvalidGenesis();
            data[1 + 3 * n + 2 * k] = bytes1(uint8(secs >> 8));
            data[2 + 3 * n + 2 * k] = bytes1(uint8(secs));
        }
        // Code de création : PUSH4 longueur, DUP1, PUSH1 14, PUSH1 0, CODECOPY, PUSH1 0, RETURN.
        // Plus de 24 576 octets : `create` échoue, InvalidGenesis.
        bytes memory init = abi.encodePacked(hex"63", uint32(data.length), hex"80600e6000396000f3", data);
        address store;
        assembly ("memory-safe") {
            store := create(0, add(init, 0x20), mload(init))
        }
        if (store == address(0)) revert InvalidGenesis();

        for (uint256 i; i < RECENT_COUNT; ++i) {
            uint256 price = recentPrices[i];
            if (price == 0) revert InvalidGenesis();
            _writePacked(_prices, from - RECENT_BEFORE + i, price);
        }
        _state = State({
            lastRecorded: uint32(lastHist),
            nextEval: uint32(from),
            lastDip: n > 0 ? uint32(dipDays[n - 1]) : 0,
            hasDip: n > 0
        });
        FEED = feed;
        DETECT_FROM = detectFrom;
        _DATA = store;
        _HIST_DIPS = n;
        _BUCKETS = buckets;
        _HIST_LAST_SECONDS = histMinSeconds[buckets - 1];
    }

    // --- Prix et baisses -------------------------------------------------------------------

    /// @notice Enregistre le prix Chainlink pour les jours écoulés depuis le dernier jour
    ///         enregistré (remplissage plat), au plus MAX_DAYS_PER_CALL par appel, évalue les
    ///         jours devenus évaluables et met à jour le temps minimal. N'importe qui peut
    ///         l'appeler (à répéter tant que `daysBehind()` > 0) ; `startRun` l'appelle aussi.
    ///         Rien à faire si le jour courant est déjà enregistré (le flux n'est pas lu).
    function recordDay() public {
        uint256 today = (block.timestamp - DATA_START) / 1 days;
        State memory st = _state;
        uint256 last = st.lastRecorded;
        if (today <= last) return;
        (, int256 answer,, uint256 updatedAt,) = IAggregatorV3(FEED).latestRoundData();
        if (answer <= 0 || uint256(answer) > MASK64 || updatedAt < block.timestamp - MAX_STALE) revert StalePrice();
        uint256 price = uint256(answer);

        uint256 lastHist = uint256(DETECT_FROM) + RECENT_AFTER;
        uint256 sum = last > lastHist ? _readPacked(_cumul, last) : 0;
        uint256 prev = _readPacked(_prices, last);
        if (today > last + MAX_DAYS_PER_CALL) today = last + MAX_DAYS_PER_CALL; // travail borné
        for (uint256 d = last + 1; d <= today; ++d) {
            _writePacked(_prices, d, price);
            emit DayRecorded(uint32(d), uint64(price));
            sum += _microsFor(prev, price, d);
            _writePacked(_cumul, d, sum);
            prev = price;
        }
        st.lastRecorded = uint32(today);
        uint256 next = st.nextEval;
        while (next + EVAL_LAG <= today) {
            _evaluate(next, st);
            ++next;
        }
        st.nextEval = uint32(next);
        _state = st;
    }

    /// @notice Jours écoulés pas encore enregistrés (0 = à jour) : appels de `recordDay` restants
    ///         = arrondi supérieur de daysBehind / MAX_DAYS_PER_CALL.
    function daysBehind() external view returns (uint256) {
        uint256 today = (block.timestamp - DATA_START) / 1 days;
        uint256 last = _state.lastRecorded;
        return today > last ? today - last : 0;
    }

    /// @notice Dernier jour dont le prix est connu.
    function lastRecordedDay() external view returns (uint32) {
        return _state.lastRecorded;
    }

    /// @notice Prix brut (USD × 1e8) d'un jour ; 0 si inconnu (avant detectFrom − 45 ou pas encore enregistré).
    function priceAt(uint32 day) public view returns (uint64) {
        uint256 d = day;
        if (d + RECENT_BEFORE < DETECT_FROM || d > _state.lastRecorded) return 0;
        return uint64(_readPacked(_prices, d));
    }

    /// @notice Prix des jours fromDay … fromDay + count − 1 (0 pour un jour inconnu).
    function pricesFrom(uint32 fromDay, uint32 count) external view returns (uint64[] memory prices) {
        prices = new uint64[](count);
        for (uint256 i; i < count; ++i) {
            uint256 d = uint256(fromDay) + i;
            if (d > type(uint32).max) break;
            prices[i] = priceAt(uint32(d));
        }
    }

    /// @notice Nombre de baisses connues (historiques puis trouvées par la chaîne).
    function dipCount() external view returns (uint256) {
        return _HIST_DIPS + _found.length;
    }

    /// @notice Baisse n° i (jours croissants) : son jour et son bonus.
    function dipAt(uint256 i) external view returns (uint16 day, uint8 bonus) {
        uint256 h = _HIST_DIPS;
        uint256 packed;
        if (i < h) {
            address store = _DATA;
            assembly ("memory-safe") {
                mstore(0, 0)
                extcodecopy(store, 29, add(1, mul(i, 3)), 3)
                packed := mload(0)
            }
        } else {
            if (i - h >= _found.length) revert DipOutOfRange();
            packed = _found[i - h];
        }
        return (uint16(packed >> 8), uint8(packed));
    }

    /// @dev Évalue le jour c (prix connus jusqu'à c + 15). Prix lissé s(d) = médiane de
    ///      p(d − 1), p(d), p(d + 1). Baisse si : s(j) > s(c) pour j = c − 7 … c − 1 ;
    ///      s(j) >= s(c) pour j = c + 1 … c + 7 ; pic = max s(c − 30 … c − 1) avec
    ///      pic × 100 >= s(c) × 110 ; rebond = max s(c + 1 … c + 14) avec rebond × 100 >= s(c) × 105 ;
    ///      plus de 7 jours après la baisse précédente.
    function _evaluate(uint256 c, State memory st) private {
        if (c > type(uint16).max) return;
        // p[i] = prix du jour c − 31 + i, i = 0 … 46 ; s(c − 30 + o) = médiane(p[o], p[o + 1], p[o + 2]).
        uint256[47] memory p;
        {
            uint256 first = c - 31;
            uint256 slot = type(uint256).max;
            uint256 word;
            for (uint256 i; i < 47; ++i) {
                uint256 d = first + i;
                if (d >> 2 != slot) {
                    slot = d >> 2;
                    word = _prices[slot];
                }
                p[i] = (word >> ((d & 3) << 6)) & MASK64;
            }
        }
        uint256 sc = _median(p[30], p[31], p[32]);
        uint256 peak;
        for (uint256 o; o < 30; ++o) {
            uint256 s = _median(p[o], p[o + 1], p[o + 2]);
            if (o >= 23 && s <= sc) return; // c − 7 … c − 1 : strictement au-dessus
            if (s > peak) peak = s;
        }
        if (peak * 100 < sc * 110) return;
        uint256 rebound;
        for (uint256 o = 31; o < 45; ++o) {
            uint256 s = _median(p[o], p[o + 1], p[o + 2]);
            if (o <= 37 && s < sc) return; // c + 1 … c + 7 : pas en dessous
            if (s > rebound) rebound = s;
        }
        if (rebound * 100 < sc * 105) return;
        if (st.hasDip && c - st.lastDip <= 7) return;
        // Arrondi de 10 × (1 − s / pic) ; pic > s > 0, donc bonus <= 10.
        uint256 bonus = (20 * (peak - sc) + peak) / (2 * peak);
        _found.push(uint24((c << 8) | bonus));
        st.lastDip = uint32(c);
        st.hasDip = true;
        emit DipFound(uint32(c), uint8(bonus));
    }

    function _median(uint256 a, uint256 b, uint256 c) private pure returns (uint256) {
        (uint256 lo, uint256 hi) = a < b ? (a, b) : (b, a);
        return c < lo ? lo : (c > hi ? hi : c);
    }

    // --- Temps minimal -----------------------------------------------------------------------

    /// @notice Temps minimal (secondes) d'une partie qui atteint `day`. Jusqu'au dernier jour
    ///         historique (detectFrom + 13) : la tranche de 30 jours du jour (la dernière au-delà
    ///         de la table). Ensuite : la valeur au dernier jour historique + la somme, pour chaque
    ///         jour enregistré d de detectFrom + 14 à day − 1, de floor(12 × 85 × 1e6 / (100 × v(d)))
    ///         microsecondes, arrondie à la seconde inférieure.
    function minTimeFor(uint32 day) public view returns (uint256 secs) {
        uint256 lastHist = uint256(DETECT_FROM) + RECENT_AFTER;
        if (day <= lastHist) {
            uint256 k = uint256(day) / MIN_TIME_BUCKET_DAYS;
            if (k >= _BUCKETS) k = _BUCKETS - 1;
            address store = _DATA;
            uint256 offset = 1 + 3 * _HIST_DIPS + 2 * k;
            assembly ("memory-safe") {
                mstore(0, 0)
                extcodecopy(store, 30, offset, 2)
                secs := mload(0)
            }
            return secs;
        }
        uint256 upTo = uint256(day) - 1;
        uint256 last = _state.lastRecorded;
        if (upTo > last) upTo = last;
        uint256 sum = upTo > lastHist ? _readPacked(_cumul, upTo) : 0;
        return _HIST_LAST_SECONDS + sum / 1e6;
    }

    /// @dev Microsecondes du jour d : v(d) = min(690, b × (100 + 6 × baisse) / 100, b × 26 / 10),
    ///      b = 140 + 8 × niveau, niveau = 10 + (année UTC de d − 2026), baisse = recul en %
    ///      (entier) depuis la veille, 0 si le prix monte. b = 8 × année − 15 988 (>= 92 dès 2010).
    function _microsFor(uint256 p0, uint256 p1, uint256 d) internal pure returns (uint256) {
        uint256 drop = p1 < p0 ? (p0 - p1) * 100 / p0 : 0;
        (uint256 year,) = _civil(d + UNIX_DAY0);
        uint256 b = 140 + 8 * (10 + year) - 8 * FIRST_YEAR;
        uint256 v = b * (100 + 6 * drop) / 100;
        uint256 cap = b * 26 / 10;
        if (cap < v) v = cap;
        if (v > 690) v = 690;
        return (12 * 85 * 1e6) / (100 * v);
    }

    // --- Concours ----------------------------------------------------------------------------

    /// @notice Concours du trimestre civil UTC courant. id = (année − 2026) × 4 + trimestre − 1.
    /// @return id Numéro du concours.
    /// @return startTs Début du trimestre (inclus).
    /// @return endTs Début du trimestre suivant (exclu).
    /// @return finishDay Jour où s'arrête la course du concours.
    function currentContest() public view returns (uint32 id, uint64 startTs, uint64 endTs, uint32 finishDay) {
        (uint256 year, uint256 month) = _civil(block.timestamp / 1 days);
        if (year < FIRST_YEAR) revert ContestNotReady(); // le contrat n'existe qu'à partir de 2026
        uint256 q = (month - 1) / 3;
        id = uint32((year - FIRST_YEAR) * 4 + q);
        uint256 startDay = _daysFromCivil(year, 3 * q + 1);
        uint256 endDay = q == 3 ? _daysFromCivil(year + 1, 1) : _daysFromCivil(year, 3 * q + 4);
        startTs = uint64(startDay * 1 days);
        endTs = uint64(endDay * 1 days);
        finishDay = uint32(startDay - UNIX_DAY0 - 1 - FINISH_LAG);
    }

    /// @notice Jour où s'arrête la course du concours `id` : (jour du 1er jour du trimestre) − 1 − FINISH_LAG.
    function contestFinishDay(uint32 id) public pure returns (uint32) {
        uint256 startDay = _daysFromCivil(FIRST_YEAR + id / 4, 3 * (id % 4) + 1);
        return uint32(startDay - UNIX_DAY0 - 1 - FINISH_LAG);
    }

    /// @dev Année et mois d'un jour Unix (algorithme de H. Hinnant, jours >= 0).
    function _civil(uint256 z) private pure returns (uint256 year, uint256 month) {
        z += 719468;
        uint256 era = z / 146097;
        uint256 doe = z - era * 146097;
        uint256 yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        month = mp < 10 ? mp + 3 : mp - 9;
        year = yoe + era * 400 + (month <= 2 ? 1 : 0);
    }

    /// @dev Jour Unix du 1er du mois `month` de `year` (année >= 1970).
    function _daysFromCivil(uint256 year, uint256 month) private pure returns (uint256) {
        if (month <= 2) year -= 1;
        uint256 era = year / 400;
        uint256 yoe = year - era * 400;
        uint256 doy = (153 * (month > 2 ? month - 3 : month + 9) + 2) / 5;
        uint256 doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        return era * 146097 + doe - 719468;
    }

    // --- Rejeu --------------------------------------------------------------------------------

    /// @notice Rejoue une partie à partir de ses touches, avec les règles entières du jeu.
    ///         Baisses prises en compte : celles dont x + 33 <= finishDay × 12.
    /// @param taps Positions x des touches : non décroissantes, dans [START_X, finishDay × 12), 1 500 au plus.
    /// @param finishDay Jour où s'arrête la course.
    /// @return day Jour atteint (finishDay si la course est finie).
    /// @return caught Baisses attrapées (parfaites ou bonnes).
    /// @return coins Pièces ramassées.
    /// @return score 3 + bonus (écart <= PERFECT) ou 1 + bonus (écart <= GOOD) par baisse attrapée.
    /// @return finalX Position de fin de partie (3e erreur, ou finishDay × 12).
    function verify(uint32[] calldata taps, uint32 finishDay)
        public
        view
        returns (uint32 day, uint32 caught, uint32 coins, uint32 score, uint32 finalX)
    {
        uint256 finishX = uint256(finishDay) * PX_PER_DAY;
        Replay memory r = _replay(taps, finishX);
        if (r.endX == 0) return (finishDay, uint32(r.caught), uint32(r.coins), uint32(r.score), uint32(finishX));
        return (uint32(r.endX / PX_PER_DAY), uint32(r.caught), uint32(r.coins), uint32(r.score), uint32(r.endX));
    }

    function _replay(uint32[] calldata taps, uint256 finishX) private view returns (Replay memory r) {
        uint256 len = taps.length;
        if (len > MAX_TAPS || finishX > type(uint32).max) revert InvalidTaps();
        (bytes memory dips, uint256 n) = _loadDips(finishX);
        r.lives = LIVES;
        uint256 prev = START_X;
        for (uint256 k; k < len;) {
            uint256 x = taps[k];
            unchecked {
                ++k;
            }
            if (x < prev || x >= finishX) revert InvalidTaps();
            prev = x;
            if (r.endX != 0) continue; // touches après la fin : vérifiées puis ignorées
            _passes(r, dips, n, x);
            if (r.endX != 0) continue;
            // Cible : la première baisse non jouée, si elle est à moins de WINDOW pixels.
            if (r.next < n) {
                uint256 packed = _dip(dips, r.next);
                uint256 dipX = (packed >> 8) * PX_PER_DAY;
                uint256 d = dipX > x ? dipX - x : x - dipX;
                if (d <= WINDOW) {
                    ++r.next;
                    if (d <= GOOD) {
                        r.score += (d <= PERFECT ? 3 : 1) + (packed & 0xff);
                        ++r.caught;
                    } else if (--r.lives == 0) {
                        r.endX = x;
                    }
                    continue;
                }
            }
            // Pas de cible : saut, sauf si le canard est déjà en l'air.
            if (x >= r.airborneUntil) _jump(r, dips, n, x, finishX);
        }
        if (r.endX == 0) _passes(r, dips, n, finishX);
    }

    /// @dev Baisses dépassées sans toucher avant `limit` (dipX + GOOD < limit) : chacune coûte
    ///      une vie, en x = dipX + GOOD + 1.
    function _passes(Replay memory r, bytes memory dips, uint256 n, uint256 limit) private pure {
        uint256 next = r.next;
        uint256 lives = r.lives;
        while (next < n) {
            uint256 missX = (_dip(dips, next) >> 8) * PX_PER_DAY + GOOD + 1;
            if (missX > limit) break;
            ++next;
            if (--lives == 0) {
                r.endX = missX;
                break;
            }
        }
        r.next = next;
        r.lives = lives;
    }

    /// @dev Saut en x : en l'air jusqu'à x + JUMP_SPAN, ramasse la pièce de [x + 84, x + 132],
    ///      autour du sommet (une au plus : les pièces sont à 240 pixels l'une de l'autre).
    function _jump(Replay memory r, bytes memory dips, uint256 n, uint256 x, uint256 finishX) private pure {
        r.airborneUntil = x + JUMP_SPAN;
        uint256 c = (x + COIN_FROM + PX_PER_DAY - 1) / PX_PER_DAY;
        c += (COIN_EVERY + COIN_PHASE - c % COIN_EVERY) % COIN_EVERY;
        uint256 coinX = c * PX_PER_DAY;
        if (coinX > x + COIN_TO || coinX < START_X + COIN_TO || coinX >= finishX || c <= r.lastCoin) return;
        uint256 cp = r.cp;
        while (cp < n && (_dip(dips, cp) >> 8) + COIN_CLEAR_AFTER < c) ++cp;
        r.cp = cp;
        if (cp < n && (_dip(dips, cp) >> 8) <= c + COIN_CLEAR_BEFORE) return; // trop près d'une baisse
        ++r.coins;
        r.lastCoin = c;
    }

    /// @dev Baisses en mémoire (3 octets chacune) et nombre de baisses prises en compte :
    ///      celles dont jour × 12 + 33 <= finishX (un préfixe : les jours sont croissants).
    function _loadDips(uint256 finishX) private view returns (bytes memory dips, uint256 n) {
        uint256 h = _HIST_DIPS;
        uint256 f = _found.length;
        dips = new bytes(3 * (h + f));
        address store = _DATA;
        assembly ("memory-safe") {
            extcodecopy(store, add(dips, 0x20), 1, mul(3, h))
        }
        if (finishX < GOOD + 1) return (dips, 0);
        uint256 limit = (finishX - GOOD - 1) / PX_PER_DAY;
        uint256 hi = h;
        while (n < hi) {
            uint256 mid = (n + hi) / 2;
            if ((_dip(dips, mid) >> 8) <= limit) n = mid + 1;
            else hi = mid;
        }
        if (n < h) return (dips, n);
        for (uint256 i; i < f; ++i) {
            uint256 packed = _found[i];
            if ((packed >> 8) > limit) break;
            assembly ("memory-safe") {
                let ptr := add(add(dips, 0x20), mul(add(h, i), 3))
                mstore8(ptr, shr(16, packed))
                mstore8(add(ptr, 1), shr(8, packed))
                mstore8(add(ptr, 2), packed)
            }
            ++n;
        }
    }

    /// @dev Baisse n° i : `jour << 8 | bonus`.
    function _dip(bytes memory dips, uint256 i) private pure returns (uint256 packed) {
        assembly ("memory-safe") {
            packed := shr(232, mload(add(add(dips, 0x20), mul(i, 3))))
        }
    }

    // --- Parties --------------------------------------------------------------------------------

    /// @notice Enregistre les jours écoulés (un appel de `recordDay`, donc au plus
    ///         MAX_DAYS_PER_CALL jours) puis démarre une partie pour l'appelant dans le concours
    ///         courant (remplace la partie en cours). ContestNotReady si le retard restant laisse
    ///         des baisses de la course non évaluées : rappeler `recordDay` d'abord.
    function startRun() external {
        recordDay();
        (uint32 id,,, uint32 finishDay) = currentContest();
        // Toutes les baisses de la course doivent être évaluées.
        if (uint256(finishDay) + EVAL_LAG > _state.lastRecorded) revert ContestNotReady();
        _runs[msg.sender] = block.timestamp | (uint256(id) << 64);
        emit RunStarted(msg.sender, id);
    }

    /// @notice Partie en cours d'un joueur : départ (0 = aucune) et concours.
    function runOf(address player) external view returns (uint64 start, uint32 contest) {
        uint256 run = _runs[player];
        return (uint64(run), uint32(run >> 64));
    }

    /// @notice Rejoue la partie démarrée par `startRun` (course du concours du départ) et
    ///         l'enregistre si elle bat le record de l'appelant dans ce concours.
    /// @param taps Touches de la partie (voir `verify`).
    /// @param nickname Pseudo : 0 à 16 octets [A-Za-z0-9 espace _ - .], le reste à zéro.
    function submit(uint32[] calldata taps, bytes32 nickname) external {
        uint256 run = _runs[msg.sender];
        uint256 start = uint64(run);
        if (start == 0) revert NoRun();
        if (block.timestamp - start > MAX_RUN) revert RunExpired();
        uint32 contest = uint32(run >> 64);
        uint256 finishDay = contestFinishDay(contest);
        Replay memory r = _replay(taps, finishDay * PX_PER_DAY);
        uint256 day = r.endX == 0 ? finishDay : r.endX / PX_PER_DAY; // = finalX / 12
        if (block.timestamp - start < minTimeFor(uint32(day))) revert TooFast();
        delete _runs[msg.sender]; // une soumission par départ
        if (!_validNickname(nickname)) revert InvalidNickname();
        _record(contest, day, r, nickname);
    }

    function _record(uint32 contest, uint256 day, Replay memory r, bytes32 nickname) private {
        Result storage best_ = _best[contest][msg.sender];
        Board storage board = _boards[contest];
        uint256 oldEntry;
        if (best_.at != 0) {
            oldEntry = _pack(best_.day, best_.caught, best_.coins, best_.score, best_.seq, msg.sender);
            // Jour, puis attrapées, puis pièces, puis score : strictement mieux.
            if (_pack(day, r.caught, r.coins, r.score, 0, address(0)) >> 188 <= oldEntry >> 188) revert NotBetter();
        }
        uint256 seq = ++board.seq;
        best_.day = uint32(day);
        best_.caught = uint32(r.caught);
        best_.coins = uint32(r.coins);
        best_.score = uint32(r.score);
        best_.seq = uint32(seq);
        best_.at = uint64(block.timestamp);
        best_.nickname = nickname;
        _place(board, _pack(day, r.caught, r.coins, r.score, seq, msg.sender), oldEntry);
        emit ScoreSubmitted(
            msg.sender, contest, uint32(day), uint32(r.caught), uint32(r.coins), uint32(r.score), nickname
        );
    }

    // --- Classement -----------------------------------------------------------------------------

    /// @notice Meilleur résultat d'un joueur dans un concours ; tout à 0 s'il n'y a jamais joué.
    function best(uint32 contest, address player)
        external
        view
        returns (uint32 day, uint32 caught, uint32 coins, uint32 score, bytes32 nickname, uint64 at)
    {
        Result storage r = _best[contest][player];
        return (r.day, r.caught, r.coins, r.score, r.nickname, r.at);
    }

    /// @notice Classement d'un concours, déjà trié (jour, attrapées, pièces, score, puis le plus ancien).
    function topList(uint32 contest)
        external
        view
        returns (
            address[] memory players,
            uint32[] memory days_,
            uint32[] memory caught,
            uint32[] memory coins,
            uint32[] memory scores,
            bytes32[] memory nicknames
        )
    {
        Board storage board = _boards[contest];
        uint256 count = board.count;
        players = new address[](count);
        days_ = new uint32[](count);
        caught = new uint32[](count);
        coins = new uint32[](count);
        scores = new uint32[](count);
        nicknames = new bytes32[](count);
        for (uint256 i; i < count; ++i) {
            address player = address(uint160(board.top[i]));
            Result storage r = _best[contest][player];
            players[i] = player;
            days_[i] = r.day;
            caught[i] = r.caught;
            coins[i] = r.coins;
            scores[i] = r.score;
            nicknames[i] = r.nickname;
        }
    }

    /// @notice Nombre d'entrées du classement d'un concours (au plus TOP_SIZE).
    function topCount(uint32 contest) external view returns (uint256) {
        return _boards[contest].count;
    }

    /// @dev Met `entry` à sa place dans le top. `oldEntry` (0 si aucun) est l'ancien résultat du
    ///      même joueur, strictement inférieur : s'il est dans le top, sa case est réutilisée.
    function _place(Board storage board, uint256 entry, uint256 oldEntry) private {
        uint256 count = board.count;
        // `end` : case libérée par le décalage (ancienne place, nouvelle case, ou dernière évincée).
        uint256 end = oldEntry == 0 ? count : _indexOf(board, oldEntry, count);
        if (end == count) {
            if (count < TOP_SIZE) {
                board.count = count + 1;
            } else {
                end = TOP_SIZE - 1;
                if (entry < board.top[end]) return; // pas assez bon pour entrer
            }
        }
        uint256 lo;
        uint256 hi = end;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (board.top[mid] > entry) lo = mid + 1;
            else hi = mid;
        }
        for (uint256 i = end; i > lo; --i) {
            board.top[i] = board.top[i - 1];
        }
        board.top[lo] = entry;
    }

    /// @dev Index de `entry` parmi les `count` premières cases, ou `count` si absente.
    function _indexOf(Board storage board, uint256 entry, uint256 count) private view returns (uint256) {
        uint256 lo;
        uint256 hi = count;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            uint256 value = board.top[mid];
            if (value == entry) return mid;
            if (value > entry) lo = mid + 1;
            else hi = mid;
        }
        return count;
    }

    function _pack(uint256 day, uint256 caught, uint256 coins, uint256 score, uint256 seq, address player)
        private
        pure
        returns (uint256)
    {
        return (day << 236) | (caught << 220) | (coins << 204) | (score << 188) | ((SEQ_MASK - seq) << 160)
            | uint256(uint160(player));
    }

    /// @dev 0 à 16 octets ASCII [A-Za-z0-9 espace _ - .] en tête, puis uniquement des zéros.
    function _validNickname(bytes32 nickname) private pure returns (bool) {
        if (uint256(nickname) & type(uint128).max != 0) return false; // octets 16 à 31
        bool ended;
        for (uint256 i; i < NICKNAME_MAX; ++i) {
            bytes1 c = nickname[i];
            if (c == 0) {
                ended = true;
            } else if (ended) {
                return false;
            } else if (
                !((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c == " " || c == "_"
                    || c == "-" || c == ".")
            ) {
                return false;
            }
        }
        return true;
    }

    // --- Stockage compact ------------------------------------------------------------------------

    function _readPacked(mapping(uint256 => uint256) storage m, uint256 day) private view returns (uint256) {
        return (m[day >> 2] >> ((day & 3) << 6)) & MASK64;
    }

    function _writePacked(mapping(uint256 => uint256) storage m, uint256 day, uint256 value) private {
        uint256 shift = (day & 3) << 6;
        uint256 slot = day >> 2;
        m[slot] = (m[slot] & ~(MASK64 << shift)) | (value << shift);
    }
}
