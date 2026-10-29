// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {DipDuckGame} from "./DipDuckGame.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";

/// @dev Sous-ensemble des cheatcodes du runner de tests Solidity de Hardhat
///      (compatibles Foundry), déclaré ici pour ne pas dépendre de forge-std.
interface GameVm {
    function expectRevert(bytes calldata revertData) external;
    function prank(address msgSender) external;
    function warp(uint256 newTimestamp) external;
}

/// @dev Expose la formule du temps minimal d'un jour.
contract GameHarness is DipDuckGame {
    constructor(
        address feed,
        uint16[] memory dipDays,
        uint8[] memory dipBonus,
        uint16[] memory histMinSeconds,
        uint32 detectFrom,
        uint64[] memory recentPrices
    ) DipDuckGame(feed, dipDays, dipBonus, histMinSeconds, detectFrom, recentPrices) {}

    function microsFor(uint256 p0, uint256 p1, uint256 day) external pure returns (uint256) {
        return _microsFor(p0, p1, day);
    }
}

/// @notice Tests du jeu « Attrape la baisse » : genèse, enregistrement des prix (remplissage
///         plat, prix périmé), détection des baisses sur des séries construites, temps minimal
///         (historique et cumul), trimestres, rejeu (baisses, sauts, pièces), parties, départage,
///         top 50 ; fuzzing du rejeu contre une implémentation de référence écrite mot pour mot
///         d'après la spécification.
contract DipDuckGameTest {
    GameVm private constant vm = GameVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant CAROL = address(0xCA201);

    uint256 private constant DATA_START = 1282089600;
    /// @dev Genèse de base : detectFrom 5900, dernier jour historique 5913 (2026-10-26),
    ///      trimestre T4 2026 (concours 3), course jusqu'au jour 5872.
    uint32 private constant D = 5900;
    uint32 private constant H = 5913;
    uint32 private constant FIN = 5872;
    uint32 private constant FIN_X = FIN * 12;
    uint32 private constant CONTEST = 3;
    /// @dev Course courte pour les rejeux directs : baisses 100, 110, 200, 300 (x = 1200, 1320,
    ///      2400, 3600), bonus 0, 2, 0, 5, fin au jour 400 (x = 4800).
    uint32 private constant END = 400;
    uint32 private constant END_X = END * 12;

    MockAggregator private feed;
    DipDuckGame private game;

    function setUp() public {
        vm.warp(_ts(H) + 3600);
        feed = new MockAggregator(100e8);
        game = _deploy(_baseDays(), _baseBonus(), D, _flat(100e8), 1);
    }

    // --- Outils -------------------------------------------------------------------------

    function _ts(uint256 day) private pure returns (uint256) {
        return DATA_START + day * 1 days;
    }

    function _baseDays() private pure returns (uint16[] memory d) {
        d = new uint16[](4);
        (d[0], d[1], d[2], d[3]) = (100, 110, 200, 300);
    }

    function _baseBonus() private pure returns (uint8[] memory b) {
        b = new uint8[](4);
        (b[0], b[1], b[2], b[3]) = (0, 2, 0, 5);
    }

    function _flat(uint64 price) private pure returns (uint64[] memory p) {
        p = new uint64[](59);
        for (uint256 i; i < 59; ++i) p[i] = price;
    }

    /// @dev Table historique : `step` secondes par tranche de 30 jours.
    function _table(uint32 from, uint16 step) private pure returns (uint16[] memory t) {
        t = new uint16[]((uint256(from) + 13) / 30 + 1);
        for (uint256 k; k < t.length; ++k) t[k] = uint16(k * step);
    }

    function _deploy(uint16[] memory days_, uint8[] memory bonus, uint32 from, uint64[] memory prices, uint16 step)
        private
        returns (DipDuckGame)
    {
        return new DipDuckGame(address(feed), days_, bonus, _table(from, step), from, prices);
    }

    function _taps(uint32 a) private pure returns (uint32[] memory t) {
        t = new uint32[](1);
        t[0] = a;
    }

    function _taps(uint32 a, uint32 b) private pure returns (uint32[] memory t) {
        t = new uint32[](2);
        (t[0], t[1]) = (a, b);
    }

    function _taps(uint32 a, uint32 b, uint32 c) private pure returns (uint32[] memory t) {
        t = new uint32[](3);
        (t[0], t[1], t[2]) = (a, b, c);
    }

    function _taps(uint32 a, uint32 b, uint32 c, uint32 d) private pure returns (uint32[] memory t) {
        t = new uint32[](4);
        (t[0], t[1], t[2], t[3]) = (a, b, c, d);
    }

    function _taps(uint32 a, uint32 b, uint32 c, uint32 d, uint32 e) private pure returns (uint32[] memory t) {
        t = new uint32[](5);
        (t[0], t[1], t[2], t[3], t[4]) = (a, b, c, d, e);
    }

    function _taps7(uint32 a, uint32 b, uint32 c, uint32 d, uint32 e, uint32 f, uint32 g)
        private
        pure
        returns (uint32[] memory t)
    {
        t = new uint32[](7);
        (t[0], t[1], t[2], t[3], t[4], t[5], t[6]) = (a, b, c, d, e, f, g);
    }

    function _expect(
        DipDuckGame g,
        uint32[] memory taps,
        uint32 finishDay,
        uint32 day,
        uint32 caught,
        uint32 coins,
        uint32 score,
        uint32 finalX
    ) private view {
        (uint32 d, uint32 c, uint32 k, uint32 s, uint32 x) = g.verify(taps, finishDay);
        require(d == day, "day");
        require(c == caught, "caught");
        require(k == coins, "coins");
        require(s == score, "score");
        require(x == finalX, "finalX");
    }

    function _err(bytes4 selector) private pure returns (bytes memory) {
        return abi.encodeWithSelector(selector);
    }

    /// @dev Démarre une partie, attend juste assez, puis soumet (échec attendu si selector != 0).
    function _playExpect(DipDuckGame g, address who, uint32[] memory taps, bytes32 nickname, bytes4 selector)
        private
    {
        vm.prank(who);
        g.startRun();
        (, uint32 contest) = g.runOf(who);
        (uint32 day,,,,) = g.verify(taps, g.contestFinishDay(contest));
        vm.warp(block.timestamp + g.minTimeFor(day));
        vm.prank(who);
        if (selector != bytes4(0)) vm.expectRevert(_err(selector));
        g.submit(taps, nickname);
    }

    function _play(DipDuckGame g, address who, uint32[] memory taps, bytes32 nickname) private {
        _playExpect(g, who, taps, nickname, bytes4(0));
    }

    function _player(uint256 i) private pure returns (address) {
        return address(uint160(0x10000 + i));
    }

    function _lastDip(DipDuckGame g) private view returns (uint16 day, uint8 bonus) {
        return g.dipAt(g.dipCount() - 1);
    }

    // --- Constantes et genèse ------------------------------------------------------------------

    function test_Constants() public view {
        require(game.DATA_START() == 1282089600 && game.PX_PER_DAY() == 12, "DATA_START, PX_PER_DAY");
        require(game.PERFECT() == 12 && game.GOOD() == 32 && game.WINDOW() == 96 && game.LIVES() == 3, "fenetres");
        require(game.START_X() == 528 && game.JUMP_SPAN() == 216, "depart, saut");
        require(game.COIN_FROM() == 84 && game.COIN_TO() == 132 && game.COIN_EVERY() == 20, "pieces");
        require(game.COIN_PHASE() == 15 && game.COIN_CLEAR_BEFORE() == 2 && game.COIN_CLEAR_AFTER() == 14, "pieces (2)");
        require(game.MAX_RUN() == 3 hours && game.TOP_SIZE() == 50 && game.FINISH_LAG() == 15, "concours");
        require(game.MAX_STALE() == 26 hours && game.MIN_TIME_BUCKET_DAYS() == 30, "temps");
        require(game.MAX_DAYS_PER_CALL() == 60 && game.daysBehind() == 0, "rattrapage");
        require(game.FEED() == address(feed) && game.DETECT_FROM() == D, "immuables");
    }

    function test_GenesisRead() public view {
        require(game.dipCount() == 4 && game.lastRecordedDay() == H, "baisses, dernier jour");
        (uint16 day, uint8 bonus) = game.dipAt(1);
        require(day == 110 && bonus == 2, "dipAt(1)");
        (day, bonus) = game.dipAt(3);
        require(day == 300 && bonus == 5, "dipAt(3)");
        require(game.priceAt(D - 45) == 100e8 && game.priceAt(H) == 100e8, "prix fournis");
        require(game.priceAt(D - 46) == 0 && game.priceAt(H + 1) == 0, "prix inconnus");
        require(game.topCount(CONTEST) == 0, "vide");
        (uint64 start, uint32 contest) = game.runOf(ALICE);
        require(start == 0 && contest == 0, "pas de partie");
    }

    function test_DipAtOutOfRange() public {
        vm.expectRevert(_err(DipDuckGame.DipOutOfRange.selector));
        game.dipAt(4);
    }

    function _expectInvalid(
        address feed_,
        uint16[] memory days_,
        uint8[] memory bonus,
        uint16[] memory table,
        uint32 from,
        uint64[] memory prices
    ) private {
        vm.expectRevert(_err(DipDuckGame.InvalidGenesis.selector));
        new DipDuckGame(feed_, days_, bonus, table, from, prices);
    }

    function test_InvalidGenesis() public {
        uint16[] memory d = _baseDays();
        uint8[] memory b = _baseBonus();
        uint16[] memory t = _table(D, 1);
        uint64[] memory p = _flat(1e8);
        _expectInvalid(address(0xdead), d, b, t, D, p); // flux sans code
        _expectInvalid(address(feed), d, new uint8[](3), t, D, p); // longueurs
        _expectInvalid(address(feed), d, b, _table(D + 30, 1), D, p); // table trop longue
        uint16[] memory shortT = new uint16[](t.length - 1);
        _expectInvalid(address(feed), d, b, shortT, D, p); // table trop courte
        uint16[] memory down = _table(D, 1);
        down[down.length - 1] = down[down.length - 2] - 1;
        _expectInvalid(address(feed), d, b, down, D, p); // table décroissante
        _expectInvalid(address(feed), d, b, t, D, new uint64[](58)); // 58 prix
        uint64[] memory zero = _flat(1e8);
        zero[30] = 0;
        _expectInvalid(address(feed), d, b, t, D, zero); // prix nul
        uint16[] memory same = _baseDays();
        same[1] = 100;
        _expectInvalid(address(feed), same, b, t, D, p); // pas strictement croissant
        uint8[] memory big = _baseBonus();
        big[2] = 11;
        _expectInvalid(address(feed), d, big, t, D, p); // bonus > 10
        _expectInvalid(address(feed), d, b, _table(300, 1), 300, p); // baisse 300 >= detectFrom
        _expectInvalid(address(feed), new uint16[](0), new uint8[](0), _table(44, 1), 44, p); // detectFrom < 45
        // Limites acceptées : baisse à detectFrom − 1, bonus 10, detectFrom = 45, aucune baisse.
        big[2] = 10;
        new DipDuckGame(address(feed), d, big, _table(301, 1), 301, p);
        new DipDuckGame(address(feed), new uint16[](0), new uint8[](0), _table(45, 1), 45, p);
    }

    // --- Enregistrement des prix -------------------------------------------------------------

    function test_RecordFlatFill() public {
        vm.warp(_ts(H + 5) + 10);
        feed.setAnswer(123e8, 0);
        game.recordDay();
        require(game.lastRecordedDay() == H + 5, "dernier jour");
        for (uint32 d = H + 1; d <= H + 5; ++d) require(game.priceAt(d) == 123e8, "remplissage plat");
        require(game.priceAt(H) == 100e8 && game.priceAt(H + 6) == 0, "bords");
        uint64[] memory ps = game.pricesFrom(H - 1, 8);
        require(ps.length == 8 && ps[0] == 100e8 && ps[1] == 100e8 && ps[2] == 123e8 && ps[6] == 123e8, "pricesFrom");
        require(ps[7] == 0, "pricesFrom : inconnu");
        // Même jour : le flux n'est plus lu, même périmé ou nul.
        feed.setAnswer(0, 1);
        game.recordDay();
        require(game.priceAt(H + 5) == 123e8, "inchange");
        // Jour suivant : un seul jour ajouté.
        vm.warp(_ts(H + 6));
        feed.setAnswer(77e8, 0);
        game.recordDay();
        require(game.lastRecordedDay() == H + 6 && game.priceAt(H + 6) == 77e8 && game.priceAt(H + 5) == 123e8, "+1");
    }

    function test_CatchUp200DaysIn4Calls() public {
        vm.warp(_ts(H + 200) + 1);
        feed.setAnswer(90e8, 0);
        require(game.daysBehind() == 200, "200 jours de retard");
        uint256 maxGas;
        for (uint256 k = 1; k <= 4; ++k) {
            uint256 before = gasleft();
            game.recordDay();
            uint256 used = before - gasleft();
            if (used > maxGas) maxGas = used;
            uint256 expected = k < 4 ? 60 * k : 200;
            require(game.lastRecordedDay() == H + expected && game.daysBehind() == 200 - expected, "60 jours par appel");
        }
        // 60 jours + 59 évaluations dans un seul appel : gas borné, très loin d'un bloc.
        require(maxGas < 3_000_000, "appel plafonne < 3 M");
        require(game.priceAt(H + 200) == 90e8 && game.priceAt(H + 61) == 90e8, "prix");
        game.recordDay(); // à jour : rien
        require(game.lastRecordedDay() == H + 200, "a jour");
        // Le cumul du temps minimal est continu d'un appel à l'autre (prix plats : même valeur par jour).
        require(game.minTimeFor(H + 121) >= game.minTimeFor(H + 61), "cumul continu");
    }

    function test_ContestNotReadyDuringCatchUp() public {
        // 2027-04-06 (jour 6075), concours 5 : course jusqu'au jour 6054, prêt quand 6069 est enregistré.
        vm.warp(_ts(6075) + 1);
        bytes memory notReady = _err(DipDuckGame.ContestNotReady.selector);
        vm.prank(ALICE);
        vm.expectRevert(notReady); // startRun n'enregistrerait que jusqu'au jour 5973
        game.startRun();
        game.recordDay(); // 5973
        vm.prank(ALICE);
        vm.expectRevert(notReady); // 6033 < 6069
        game.startRun();
        require(game.lastRecordedDay() == 5973 && game.daysBehind() == 102, "rien garde par l'echec");
        game.recordDay(); // 6033
        vm.prank(ALICE);
        game.startRun(); // enregistre jusqu'à 6075 : prêt
        (, uint32 contest) = game.runOf(ALICE);
        require(contest == 5 && game.lastRecordedDay() == 6075 && game.daysBehind() == 0, "pret");
    }

    function test_StalePrice() public {
        vm.warp(_ts(H + 1) + 7200);
        bytes memory stale = _err(DipDuckGame.StalePrice.selector);
        feed.setAnswer(100e8, block.timestamp - 26 hours - 1);
        vm.expectRevert(stale);
        game.recordDay();
        feed.setAnswer(0, 0);
        vm.expectRevert(stale);
        game.recordDay();
        feed.setAnswer(-1, 0);
        vm.expectRevert(stale);
        game.recordDay();
        feed.setAnswer(int256(uint256(type(uint64).max)) + 1, 0);
        vm.expectRevert(stale);
        game.recordDay();
        // startRun enregistre aussi : même refus.
        feed.setAnswer(100e8, block.timestamp - 26 hours - 1);
        vm.prank(ALICE);
        vm.expectRevert(stale);
        game.startRun();
        // 26 h pile : accepté.
        feed.setAnswer(int256(uint256(type(uint64).max)), block.timestamp - 26 hours);
        game.recordDay();
        require(game.priceAt(H + 1) == type(uint64).max, "26 h pile");
    }

    // --- Détection des baisses --------------------------------------------------------------

    /// @dev Série de la genèse autour de c = D + 5 (indice 50) : pic P avant c − 7, palier 102
    ///      de c − 7 à c − 1, 100 en c, 101 de c + 1 à c + 8 ; le flux donnera ensuite R.
    ///      s(c) = médiane(102, 100, 101) = 101.
    function _vShape(uint64 peak) private pure returns (uint64[] memory p) {
        p = new uint64[](59);
        for (uint256 i; i < 59; ++i) {
            if (i <= 42) p[i] = peak;
            else if (i <= 49) p[i] = 102e8;
            else if (i == 50) p[i] = 100e8;
            else p[i] = 101e8;
        }
    }

    /// @dev Déploie, puis enregistre jusqu'à aujourd'hui (au moins le jour D + 40) avec le prix R.
    function _detect(uint64[] memory prices, uint16[] memory days_, uint64 rebound) private returns (DipDuckGame g) {
        g = _deploy(days_, new uint8[](days_.length), D, prices, 1);
        if (block.timestamp < _ts(D + 40)) vm.warp(_ts(D + 40) + 1);
        feed.setAnswer(int256(uint256(rebound)), 0);
        g.recordDay();
    }

    function test_DetectSharpV() public {
        DipDuckGame g = _deploy(new uint16[](0), new uint8[](0), D, _vShape(120e8), 1);
        feed.setAnswer(110e8, 0);
        // c + 14 enregistré : c n'est pas encore évaluable (la médiane de c + 14 demande c + 15).
        vm.warp(_ts(D + 19) + 1);
        g.recordDay();
        require(g.dipCount() == 0, "pas encore");
        vm.warp(_ts(D + 20) + 1);
        g.recordDay();
        require(g.dipCount() == 1, "V detecte");
        (uint16 day, uint8 bonus) = g.dipAt(0);
        // bonus = (20 × (120 − 101) + 120) / 240 = 2.
        require(day == D + 5 && bonus == 2, "jour et bonus");
        // Rien d'autre ensuite (palier plat à 110).
        vm.warp(_ts(D + 80) + 1);
        g.recordDay();
        require(g.dipCount() == 1, "palier plat ignore");
    }

    function test_DetectBonus() public {
        DipDuckGame g = _detect(_vShape(200e8), new uint16[](0), 110e8);
        (, uint8 bonus) = _lastDip(g);
        require(bonus == 5, "(20 x 99 + 200) / 400 = 5");
        g = _detect(_vShape(10000e8), new uint16[](0), 110e8);
        (, bonus) = _lastDip(g);
        require(bonus == 10, "plafond 10");
        // Pic à 111,1 pile : pic × 100 = s × 110 accepté ; bonus 1.
        g = _detect(_vShape(11110000000), new uint16[](0), 110e8);
        (, bonus) = _lastDip(g);
        require(g.dipCount() == 1 && bonus == 1, "pic limite");
        g = _detect(_vShape(11109999999), new uint16[](0), 110e8);
        require(g.dipCount() == 0, "pic < 10 %");
    }

    function test_DetectReboundThreshold() public {
        require(_detect(_vShape(120e8), new uint16[](0), 10605000000).dipCount() == 1, "rebond 5 % pile");
        require(_detect(_vShape(120e8), new uint16[](0), 10604999999).dipCount() == 0, "rebond < 5 %");
        require(_detect(_vShape(120e8), new uint16[](0), 104e8).dipCount() == 0, "rebond 3 %");
    }

    function test_DetectFlatIgnored() public {
        require(_detect(_flat(100e8), new uint16[](0), 100e8).dipCount() == 0, "tout plat");
        // Fond en palier : 100 de c à c + 2 : une seule baisse, au premier jour.
        uint64[] memory p = _vShape(120e8);
        (p[51], p[52]) = (100e8, 100e8);
        DipDuckGame g = _detect(p, new uint16[](0), 110e8);
        (uint16 day,) = _lastDip(g);
        require(g.dipCount() == 1 && day == D + 5, "palier : premier jour seulement");
        // Avant non strictement au-dessus : s(c − 1) = s(c) = 101 : la baisse est la veille.
        p = _vShape(120e8);
        p[49] = 101e8;
        g = _detect(p, new uint16[](0), 110e8);
        (day,) = _lastDip(g);
        require(g.dipCount() == 1 && day == D + 4, "avant non strict");
        // Après en dessous : s(c + 3) < s(c).
        p = _vShape(120e8);
        (p[52], p[53], p[54]) = (99e8, 99e8, 99e8);
        g = _detect(p, new uint16[](0), 110e8);
        (day,) = _lastDip(g);
        require(g.dipCount() == 1 && day != D + 5, "la baisse est plus loin");
    }

    function test_DetectSpacing() public {
        uint16[] memory near = new uint16[](1);
        near[0] = uint16(D - 2); // c − 7
        DipDuckGame g = _detect(_vShape(120e8), near, 110e8);
        require(g.dipCount() == 1, "7 jours apres la precedente : ignoree");
        near[0] = uint16(D - 3); // c − 8
        g = _detect(_vShape(120e8), near, 110e8);
        (uint16 day,) = _lastDip(g);
        require(g.dipCount() == 2 && day == D + 5, "8 jours : trouvee");
    }

    // --- Temps minimal -----------------------------------------------------------------------

    /// @dev Année UTC d'un jour du jeu, comptée année par année (indépendante du contrat).
    function _refYear(uint256 day) private pure returns (uint256 y) {
        uint256 u = day + 14839;
        y = 1970;
        while (true) {
            uint256 len = (y % 4 == 0 && (y % 100 != 0 || y % 400 == 0)) ? 366 : 365;
            if (u < len) return y;
            u -= len;
            ++y;
        }
    }

    function _refMicros(uint256 p0, uint256 p1, uint256 day) private pure returns (uint256) {
        uint256 drop = p1 < p0 ? (p0 - p1) * 100 / p0 : 0;
        int256 level = 10 + int256(_refYear(day)) - 2026;
        uint256 b = uint256(140 + 8 * level);
        uint256 v = 690;
        uint256 v1 = b * (100 + 6 * drop) / 100;
        uint256 v2 = b * 26 / 10;
        if (v1 < v) v = v1;
        if (v2 < v) v = v2;
        return (12 * 85 * 1e6) / (100 * v);
    }

    function test_MinTimeHistorical() public {
        DipDuckGame g = _deploy(_baseDays(), _baseBonus(), D, _flat(100e8), 2);
        require(g.minTimeFor(0) == 0 && g.minTimeFor(29) == 0 && g.minTimeFor(30) == 2, "tranches 0 et 1");
        require(g.minTimeFor(400) == 26 && g.minTimeFor(5879) == 2 * 195 && g.minTimeFor(5880) == 2 * 196, "tranches");
        require(g.minTimeFor(H) == 2 * 197, "dernier jour historique");
        require(g.minTimeFor(H + 1) == 2 * 197 && g.minTimeFor(type(uint32).max) == 2 * 197, "rien d'enregistre");
    }

    function test_MinTimeCumul() public {
        DipDuckGame g = _deploy(_baseDays(), _baseBonus(), D, _flat(100e8), 2);
        // Jour par jour jusqu'au jour 5990 (2027-01-11) : passage à 2027 (jour 5980), baisses de 0 à 22 %.
        uint256 price = 100e8;
        for (uint256 d = H + 1; d <= 5990; ++d) {
            price = d % 3 == 0 ? 100e8 : price * (100 - (d * 37) % 23) / 100;
            vm.warp(_ts(d) + 60);
            feed.setAnswer(int256(price), 0);
            g.recordDay();
        }
        uint256 sum;
        for (uint256 day = H + 1; day <= 5995; ++day) {
            require(g.minTimeFor(uint32(day)) == 2 * 197 + sum / 1e6, "cumul");
            if (day <= 5990) sum += _refMicros(g.priceAt(uint32(day - 1)), g.priceAt(uint32(day)), day);
        }
        require(sum > 2e6, "plusieurs secondes");
        // Exemple à la main : jour H + 1 = 2026-10-27, niveau 10, b = 220.
        GameHarness h = new GameHarness(address(feed), _baseDays(), _baseBonus(), _table(D, 1), D, _flat(1e8));
        require(h.microsFor(100e8, 90e8, H + 1) == 28977, "baisse 10 % : v = 352");
        require(h.microsFor(100e8, 100e8, H + 1) == 46363, "plat : v = 220");
        require(h.microsFor(100e8, 50e8, H + 1) == 17832, "baisse 50 % : v = 572 (b x 2,6)");
        // 2032 : niveau 16, b = 268 ; baisse 50 % : min(690, 1072, 696) = 690.
        require(h.microsFor(100e8, 50e8, 7806) == 14782, "plafond 690");
        require(h.microsFor(100e8, 50e8, 7805) == uint256(1020000000) / (100 * 676), "2031 : b = 260, v = 676");
    }

    function testFuzz_MicrosMatchReference(uint64 p0, uint64 p1, uint16 day) public {
        GameHarness h = new GameHarness(address(feed), _baseDays(), _baseBonus(), _table(D, 1), D, _flat(1e8));
        uint256 a = uint256(p0) + 1;
        uint256 b = uint256(p1) + 1;
        require(h.microsFor(a, b, day) == _refMicros(a, b, day), "formule");
    }

    // --- Concours ----------------------------------------------------------------------------

    function _contestAt(uint256 ts) private returns (uint32 id, uint64 startTs, uint64 endTs, uint32 finishDay) {
        vm.warp(ts);
        return game.currentContest();
    }

    function test_Quarters() public {
        (uint32 id, uint64 s, uint64 e, uint32 f) = _contestAt(1798761599); // 2026-12-31 23:59:59
        require(id == 3 && s == 1790812800 && e == 1798761600 && f == 5872, "T4 2026");
        (id, s, e, f) = _contestAt(1798761600); // 2027-01-01 00:00:00
        require(id == 4 && s == 1798761600 && e == 1806537600 && f == 5964, "T1 2027");
        (id,,,) = _contestAt(1806537599);
        require(id == 4, "2027-03-31");
        (id, s,,) = _contestAt(1806537600);
        require(id == 5 && s == 1806537600, "2027-04-01");
        (id,,,) = _contestAt(1814400000 - 1); // 2027-06-30 23:59:59
        require(id == 5, "2027-06-30");
        (id,,,) = _contestAt(1814400000); // 2027-07-01
        require(id == 6, "2027-07-01");
        (id,, e,) = _contestAt(1822348800); // 2027-10-01
        require(id == 7 && e == 1830297600, "2027-10-01 -> 2028-01-01");
        require(game.contestFinishDay(0) == 5599 && game.contestFinishDay(1) == 5689, "2026 T1, T2");
        require(game.contestFinishDay(3) == 5872 && game.contestFinishDay(4) == 5964, "T4 2026, T1 2027");
        require(game.contestFinishDay(8) == 6329 && game.contestFinishDay(9) == 6420, "2028 bissextile");
    }

    function testFuzz_QuarterMatchesReference(uint32 offset) public {
        uint256 ts = 1767225600 + uint256(offset) % (75 * 365 days); // 2026 … ~2100
        vm.warp(ts);
        (uint32 id, uint64 s, uint64 e, uint32 f) = game.currentContest();
        require(s <= ts && ts < e, "dans le trimestre");
        require(f == game.contestFinishDay(id), "finishDay");
        require(uint256(f) == s / 1 days - 14839 - 16, "16 jours avant");
        uint256 year = _refYear(ts / 1 days - 14839);
        require(id / 4 + 2026 == year, "annee");
        // Le début du trimestre est un 1er janvier, avril, juillet ou octobre.
        uint256 day0 = s / 1 days - 14839;
        uint256 y = 1970;
        uint256 u = day0 + 14839;
        while (u >= ((y % 4 == 0 && (y % 100 != 0 || y % 400 == 0)) ? 366 : 365)) {
            u -= (y % 4 == 0 && (y % 100 != 0 || y % 400 == 0)) ? 366 : 365;
            ++y;
        }
        uint256 leap = (y % 4 == 0 && (y % 100 != 0 || y % 400 == 0)) ? 1 : 0;
        uint256[4] memory starts = [uint256(0), 90 + leap, 181 + leap, 273 + leap];
        require(u == starts[id % 4], "1er jour du trimestre");
    }

    function test_ContestNotReadyBefore2026() public {
        // Genèse en 2025 : avant le 1er janvier 2026, pas de concours.
        vm.warp(_ts(5413) + 1);
        DipDuckGame g = _deploy(new uint16[](0), new uint8[](0), 5400, _flat(100e8), 1);
        vm.warp(1767225600 - 1); // 2025-12-31 23:59:59
        while (g.daysBehind() > 0) g.recordDay(); // 201 jours : 4 appels
        vm.prank(ALICE);
        vm.expectRevert(_err(DipDuckGame.ContestNotReady.selector));
        g.startRun();
        vm.warp(1767225600); // 2026-01-01 : concours 0, course jusqu'au jour 5599
        require(g.daysBehind() == 1, "un jour de retard");
        vm.prank(ALICE);
        g.startRun();
        (, uint32 contest) = g.runOf(ALICE);
        require(contest == 0 && g.lastRecordedDay() == 5615, "concours 0");
    }

    // --- Rejeu : scénarios écrits à la main ----------------------------------------------------

    function test_ReplayPerfect() public view {
        _expect(game, _taps(1200, 1320, 2400, 3600), END, END, 4, 0, 19, END_X);
        _expect(game, _taps(1188, 1332, 2412, 3588), END, END, 4, 0, 19, END_X); // écart 12 : parfait
        // Course du concours : même chose, fin au jour 5872.
        _expect(game, _taps(1200, 1320, 2400, 3600), FIN, FIN, 4, 0, 19, FIN_X);
    }

    function test_ReplayGood() public view {
        // Écarts 13, 32, 20, 32 : 1 + 0, 1 + 2, 1 + 0, 1 + 5.
        _expect(game, _taps(1213, 1288, 2420, 3632), END, END, 4, 0, 11, END_X);
    }

    function test_ReplayMiss() public view {
        // 1233 : baisse 0 passée (x = 1233), puis cible baisse 1 (écart 87) ratée : 2 vies perdues.
        _expect(game, _taps(1233, 2400, 3600), END, END, 2, 0, 11, END_X);
        // 1167 : écart 33 : ratée ; 1250 : écart 70 : ratée ; 2400 parfait ; baisse 3 passée en 3633.
        _expect(game, _taps(1167, 1250, 2400), END, 302, 1, 0, 3, 3633);
        // Aucune touche : trois baisses passées, fin en 2400 + 33.
        _expect(game, new uint32[](0), END, 202, 0, 0, 0, 2433);
    }

    function test_ReplayJumpAndCoins() public view {
        // Pièces aux jours 55, 75, 95, 135, … (c % 20 == 15, hors de [d − 2, d + 14] d'une baisse d).
        // 528 : pas de cible, saut jusqu'à 744, pièce du jour 55 (x = 660 dans [612, 660]).
        // 696 : en l'air, sans cible : rien.
        // 768 : nouveau saut, pièce 75 (x = 900 dans [852, 900]).
        _expect(game, _taps7(528, 696, 768, 1200, 1320, 2400, 3600), END, END, 4, 2, 19, END_X);
        // Hors du sommet : un saut en 600 ([684, 732]) tombe entre les pièces 55 (660) et 75 (900).
        _expect(game, _taps(600, 1200, 1320, 2400, 3600), END, END, 4, 0, 19, END_X);
        // Une touche sans cible ne coûte pas de vie : 1500 passe les baisses 0 et 1 (2 vies).
        // Sauts en 600 (rien), 816 (pièce 75), 1500 (pièce 135, en l'air jusqu'à 1716) ;
        // 1700 en l'air : rien ; 1900 : [1984, 2032], rien ; 2400 et 3600 parfaits.
        _expect(game, _taps7(600, 816, 1500, 1700, 1900, 2400, 3600), END, END, 2, 2, 11, END_X);
    }

    function test_ReplayAirborneTapJudged() public view {
        // 1100 : sans cible (écart 100) : saut jusqu'à 1316 ; aucune pièce dans [1184, 1232].
        // 1190 : en l'air mais baisse 0 à 10 pixels : jugée, parfaite.
        _expect(game, _taps(1100, 1190, 1320, 2400, 3600), END, END, 4, 0, 19, END_X);
        // 1100 puis 1150 : en l'air, cible baisse 0 à 50 pixels : ratée (une vie).
        _expect(game, _taps(1100, 1150, 1320, 2400, 3600), END, END, 3, 0, 16, END_X);
    }

    /// @dev Genèse d'une seule baisse, au jour d (bonus 0).
    function _oneDip(uint16 d) private returns (DipDuckGame) {
        uint16[] memory days_ = new uint16[](1);
        days_[0] = d;
        return _deploy(days_, new uint8[](1), D, _flat(100e8), 1);
    }

    function test_ReplayCoinRules() public {
        // Pièce 135 (x = 1620) : ramassée par un saut en x si x + 84 <= 1620 <= x + 132, soit x de
        // 1488 à 1536 (bords inclus) ; 1487 et 1537 la manquent.
        _expect(game, _taps(1200, 1320, 1536, 2400, 3600), END, END, 4, 1, 19, END_X); // [1620, 1668]
        _expect(game, _taps(1200, 1320, 1488, 2400, 3600), END, END, 4, 1, 19, END_X); // [1572, 1620]
        _expect(game, _taps(1200, 1320, 1537, 2400, 3600), END, END, 4, 0, 19, END_X); // 1620 < 1621
        _expect(game, _taps(1200, 1320, 1487, 2400, 3600), END, END, 4, 0, 19, END_X); // 1620 > 1619
        // Pièce 95 près d'une baisse qui suit : interdite si d − 2 <= 95 (baisse 97), permise sinon
        // (baisse 98). Saut en 1032 ([1116, 1164]) : la baisse est à plus de 96 pixels, pas de cible.
        _expect(_oneDip(97), _taps(1032), END, END, 0, 0, 0, END_X);
        _expect(_oneDip(98), _taps(1032), END, END, 0, 1, 0, END_X);
        // Pièce 135 après une baisse : interdite si 135 <= d + 14 (baisse 121), permise sinon (120).
        _expect(_oneDip(121), _taps(1452, 1500), END, END, 1, 0, 3, END_X);
        _expect(_oneDip(120), _taps(1440, 1500), END, END, 1, 1, 3, END_X);
        // Seules les baisses prises en compte interdisent : baisse 296 (296 × 12 + 33 = 3585) et
        // pièce 295 (saut en 3432). Course jusqu'au jour 400 : interdite ; jusqu'au jour 298
        // (3585 > 3576, la baisse ne compte pas) : ramassée.
        DipDuckGame g = _oneDip(296);
        _expect(g, _taps(3432), END, END, 0, 0, 0, END_X);
        _expect(g, _taps(3432), 298, 298, 0, 1, 0, 3576);
        // Pas de pièce au-delà de la ligne d'arrivée : course jusqu'au jour 410, saut en 4850,
        // pièce 415 (4980) dans [4934, 4982] mais >= 4920.
        _expect(game, _taps(1200, 1320, 2400, 3600, 4850), 410, 410, 4, 0, 19, 4920);
        // Première pièce : jour 55 (55 × 12 − 132 = START_X ; la pièce 35 ne pourrait pas être sautée).
        // Saut en 528 : [612, 660], pièce 55 ; saut en 577 : [661, 709], rien.
        _expect(game, _taps(528, 1200, 1320, 2400, 3600), END, END, 4, 1, 19, END_X);
        _expect(game, _taps(577, 1200, 1320, 2400, 3600), END, END, 4, 0, 19, END_X);
    }

    function test_ReplayCoinsNeverTwice() public view {
        // Touches tous les 72 pixels dans une zone sans baisse (jours 310 à 390) : sauts en 3700,
        // 3916, 4132, 4348 (les autres en l'air) ; pièces 335 et 355, chacune une fois.
        uint32[] memory t = new uint32[](16);
        (t[0], t[1], t[2], t[3]) = (1200, 1320, 2400, 3600);
        for (uint256 i; i < 12; ++i) t[4 + i] = uint32(3700 + 72 * i);
        (,, uint32 coins,,) = game.verify(t, END);
        (,, uint32 refCoins,,) = _refVerify(_baseDays(), _baseBonus(), END, t);
        require(coins == refCoins && coins == 2, "chaque piece une fois");
    }

    function test_ReplayEndOfRun() public view {
        // Trois touches ratées dans les fenêtres : fin à la 3e (x = 2330), touches suivantes ignorées.
        _expect(game, _taps(1167, 1250, 2330, 3600), END, 194, 0, 0, 0, 2330);
        // 1167 et 1250 ratées, 2300 (écart 100) : saut, pas de vie perdue ; baisse 2 passée en 2433.
        _expect(game, _taps(1167, 1250, 2300), END, 202, 0, 0, 0, 2433);
    }

    function test_InvalidTaps() public {
        bytes memory invalid = _err(DipDuckGame.InvalidTaps.selector);
        vm.expectRevert(invalid);
        game.verify(_taps(1320, 1200), END); // décroissant
        vm.expectRevert(invalid);
        game.verify(_taps(527), END); // avant START_X
        vm.expectRevert(invalid);
        game.verify(_taps(1200, END_X), END); // à finishX
        vm.expectRevert(invalid);
        game.verify(_taps(1250, 2300, 3500, 3600, 3550), END); // désordre après la fin : refusé aussi
        vm.expectRevert(invalid);
        game.verify(new uint32[](0), uint32(uint256(type(uint32).max) / 12 + 1)); // finishX hors de 32 bits
        game.verify(_taps(528, END_X - 1), END); // bornes
        uint32[] memory many = new uint32[](1501);
        for (uint256 i; i < many.length; ++i) many[i] = 4000;
        vm.expectRevert(invalid);
        game.verify(many, END);
        uint32[] memory max = new uint32[](1500);
        for (uint256 i; i < max.length; ++i) max[i] = 4000;
        game.verify(max, END);
    }

    // --- Parties ----------------------------------------------------------------------------

    function test_NoRun() public {
        vm.prank(ALICE);
        vm.expectRevert(_err(DipDuckGame.NoRun.selector));
        game.submit(_taps(1200), "a");
    }

    function test_TooFastAndRunExpired() public {
        uint32[] memory taps = _taps(1200, 1320, 2400, 3600); // jour 5872 : tranche 195, 195 s
        uint256 t0 = block.timestamp;
        vm.prank(ALICE);
        game.startRun();
        (uint64 start, uint32 contest) = game.runOf(ALICE);
        require(start == t0 && contest == CONTEST, "depart note");
        vm.warp(t0 + 194);
        vm.prank(ALICE);
        vm.expectRevert(_err(DipDuckGame.TooFast.selector));
        game.submit(taps, "a");
        vm.warp(t0 + 3 hours + 1);
        vm.prank(ALICE);
        vm.expectRevert(_err(DipDuckGame.RunExpired.selector));
        game.submit(taps, "a");
        vm.prank(ALICE);
        game.startRun(); // remplace l'ancien départ
        vm.warp(t0 + 3 hours + 1 + 195);
        vm.prank(ALICE);
        game.submit(taps, "a");
        (uint32 d, uint32 c, uint32 k, uint32 s,, uint64 at) = game.best(CONTEST, ALICE);
        require(d == FIN && c == 4 && k == 0 && s == 19 && at == block.timestamp, "enregistre");
        (start,) = game.runOf(ALICE);
        require(start == 0, "depart efface");
        vm.prank(ALICE);
        vm.expectRevert(_err(DipDuckGame.NoRun.selector));
        game.submit(taps, "a");
    }

    function test_RunExpiresAfterExactlyThreeHours() public {
        vm.prank(ALICE);
        game.startRun();
        vm.warp(block.timestamp + 3 hours);
        vm.prank(ALICE);
        game.submit(_taps(1200), "a"); // 3 h pile : accepté
    }

    function test_RunKeepsItsContest() public {
        // Départ le 2026-12-31 à 23 h (concours 3), soumission en 2027 : comptée dans le concours 3.
        vm.warp(1798761600 - 3600);
        vm.prank(ALICE);
        game.startRun();
        vm.warp(1798761600 + 1800);
        vm.prank(ALICE);
        game.submit(_taps(1200, 1320, 2400, 3600), "a");
        (uint32 d,,,,,) = game.best(CONTEST, ALICE);
        require(d == FIN && game.topCount(CONTEST) == 1 && game.topCount(4) == 0, "concours du depart");
        // Nouveau concours : record séparé, course plus longue (jour 5964).
        _play(game, ALICE, _taps(1200, 1320, 2400, 3600), "a");
        (d,,,,,) = game.best(4, ALICE);
        require(d == 5964 && game.topCount(4) == 1, "concours 4");
    }

    function test_SubmitRecordsAndLists() public {
        _play(game, ALICE, _taps(1200, 1320, 2400, 3600), "Alice");
        (uint32 d, uint32 c, uint32 k, uint32 s, bytes32 n, uint64 at) = game.best(CONTEST, ALICE);
        require(d == FIN && c == 4 && k == 0 && s == 19 && n == "Alice" && at == block.timestamp, "best");
        (address[] memory players, uint32[] memory days_,,, uint32[] memory scores, bytes32[] memory names) =
            game.topList(CONTEST);
        require(players.length == 1 && players[0] == ALICE && days_[0] == FIN && scores[0] == 19, "top");
        require(names[0] == "Alice", "pseudo");
    }

    function test_NicknameRules() public {
        _play(game, address(1), _taps(1200), "");
        _play(game, address(2), _taps(1200), "Dip Duck_1.0-x");
        _play(game, address(3), _taps(1200), "abcdefghijklmnop");
        bytes32[5] memory bad =
            [bytes32("abcdefghijklmnopq"), bytes32("<b>"), bytes32("a\x00b"), bytes32(uint256(1)), bytes32("caf\xc3\xa9")];
        for (uint256 i; i < bad.length; ++i) {
            _playExpect(game, address(uint160(100 + i)), _taps(1200), bad[i], DipDuckGame.InvalidNickname.selector);
        }
    }

    function test_NotBetter() public {
        bytes4 notBetter = DipDuckGame.NotBetter.selector;
        uint32[] memory a = _taps(1200, 1320, 2400, 3600); // (5872, 4, 0, 19)
        _play(game, ALICE, a, "a");
        _playExpect(game, ALICE, a, "a", notBetter); // égal
        _play(game, ALICE, _taps(528, 1200, 1320, 2400, 3600), "a"); // une pièce : mieux
        _playExpect(game, ALICE, _taps(528, 1213, 1288, 2420, 3632), "a", notBetter); // score plus bas
        _playExpect(game, ALICE, _taps7(600, 744, 888, 1200, 2400, 3600, 3700), "a", notBetter); // 3 attrapées
        (uint32 d, uint32 c, uint32 k, uint32 s,,) = game.best(CONTEST, ALICE);
        require(d == FIN && c == 4 && k == 1 && s == 19, "garde le meilleur");
        require(game.topCount(CONTEST) == 1, "une seule ligne");
    }

    // --- Départage et top 50 -----------------------------------------------------------------

    function _key(uint32 d, uint32 c, uint32 k, uint32 s) private pure returns (uint256) {
        return (uint256(d) << 96) | (uint256(c) << 64) | (uint256(k) << 32) | s;
    }

    function _checkTop(DipDuckGame g, uint32 contest) private view returns (address[] memory players) {
        uint32[] memory days_;
        uint32[] memory caught;
        uint32[] memory coins;
        uint32[] memory scores;
        (players, days_, caught, coins, scores,) = g.topList(contest);
        require(players.length == g.topCount(contest) && players.length <= 50, "taille");
        for (uint256 i; i < players.length; ++i) {
            (uint32 d, uint32 c, uint32 k, uint32 s,,) = g.best(contest, players[i]);
            require(d == days_[i] && c == caught[i] && k == coins[i] && s == scores[i], "ligne = best");
            for (uint256 j; j < i; ++j) require(players[j] != players[i], "pas de doublon");
            if (i > 0) {
                require(
                    _key(days_[i], caught[i], coins[i], scores[i])
                        <= _key(days_[i - 1], caught[i - 1], coins[i - 1], scores[i - 1]),
                    "tri"
                );
            }
        }
    }

    function test_TieBreakComplete() public {
        uint32[] memory a = _taps(1200, 1320, 2400, 3600); // (5872, 4, 0, 19)
        uint32[] memory b = _taps(528, 1200, 1320, 2400, 3600); // (5872, 4, 1, 19)
        uint32[] memory c = _taps(528, 1213, 1288, 2420, 3632); // (5872, 4, 1, 11)
        uint32[] memory d = _taps(528, 768, 1200, 2400, 3600); // (5872, 3, 2, 14)
        uint32[] memory e = _taps(1200); // jour 302
        _expect(game, b, FIN, FIN, 4, 1, 19, FIN_X);
        _expect(game, c, FIN, FIN, 4, 1, 11, FIN_X);
        _expect(game, d, FIN, FIN, 3, 2, 14, FIN_X);
        _play(game, _player(1), a, "A");
        _play(game, _player(2), d, "D");
        _play(game, _player(3), c, "C");
        _play(game, _player(4), b, "B");
        _play(game, _player(5), a, "A2"); // égal à A, plus récent
        _play(game, _player(6), b, "B2"); // égal à B, plus récent
        _play(game, _player(7), e, "E"); // moins loin, même s'il a des baisses
        address[] memory players = _checkTop(game, CONTEST);
        require(players.length == 7, "7 lignes");
        // pièces avant score, attrapées avant pièces, jour avant tout ; puis le plus ancien.
        require(players[0] == _player(4) && players[1] == _player(6), "B puis B2");
        require(players[2] == _player(3), "C (score 11) : plus de pieces que A");
        require(players[3] == _player(1) && players[4] == _player(5), "A puis A2");
        require(players[5] == _player(2), "D : moins d'attrapees malgre ses pieces");
        require(players[6] == _player(7), "E : moins loin");
    }

    /// @dev 60 baisses (jours 100, 110, …, 690) ; le niveau k attrape les k premières.
    function _bigGame() private returns (DipDuckGame g) {
        uint16[] memory days_ = new uint16[](60);
        for (uint256 i; i < 60; ++i) days_[i] = uint16(100 + 10 * i);
        g = _deploy(days_, new uint8[](60), D, _flat(100e8), 1);
    }

    function _level(uint256 k) private pure returns (uint32[] memory taps) {
        taps = new uint32[](k);
        for (uint256 i; i < k; ++i) taps[i] = uint32((100 + 10 * i) * 12);
    }

    function _inTop(DipDuckGame g, address who) private view returns (bool) {
        (address[] memory players,,,,,) = g.topList(CONTEST);
        for (uint256 i; i < players.length; ++i) if (players[i] == who) return true;
        return false;
    }

    function test_Top50() public {
        DipDuckGame g = _bigGame();
        for (uint256 i; i < 50; ++i) _play(g, _player(i), _level(1 + (i * 17) % 50), "p");
        address[] memory players = _checkTop(g, CONTEST);
        require(players.length == 50, "plein");
        _play(g, ALICE, _level(0), "Alice");
        require(!_inTop(g, ALICE) && g.topCount(CONTEST) == 50, "hors du top");
        (,,,,, uint64 at) = g.best(CONTEST, ALICE);
        require(at != 0, "record note quand meme");
        _play(g, BOB, _level(1), "Bob");
        require(!_inTop(g, BOB), "egalite plus recente : dehors");
        address last = players[49];
        _play(g, CAROL, _level(55), "Carol");
        players = _checkTop(g, CONTEST);
        require(players[0] == CAROL && !_inTop(g, last) && players.length == 50, "tete, dernier evince");
        _play(g, last, _level(20), "p");
        players = _checkTop(g, CONTEST);
        require(_inTop(g, last) && players.length == 50, "retour sans doublon");
    }

    // --- Pas d'ETH ---------------------------------------------------------------------------

    function test_RejectsEth() public {
        (bool sent,) = address(game).call{value: 0}("");
        require(!sent, "pas de receive ni de fallback");
    }

    // --- Fuzzing : rejeu contre la référence ---------------------------------------------------

    struct Ref {
        uint256 lives;
        uint256 score;
        uint256 caught;
        uint256 coins;
        uint256 airborneUntil;
        bool ended;
        uint256 endX;
        bool[] done;
        bool[] collected;
        uint256 n;
    }

    function _refMiss(Ref memory st, uint256 eventX) private pure {
        st.lives -= 1;
        if (st.lives == 0) {
            st.ended = true;
            st.endX = eventX;
        }
    }

    function _refPasses(Ref memory st, uint16[] memory days_, uint256 limit) private pure {
        for (uint256 i; i < st.n; ++i) {
            if (st.ended) return;
            if (st.done[i]) continue;
            uint256 dipX = uint256(days_[i]) * 12;
            if (dipX + 32 >= limit) return;
            st.done[i] = true;
            _refMiss(st, dipX + 33);
        }
    }

    function _refIsCoin(Ref memory st, uint16[] memory days_, uint256 c, uint256 finishX) private pure returns (bool) {
        if (c % 20 != 15 || c * 12 < 528 + 132 || c * 12 >= finishX) return false;
        for (uint256 i; i < st.n; ++i) {
            uint256 d = days_[i];
            if (d <= c + 2 && c <= d + 14) return false; // d − 2 <= c <= d + 14
        }
        return true;
    }

    function _refTap(Ref memory st, uint16[] memory days_, uint8[] memory bonus, uint256 x, uint256 finishX)
        private
        pure
    {
        for (uint256 i; i < st.n; ++i) {
            uint256 dipX = uint256(days_[i]) * 12;
            uint256 d = dipX > x ? dipX - x : x - dipX;
            if (!st.done[i] && d <= 96) {
                st.done[i] = true;
                if (d <= 12) {
                    st.score += 3 + bonus[i];
                    st.caught += 1;
                } else if (d <= 32) {
                    st.score += 1 + bonus[i];
                    st.caught += 1;
                } else {
                    _refMiss(st, x);
                }
                return;
            }
        }
        if (x < st.airborneUntil) return;
        st.airborneUntil = x + 216;
        for (uint256 c; c * 12 < finishX; ++c) {
            uint256 coinX = c * 12;
            if (coinX >= x + 84 && coinX <= x + 132 && !st.collected[c] && _refIsCoin(st, days_, c, finishX)) {
                st.collected[c] = true;
                st.coins += 1;
            }
        }
    }

    /// @dev Spécification mot pour mot : tableaux `done` et `collected`, aucun raccourci.
    function _refVerify(uint16[] memory days_, uint8[] memory bonus, uint32 finishDay, uint32[] memory taps)
        private
        pure
        returns (uint32 day, uint32 caught, uint32 coins, uint32 score, uint32 finalX)
    {
        uint256 finishX = uint256(finishDay) * 12;
        Ref memory st;
        st.lives = 3;
        st.done = new bool[](days_.length);
        st.collected = new bool[](uint256(finishDay) + 1);
        for (uint256 i; i < days_.length; ++i) if (uint256(days_[i]) * 12 + 33 <= finishX) st.n = i + 1;
        for (uint256 k; k < taps.length; ++k) {
            _refPasses(st, days_, taps[k]);
            if (st.ended) break;
            _refTap(st, days_, bonus, taps[k], finishX);
            if (st.ended) break;
        }
        if (!st.ended) {
            _refPasses(st, days_, finishX);
            if (!st.ended) return (finishDay, uint32(st.caught), uint32(st.coins), uint32(st.score), uint32(finishX));
        }
        return (uint32(st.endX / 12), uint32(st.caught), uint32(st.coins), uint32(st.score), uint32(st.endX));
    }

    function _rand(uint256 seed, uint256 k) private pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, k)));
    }

    /// @dev 0 à 40 baisses, écarts de 1 à 25 jours (fenêtres qui se chevauchent, pièces entre
    ///      deux), parfois avant START_X ; fin de course parfois avant les dernières baisses.
    function _randomGame(uint256 seed)
        private
        pure
        returns (uint16[] memory days_, uint8[] memory bonus, uint32 finishDay)
    {
        uint256 n = _rand(seed, 0) % 41;
        days_ = new uint16[](n);
        bonus = new uint8[](n);
        uint256 day = 20 + _rand(seed, 1) % 50;
        for (uint256 i; i < n; ++i) {
            uint256 r = _rand(seed, 10 + i);
            days_[i] = uint16(day);
            bonus[i] = uint8(r % 11);
            day += 1 + (r >> 8) % 25;
        }
        finishDay = uint32(day + _rand(seed, 2) % 40);
        if (_rand(seed, 3) % 3 == 0 && day > 60) finishDay = uint32(day - _rand(seed, 4) % 30);
        if (finishDay < 50) finishDay = 50;
    }

    /// @dev Touches triées dans [START_X, finishX) : près des baisses (−110 à +110), en avant,
    ///      sur les pièces, doubles.
    function _randomTaps(uint256 seed, uint16[] memory days_, uint32 finishDay)
        private
        pure
        returns (uint32[] memory taps)
    {
        uint256 finishX = uint256(finishDay) * 12;
        uint256 max = _rand(seed, 5) % 90;
        taps = new uint32[](max);
        uint256 count;
        uint256 x = 528 + _rand(seed, 6) % 200;
        uint256 aim;
        for (uint256 k; k < max; ++k) {
            uint256 r = _rand(seed, 1000 + k);
            uint256 mode = r % 5;
            if (mode == 0) {
                x += (r >> 8) % 160;
            } else if (mode == 1 || mode == 2) {
                while (aim < days_.length && uint256(days_[aim]) * 12 + 110 < x) ++aim;
                if (aim < days_.length) {
                    uint256 target = uint256(days_[aim]) * 12 + 110 - (r >> 8) % 221;
                    if (target > x) x = target;
                    ++aim;
                }
            } else if (mode == 3) {
                x += 120 + (r >> 8) % 40; // juste avant une pièce
            } // mode 4 : même x
            if (x >= finishX) break;
            taps[count++] = uint32(x);
        }
        assembly ("memory-safe") {
            mstore(taps, count)
        }
    }

    /// @dev Résultat de `verify` du contrat : [jour, attrapées, pièces, score, finalX].
    function _out(DipDuckGame g, uint32[] memory taps, uint32 finishDay) private view returns (uint256[5] memory o) {
        (uint32 a, uint32 b, uint32 c, uint32 d, uint32 e) = g.verify(taps, finishDay);
        o = [uint256(a), b, c, d, e];
    }

    /// @dev Résultat de la référence, même ordre.
    function _refOut(uint16[] memory days_, uint8[] memory bonus, uint32 finishDay, uint32[] memory taps)
        private
        pure
        returns (uint256[5] memory o)
    {
        (uint32 a, uint32 b, uint32 c, uint32 d, uint32 e) = _refVerify(days_, bonus, finishDay, taps);
        o = [uint256(a), b, c, d, e];
    }

    function testFuzz_ReplayMatchesReference(uint256 seed) public {
        (uint16[] memory days_, uint8[] memory bonus, uint32 finishDay) = _randomGame(seed);
        uint32 from = days_.length > 0 && days_[days_.length - 1] >= 45 ? days_[days_.length - 1] + 1 : 45;
        DipDuckGame g = _deploy(days_, bonus, from, _flat(1e8), 0);
        uint32[] memory taps = _randomTaps(seed, days_, finishDay);
        uint256[5] memory o = _out(g, taps, finishDay);
        uint256[5] memory r = _refOut(days_, bonus, finishDay, taps);
        for (uint256 i; i < 5; ++i) require(o[i] == r[i], "rejeu = reference");
        require(o[3] <= 13 * o[1] && o[1] <= days_.length && o[0] <= finishDay, "invariants");
        require(o[0] == finishDay || o[0] == o[4] / 12, "day coherent");
    }

    function testFuzz_InvariantsArbitraryTaps(uint32[16] memory raw, uint8 length) public view {
        uint256 len = uint256(length) % 17;
        uint32[] memory taps = new uint32[](len);
        uint256 x = 528;
        for (uint256 i; i < len; ++i) {
            x += raw[i] % 400;
            if (x >= END_X) x = END_X - 1;
            taps[i] = uint32(x);
        }
        uint256[5] memory o = _out(game, taps, END);
        uint256[5] memory r = _refOut(_baseDays(), _baseBonus(), END, taps);
        for (uint256 i; i < 5; ++i) require(o[i] == r[i], "rejeu = reference");
    }
}
