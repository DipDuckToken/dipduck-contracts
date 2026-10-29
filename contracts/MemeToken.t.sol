// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {MemeToken} from "./MemeToken.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

/// @dev Sous-ensemble des cheatcodes du runner de tests Solidity de Hardhat
///      (compatibles Foundry), déclaré ici pour ne pas dépendre de forge-std.
interface Vm {
    function expectRevert(bytes calldata revertData) external;
    function prank(address msgSender) external;
    function assume(bool condition) external;
}

/// @notice Tests unitaires et de fuzzing du token. Toute fonction `test*`
///         est exécutée ; celles qui prennent des paramètres sont fuzzées.
contract MemeTokenTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant UNIT = 1e18;
    uint256 private constant MAX_WHOLE_TOKENS = type(uint112).max / UNIT;
    uint256 private constant SUPPLY = 1_000_000_000;

    function _deploy(uint256 wholeTokens) private returns (MemeToken) {
        return new MemeToken("Test Token", "TEST", wholeTokens);
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
}
