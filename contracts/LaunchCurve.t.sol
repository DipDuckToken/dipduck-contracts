// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {LaunchCurve} from "./LaunchCurve.sol";
import {MemeToken} from "./MemeToken.sol";
import {MockUniFactory, MockUniPair, MockWETH} from "./mocks/MockUniswap.sol";

interface CurveVm {
    function expectRevert(bytes calldata revertData) external;
    function expectRevert() external;
    function prank(address msgSender) external;
    function warp(uint256 newTimestamp) external;
    function deal(address who, uint256 newBalance) external;
}

/// @dev Acheteur qui tente de rappeler la courbe quand elle lui rend de l'ETH.
contract ReentrantBuyer {
    LaunchCurve private immutable curve;
    bool private attacking;

    constructor(LaunchCurve c) {
        curve = c;
    }

    function attack() external payable {
        attacking = true;
        curve.buy{value: msg.value}(0, type(uint256).max);
    }

    receive() external payable {
        if (attacking) {
            attacking = false;
            curve.buy{value: 1}(0, type(uint256).max); // doit échouer : nonReentrant
        }
    }
}

/// @dev Destinataire avec du code (contrat de blocage, Safe).
contract Holder {}

/// @dev Acheteur qui refuse l'ETH.
contract EthRefuser {
    function buy(LaunchCurve curve) external payable {
        curve.buy{value: msg.value}(0, type(uint256).max);
    }
}

/// @notice Tests de la courbe de lancement : paramètres, prix, achats, reventes, limites
///         anti-bot, ouverture du pool (prix continu, dons, blocage de la paire), réentrance,
///         et fuzzing des invariants (la courbe ne doit jamais plus d'ETH qu'elle n'en a,
///         aucun aller-retour gagnant).
contract LaunchCurveTest {
    CurveVm private constant vm = CurveVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant UNIT = 1e18;
    uint256 private constant SUPPLY = 1_000_000_000;
    uint256 private constant TEAM = 100_000_000;
    uint256 private constant COMMUNITY = 30_000_000;
    uint256 private constant V = 2 ether;
    uint256 private constant E = 3 ether;
    uint256 private constant T0 = 1_800_000_000;
    uint256 private constant OPEN = T0 + 1 days;
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;

    MockUniFactory private factory;
    MockWETH private weth;
    LaunchCurve private curve;
    MemeToken private token;
    address private vesting;
    address private community;

    function setUp() public {
        vm.warp(T0);
        factory = new MockUniFactory();
        weth = new MockWETH();
        vesting = address(new Holder());
        community = address(new Holder());
        curve = _deploy(V, E);
        token = curve.TOKEN();
        vm.deal(ALICE, 1000 ether);
        vm.deal(BOB, 1000 ether);
    }

    function _config(uint256 v, uint256 e) private view returns (LaunchCurve.Config memory) {
        return LaunchCurve.Config({
            supply: SUPPLY,
            vesting: vesting,
            vestingTokens: TEAM,
            community: community,
            communityTokens: COMMUNITY,
            virtualEth: v,
            targetEth: e,
            openAt: OPEN,
            factory: address(factory),
            weth: address(weth)
        });
    }

    function _deploy(uint256 v, uint256 e) private returns (LaunchCurve) {
        return new LaunchCurve("Dip Duck", "DIPDUCK", _config(v, e));
    }

    function _expectInvalid(LaunchCurve.Config memory c) private {
        vm.expectRevert(_err(LaunchCurve.InvalidParams.selector));
        new LaunchCurve("D", "D", c);
    }

    function _err(bytes4 selector) private pure returns (bytes memory) {
        return abi.encodeWithSelector(selector);
    }

    function _buy(address who, uint256 eth) private returns (uint256 out) {
        vm.prank(who);
        out = curve.buy{value: eth}(0, type(uint256).max);
    }

    function _sell(address who, uint256 amount) private returns (uint256 out) {
        vm.prank(who);
        token.approve(address(curve), amount);
        vm.prank(who);
        out = curve.sell(amount, 0, type(uint256).max);
    }

    // --- Paramètres ------------------------------------------------------------------------

    function test_SplitsSupply() public view {
        require(token.totalSupply() == SUPPLY * UNIT, "offre");
        require(token.balanceOf(address(curve)) == SUPPLY * UNIT, "toute l'offre a la courbe");
        require(token.balanceOf(address(this)) == 0 && token.balanceOf(vesting) == 0, "personne d'autre");
        require(curve.VESTING_TOKENS() == TEAM * UNIT && curve.COMMUNITY_TOKENS() == COMMUNITY * UNIT, "parts");
        require(token.LAUNCHER() == address(curve), "la courbe ouvre le pool");
        uint256 share = (SUPPLY - TEAM - COMMUNITY) * UNIT;
        uint256 used = curve.CURVE_TOKENS() + curve.LP_TOKENS();
        require(used <= share && share - used < 1e9, "vendus + pool = part confiee, a l'arrondi pres");
        require(curve.PAIR() == token.PAIR() && curve.PAIR() != address(0), "paire");
    }

    function test_InvalidParams() public {
        LaunchCurve.Config memory c = _config(V, E);
        c.virtualEth = 0;
        _expectInvalid(c);
        _expectInvalid(_config(V, 0));
        c = _config(V, E);
        c.openAt = T0; // ouverture dans le passé
        _expectInvalid(c);
        c.openAt = T0 + 31 days; // plus de 30 jours
        _expectInvalid(c);
        c = _config(V, E);
        c.factory = ALICE; // pas de factory
        _expectInvalid(c);
        c = _config(V, E);
        c.weth = ALICE; // pas de WETH
        _expectInvalid(c);
        c = _config(V, E);
        c.vesting = ALICE; // blocage sans code
        _expectInvalid(c);
        c = _config(V, E);
        c.community = ALICE; // Safe sans code
        _expectInvalid(c);
        c = _config(V, E);
        c.community = vesting; // la même adresse
        _expectInvalid(c);
        c = _config(V, E);
        c.vestingTokens = SUPPLY - COMMUNITY; // rien pour la courbe
        _expectInvalid(c);
        c = _config(V, E);
        (c.supply, c.vestingTokens, c.communityTokens) = (1, 0, 0); // offre ridicule face à la cible
        _expectInvalid(c);
    }

    function test_NoTeamNoCommunity() public {
        LaunchCurve.Config memory c = _config(V, E);
        (c.vesting, c.vestingTokens, c.community, c.communityTokens) = (address(0), 0, address(0), 0);
        LaunchCurve all = new LaunchCurve("D", "D", c);
        require(all.CURVE_TOKENS() + all.LP_TOKENS() <= SUPPLY * UNIT, "tout sur la courbe");
    }

    function test_StartPriceComesFromVirtualReserves() public {
        vm.warp(OPEN);
        // 0,5 % de l'offre coûte environ V × 5 M / (Y − 5 M), près de 0,01 ETH (au lieu de 0,0006 ETH).
        (uint256 out,) = curve.quoteBuy(0.009 ether);
        require(out < SUPPLY * UNIT / 200, "0,009 ETH n achete pas 0,5 %");
        require(curve.price() > 1e9, "prix de depart > 1 gwei par token");
    }

    // --- Ouverture ---------------------------------------------------------------------------

    function test_ClosedBeforeOpenAt() public {
        vm.warp(OPEN - 1);
        vm.prank(ALICE);
        vm.expectRevert(_err(LaunchCurve.NotOpen.selector));
        curve.buy{value: 1 ether}(0, type(uint256).max);
        vm.warp(OPEN);
        require(_buy(ALICE, 0.001 ether) > 0, "ouvert");
    }

    function test_NobodyElseCanSendToPairBeforeGraduation() public {
        vm.warp(OPEN + 1 days);
        _buy(ALICE, 0.5 ether);
        address pair = curve.PAIR();
        vm.prank(ALICE);
        vm.expectRevert(_err(MemeToken.PoolNotOpen.selector));
        token.transfer(pair, 1);
        // Personne d'autre ne détient de tokens : le déployeur n'a rien.
        require(token.balanceOf(address(this)) == 0, "deployeur sans tokens");
    }

    // --- Achat, revente -----------------------------------------------------------------------

    function test_BuyAndSell() public {
        vm.warp(OPEN + 1 days);
        uint256 out = _buy(ALICE, 0.1 ether);
        require(token.balanceOf(ALICE) == out && curve.tokensSold() == out && curve.ethReserve() == 0.1 ether, "achat");
        uint256 before = ALICE.balance;
        uint256 back = _sell(ALICE, out);
        require(back <= 0.1 ether && 0.1 ether - back <= 2, "revente au meme prix, arrondi pour la courbe");
        require(ALICE.balance == before + back && curve.tokensSold() == 0 && curve.ethReserve() == 0.1 ether - back, "revente");
    }

    function test_SlippageAndDeadline() public {
        vm.warp(OPEN + 1 days);
        (uint256 q,) = curve.quoteBuy(0.1 ether);
        vm.prank(ALICE);
        vm.expectRevert(_err(LaunchCurve.Slippage.selector));
        curve.buy{value: 0.1 ether}(q + 1, type(uint256).max);
        vm.prank(ALICE);
        vm.expectRevert(_err(LaunchCurve.Expired.selector));
        curve.buy{value: 0.1 ether}(0, block.timestamp - 1);
        vm.prank(ALICE);
        require(curve.buy{value: 0.1 ether}(q, block.timestamp) == q, "minimum exact accepte");
        uint256 ethQ = curve.quoteSell(q);
        vm.prank(ALICE);
        token.approve(address(curve), q);
        vm.prank(ALICE);
        vm.expectRevert(_err(LaunchCurve.Slippage.selector));
        curve.sell(q, ethQ + 1, type(uint256).max);
        vm.prank(ALICE);
        vm.expectRevert(_err(LaunchCurve.ZeroAmount.selector));
        curve.buy{value: 0}(0, type(uint256).max);
    }

    function test_CannotSellMoreThanSold() public {
        vm.warp(OPEN + 1 days);
        uint256 out = _buy(ALICE, 0.1 ether);
        _buy(BOB, 0.1 ether);
        // On ne revend que ce qui a été vendu ; personne d'autre que les acheteurs n'a de tokens.
        vm.prank(ALICE);
        token.transfer(BOB, out);
        uint256 sold = curve.tokensSold();
        vm.prank(BOB);
        token.approve(address(curve), type(uint256).max);
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(LaunchCurve.TooManyTokens.selector, sold));
        curve.sell(sold + 1, 0, type(uint256).max);
        vm.prank(BOB);
        uint256 got = curve.sell(sold, 0, type(uint256).max);
        require(got <= 0.2 ether && address(curve).balance >= curve.ethReserve(), "jamais plus que l'ETH recu");
    }

    // --- Limite par wallet ----------------------------------------------------------------------

    function test_WalletLimitSchedule() public {
        uint256 supply = SUPPLY * UNIT;
        vm.warp(OPEN);
        require(curve.walletLimit() == supply / 200, "0,5 %");
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(LaunchCurve.WalletLimit.selector, supply / 200));
        curve.buy{value: 1 ether}(0, type(uint256).max);
        vm.warp(OPEN + 1 hours);
        require(curve.walletLimit() == supply / 100, "1 %");
        vm.warp(OPEN + 6 hours);
        require(curve.walletLimit() == supply / 50, "2 %");
        vm.warp(OPEN + 24 hours);
        require(curve.walletLimit() == type(uint256).max, "plus de limite");
        require(_buy(ALICE, 1 ether) > supply / 50, "gros achat permis apres 24 h");
    }

    function test_WalletLimitCountsExistingBalance() public {
        vm.warp(OPEN);
        uint256 limit = curve.walletLimit();
        (uint256 q,) = curve.quoteBuy(0.001 ether);
        require(q < limit, "petit achat");
        _buy(ALICE, 0.001 ether);
        // Achats successifs : le solde total compte.
        uint256 n;
        while (true) {
            (uint256 next,) = curve.quoteBuy(0.001 ether);
            if (token.balanceOf(ALICE) + next > limit) break;
            _buy(ALICE, 0.001 ether);
            ++n;
        }
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(LaunchCurve.WalletLimit.selector, limit));
        curve.buy{value: 0.001 ether}(0, type(uint256).max);
        require(n > 0, "plusieurs achats");
    }

    // --- Ouverture du pool --------------------------------------------------------------------

    function test_GraduationAtExactEndPrice() public {
        vm.warp(OPEN + 1 days);
        _buy(ALICE, 1 ether);
        uint256 endPrice; // prix de fin de courbe, wei par token entier (× 1e18 pour la précision)
        {
            uint256 x = V + E;
            uint256 y = curve.VIRTUAL_TOKENS() - curve.CURVE_TOKENS();
            endPrice = x * 1e36 / y;
        }
        uint256 before = BOB.balance;
        uint256 out = _buy(BOB, 10 ether); // dépasse la cible : plafonné, surplus rendu
        require(curve.graduated() && curve.ethReserve() == E, "cible atteinte");
        require(BOB.balance == before - (E - 1 ether), "surplus rendu");
        require(curve.tokensSold() == curve.CURVE_TOKENS() && token.balanceOf(BOB) == out, "tout vendu");

        MockUniPair pair = MockUniPair(curve.PAIR());
        require(weth.balanceOf(address(pair)) == E && token.balanceOf(address(pair)) == curve.LP_TOKENS(), "pool");
        require(pair.balanceOf(DEAD) == pair.totalSupply() - 1000, "parts LP brulees");
        uint256 poolPrice = E * 1e36 / curve.LP_TOKENS();
        uint256 gap = poolPrice > endPrice ? poolPrice - endPrice : endPrice - poolPrice;
        require(gap * 1e9 <= endPrice, "prix du pool = prix de fin de courbe (1 ppb)");
        require(token.balanceOf(address(curve)) == 0 && address(curve).balance == 0, "courbe vide");
        require(token.balanceOf(vesting) == TEAM * UNIT && token.balanceOf(community) == COMMUNITY * UNIT, "parts versees");
        require(token.launchedAt() == block.timestamp, "limite du token demarree");

        vm.prank(ALICE);
        vm.expectRevert(_err(LaunchCurve.AlreadyGraduated.selector));
        curve.buy{value: 1 ether}(0, type(uint256).max);
        vm.prank(ALICE);
        vm.expectRevert(_err(LaunchCurve.AlreadyGraduated.selector));
        curve.sell(1, 0, type(uint256).max);
    }

    function test_GraduationNotBlockedByDonations() public {
        vm.warp(OPEN + 1 days);
        uint256 got = _buy(ALICE, 2 ether);
        // Gros don de tokens à la courbe (> 0,5 %) et don de WETH synchronisé dans la paire.
        vm.prank(ALICE);
        token.transfer(address(curve), got / 2);
        vm.deal(address(this), 1 ether);
        weth.deposit{value: 1 ether}();
        weth.transfer(curve.PAIR(), 1 ether);
        MockUniPair(curve.PAIR()).sync();
        _buy(BOB, 5 ether);
        require(curve.graduated(), "ouverture malgre les dons");
        require(token.balanceOf(DEAD) >= got / 2, "tokens donnes brules");
        require(token.balanceOf(curve.PAIR()) == curve.LP_TOKENS(), "pool cote token exact");
    }

    function test_ForcedEthDoesNotChangeAccounting() public {
        vm.warp(OPEN + 1 days);
        vm.deal(address(curve), 5 ether); // ETH forcé (selfdestruct)
        _buy(ALICE, 0.1 ether);
        require(curve.ethReserve() == 0.1 ether, "comptabilite");
        _buy(BOB, 10 ether);
        require(curve.graduated() && weth.balanceOf(curve.PAIR()) == E, "seul l'ETH des acheteurs va au pool");
    }

    function test_NoPlainEth() public {
        (bool ok,) = address(curve).call{value: 1}("");
        require(!ok, "pas de receive");
    }

    // --- Réentrance, destinataire hostile -------------------------------------------------------

    function test_ReentrancyBlockedOnRefund() public {
        vm.warp(OPEN + 1 days);
        ReentrantBuyer attacker = new ReentrantBuyer(curve);
        vm.deal(address(this), 10 ether);
        vm.expectRevert(_err(LaunchCurve.EthTransferFailed.selector));
        attacker.attack{value: 10 ether}();
        require(!curve.graduated(), "rien n'a change");
    }

    function test_RefuserOnlyHurtsItself() public {
        vm.warp(OPEN + 1 days);
        EthRefuser refuser = new EthRefuser();
        vm.deal(address(this), 10 ether);
        vm.expectRevert(_err(LaunchCurve.EthTransferFailed.selector));
        refuser.buy{value: 10 ether}(curve); // surplus impossible à rendre : son propre achat échoue
        refuser.buy{value: E}(curve); // montant exact : passe
        require(curve.graduated(), "les autres ne sont pas bloques");
    }

    // --- Fuzzing ---------------------------------------------------------------------------------

    /// @dev Suite aléatoire d'achats et de reventes : la courbe a toujours au moins l'ETH qu'elle
    ///      doit, x × y >= K, et elle ne vend jamais plus que CURVE_TOKENS.
    function testFuzz_Invariants(uint256 seed) public {
        vm.warp(OPEN + 1 days);
        uint256 k = curve.VIRTUAL_ETH() * curve.VIRTUAL_TOKENS();
        for (uint256 i; i < 24 && !curve.graduated(); ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            address who = seed % 2 == 0 ? ALICE : BOB;
            if ((seed >> 8) % 3 != 0) {
                _buy(who, 1 + (seed >> 16) % 1.5 ether);
            } else {
                uint256 bal = token.balanceOf(who);
                uint256 amount = bal == 0 ? 0 : 1 + (seed >> 16) % bal;
                if (amount > 0 && amount <= curve.tokensSold() && curve.quoteSell(amount) > 0) _sell(who, amount);
            }
            uint256 x = curve.VIRTUAL_ETH() + curve.ethReserve();
            uint256 y = curve.VIRTUAL_TOKENS() - curve.tokensSold();
            if (!curve.graduated()) {
                require(x * y >= k, "x * y >= K");
                require(address(curve).balance >= curve.ethReserve(), "ETH du");
            }
            require(curve.tokensSold() <= curve.CURVE_TOKENS(), "vendus");
        }
    }

    /// @dev Achat puis revente immédiate : jamais plus d'ETH en sortie qu'en entrée.
    function testFuzz_NoProfitableRoundTrip(uint256 pre, uint256 amount) public {
        vm.warp(OPEN + 1 days);
        pre = pre % 2.9 ether;
        if (pre > 0) _buy(BOB, pre);
        amount = 1 + amount % (E - pre - 1);
        uint256 out = _buy(ALICE, amount);
        if (out == 0) return;
        require(_sell(ALICE, out) <= amount, "aller-retour jamais gagnant");
    }

    receive() external payable {}
}
