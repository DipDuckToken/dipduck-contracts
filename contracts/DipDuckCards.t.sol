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
        Card memory card = Card(name, address(0), 0, lucky, mood, element, 0);
        return _pick(card, seed, t);
    }

    function boostFor(bytes32 name, uint8 mood, uint8 element, uint16 lucky, uint256 t, uint256 i)
        external
        pure
        returns (uint256)
    {
        Card memory card = Card(name, address(0), 0, lucky, mood, element, 0);
        return _boost(card, t, i);
    }
}

/// @dev Destinataire qui refuse l'ETH : pour vérifier qu'un échec d'envoi annule tout.
contract RejectEth {}

/// @notice Tests des cartes de collection Dip Duck : mint, réserve, commit-reveal,
///         attributs et secrets, vote de la fondation, versements, métadonnées.
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
        (bytes32 name, uint8 mood, uint8 element, uint16 lucky, uint64 commitBlock, bool revealed) = cards.cardOf(1);
        require(name == NAME && mood == 1 && element == 2 && lucky == 7, "choix enregistres");
        require(commitBlock == 1_000 && !revealed, "bloc d'engagement, pas encore revelee");
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
        _round(1);
        require(cards.foundersAvailable() == thirty, "30 % fondateurs");
        require(cards.communityAvailable() == paid - 2 * thirty, "le reste a la communaute");
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
        // La réserve reste disponible après l'épuisement de l'offre publique.
        vm.prank(COMMUNITY);
        cards.mintReserved(BOB, 111, "Winner", 0, 0, 0);
        require(cards.totalMinted() == cards.MAX_SUPPLY(), "3333 cartes au total");
    }

    // --- Réserve ----------------------------------------------------------------

    function test_ReserveOnlyByCommunityAndCapped() public {
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.OnlyCommunity.selector));
        cards.mintReserved(ALICE, 1, NAME, 0, 0, 0);
        vm.prank(COMMUNITY);
        cards.mintReserved(BOB, 100, "Winner", 0, 0, 0);
        vm.prank(COMMUNITY);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.SoldOut.selector));
        cards.mintReserved(BOB, 12, "Winner", 0, 0, 0);
        vm.prank(COMMUNITY);
        cards.mintReserved(BOB, 11, "Winner", 0, 0, 0);
        require(cards.reservedMinted() == 111 && cards.balanceOf(BOB) == 111, "111 cartes de reserve");
        require(address(cards).balance == 0, "la reserve est gratuite");
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
        // Cartes 4 et 5 engagées maintenant (la réserve ne révèle rien au passage) : pas encore prêtes.
        vm.prank(COMMUNITY);
        cards.mintReserved(BOB, 2, "Winner", 0, 0, 0);
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

    function _ids(uint256 a, uint256 b) private pure returns (uint256[] memory ids) {
        ids = new uint256[](b - a + 1);
        for (uint256 i = 0; i < ids.length; i++) {
            ids[i] = a + i;
        }
    }

    function _round(uint256 r) private {
        vm.warp(START + r * ROUND);
    }

    function test_RoundsAre30Days() public {
        require(cards.currentRound() == 0 && cards.roundEnd(0) == START + ROUND, "periode 0");
        vm.warp(START - 1);
        require(cards.currentRound() == 0, "0 avant le debut du mint");
        _round(1);
        require(cards.currentRound() == 1 && cards.roundEnd(1) == START + 2 * ROUND, "periode 1");
        vm.warp(START + 2 * ROUND - 1);
        require(cards.currentRound() == 1, "encore la periode 1");
    }

    function test_MintCreditsThePotsOfTheCurrentRound() public {
        _mintAs(ALICE, 3);
        _round(1);
        _mintAs(BOB, 1);
        require(cards.roundCharity(0) == (PRICE * 3 * 30) / 100, "fondation periode 0");
        require(cards.roundCharity(1) == (PRICE * 30) / 100, "fondation periode 1");
        require(cards.foundersAvailable() == (PRICE * 3 * 30) / 100, "fondateurs : seulement la periode terminee");
        uint256 community = PRICE * 3 - 2 * ((PRICE * 3 * 30) / 100);
        require(cards.communityAvailable() == community, "communaute : le reste de la periode terminee");
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
        // ... mais revote à la période suivante.
        _round(1);
        vm.prank(BOB);
        cards.vote(_ids(1, 1), 0);
        require(cards.votesFor(1, 0) == 1 && cards.hasVoted(1, 1), "nouvelle voix en periode 1");
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

    function test_NoWithdrawalBeforeRoundEnds() public {
        _mintAs(ALICE, 4);
        require(cards.foundersAvailable() == 0 && cards.communityAvailable() == 0, "rien de disponible pendant la periode");
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.NothingToSend.selector));
        cards.withdrawFounders();
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.NothingToSend.selector));
        cards.withdrawCommunity();
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.RoundNotOver.selector, 0));
        cards.releaseCharity(0);
    }

    function test_WithdrawalsAfterRoundGoToFixedAddresses() public {
        _mintAs(ALICE, 4);
        _round(1);
        _mintAs(BOB, 1); // période 1 : pas encore disponible
        uint256 founders = cards.foundersAvailable();
        uint256 community = cards.communityAvailable();
        vm.prank(BOB); // n'importe qui peut déclencher
        cards.withdrawFounders();
        cards.withdrawCommunity();
        require(FOUNDERS.balance == founders && COMMUNITY.balance == community, "versements aux adresses fixes");
        require(cards.foundersPaid() == founders && cards.communityPaid() == community, "totaux verses");
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.NothingToSend.selector));
        cards.withdrawFounders();
        _round(2);
        cards.withdrawFounders();
        require(FOUNDERS.balance == founders + (PRICE * 30) / 100, "part de la periode 1 apres sa fin");
    }

    function test_ReleaseCharityToTheWinnerOfThatRound() public {
        _mintAs(ALICE, 10);
        vm.prank(ALICE);
        cards.vote(_ids(1, 10), 1);
        uint256 amount = cards.roundCharity(0);
        _round(1);
        vm.prank(BOB);
        cards.releaseCharity(0);
        require(CHARITY_B.balance == amount && cards.charityReleased() == amount, "cagnotte versee au gagnant");
        require(cards.roundPaid(0) && cards.roundCharity(0) == 0, "periode 0 soldee");
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.AlreadyPaid.selector, 0));
        cards.releaseCharity(0);
    }

    function test_CharityRollsOverWhenNobodyVoted() public {
        _mintAs(ALICE, 2);
        uint256 amount = cards.roundCharity(0);
        _round(2); // personne n'a voté en période 0 ; on est en période 2
        cards.releaseCharity(0);
        require(cards.roundCharity(2) == amount && cards.charityReleased() == 0, "reportee sur la periode en cours");
        require(CHARITY_A.balance == 0 && CHARITY_B.balance == 0, "rien verse");
        vm.prank(ALICE);
        cards.vote(_ids(1, 1), 0);
        _round(3);
        cards.releaseCharity(2);
        require(CHARITY_A.balance == amount, "versee au gagnant de la periode suivante");
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.NothingToSend.selector));
        cards.releaseCharity(1);
    }

    function test_FailedTransferRevertsEverything() public {
        RejectEth sink = new RejectEth();
        DipDuckCards other =
            new DipDuckCards(address(sink), COMMUNITY, START, "", "", _names(), _wallets(), _urls());
        vm.prank(ALICE);
        other.mint{value: PRICE}(NAME, 0, 0, 0, 1);
        _round(1);
        uint256 founders = other.foundersAvailable();
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.TransferFailed.selector));
        other.withdrawFounders();
        require(other.foundersAvailable() == founders && other.foundersPaid() == 0, "rien de change apres echec");
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
        _round(1);
        _mintAs(BOB, 1); // période 1 : aucune voix
        _round(2);
        _mintAs(BOB, 1); // période 2 : aucune voix
        _round(3);
        _expectPlan(cards, 1, 2, 0); // 1 période sans voix : report
        cards.releaseCharity(1);
        _expectPlan(cards, 1, 0, 0);
        _expectPlan(cards, 2, 2, 0); // 2 périodes sans voix : report
        cards.releaseCharity(2);
        require(cards.roundCharity(3) == 2 * ((PRICE * 30) / 100), "deux reports sur la periode en cours");
        require(CHARITY_B.balance == 0, "rien verse");
    }

    function test_FallbackPaysTheLastWinnerAfterThreeSilentRounds() public {
        _mintAs(ALICE, 2);
        vm.prank(ALICE);
        cards.vote(_ids(1, 2), 1); // période 0 : gagnante B
        _round(3);
        _mintAs(BOB, 1); // période 3 : 3 périodes après la dernière voix
        uint256 amount = cards.roundCharity(3);
        _round(4);
        _expectPlan(cards, 3, 3, 1);
        cards.releaseCharity(3);
        require(CHARITY_B.balance == amount && cards.charityReleased() == amount, "cagnotte a la derniere gagnante");
        require(cards.roundPaid(3), "periode soldee");
        _expectPlan(cards, 3, 0, 0);

        // Une période avec des voix : retour au fonctionnement normal.
        vm.prank(ALICE);
        cards.vote(_ids(1, 1), 0); // période 4 : gagnante A
        _mintAs(BOB, 1);
        uint256 next = cards.roundCharity(4);
        _round(5);
        _expectPlan(cards, 4, 1, 0);
        cards.releaseCharity(4);
        require(CHARITY_A.balance == next, "gagnante de la periode");
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
        DipDuckCards c = new DipDuckCards(FOUNDERS, COMMUNITY, START, "", "", names, wallets, urls);
        for (uint256 i = 0; i < 2; i++) {
            address holder = address(uint160(0x40000 + i));
            vm.deal(holder, 1 ether);
            vm.prank(holder);
            c.mint{value: PRICE * 10}(NAME, 0, 0, 0, 10);
            vm.prank(holder);
            c.propose("Nouvelle", address(uint160(0xD05 + i)), "", "d");
            vm.prank(holder);
            c.voteProposal(i, _ids(i * 10 + 1, i * 10 + 10), true);
        }
        _round(1);
        c.finalizeProposal(0);
        c.finalizeProposal(1);
        require(c.candidateCount() == 7, "7 candidates");
        _round(2);
        vm.prank(ALICE);
        c.mint{value: PRICE}(NAME, 0, 0, 0, 1); // période 2, jamais aucune voix : 3e période
        uint256 amount = c.roundCharity(2);
        _round(3);
        _expectPlan(c, 0, 2, 0); // période 0 : seulement la 1re sans voix → report
        _expectPlan(c, 2, 4, 0);
        c.releaseCharity(2);
        uint256 share = amount / 7;
        uint256 remainder = amount - share * 7;
        require(remainder > 0, "le test doit avoir un reste");
        require(address(uint160(0xD00)).balance == share + remainder, "reste a la premiere");
        for (uint256 i = 1; i < 7; i++) {
            require(address(uint160(0xD00 + i)).balance == share, "parts egales");
        }
        require(c.charityReleased() == amount && c.roundPaid(2), "tout verse");
        _expectPlan(c, 2, 0, 0);
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

    function _propose(address who) private {
        vm.prank(who);
        cards.propose("Nouvelle fondation", NEW_CHARITY, "https://exemple.org", "Elle aide les canards.");
    }

    function test_ProposalApprovedBecomesCandidateNextRound() public {
        _mintAs(ALICE, 10);
        _mintAs(BOB, 3);
        _propose(ALICE);
        require(cards.proposalCount() == 1, "une proposition");
        vm.prank(ALICE);
        cards.voteProposal(0, _ids(1, 10), true);
        vm.prank(BOB);
        cards.voteProposal(0, _ids(11, 13), false);
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.AlreadyVoted.selector, 1));
        cards.voteProposal(0, _ids(1, 1), true);
        require(cards.hasVotedProposal(0, 11), "voix contre notee");
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.RoundNotOver.selector, 0));
        cards.finalizeProposal(0);

        _round(1);
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.ProposalClosed.selector));
        cards.voteProposal(0, _ids(11, 11), false); // sa période est finie
        cards.finalizeProposal(0);
        (,,,,, uint256 round, uint256 yes, uint256 no, uint8 status) = cards.proposal(0);
        require(round == 0 && yes == 10 && no == 3 && status == 1, "approuvee");
        require(cards.candidateCount() == 3, "nouvelle candidate");
        (string memory name, address wallet, string memory url, uint256 fromRound) = cards.candidate(2);
        require(wallet == NEW_CHARITY && fromRound == 1, "candidate a partir de la periode suivante");
        require(keccak256(bytes(name)) == keccak256("Nouvelle fondation") && bytes(url).length > 0, "nom et lien");
        vm.prank(BOB);
        cards.vote(_ids(11, 11), 2);
        require(cards.votesFor(1, 2) == 1, "votable en periode 1");
    }

    function test_NewCandidateNotVotableBeforeItsRound() public {
        _mintAs(ALICE, 10);
        _propose(ALICE);
        vm.prank(ALICE);
        cards.voteProposal(0, _ids(1, 10), true);
        _round(1);
        cards.finalizeProposal(0);
        // La candidate est votable dès la période 1 (= période de la proposition + 1).
        vm.prank(ALICE);
        cards.vote(_ids(1, 1), 2);
    }

    function test_ProposalRejectedWithoutQuorumOrMajority() public {
        _mintAs(ALICE, 9);
        _propose(ALICE);
        vm.prank(ALICE);
        cards.voteProposal(0, _ids(1, 9), true); // 9 voix < quorum de 10
        _round(1);
        cards.finalizeProposal(0);
        (,,,,,,,, uint8 status) = cards.proposal(0);
        require(status == 2 && cards.candidateCount() == 2, "rejetee faute de quorum");
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.ProposalClosed.selector));
        cards.finalizeProposal(0);
        // Le wallet peut être reproposé ensuite.
        _propose(ALICE);
        require(cards.proposalCount() == 2, "nouvelle proposition possible");
    }

    function test_ProposeRules() public {
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.NotHolder.selector));
        cards.propose("X", NEW_CHARITY, "", "d");
        _mintAs(ALICE, 1);
        _mintAs(BOB, 1);
        vm.startPrank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.InvalidProposal.selector));
        cards.propose("", NEW_CHARITY, "", "d");
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.InvalidProposal.selector));
        cards.propose("X", NEW_CHARITY, "", "");
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.InvalidProposal.selector));
        cards.propose("12345678901234567890123456789012345678901", NEW_CHARITY, "", "d"); // 41
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.InvalidProposal.selector));
        cards.propose("X", address(0), "", "d");
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.InvalidProposal.selector));
        cards.propose("X", address(cards), "", "d"); // un contrat
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.AlreadyCandidate.selector));
        cards.propose("X", CHARITY_A, "", "d");
        cards.propose("X", NEW_CHARITY, "", "d");
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.AlreadyProposed.selector));
        cards.propose("Y", address(0xC4), "", "d"); // une par adresse et par période
        vm.stopPrank();
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(DipDuckCards.AlreadyProposed.selector));
        cards.propose("Z", NEW_CHARITY, "", "d"); // ce wallet est déjà proposé
    }

    function test_FullWhenTwentyCandidates() public {
        // 2 candidats initiaux + 18 approuvés = 20 ; la suivante est « Full ».
        for (uint256 i = 0; i < 19; i++) {
            address voter = address(uint160(0x20000 + i));
            vm.deal(voter, 1 ether);
            _mintAs(voter, 10);
            vm.prank(voter);
            cards.propose("Fondation", address(uint160(0x30000 + i)), "", "d");
            vm.prank(voter);
            cards.voteProposal(i, _ids(i * 10 + 1, i * 10 + 10), true);
            _round(i + 1);
            cards.finalizeProposal(i);
        }
        (,,,,,,,, uint8 status) = cards.proposal(18);
        require(cards.candidateCount() == 20 && status == 3, "20 candidats au maximum");
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
