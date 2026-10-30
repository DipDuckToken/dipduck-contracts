// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {MemeToken} from "./MemeToken.sol";
import {MockPairFactory} from "./mocks/MockPairFactory.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

/// @dev Sous-ensemble des cheatcodes du runner de tests Solidity de Hardhat
///      (compatibles Foundry), déclaré ici pour ne pas dépendre de forge-std.
interface Vm {
    function expectRevert(bytes calldata revertData) external;
    function prank(address msgSender) external;
    function assume(bool condition) external;
    function warp(uint256 newTimestamp) external;
    function getNonce(address account) external view returns (uint64);
}

/// @notice Tests unitaires et de fuzzing du token. Toute fonction `test*`
///         est exécutée ; celles qui prennent des paramètres sont fuzzées.
contract MemeTokenTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant UNIT = 1e18;
    uint256 private constant MAX_WHOLE_TOKENS = type(uint112).max / UNIT;
    uint256 private constant SUPPLY = 1_000_000_000;

    function _deploy(uint256 wholeTokens) private returns (MemeToken) {
        return new MemeToken("Test Token", "TEST", wholeTokens, address(0), address(0), FEE, block.timestamp + 1 days);
    }

    // --- Émission initiale ---------------------------------------------------

    function test_MintsWholeSupplyToDeployerOnce() public {
        MemeToken token = _deploy(SUPPLY);
        require(token.totalSupply() == SUPPLY * UNIT, "offre totale incorrecte");
        require(token.balanceOf(address(this)) == SUPPLY * UNIT, "le deployeur doit tout recevoir");
        require(token.decimals() == 18, "decimales incorrectes");
    }

    function test_SetsNameAndSymbol() public {
        MemeToken token = _deploy(SUPPLY);
        require(keccak256(bytes(token.name())) == keccak256("Test Token"), "nom incorrect");
        require(keccak256(bytes(token.symbol())) == keccak256("TEST"), "symbole incorrect");
    }

    // --- Borne uint112 (réserves Uniswap v2), donc aussi u128 ----------------

    function test_RevertsOnZeroSupply() public {
        vm.expectRevert(abi.encodeWithSelector(MemeToken.InvalidSupply.selector, 0));
        _deploy(0);
    }

    function test_AcceptsLargestUint112CompatibleSupply() public {
        MemeToken token = _deploy(MAX_WHOLE_TOKENS);
        require(token.totalSupply() <= type(uint112).max, "l'offre doit tenir dans un uint112");
        require(type(uint112).max - token.totalSupply() < UNIT, "la borne doit etre la plus grande possible");
    }

    function test_RevertsJustAboveUint112Bound() public {
        vm.expectRevert(abi.encodeWithSelector(MemeToken.InvalidSupply.selector, MAX_WHOLE_TOKENS + 1));
        _deploy(MAX_WHOLE_TOKENS + 1);
    }

    function testFuzz_ValidSupplyFitsUint112(uint256 seed) public {
        uint256 wholeTokens = 1 + (seed % MAX_WHOLE_TOKENS);
        MemeToken token = _deploy(wholeTokens);
        require(token.totalSupply() == wholeTokens * UNIT, "offre totale incorrecte");
        require(token.totalSupply() <= type(uint112).max, "l'offre doit tenir dans un uint112");
        require(token.balanceOf(address(this)) == token.totalSupply(), "le deployeur doit tout recevoir");
    }

    function testFuzz_OversizedSupplyReverts(uint256 seed) public {
        uint256 wholeTokens = MAX_WHOLE_TOKENS + 1 + (seed % (type(uint256).max - MAX_WHOLE_TOKENS));
        vm.expectRevert(abi.encodeWithSelector(MemeToken.InvalidSupply.selector, wholeTokens));
        _deploy(wholeTokens);
    }

    // --- Transferts sans taxe ------------------------------------------------

    function testFuzz_TransferMovesExactAmount(address to, uint256 amount) public {
        vm.assume(to != address(0) && to != address(this));
        MemeToken token = _deploy(SUPPLY);
        uint256 supplyBefore = token.totalSupply();
        amount = amount % (supplyBefore + 1);

        require(token.transfer(to, amount), "le transfert doit reussir");

        require(token.balanceOf(to) == amount, "le destinataire doit recevoir le montant exact");
        require(token.balanceOf(address(this)) == supplyBefore - amount, "l'emetteur doit etre debite du montant exact");
        require(token.totalSupply() == supplyBefore, "l'offre ne doit jamais changer");
    }

    function testFuzz_TransferFromNeverExceedsAllowance(address spender, uint256 allowance, uint256 amount) public {
        vm.assume(spender != address(0) && spender != address(this));
        MemeToken token = _deploy(SUPPLY);
        allowance = allowance % (token.totalSupply() + 1);
        vm.assume(amount > allowance);
        token.approve(spender, allowance);

        vm.prank(spender);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, spender, allowance, amount)
        );
        token.transferFrom(address(this), spender, amount);
    }

    function test_RejectsTransferToZeroAddress() public {
        MemeToken token = _deploy(SUPPLY);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InvalidReceiver.selector, address(0)));
        token.transfer(address(0), 1);
    }

    // --- Pas d'ETH piégé -----------------------------------------------------

    function test_RejectsEther() public {
        MemeToken token = _deploy(SUPPLY);
        (bool ok,) = address(token).call{value: 1}("");
        require(!ok, "le token ne doit pas accepter d'ETH");
        require(address(token).balance == 0, "aucun ETH ne doit rester sur le token");
    }

    // --- Ouverture à heure fixe et anti-bot ------------------------------------

    address private constant WETH = address(0xE7);
    address private constant BOT = address(0xB07);
    uint24 private constant FEE = 10_000;
    uint256 private constant OPEN = 2_000_000;

    function _launch() private returns (MemeToken token, address pool) {
        vm.warp(OPEN - 1 days);
        MockPairFactory factory = new MockPairFactory();
        token = new MemeToken("Test Token", "TEST", SUPPLY, address(factory), WETH, FEE, OPEN);
        pool = token.PAIR();
        require(pool != address(0) && factory.getPool(address(token), WETH, FEE) == pool, "pool cree au deploiement");
    }

    function test_ClosedBeforeOpenAt() public {
        (MemeToken token, address pool) = _launch();
        require(token.LAUNCHER() == address(this) && token.OPEN_AT() == OPEN, "lanceur et heure");
        require(token.walletLimit() == type(uint256).max, "pas de limite avant l'ouverture");
        // Part bloquée et réserve : envoyées avant l'ouverture, sans limite.
        require(token.transfer(address(0x7E57), (SUPPLY * UNIT) / 10), "10 % bloques");
        require(token.transfer(BOT, (SUPPLY * UNIT) * 3 / 100), "3 % reserve");
        // Seul le lanceur alimente le pool ; rien n'en sort avant OPEN_AT.
        vm.prank(BOT);
        vm.expectRevert(abi.encodeWithSelector(MemeToken.PoolNotOpen.selector));
        token.transfer(pool, 1);
        require(token.transfer(pool, (SUPPLY * UNIT * 87) / 100), "le lanceur place la liquidite");
        vm.prank(pool);
        vm.expectRevert(abi.encodeWithSelector(MemeToken.PoolNotOpen.selector));
        token.transfer(BOT, 1);
        // La réserve ne peut rien envoyer ailleurs non plus (pas d'autre marché avant l'heure).
        vm.prank(BOT);
        vm.expectRevert(abi.encodeWithSelector(MemeToken.PoolNotOpen.selector));
        token.transfer(address(0xA11CE), 1);
        vm.warp(OPEN);
        vm.prank(pool);
        require(token.transfer(address(0xA11CE), 1000), "achat a l'heure");
        vm.prank(BOT);
        require(token.transfer(pool, 1000), "vente au pool apres l'ouverture");
    }

    function test_LimitStepsThenDisappears() public {
        (MemeToken token, address pool) = _launch();
        require(token.transfer(pool, (SUPPLY * UNIT * 87) / 100), "pool");
        uint256 total = SUPPLY * UNIT;
        vm.warp(OPEN);
        require(token.walletLimit() == total / 200, "0,5 % la premiere heure");

        vm.prank(pool);
        require(token.transfer(BOT, total / 200), "0,5 % pile accepte");
        vm.prank(pool);
        vm.expectRevert(abi.encodeWithSelector(MemeToken.WalletLimit.selector, total / 200));
        token.transfer(BOT, 1);

        vm.warp(OPEN + 1 hours);
        require(token.walletLimit() == total / 100, "1 % apres 1 h");
        vm.prank(pool);
        require(token.transfer(BOT, total / 200), "jusqu'a 1 %");
        vm.prank(pool);
        vm.expectRevert(abi.encodeWithSelector(MemeToken.WalletLimit.selector, total / 100));
        token.transfer(BOT, 1);

        vm.warp(OPEN + 6 hours);
        require(token.walletLimit() == total / 50, "2 % apres 6 h");
        vm.prank(pool);
        require(token.transfer(BOT, total / 100), "jusqu'a 2 %");
        vm.prank(pool);
        vm.expectRevert(abi.encodeWithSelector(MemeToken.WalletLimit.selector, total / 50));
        token.transfer(BOT, 1);

        vm.warp(OPEN + 24 hours - 1);
        require(token.walletLimit() == total / 50, "toujours 2 % juste avant 24 h");
        vm.warp(OPEN + 24 hours);
        require(token.walletLimit() == type(uint256).max, "plus de limite apres 24 h");
        vm.prank(pool);
        require(token.transfer(BOT, total / 10), "achat libre apres 24 h");
    }

    function test_LimitAlsoAppliesBetweenWalletsButNotToPoolOrDead() public {
        (MemeToken token, address pool) = _launch();
        require(token.transfer(address(0xA11CE), (SUPPLY * UNIT) / 10), "avant l'ouverture : libre");
        vm.warp(OPEN);
        vm.prank(address(0xA11CE));
        vm.expectRevert(abi.encodeWithSelector(MemeToken.WalletLimit.selector, (SUPPLY * UNIT) / 200));
        token.transfer(BOT, (SUPPLY * UNIT) / 200 + 1);
        // Vendre au pool, ou brûler, reste toujours possible, quelle que soit la quantité.
        vm.prank(address(0xA11CE));
        require(token.transfer(pool, (SUPPLY * UNIT) / 20), "vente au pool libre");
        vm.prank(address(0xA11CE));
        require(token.transfer(address(0xdEaD), (SUPPLY * UNIT) / 20), "brulage libre");
    }

    function test_RefusesPoolCreatedByThirdParty() public {
        MockPairFactory factory = new MockPairFactory();
        address predicted = _nextAddress(address(this));
        factory.setPool(predicted, WETH, FEE, address(0xFA1C));
        vm.expectRevert(abi.encodeWithSelector(MemeToken.PoolAlreadyExists.selector, address(0xFA1C)));
        new MemeToken("Test Token", "TEST", SUPPLY, address(factory), WETH, FEE, block.timestamp + 1 days);
    }

    function test_NoFactoryMeansNoPool() public {
        MemeToken token = _deploy(SUPPLY);
        require(token.PAIR() == address(0), "pas de pool");
        require(token.transfer(BOT, (SUPPLY * UNIT) / 2), "transfert libre avant l'heure");
    }

    function _nextAddress(address deployer) private view returns (address) {
        uint256 nonce = vm.getNonce(deployer);
        require(nonce > 0 && nonce < 128, "nonce hors plage");
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xd6), bytes1(0x94), deployer, uint8(nonce))))));
    }
}
