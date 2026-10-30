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
        return new MemeToken("Test Token", "TEST", wholeTokens, address(0), address(0));
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

    // --- Anti-bot : limite par wallet pendant 24 h après l'ouverture du pool ---

    address private constant WETH = address(0xE7);
    address private constant BOT = address(0xB07);

    function _launch() private returns (MemeToken token, address pair) {
        MockPairFactory factory = new MockPairFactory();
        token = new MemeToken("Test Token", "TEST", SUPPLY, address(factory), WETH);
        pair = token.PAIR();
        require(pair != address(0) && factory.getPair(address(token), WETH) == pair, "paire creee au deploiement");
    }

    function test_NoLimitBeforePoolOpens() public {
        (MemeToken token,) = _launch();
        require(token.launchedAt() == 0 && token.walletLimit() == type(uint256).max, "pas de limite avant le pool");
        // blocage de la part et reserve communaute : envoyes avant l'ouverture, sans limite
        require(token.transfer(address(0x7E57), (SUPPLY * UNIT) / 10), "10 % bloques");
        require(token.transfer(address(0x5AFE), (SUPPLY * UNIT * 3) / 100), "3 % reserve");
    }

    function test_FirstTransferToPairStartsLimit() public {
        (MemeToken token, address pair) = _launch();
        vm.warp(1_000_000);
        require(token.transfer(pair, (SUPPLY * UNIT * 87) / 100), "87 % dans le pool");
        require(token.launchedAt() == 1_000_000, "ouverture notee");
        require(token.walletLimit() == (SUPPLY * UNIT) / 200, "0,5 % la premiere heure");
        vm.warp(1_000_000 + 3 hours);
        require(token.transfer(pair, 1), "un second envoi ne change pas l'ouverture");
        require(token.launchedAt() == 1_000_000, "ouverture inchangee");
    }

    function test_LimitStepsThenDisappears() public {
        (MemeToken token, address pair) = _launch();
        vm.warp(1_000_000);
        require(token.transfer(pair, (SUPPLY * UNIT * 87) / 100), "pool");
        uint256 total = SUPPLY * UNIT;

        vm.prank(pair);
        require(token.transfer(BOT, total / 200), "0,5 % pile accepte");
        vm.prank(pair);
        vm.expectRevert(abi.encodeWithSelector(MemeToken.WalletLimit.selector, total / 200));
        token.transfer(BOT, 1);

        vm.warp(1_000_000 + 1 hours);
        require(token.walletLimit() == total / 100, "1 % apres 1 h");
        vm.prank(pair);
        require(token.transfer(BOT, total / 200), "jusqu'a 1 %");
        vm.prank(pair);
        vm.expectRevert(abi.encodeWithSelector(MemeToken.WalletLimit.selector, total / 100));
        token.transfer(BOT, 1);

        vm.warp(1_000_000 + 6 hours);
        require(token.walletLimit() == total / 50, "2 % apres 6 h");
        vm.prank(pair);
        require(token.transfer(BOT, total / 100), "jusqu'a 2 %");
        vm.prank(pair);
        vm.expectRevert(abi.encodeWithSelector(MemeToken.WalletLimit.selector, total / 50));
        token.transfer(BOT, 1);

        vm.warp(1_000_000 + 24 hours - 1);
        require(token.walletLimit() == total / 50, "toujours 2 % juste avant 24 h");
        vm.warp(1_000_000 + 24 hours);
        require(token.walletLimit() == type(uint256).max, "plus de limite apres 24 h");
        vm.prank(pair);
        require(token.transfer(BOT, total / 10), "achat libre apres 24 h");
    }

    function test_LimitAlsoAppliesBetweenWallets() public {
        (MemeToken token, address pair) = _launch();
        require(token.transfer(address(0xA11CE), (SUPPLY * UNIT) / 10), "avant l'ouverture : libre");
        require(token.transfer(pair, (SUPPLY * UNIT * 87) / 100), "pool");
        vm.prank(address(0xA11CE));
        vm.expectRevert(abi.encodeWithSelector(MemeToken.WalletLimit.selector, (SUPPLY * UNIT) / 200));
        token.transfer(BOT, (SUPPLY * UNIT) / 200 + 1);
        // vendre au pool reste toujours possible, quelle que soit la quantite
        vm.prank(address(0xA11CE));
        require(token.transfer(pair, (SUPPLY * UNIT) / 10), "vente au pool libre");
    }

    function test_ReusesPairCreatedByThirdParty() public {
        MockPairFactory factory = new MockPairFactory();
        // adresse du prochain contrat cree par ce test (nonce courant du contrat de test)
        address predicted = _nextAddress(address(this));
        factory.setPair(predicted, WETH, address(0xFA1C));
        MemeToken token = new MemeToken("Test Token", "TEST", SUPPLY, address(factory), WETH);
        require(address(token) == predicted, "prediction");
        require(token.PAIR() == address(0xFA1C), "paire existante reprise, pas de blocage");
    }

    function test_NoFactoryMeansNoLimit() public {
        MemeToken token = _deploy(SUPPLY);
        require(token.PAIR() == address(0), "pas de paire");
        require(token.transfer(BOT, (SUPPLY * UNIT) / 2), "transfert libre");
        require(token.launchedAt() == 0 && token.walletLimit() == type(uint256).max, "jamais de limite");
    }

    function _nextAddress(address deployer) private view returns (address) {
        uint256 nonce = vm.getNonce(deployer);
        require(nonce > 0 && nonce < 128, "nonce hors plage");
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xd6), bytes1(0x94), deployer, uint8(nonce))))));
    }
}
