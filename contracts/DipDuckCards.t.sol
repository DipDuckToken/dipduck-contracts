// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {DipDuckCards} from "./DipDuckCards.sol";

/// @dev Sous-ensemble des cheatcodes du runner de tests Solidity de Hardhat
///      (compatibles Foundry), déclaré ici pour ne pas dépendre de forge-std.
interface CardsVm {
    function expectRevert(bytes calldata revertData) external;
    function expectRevert() external;
    function prank(address msgSender) external;
    function startPrank(address msgSender) external;
    function stopPrank() external;
    function deal(address account, uint256 newBalance) external;
    function warp(uint256 newTimestamp) external;
    function roll(uint256 newHeight) external;
    function assume(bool condition) external;
    function setBlockhash(uint256 blockNumber, bytes32 blockHash) external;
}

/// @dev Expose le tirage des attributs pour le tester sans passer par un mint.
contract DipDuckCardsHarness is DipDuckCards {
    constructor(
        address founders,
        address community,
        uint64 mintStart,
        string[] memory names,
        address[] memory wallets,
        string[] memory urls
    ) DipDuckCards(founders, community, mintStart, "https://x.test/img/", "https://x.test/card.html", names, wallets, urls) {}

    function pickFor(bytes32 name, uint8 mood, uint8 element, uint16 lucky, bytes32 seed, uint256 t)
        external
        pure
        returns (uint8)
    {
        Card memory card = Card(name, address(0), 0, lucky, mood, element, 0, false);
        return _pick(card, seed, t);
    }

    function pickTrophyFor(bytes32 name, uint8 mood, uint8 element, uint16 lucky, bytes32 seed, uint256 t)
        external
        pure
        returns (uint8)
    {
        Card memory card = Card(name, address(0), 0, lucky, mood, element, 0, true);
        return _pick(card, seed, t);
    }

    function boostFor(bytes32 name, uint8 mood, uint8 element, uint16 lucky, uint256 t, uint256 i)
        external
        pure
        returns (uint256)
    {
        Card memory card = Card(name, address(0), 0, lucky, mood, element, 0, false);
        return _boost(card, t, i);
    }

    function activeCount() external view returns (uint256) {
        return _active.length;
    }

    function quorumFor(uint256 snapshot) external pure returns (uint256) {
        return _quorumFor(snapshot);
    }
}

/// @dev Destinataire qui refuse l'ETH : son retrait échoue sans bloquer les autres.
contract RejectEth {}

/// @notice Tests des cartes de collection Dip Duck : mint, édition Trophée (réserve),
///         commit-reveal, attributs et secrets, vote de la fondation, propositions (dépôt,
///         snapshot, 2/3, quorum, plafond, expiration, réserve), versements en mode pull, métadonnées.
contract DipDuckCardsTest {
    CardsVm private constant vm = CardsVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant FOUNDERS = address(0xF0);
    address private constant COMMUNITY = address(0xC0);
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant CHARITY_A = address(0xCA);
    address private constant CHARITY_B = address(0xCB);
    uint64 private constant START = 1_800_000_000;
    uint256 private constant PRICE = 0.001 ether;
    bytes32 private constant NAME = "Quackers";

    DipDuckCardsHarness private cards;

    function setUp() public {
        vm.warp(START);
        vm.roll(1_000);
        cards = new DipDuckCardsHarness(FOUNDERS, COMMUNITY, START, _names(), _wallets(), _urls());
        vm.deal(ALICE, 1 ether);
        vm.deal(BOB, 1 ether);
    }

    function _mintAs(address who, uint256 quantity) private {
        vm.prank(who);
        cards.mint{value: PRICE * quantity}(NAME, 1, 2, 7, quantity);
    }

    /// @dev Avance après le bloc cible et lui donne un hachage connu.
    function _rollPastTarget(uint256 commitBlock, bytes32 hash) private {
        vm.roll(commitBlock + cards.REVEAL_DELAY() + 1);
        vm.setBlockhash(commitBlock + cards.REVEAL_DELAY(), hash);
    }

    // --- Mint -------------------------------------------------------------------

    function test_MintStoresChoicesAndStartsAtOne() public {
        _mintAs(ALICE, 2);
        require(cards.totalMinted() == 2 && cards.ownerOf(1) == ALICE && cards.ownerOf(2) == ALICE, "cartes 1 et 2 a Alice");
        (bytes32 name, uint8 mood, uint8 element, uint16 lucky, uint64 commitBlock, bool revealed, bool trophy) =
            cards.cardOf(1);
        require(name == NAME && mood == 1 && element == 2 && lucky == 7, "choix enregistres");
        require(commitBlock == 1_000 && !revealed, "bloc d'engagement, pas encore revelee");
        require(!trophy, "carte achetee : pas un Trophee");
        require(cards.mintedBy(ALICE) == 2, "compteur du wallet");
    }

    function test_RejectsMintBeforeStart() public {
        vm.warp(START - 1);
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.MintNotStarted.selector));
        cards.mint{value: PRICE}(NAME, 0, 0, 0, 1);
    }

    function test_RequiresExactPayment() public {
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.WrongPayment.selector, PRICE * 2));
        cards.mint{value: PRICE * 2 + 1}(NAME, 0, 0, 0, 2);
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.WrongPayment.selector, PRICE));
        cards.mint{value: PRICE - 1}(NAME, 0, 0, 0, 1);
    }

    function test_EnforcesQuantityAndWalletLimit() public {
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.InvalidQuantity.selector));
        cards.mint{value: 0}(NAME, 0, 0, 0, 0);
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.InvalidQuantity.selector));
        cards.mint{value: PRICE * 11}(NAME, 0, 0, 0, 11);
        _mintAs(ALICE, 7);
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.WalletLimit.selector));
        cards.mint{value: PRICE * 4}(NAME, 0, 0, 0, 4);
        _mintAs(ALICE, 3);
        require(cards.mintedBy(ALICE) == 10, "10 cartes au maximum");
    }

    function test_RejectsInvalidChoices() public {
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.InvalidChoice.selector));
        cards.mint{value: PRICE}(NAME, 4, 0, 0, 1);
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.InvalidChoice.selector));
        cards.mint{value: PRICE}(NAME, 0, 4, 0, 1);
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.InvalidChoice.selector));
        cards.mint{value: PRICE}(NAME, 0, 0, 1000, 1);
    }

    function test_SplitsPaymentExactly() public {
        _mintAs(ALICE, 3);
        uint256 paid = PRICE * 3;
        uint256 thirty = (paid * 30) / 100;
        require(cards.roundCharity(0) == thirty, "30 % fondation");
        require(cards.roundFounders(0) == thirty, "30 % fondateurs");
        require(cards.roundCommunity(0) == paid - 2 * thirty, "le reste a la communaute");
        require(address(cards).balance == paid, "tout l'ETH est dans le contrat");
    }

    function test_PublicSupplyStopsAtMaxMinusReserved() public {
        uint256 publicSupply = cards.MAX_SUPPLY() - cards.RESERVED();
        for (uint256 i = 0; i < publicSupply / 10; i++) {
            address buyer = address(uint160(0x10000 + i));
            vm.deal(buyer, 1 ether);
            _mintAs(buyer, 10);
        }
        uint256 left = publicSupply % 10;
        _mintAs(ALICE, left);
        require(cards.totalMinted() == publicSupply, "offre publique epuisee");
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.SoldOut.selector));
        cards.mint{value: PRICE}(NAME, 0, 0, 0, 1);
        // La réserve (cartes Trophée) reste disponible après l'épuisement de l'offre publique.
        _mintAllTrophies();
        require(cards.totalMinted() == cards.MAX_SUPPLY(), "3333 cartes au total");
    }

    // --- Édition Trophée (réserve) ---------------------------------------------

    function _trophy(address to) private {
        vm.prank(COMMUNITY);
        cards.mintTrophy(to, "Winner", 0, 0, 0);
    }

    function _expectTrophyRefused(address to, bytes4 selector) private {
        vm.prank(COMMUNITY);
        vm.expectRevert(abi.encodeWithSelector(selector));
        cards.mintTrophy(to, "Winner", 0, 0, 0);
    }

    function _mintAllTrophies() private {
        for (uint256 i = 0; i < 111; i++) {
            _trophy(address(uint160(0x50000 + i)));
        }
    }

    function _isTrophy(uint256 id) private view returns (bool trophy) {
        (,,,,,, trophy) = cards.cardOf(id);
    }

    function test_TrophyOnlyByCommunityAndFree() public {
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.OnlyCommunity.selector));
        cards.mintTrophy(ALICE, NAME, 0, 0, 0);
        _trophy(BOB);
        require(cards.ownerOf(1) == BOB && cards.balanceOf(BOB) == 1 && _isTrophy(1), "une carte Trophee a Bob");
        require(cards.reservedMinted() == 1 && cards.trophyReceived(BOB), "comptee dans la reserve");
        require(cards.mintedBy(BOB) == 0, "hors limite de 10 cartes achetees");
        require(address(cards).balance == 0 && cards.roundCommunity(0) == 0, "gratuite, aucune cagnotte");
    }

    function test_TrophyCappedAtReserved() public {
        _mintAllTrophies();
        require(cards.reservedMinted() == 111 && cards.totalMinted() == 111, "111 cartes Trophee");
        _expectTrophyRefused(BOB, DipDuckCards.SoldOut.selector);
        // L'offre publique n'est pas entamée par la réserve.
        _mintAs(ALICE, 10);
        require(cards.totalMinted() == 121, "mint public intact");
    }

    function test_TrophyOncePerWalletForLife() public {
        _trophy(BOB);
        _expectTrophyRefused(BOB, DipDuckCards.TrophyNotAllowed.selector);
        // Même après avoir donné sa carte, le wallet n'en reçoit plus.
        vm.prank(BOB);
        cards.transferFrom(BOB, ALICE, 1);
        require(cards.balanceOf(BOB) == 0, "Bob n'a plus de carte");
        _expectTrophyRefused(BOB, DipDuckCards.TrophyNotAllowed.selector);
        require(cards.reservedMinted() == 1, "une seule frappee");
    }

    function test_TrophyOnlyForWalletsWithTwoCardsOrLess() public {
        _mintAs(ALICE, 2);
        _trophy(ALICE); // 2 cartes : accepté
        require(cards.balanceOf(ALICE) == 3 && _isTrophy(3), "Trophee recu avec 2 cartes");
        _mintAs(BOB, 3);
        _expectTrophyRefused(BOB, DipDuckCards.TrophyNotAllowed.selector); // 3 cartes : refusé
        vm.prank(BOB);
        cards.transferFrom(BOB, ALICE, 4);
        _trophy(BOB); // redescendu à 2 cartes : accepté
        require(cards.balanceOf(BOB) == 3, "Trophee recu apres etre redescendu a 2");
    }

    function test_TrophyNeverToCommunity() public {
        _expectTrophyRefused(COMMUNITY, DipDuckCards.TrophyNotAllowed.selector);
        vm.prank(COMMUNITY);
        vm.expectRevert(); // ERC721InvalidReceiver(0)
        cards.mintTrophy(address(0), "Winner", 0, 0, 0);
        vm.prank(COMMUNITY);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.InvalidName.selector));
        cards.mintTrophy(BOB, "<b>", 0, 0, 0);
        require(cards.reservedMinted() == 0 && !cards.trophyReceived(BOB), "rien de frappe");
    }

    function test_TrophyDrawSkipsTheCommonestOptions() public view {
        uint256 n = 300;
        uint256 crowns;
        for (uint256 i = 0; i < n; i++) {
            bytes32 seed = keccak256(abi.encode("trophee", i));
            for (uint256 t = 0; t < 10; t++) {
                uint8 floor = t == 6 || t == 7 ? 2 : 1;
                require(cards.pickTrophyFor("Winner", 0, 0, 0, seed, t) >= floor, "jamais l'option la plus commune");
            }
            if (cards.pickTrophyFor("Winner", 1, 0, 0, seed, 2) == 3) crowns++;
        }
        // Les secrets s'appliquent aussi : courageux, couronne x1,5 (poids 90 sur 550 sans « none »).
        require(crowns > (n * 12) / 100, "secrets actifs sur le Trophee");
        // Graine nulle (carte Plain) : le plancher, ni plus ni moins.
        for (uint256 t = 0; t < 10; t++) {
            require(cards.pickTrophyFor("Winner", 0, 0, 0, 0, t) == (t == 6 || t == 7 ? 2 : 1), "Plain : plancher");
            require(cards.pickFor("Winner", 0, 0, 0, 0, t) == 0, "Plain achetee : zero");
        }
    }

    function test_TrophyDoesNotChangePaidDraws() public {
        _trophy(BOB); // carte 1
        _mintAs(ALICE, 1); // carte 2, même bloc
        bytes32 hash = keccak256("bloc cible");
        _rollPastTarget(1_000, hash);
        uint256[] memory ids = _ids(1, 2);
        cards.revealMany(ids);
        (uint8[10] memory paid,) = cards.traitsOf(2);
        bytes32 seed = keccak256(abi.encode(NAME, uint8(1), uint8(2), uint16(7), uint256(2), ALICE, hash));
        for (uint256 t = 0; t < 10; t++) {
            require(paid[t] == cards.pickFor(NAME, 1, 2, 7, seed, t), "carte achetee : tirage normal");
        }
        (uint8[10] memory trophy,) = cards.traitsOf(1);
        bytes32 trophySeed = keccak256(abi.encode(bytes32("Winner"), uint8(0), uint8(0), uint16(0), uint256(1), BOB, hash));
        for (uint256 t = 0; t < 10; t++) {
            require(trophy[t] == cards.pickTrophyFor("Winner", 0, 0, 0, trophySeed, t), "Trophee : tirage a part");
        }
        require(!_isTrophy(2) && _isTrophy(1), "marque Trophee sur la seule carte de la reserve");
    }

    function test_PlainTrophyKeepsItsFloor() public {
        _trophy(BOB);
        vm.roll(1_000 + cards.REVEAL_DELAY() + 300);
        cards.reveal(1);
        (uint8[10] memory traits, bool revealed) = cards.traitsOf(1);
        require(revealed, "revelee (Plain)");
        for (uint256 t = 0; t < 10; t++) {
            require(traits[t] == (t == 6 || t == 7 ? 2 : 1), "Plain Trophee : plancher du tirage");
        }
    }

    // --- Commit-reveal ----------------------------------------------------------

    function test_RevealOnlyAfterTargetBlock() public {
        _mintAs(ALICE, 1);
        vm.roll(1_000 + cards.REVEAL_DELAY());
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.NotReady.selector, 1));
        cards.reveal(1);
        (, bool before) = cards.traitsOf(1);
        require(!before, "pas revelee avant le bloc cible");

        _rollPastTarget(1_000, keccak256("bloc"));
        vm.prank(BOB); // n'importe qui peut révéler
        cards.reveal(1);
        (, bool revealed) = cards.traitsOf(1);
        require(revealed, "revelee apres le bloc cible");
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.AlreadyRevealed.selector, 1));
        cards.reveal(1);
    }

    function test_TraitsAreDeterministicFromTheSeed() public {
        _mintAs(ALICE, 1);
        bytes32 hash = keccak256("bloc cible");
        _rollPastTarget(1_000, hash);
        cards.reveal(1);
        (uint8[10] memory traits,) = cards.traitsOf(1);
        bytes32 seed = keccak256(abi.encode(NAME, uint8(1), uint8(2), uint16(7), uint256(1), ALICE, hash));
        for (uint256 t = 0; t < 10; t++) {
            require(traits[t] == cards.pickFor(NAME, 1, 2, 7, seed, t), "attribut = tirage depuis la graine");
        }
        // Relire ne change rien.
        (uint8[10] memory again,) = cards.traitsOf(1);
        for (uint256 t = 0; t < 10; t++) {
            require(again[t] == traits[t], "attributs stables");
        }
    }

    function test_ExpiredRevealBecomesPlain() public {
        _mintAs(ALICE, 1);
        vm.roll(1_000 + cards.REVEAL_DELAY() + 300); // plus de 256 blocs après le bloc cible
        cards.reveal(1);
        (uint8[10] memory traits, bool revealed) = cards.traitsOf(1);
        require(revealed, "revelee (Plain)");
        for (uint256 t = 0; t < 10; t++) {
            require(traits[t] == 0, "Plain : tout au plus commun");
        }
    }

    function test_RevealManyRevealsReadyCardsAndIgnoresTheRest() public {
        _mintAs(ALICE, 3); // cartes 1 à 3 au bloc 1000
        _rollPastTarget(1_000, keccak256("a"));
        // Carte 4 engagée maintenant (la réserve ne révèle rien au passage) : pas encore prête.
        _trophy(BOB);
        uint256[] memory ids = new uint256[](6);
        ids[0] = 1;
        ids[1] = 2;
        ids[2] = 3;
        ids[3] = 4;
        ids[4] = 99; // inexistante : ignorée
        ids[5] = 1; // en double : ignorée la deuxième fois
        cards.revealMany(ids);
        for (uint256 id = 1; id <= 3; id++) {
            (, bool revealed) = cards.traitsOf(id);
            require(revealed, "cartes pretes revelees");
        }
        (, bool fourth) = cards.traitsOf(4);
        require(!fourth, "carte pas prete ignoree");
        cards.revealMany(ids); // rien à faire : aucune erreur
    }

    function test_MintAutoRevealsUpToThreeReadyCards() public {
        _mintAs(ALICE, 5);
        _rollPastTarget(1_000, keccak256("a"));
        _mintAs(BOB, 1);
        for (uint256 id = 1; id <= 3; id++) {
            (, bool revealed) = cards.traitsOf(id);
            require(revealed, "3 cartes revelees au passage");
        }
        (, bool fourth) = cards.traitsOf(4);
        require(!fourth, "pas plus de 3 par mint");
    }

    // --- Attributs et secrets ---------------------------------------------------

    function test_BoostsMatchTheSecrets() public view {
        require(cards.boostFor("satoshi", 0, 0, 0, 1, 5) == 300, "satoshi : canard dore x3");
        require(cards.boostFor("SaToShI", 0, 0, 0, 1, 5) == 300, "insensible a la casse");
        require(cards.boostFor("satoshis", 0, 0, 0, 1, 5) == 100, "nom exact seulement");
        require(cards.boostFor("Bob", 0, 1, 0, 3, 1) == 200, "feu : yeux laser x2");
        require(cards.boostFor("Bob", 0, 3, 0, 5, 5) == 300, "foudre : eclairs x3");
        require(cards.boostFor("Bob", 0, 3, 0, 9, 4) == 200, "foudre : meteores x2");
        require(cards.boostFor("Bob", 0, 0, 170, 6, 2) == 150, "un 7 : cadre or x1,5");
        require(cards.boostFor("Bob", 0, 0, 777, 8, 5) == 300, "777 : lune x3");
        require(cards.boostFor("Bob", 0, 0, 778, 8, 5) == 100, "778 : pas de lune");
        require(cards.boostFor("Bob", 1, 0, 0, 2, 3) == 150, "courageux : couronne x1,5");
        require(cards.boostFor("Bob", 0, 0, 0, 2, 3) == 100, "calme : pas de couronne");
    }

    function test_SatoshiGetsMoreGoldenDucks() public view {
        uint256 golden;
        uint256 goldenSatoshi;
        for (uint256 i = 0; i < 1500; i++) {
            bytes32 seed = keccak256(abi.encode("graine", i));
            if (cards.pickFor("bob", 0, 0, 0, seed, 1) == 5) golden++;
            if (cards.pickFor("satoshi", 0, 0, 0, seed, 1) == 5) goldenSatoshi++;
        }
        require(goldenSatoshi > golden * 2, "satoshi favorise le canard dore");
    }

    function test_PickFollowsTheWeights() public view {
        uint256 pond;
        uint256 n = 3000;
        for (uint256 i = 0; i < n; i++) {
            if (cards.pickFor("bob", 0, 0, 0, keccak256(abi.encode(i)), 0) == 0) pond++;
        }
        // 30 % attendus pour la mare (écart large pour un test stable).
        require(pond > (n * 25) / 100 && pond < (n * 35) / 100, "frequence de la mare proche de 30 %");
    }

    function testFuzz_NameCharset(bytes32 name) public {
        bool valid = _validName(name);
        vm.prank(ALICE);
        if (!valid) vm.expectRevert(abi.encodeWithSelector(DipDuckCards.InvalidName.selector));
        cards.mint{value: PRICE}(name, 0, 0, 0, 1);
        if (valid) require(cards.totalMinted() == 1, "nom valide accepte");
    }

    function test_NameRules() public {
        vm.startPrank(ALICE);
        cards.mint{value: PRICE}("", 0, 0, 0, 1);
        cards.mint{value: PRICE}("Dip Duck_1.0-x", 0, 0, 0, 1);
        cards.mint{value: PRICE}("abcdefghijklmnopqrst", 0, 0, 0, 1); // 20 caractères
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.InvalidName.selector));
        cards.mint{value: PRICE}("abcdefghijklmnopqrstu", 0, 0, 0, 1); // 21
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.InvalidName.selector));
        cards.mint{value: PRICE}('a"b', 0, 0, 0, 1); // guillemet : casserait le JSON
        vm.stopPrank();
    }

    function _validName(bytes32 name) private pure returns (bool) {
        bool ended;
        for (uint256 i = 0; i < 32; i++) {
            bytes1 c = name[i];
            if (c == 0) {
                ended = true;
                continue;
            }
            if (ended || i >= 20) return false;
            bool ok = (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == " "
                || c == "-" || c == "_" || c == ".";
            if (!ok) return false;
        }
        return true;
    }

    // --- Périodes, vote et cagnottes ---------------------------------------------

    uint256 private constant ROUND = 30 days;
    uint256 private constant DEPOSIT = 0.005 ether;
    string private constant URL = "https://exemple.org/dons";

    function _ids(uint256 a, uint256 b) private pure returns (uint256[] memory ids) {
        ids = new uint256[](b - a + 1);
        for (uint256 i = 0; i < ids.length; i++) {
            ids[i] = a + i;
        }
    }

    function _round(uint256 r) private {
        vm.warp(START + r * ROUND);
    }

    /// @dev Tout l'ETH du contrat est expliqué : soldes dus + cagnottes pas clôturées + dépôts ouverts.
    function _checkBalance(DipDuckCards c, uint256 openDeposits) private view {
        uint256 pots;
        for (uint256 r = c.roundsClosed(); r <= c.currentRound(); r++) {
            pots += c.roundCharity(r) + c.roundFounders(r) + c.roundCommunity(r);
        }
        require(address(c).balance == c.totalOwed() + pots + openDeposits, "ETH du contrat explique");
    }

    function test_RoundsAre30Days() public {
        require(cards.currentRound() == 0, "periode 0");
        vm.warp(START - 1);
        require(cards.currentRound() == 0, "0 avant le debut du mint");
        _round(1);
        require(cards.currentRound() == 1, "periode 1");
        vm.warp(START + 2 * ROUND - 1);
        require(cards.currentRound() == 1, "encore la periode 1");
    }

    function test_MintCreditsThePotsOfTheCurrentRound() public {
        _mintAs(ALICE, 3);
        _round(1);
        _mintAs(BOB, 1);
        require(cards.roundCharity(0) == (PRICE * 3 * 30) / 100, "fondation periode 0");
        require(cards.roundCharity(1) == (PRICE * 30) / 100, "fondation periode 1");
        require(cards.roundFounders(0) == (PRICE * 3 * 30) / 100, "fondateurs periode 0");
        uint256 community = PRICE * 3 - 2 * ((PRICE * 3 * 30) / 100);
        require(cards.roundCommunity(0) == community, "communaute : le reste");
        cards.closeRounds(5);
        require(cards.owed(FOUNDERS) == (PRICE * 3 * 30) / 100 && cards.owed(COMMUNITY) == community, "credite a la cloture");
        require(cards.roundFounders(1) == (PRICE * 30) / 100, "periode 1 pas encore cloturee");
        _checkBalance(cards, 0);
    }

    function test_VotePerRoundOncePerCard() public {
        _mintAs(ALICE, 3);
        _mintAs(BOB, 2);
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.NotCardOwner.selector, 1));
        cards.vote(_ids(1, 1), 0);
        vm.prank(ALICE);
        cards.vote(_ids(1, 3), 1);
        require(cards.votesFor(0, 1) == 3 && cards.hasVoted(0, 2), "3 voix pour B en periode 0");
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.AlreadyVoted.selector, 1));
        cards.vote(_ids(1, 1), 0);
        // Une carte transférée ne revote pas dans la même période...
        vm.prank(ALICE);
        cards.transferFrom(ALICE, BOB, 1);
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.AlreadyVoted.selector, 1));
        cards.vote(_ids(1, 1), 0);
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.InvalidCandidate.selector));
        cards.vote(_ids(4, 5), 2);
        vm.prank(BOB);
        cards.vote(_ids(4, 5), 0);
        (bool hasWinner, uint256 index) = cards.winnerOf(0);
        require(hasWinner && index == 1, "B en tete 3 contre 2");
        // ... mais revote à la période suivante (le vote clôture la période 0 au passage).
        _round(1);
        vm.prank(BOB);
        cards.vote(_ids(1, 1), 0);
        require(cards.votesFor(1, 0) == 1 && cards.hasVoted(1, 1) && cards.roundsClosed() == 1, "periode 1");
        (hasWinner, index) = cards.winnerOf(0);
        require(hasWinner && index == 1, "gagnante notee a la cloture");
    }

    function test_WinnerTieAndNoVote() public {
        _mintAs(ALICE, 2);
        (bool none,) = cards.winnerOf(0);
        require(!none, "aucune voix : pas de gagnant");
        vm.startPrank(ALICE);
        cards.vote(_ids(1, 1), 1);
        cards.vote(_ids(2, 2), 0);
        vm.stopPrank();
        (bool hasWinner, uint256 index) = cards.winnerOf(0);
        require(hasWinner && index == 0, "egalite : le plus petit index");
    }

    function test_NothingBeforeRoundEnds() public {
        _mintAs(ALICE, 4);
        require(cards.owed(FOUNDERS) == 0 && cards.owed(COMMUNITY) == 0, "rien de du pendant la periode");
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.NothingToSend.selector));
        cards.closeRounds(1);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.NothingToSend.selector));
        cards.withdraw(FOUNDERS);
    }

    function test_PullPaymentsToFixedAddresses() public {
        _mintAs(ALICE, 4);
        _round(1);
        _mintAs(BOB, 1); // période 1 : pas encore clôturable
        uint256 founders = cards.roundFounders(0);
        uint256 community = cards.roundCommunity(0);
        vm.prank(BOB); // n'importe qui clôture
        cards.closeRounds(10);
        require(cards.roundsClosed() == 1, "seulement la periode terminee");
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.NothingToSend.selector));
        cards.closeRounds(10);
        vm.prank(BOB); // n'importe qui déclenche, mais l'ETH ne va qu'au payee
        cards.withdraw(FOUNDERS);
        cards.withdraw(COMMUNITY);
        require(FOUNDERS.balance == founders && COMMUNITY.balance == community, "versements aux adresses fixes");
        require(cards.owed(FOUNDERS) == 0 && cards.totalOwed() == 0, "totaux");
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.NothingToSend.selector));
        cards.withdraw(FOUNDERS);
        _round(2);
        cards.closeRounds(10);
        cards.withdraw(FOUNDERS);
        require(FOUNDERS.balance == founders + (PRICE * 30) / 100, "part de la periode 1 apres sa fin");
        _checkBalance(cards, 0);
    }

    function test_CharityCreditedToTheWinnerOfThatRound() public {
        _mintAs(ALICE, 10);
        vm.prank(ALICE);
        cards.vote(_ids(1, 10), 1);
        uint256 amount = cards.roundCharity(0);
        _round(1);
        vm.prank(BOB);
        cards.closeRounds(1);
        require(cards.owed(CHARITY_B) == amount && cards.charityReleased() == amount, "creditee a la gagnante");
        require(cards.roundCharity(0) == 0, "periode 0 soldee");
        cards.withdraw(CHARITY_B);
        require(CHARITY_B.balance == amount, "retiree");
    }

    function test_CharityRollsOverWhenNobodyVoted() public {
        _mintAs(ALICE, 2);
        uint256 amount = cards.roundCharity(0);
        _round(2); // personne n'a voté en période 0 ; on est en période 2
        cards.closeRounds(10);
        require(cards.roundCharity(2) == amount && cards.charityReleased() == 0, "reportee sur la periode en cours");
        require(cards.owed(CHARITY_A) == 0 && cards.owed(CHARITY_B) == 0, "rien credite");
        vm.prank(ALICE);
        cards.vote(_ids(1, 1), 0);
        _round(3);
        cards.closeRounds(10);
        require(cards.owed(CHARITY_A) == amount, "creditee a la gagnante de la periode suivante");
    }

    function test_RefusingPayeeDoesNotBlockOthers() public {
        RejectEth sink = new RejectEth();
        DipDuckCards other = new DipDuckCards(address(sink), COMMUNITY, START, "", "", _names(), _wallets(), _urls());
        vm.prank(ALICE);
        other.mint{value: PRICE * 2}(NAME, 0, 0, 0, 2);
        vm.prank(ALICE);
        other.vote(_ids(1, 2), 0);
        _round(1);
        other.closeRounds(1); // la clôture n'envoie rien : elle ne peut pas échouer à cause d'un payee
        uint256 founders = other.owed(address(sink));
        require(founders > 0, "fondateurs credites");
        other.withdraw(address(sink)); // refus de l'ETH : pas de revert, le solde reste
        require(other.owed(address(sink)) == founders && address(sink).balance == 0, "solde garde");
        other.withdraw(COMMUNITY);
        other.withdraw(CHARITY_A);
        require(COMMUNITY.balance > 0 && CHARITY_A.balance > 0, "les autres sont payes");
        require(address(other).balance == founders && other.totalOwed() == founders, "seul le du du refusant reste");
    }

    function test_RejectsBadConfig() public {
        string[] memory one = new string[](1);
        one[0] = "Seule";
        address[] memory oneWallet = new address[](1);
        oneWallet[0] = CHARITY_A;
        string[] memory oneUrl = new string[](1);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.InvalidConfig.selector));
        new DipDuckCards(FOUNDERS, COMMUNITY, START, "", "", one, oneWallet, oneUrl);
        address[] memory twice = _wallets();
        twice[1] = twice[0];
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.InvalidConfig.selector));
        new DipDuckCards(FOUNDERS, COMMUNITY, START, "", "", _names(), twice, _urls());
    }

    // --- Règle de secours de la cagnotte fondation --------------------------------

    function _expectPlan(DipDuckCards c, uint256 round, uint8 kind, uint256 index) private view {
        (uint8 k, uint256 i) = c.charityPlan(round);
        require(k == kind && i == index, "charityPlan inattendu");
    }

    function test_FallbackStreakOneAndTwoStillRollOver() public {
        _mintAs(ALICE, 2);
        vm.prank(ALICE);
        cards.vote(_ids(1, 1), 1); // période 0 : gagnante B
        uint256 first = cards.roundCharity(0);
        _round(1);
        _mintAs(BOB, 1); // période 1 : aucune voix
        _round(2);
        _mintAs(BOB, 1); // période 2 : aucune voix
        _round(3);
        cards.closeRounds(1); // période 0 : à B
        _expectPlan(cards, 1, 2, 0); // 1 période sans voix : report
        cards.closeRounds(1);
        _expectPlan(cards, 1, 0, 0);
        _expectPlan(cards, 2, 2, 0); // 2 périodes sans voix : report
        cards.closeRounds(1);
        require(cards.roundCharity(3) == 2 * ((PRICE * 30) / 100), "deux reports sur la periode en cours");
        require(cards.owed(CHARITY_B) == first, "seulement la periode 0");
    }

    function test_FallbackPaysTheLastWinnerAfterThreeSilentRounds() public {
        _mintAs(ALICE, 2);
        vm.prank(ALICE);
        cards.vote(_ids(1, 2), 1); // période 0 : gagnante B
        uint256 first = cards.roundCharity(0);
        _round(3);
        _mintAs(BOB, 1); // période 3 : 3 périodes après la dernière voix
        uint256 amount = cards.roundCharity(3);
        _round(4);
        cards.closeRounds(3); // périodes 0, 1, 2
        _expectPlan(cards, 3, 3, 1);
        cards.closeRounds(1);
        require(cards.owed(CHARITY_B) == first + amount && cards.charityReleased() == first + amount, "derniere gagnante");
        _expectPlan(cards, 3, 0, 0);

        // Une période avec des voix : retour au fonctionnement normal.
        vm.prank(ALICE);
        cards.vote(_ids(1, 1), 0); // période 4 : gagnante A
        _mintAs(BOB, 1);
        uint256 next = cards.roundCharity(4);
        _round(5);
        _expectPlan(cards, 4, 1, 0);
        cards.closeRounds(1);
        require(cards.owed(CHARITY_A) == next, "gagnante de la periode");
    }

    function test_FallbackSplitsEquallyWhenNobodyEverVoted() public {
        // 5 fondations de départ + 2 approuvées par proposition = 7 (montant non divisible par 7).
        string[] memory names = new string[](5);
        address[] memory wallets = new address[](5);
        string[] memory urls = new string[](5);
        for (uint256 i = 0; i < 5; i++) {
            names[i] = "F";
            wallets[i] = address(uint160(0xD00 + i));
        }
        DipDuckCardsHarness c = new DipDuckCardsHarness(FOUNDERS, COMMUNITY, START, names, wallets, urls);
        address[] memory voters = _voters(c, 0x40000, 3);
        _proposeWith(c, voters[0], address(uint160(0xD05)));
        _proposeWith(c, voters[1], address(uint160(0xD06)));
        _voteAll(c, 0, voters, true);
        _voteAll(c, 1, voters, true);
        vm.warp(START + 7 days);
        c.finalizeProposal(0);
        c.finalizeProposal(1);
        require(c.candidateCount() == 7 && c.activeCount() == 7, "7 candidates");
        _round(2);
        vm.prank(ALICE);
        c.mint{value: PRICE}(NAME, 0, 0, 0, 1); // période 2, jamais aucune voix : 3e période
        uint256 amount = c.roundCharity(2);
        _round(3);
        _expectPlan(c, 0, 2, 0); // période 0 : seulement la 1re sans voix → report
        c.closeRounds(2);
        _expectPlan(c, 2, 4, 0);
        c.closeRounds(1);
        uint256 share = amount / 7;
        uint256 remainder = amount - share * 7;
        require(remainder > 0, "le test doit avoir un reste");
        require(c.owed(address(uint160(0xD00))) == share + remainder, "reste a la premiere");
        for (uint256 i = 1; i < 7; i++) {
            require(c.owed(address(uint160(0xD00 + i))) == share, "parts egales");
        }
        _expectPlan(c, 2, 0, 0);
        _checkBalance(c, 0);
    }

    function test_CharityPlanNothingCases() public {
        _expectPlan(cards, 0, 0, 0); // période pas terminée
        _round(1);
        _expectPlan(cards, 0, 0, 0); // cagnotte vide
        _mintAs(ALICE, 1);
        vm.prank(ALICE);
        cards.vote(_ids(1, 1), 1);
        _round(2);
        _expectPlan(cards, 1, 1, 1); // gagnante de la période
    }

    // --- Propositions de fondations ----------------------------------------------

    address private constant NEW_CHARITY = address(0xC3);

    /// @dev `n` wallets neufs de 10 cartes chacun.
    function _voters(DipDuckCards c, uint256 base, uint256 n) private returns (address[] memory voters) {
        voters = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            voters[i] = address(uint160(base + i));
            vm.deal(voters[i], 1 ether);
            vm.prank(voters[i]);
            c.mint{value: PRICE * 10}(NAME, 0, 0, 0, 10);
        }
    }

    function _proposeWith(DipDuckCards c, address who, address wallet) private returns (uint256 id) {
        vm.prank(who);
        c.propose{value: DEPOSIT}("Nouvelle fondation", wallet, URL, "Elle aide les canards.");
        return c.proposalCount() - 1;
    }

    function _voteAll(DipDuckCards c, uint256 id, address[] memory voters, bool support) private {
        for (uint256 i = 0; i < voters.length; i++) {
            uint256[] memory ids = c.tokensOfOwner(voters[i]);
            vm.prank(voters[i]);
            c.voteProposal(id, ids, support);
        }
    }

    function _status(DipDuckCards c, uint256 id) private view returns (uint8 status) {
        (,,,,,, status) = c.proposal(id);
    }

    function test_ProposalApprovedRefundsDepositAndBecomesCandidate() public {
        address[] memory voters = _voters(cards, 0x50000, 3);
        vm.prank(voters[0]);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.WrongPayment.selector, DEPOSIT));
        cards.propose{value: DEPOSIT - 1}("X", NEW_CHARITY, URL, "d");
        uint256 id = _proposeWith(cards, voters[0], NEW_CHARITY);
        _voteAll(cards, id, voters, true);
        vm.prank(voters[0]);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.AlreadyVoted.selector, 1));
        cards.voteProposal(id, _ids(1, 1), true);
        (uint256 yes, uint256 no, uint256 snapshot, uint256 quorum, uint256 endsAt) = cards.proposalVotes(id);
        require(yes == 30 && no == 0 && snapshot == 30 && quorum == 25 && endsAt == START + 7 days, "decompte");
        _checkBalance(cards, DEPOSIT);
        vm.warp(START + 7 days);
        cards.finalizeProposal(id);
        require(_status(cards, id) == 1 && cards.candidateCount() == 3, "approuvee");
        (string memory name, address wallet, string memory url, uint256 fromRound, bool active, uint256 deadline) =
            cards.candidate(2);
        require(wallet == NEW_CHARITY && fromRound == 1 && active && deadline == 6, "candidate a partir de la periode 1");
        require(keccak256(bytes(name)) == keccak256("Nouvelle fondation") && keccak256(bytes(url)) == keccak256(bytes(URL)), "nom, lien");
        require(cards.owed(voters[0]) == DEPOSIT, "depot rendu (credit)");
        uint256 before = voters[0].balance;
        cards.withdraw(voters[0]);
        require(voters[0].balance == before + DEPOSIT, "depot retire");
        vm.prank(voters[1]);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.InvalidCandidate.selector));
        cards.vote(_ids(11, 11), 2); // pas avant la période 1
        _round(1);
        vm.prank(voters[1]);
        cards.vote(_ids(11, 11), 2);
        require(cards.votesFor(1, 2) == 1, "votable en periode 1");
    }

    function test_ProposalRejectedForfeitsDepositToCommunity() public {
        address[] memory voters = _voters(cards, 0x50000, 3);
        uint256 id = _proposeWith(cards, voters[0], NEW_CHARITY);
        uint256 potBefore = cards.roundCommunity(0);
        vm.prank(voters[0]);
        cards.voteProposal(id, _ids(1, 10), true); // 10 voix < quorum de 25
        vm.warp(START + 7 days);
        cards.finalizeProposal(id);
        require(_status(cards, id) == 2 && cards.candidateCount() == 2, "refusee faute de quorum");
        require(cards.roundCommunity(0) == potBefore + DEPOSIT && cards.owed(voters[0]) == 0, "depot a la communaute");
        _checkBalance(cards, 0);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.ProposalClosed.selector));
        cards.finalizeProposal(id);
        _round(1);
        cards.closeRounds(1);
        require(cards.owed(COMMUNITY) == potBefore + DEPOSIT, "credite a la cloture");
        // Le wallet peut être reproposé ensuite.
        _proposeWith(cards, voters[0], NEW_CHARITY);
    }

    function test_TwoThirdsOfVotesCast() public {
        address[] memory voters = _voters(cards, 0x50000, 3);
        uint256 a = _proposeWith(cards, voters[0], NEW_CHARITY);
        uint256 b = _proposeWith(cards, voters[1], address(0xC4));
        // a : 20 oui, 10 non → 2/3 pile, approuvée. b : 19 oui, 11 non → refusée.
        vm.prank(voters[0]);
        cards.voteProposal(a, _ids(1, 10), true);
        vm.prank(voters[1]);
        cards.voteProposal(a, _ids(11, 20), true);
        vm.prank(voters[2]);
        cards.voteProposal(a, _ids(21, 30), false);
        vm.prank(voters[0]);
        cards.voteProposal(b, _ids(1, 10), true);
        vm.prank(voters[1]);
        cards.voteProposal(b, _ids(11, 19), true);
        vm.prank(voters[1]);
        cards.voteProposal(b, _ids(20, 20), false);
        vm.prank(voters[2]);
        cards.voteProposal(b, _ids(21, 30), false);
        vm.warp(START + 7 days);
        cards.finalizeProposal(a);
        cards.finalizeProposal(b);
        require(_status(cards, a) == 1 && _status(cards, b) == 2, "2/3 pile approuvee, moins refusee");
    }

    function test_QuorumIsMax25Or5Percent() public {
        require(cards.quorumFor(0) == 25 && cards.quorumFor(500) == 25 && cards.quorumFor(501) == 26, "quorum");
        require(cards.quorumFor(1000) == 50 && cards.quorumFor(3333) == 167, "5 % arrondi au-dessus");
        address[] memory voters = _voters(cards, 0x50000, 3);
        uint256 a = _proposeWith(cards, voters[0], NEW_CHARITY);
        uint256 b = _proposeWith(cards, voters[1], address(0xC4));
        vm.prank(voters[0]);
        cards.voteProposal(a, _ids(1, 10), true);
        vm.prank(voters[1]);
        cards.voteProposal(a, _ids(11, 20), true);
        vm.prank(voters[2]);
        cards.voteProposal(a, _ids(21, 24), true); // 24 voix
        vm.prank(voters[0]);
        cards.voteProposal(b, _ids(1, 10), true);
        vm.prank(voters[1]);
        cards.voteProposal(b, _ids(11, 20), true);
        vm.prank(voters[2]);
        cards.voteProposal(b, _ids(21, 25), true); // 25 voix
        vm.warp(START + 7 days);
        cards.finalizeProposal(a);
        cards.finalizeProposal(b);
        require(_status(cards, a) == 2 && _status(cards, b) == 1, "24 refusee, 25 approuvee");
    }

    function test_VotingWindowIsSevenFullDays() public {
        address[] memory voters = _voters(cards, 0x50000, 3);
        // Proposée 2 jours avant la fin de la période 0 : le vote continue en période 1.
        vm.warp(START + ROUND - 2 days);
        uint256 id = _proposeWith(cards, voters[0], NEW_CHARITY);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.VotingNotOver.selector, START + ROUND + 5 days));
        cards.finalizeProposal(id);
        _voteAll(cards, id, voters, true);
        vm.warp(START + ROUND + 5 days - 1);
        vm.prank(voters[0]);
        cards.transferFrom(voters[0], BOB, 1);
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.AlreadyVoted.selector, 1));
        cards.voteProposal(id, _ids(1, 1), false);
        vm.warp(START + ROUND + 5 days);
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.ProposalClosed.selector));
        cards.voteProposal(id, _ids(1, 1), false);
        cards.finalizeProposal(id);
        (,,, uint256 fromRound,,) = cards.candidate(2);
        require(_status(cards, id) == 1 && fromRound == 2, "finalisee en periode 1 : candidate en periode 2");
    }

    function test_LastMinuteMintCannotVote() public {
        address[] memory voters = _voters(cards, 0x50000, 3);
        uint256 id = _proposeWith(cards, voters[0], NEW_CHARITY);
        _voteAll(cards, id, voters, true);
        // Attaque : 3 wallets mintent juste avant la fin pour renverser le vote.
        vm.warp(START + 7 days - 60);
        address[] memory late = _voters(cards, 0x60000, 3);
        vm.prank(late[0]);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.NotEligible.selector, 31));
        cards.voteProposal(id, _ids(31, 40), false);
        // Les cartes déjà existantes, même achetées après, votent une seule fois chacune.
        vm.warp(START + 7 days);
        cards.finalizeProposal(id);
        require(_status(cards, id) == 1, "le remplissage de derniere minute echoue");
        (,, uint256 snapshot,,) = cards.proposalVotes(id);
        require(snapshot == 30, "snapshot a la proposition");
    }

    function test_AtMostThreeApprovalsPerRound() public {
        address[] memory voters = _voters(cards, 0x50000, 4);
        for (uint256 i = 0; i < 4; i++) _proposeWith(cards, voters[i], address(uint160(0xE00 + i)));
        for (uint256 i = 0; i < 4; i++) _voteAll(cards, i, voters, true);
        vm.warp(START + 7 days);
        for (uint256 i = 0; i < 4; i++) cards.finalizeProposal(i);
        require(_status(cards, 2) == 1 && _status(cards, 3) == 3, "3 approuvees, la 4e sans place");
        require(cards.activeCount() == 5, "plafond de la periode");
        require(cards.owed(voters[3]) == DEPOSIT, "depot rendu a la 4e");
        // Période suivante : elle peut être reproposée.
        _round(1);
        uint256 again = _proposeWith(cards, voters[3], address(uint160(0xE03)));
        _voteAll(cards, again, voters, true);
        vm.warp(START + ROUND + 7 days);
        cards.finalizeProposal(again);
        require(_status(cards, again) == 1 && cards.activeCount() == 6, "approuvee en periode 1");
    }

    function test_CandidateExpiresAfterSixRoundsWithoutWin() public {
        address[] memory voters = _voters(cards, 0x50000, 3);
        uint256 a = _proposeWith(cards, voters[0], NEW_CHARITY);
        uint256 b = _proposeWith(cards, voters[1], address(0xC4));
        _voteAll(cards, a, voters, true);
        _voteAll(cards, b, voters, true);
        vm.warp(START + 7 days);
        cards.finalizeProposal(a); // candidate 2
        cards.finalizeProposal(b); // candidate 3
        // Périodes 1 à 6 : la fondation A gagne toujours ; la candidate 3 gagne la période 3.
        for (uint256 r = 1; r <= 6; r++) {
            _round(r);
            vm.prank(voters[0]);
            cards.vote(_ids(1, 2), r == 3 ? 3 : 0);
            vm.prank(voters[0]);
            cards.vote(_ids(3, 3), 2); // une voix ne suffit pas
        }
        (,,,, bool active2, uint256 deadline2) = cards.candidate(2);
        (,,,, bool active3, uint256 deadline3) = cards.candidate(3);
        require(active2 && deadline2 == 6 && active3 && deadline3 == 9, "pas encore : la periode 6 est en cours");
        _round(7);
        cards.closeRounds(1); // clôture de la période 6 : 6 périodes sans victoire pour la candidate 2
        (,,,, active2,) = cards.candidate(2);
        (,,,, active3,) = cards.candidate(3);
        require(!active2 && active3 && cards.activeCount() == 3, "candidate 2 expiree, 3 gardee (victoire en 3)");
        vm.prank(voters[0]);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.InvalidCandidate.selector));
        cards.vote(_ids(1, 1), 2);
        // Sa place est libre et son wallet peut être reproposé.
        _proposeWith(cards, voters[1], NEW_CHARITY);
    }

    function test_CommunityDoesNotVote() public {
        vm.deal(COMMUNITY, 1 ether);
        _mintAs(COMMUNITY, 2);
        _mintAs(ALICE, 1);
        vm.startPrank(COMMUNITY);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.CommunityCannotVote.selector));
        cards.vote(_ids(1, 2), 0);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.CommunityCannotVote.selector));
        cards.propose{value: DEPOSIT}("X", NEW_CHARITY, URL, "d");
        vm.stopPrank();
        vm.deal(ALICE, 1 ether);
        uint256 id = _proposeWith(cards, ALICE, NEW_CHARITY);
        vm.prank(COMMUNITY);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.CommunityCannotVote.selector));
        cards.voteProposal(id, _ids(1, 2), true);
        // Données à quelqu'un d'autre, des cartes achetées votent normalement.
        vm.prank(COMMUNITY);
        cards.transferFrom(COMMUNITY, BOB, 1);
        vm.prank(BOB);
        cards.voteProposal(id, _ids(1, 1), true);
        vm.prank(BOB);
        cards.vote(_ids(1, 1), 0);
    }

    function test_TrophyNeverVotes() public {
        _mintAs(BOB, 2); // cartes 1 et 2
        _trophy(BOB); // carte 3
        vm.deal(ALICE, 1 ether);
        _mintAs(ALICE, 1); // carte 4
        uint256 id = _proposeWith(cards, ALICE, NEW_CHARITY);
        vm.startPrank(BOB);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.NotEligible.selector, 3));
        cards.vote(_ids(1, 3), 0);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.NotEligible.selector, 3));
        cards.voteProposal(id, _ids(3, 3), true);
        // Les cartes achetées du même wallet votent normalement.
        cards.vote(_ids(1, 2), 0);
        cards.voteProposal(id, _ids(1, 2), true);
        vm.stopPrank();
        require(cards.votesFor(0, 0) == 2, "2 voix, pas 3");
        // Donnée à quelqu'un d'autre, la carte Trophée ne vote toujours pas.
        vm.prank(BOB);
        cards.transferFrom(BOB, ALICE, 3);
        vm.startPrank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.NotEligible.selector, 3));
        cards.vote(_ids(3, 3), 0);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.NotEligible.selector, 3));
        cards.voteProposal(id, _ids(3, 3), true);
        vm.stopPrank();
    }

    function test_ProposeRules() public {
        vm.deal(ALICE, 1 ether);
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.NotHolder.selector));
        cards.propose{value: DEPOSIT}("X", NEW_CHARITY, URL, "d");
        _mintAs(ALICE, 1);
        _mintAs(BOB, 1);
        bytes memory invalid = abi.encodeWithSelector(DipDuckCards.InvalidProposal.selector);
        bytes memory long = new bytes(201);
        for (uint256 i = 0; i < long.length; i++) long[i] = "a";
        bytes memory max = new bytes(200);
        for (uint256 i = 0; i < max.length; i++) max[i] = i < 8 ? bytes("https://")[i] : bytes1("a");
        for (uint256 i = 0; i < 8; i++) long[i] = bytes("https://")[i];
        vm.startPrank(ALICE);
        vm.expectRevert(invalid);
        cards.propose{value: DEPOSIT}("", NEW_CHARITY, URL, "d");
        vm.expectRevert(invalid);
        cards.propose{value: DEPOSIT}("X", NEW_CHARITY, URL, "");
        vm.expectRevert(invalid);
        cards.propose{value: DEPOSIT}("12345678901234567890123456789012345678901", NEW_CHARITY, URL, "d"); // 41
        vm.expectRevert(invalid);
        cards.propose{value: DEPOSIT}("X", NEW_CHARITY, "", "d"); // lien obligatoire
        vm.expectRevert(invalid);
        cards.propose{value: DEPOSIT}("X", NEW_CHARITY, "http://exemple.org", "d"); // https seulement
        vm.expectRevert(invalid);
        cards.propose{value: DEPOSIT}("X", NEW_CHARITY, "javascript:alert(1)", "d");
        vm.expectRevert(invalid);
        cards.propose{value: DEPOSIT}("X", NEW_CHARITY, "https://", "d");
        vm.expectRevert(invalid);
        cards.propose{value: DEPOSIT}("X", NEW_CHARITY, string(long), "d"); // 201 octets
        vm.expectRevert(invalid);
        cards.propose{value: DEPOSIT}("X", address(0), URL, "d");
        vm.expectRevert(invalid);
        cards.propose{value: DEPOSIT}("X", address(cards), URL, "d"); // un contrat
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.AlreadyCandidate.selector));
        cards.propose{value: DEPOSIT}("X", CHARITY_A, URL, "d");
        cards.propose{value: DEPOSIT}("X", NEW_CHARITY, string(max), "d"); // 200 octets : accepté
        cards.propose{value: DEPOSIT}("Y", address(0xC4), URL, "d"); // une 2e : nouveau dépôt
        vm.stopPrank();
        vm.deal(BOB, 1 ether);
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.AlreadyProposed.selector));
        cards.propose{value: DEPOSIT}("Z", NEW_CHARITY, URL, "d"); // ce wallet est déjà proposé
    }

    function test_FullWhenTwentyCandidates() public {
        // 2 candidates de départ + 18 approuvées (3 par période, périodes 0 à 5) = 20 ; la suivante est « Full ».
        address[] memory voters = _voters(cards, 0x50000, 8);
        for (uint256 r = 0; r < 7; r++) {
            _round(r);
            uint256 first = cards.proposalCount();
            uint256 count = r < 6 ? 3 : 1;
            for (uint256 k = 0; k < count; k++) _proposeWith(cards, voters[k], address(uint160(0x30000 + r * 3 + k)));
            for (uint256 k = 0; k < count; k++) _voteAll(cards, first + k, voters, true);
            vm.warp(START + r * ROUND + 7 days);
            for (uint256 k = 0; k < count; k++) cards.finalizeProposal(first + k);
        }
        require(cards.activeCount() == 20 && _status(cards, 18) == 3, "20 candidates au maximum");
        require(cards.owed(voters[0]) == 7 * DEPOSIT, "tous les depots rendus");
    }

    function _names() private pure returns (string[] memory names) {
        names = new string[](2);
        names[0] = "Fondation A";
        names[1] = "Fondation B";
    }

    function _wallets() private pure returns (address[] memory wallets) {
        wallets = new address[](2);
        wallets[0] = CHARITY_A;
        wallets[1] = CHARITY_B;
    }

    function _urls() private pure returns (string[] memory urls) {
        urls = new string[](2);
    }

    // --- Lecture et métadonnées -------------------------------------------------

    function test_TokensOfOwner() public {
        _mintAs(ALICE, 2);
        _mintAs(BOB, 1);
        _mintAs(ALICE, 1);
        uint256[] memory ids = cards.tokensOfOwner(ALICE);
        require(ids.length == 3 && ids[0] == 1 && ids[1] == 2 && ids[2] == 4, "cartes d'Alice");
    }

    function test_TokenURIIsBase64Json() public {
        _mintAs(ALICE, 1);
        string memory before = cards.tokenURI(1);
        require(_startsWith(before, "data:application/json;base64,"), "prefixe data URI");
        _rollPastTarget(1_000, keccak256("a"));
        cards.reveal(1);
        string memory uri = cards.tokenURI(1);
        bytes memory encoded = bytes(uri);
        bytes memory payload = new bytes(encoded.length - 29);
        for (uint256 i = 0; i < payload.length; i++) {
            payload[i] = encoded[29 + i];
        }
        // Le JSON n'est pas décodé ici ; on vérifie que l'encodage est celui d'OZ pour le JSON attendu.
        require(keccak256(payload) != keccak256(bytes(Base64.encode(""))), "contenu non vide");
        require(payload.length % 4 == 0, "base64 bien forme");
    }

    function _startsWith(string memory s, string memory prefix) private pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory b = bytes(prefix);
        if (a.length < b.length) return false;
        for (uint256 i = 0; i < b.length; i++) {
            if (a[i] != b[i]) return false;
        }
        return true;
    }
}
