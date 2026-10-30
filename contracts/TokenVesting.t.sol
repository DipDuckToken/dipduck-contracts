// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {VestingWalletCliff} from "@openzeppelin/contracts/finance/VestingWalletCliff.sol";
import {MemeToken} from "./MemeToken.sol";
import {TokenVesting} from "./TokenVesting.sol";

/// @dev Sous-ensemble des cheatcodes du runner de tests Solidity de Hardhat
///      (compatibles Foundry), déclaré ici pour ne pas dépendre de forge-std.
interface VestingVm {
    function expectRevert(bytes calldata revertData) external;
    function prank(address msgSender) external;
    function assume(bool condition) external;
    function warp(uint256 newTimestamp) external;
}

/// @notice Tests unitaires et de fuzzing du blocage de la part du créateur.
contract TokenVestingTest {
    VestingVm private constant vm = VestingVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant UNIT = 1e18;
    uint256 private constant LOCKED = 50_000_000 * UNIT; // 5 % d'un milliard
    uint64 private constant DAY = 1 days;
    uint64 private constant DURATION = 365 * DAY;
    uint64 private constant CLIFF = 90 * DAY;
    address private constant BENEFICIARY = address(0xBEEF);
    address private constant STRANGER = address(0xCAFE);

    MemeToken private token;
    TokenVesting private vesting;
    uint64 private start;

    function setUp() public {
        vm.warp(1_800_000_000);
        start = uint64(block.timestamp);
        token = new MemeToken("Test Token", "TEST", 1_000_000_000, address(0), address(0), 10_000, 1); // ouvert depuis toujours : transferts libres, sans limite
        vesting = new TokenVesting(BENEFICIARY, start, DURATION, CLIFF);
        token.transfer(address(vesting), LOCKED);
    }

    // --- Calendrier ----------------------------------------------------------

    function test_NothingReleasableBeforeCliff() public {
        vm.warp(start + CLIFF - 1);
        require(vesting.releasable(address(token)) == 0, "rien ne doit etre liberable avant la falaise");
        vm.prank(STRANGER);
        vesting.release(address(token));
        require(token.balanceOf(BENEFICIARY) == 0, "le beneficiaire ne doit rien recevoir");
        require(token.balanceOf(address(vesting)) == LOCKED, "la part doit rester bloquee");
    }

    function test_ReleasesLinearlyFromTheCliff() public {
        vm.warp(start + CLIFF);
        uint256 expected = (LOCKED * CLIFF) / DURATION;
        require(vesting.releasable(address(token)) == expected, "montant liberable a la falaise incorrect");
        vm.prank(STRANGER);
        vesting.release(address(token));
        require(token.balanceOf(BENEFICIARY) == expected, "le beneficiaire doit recevoir la part liberee");
        require(token.balanceOf(STRANGER) == 0, "l'appelant ne doit rien recevoir");
    }

    function test_ReleasesEverythingAtTheEnd() public {
        vm.warp(start + DURATION);
        vesting.release(address(token));
        require(token.balanceOf(BENEFICIARY) == LOCKED, "tout doit etre libere a la fin");
        require(token.balanceOf(address(vesting)) == 0, "le contrat doit etre vide");
    }

    function test_ExposesTheSchedule() public view {
        require(vesting.owner() == BENEFICIARY, "beneficiaire incorrect");
        require(vesting.start() == start, "debut incorrect");
        require(vesting.cliff() == start + CLIFF, "falaise incorrecte");
        require(vesting.end() == start + DURATION, "fin incorrecte");
    }

    // --- Personne ne peut retirer plus tôt -----------------------------------

    function test_RenounceOwnershipIsDisabled() public {
        vm.prank(BENEFICIARY);
        vm.expectRevert(abi.encodeWithSelector(TokenVesting.RenounceDisabled.selector));
        vesting.renounceOwnership();
    }

    function test_OnlyTheBeneficiaryCanHandOverTheBeneficiaryRole() public {
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, STRANGER));
        vesting.transferOwnership(STRANGER);
    }

    function test_RevertsWhenCliffIsLongerThanDuration() public {
        vm.expectRevert(
            abi.encodeWithSelector(VestingWalletCliff.InvalidCliffDuration.selector, DURATION + 1, DURATION)
        );
        new TokenVesting(BENEFICIARY, start, DURATION, DURATION + 1);
    }

    // --- Fuzzing -------------------------------------------------------------

    function testFuzz_VestedAmountIsMonotonicAndBounded(uint64 a, uint64 b) public view {
        uint64 t1 = a < b ? a : b;
        uint64 t2 = a < b ? b : a;
        uint256 v1 = vesting.vestedAmount(address(token), t1);
        uint256 v2 = vesting.vestedAmount(address(token), t2);
        require(v1 <= v2, "le montant libere ne doit jamais diminuer");
        require(v2 <= LOCKED, "jamais plus que la part bloquee");
        if (t2 < start + CLIFF) {
            require(v2 == 0, "rien avant la falaise");
        }
    }

    function testFuzz_ReleaseOnlyEverPaysTheBeneficiary(address caller, uint32 elapsed) public {
        vm.assume(caller != BENEFICIARY && caller != address(vesting) && caller != address(0));
        vm.warp(uint256(start) + elapsed);
        uint256 releasable = vesting.releasable(address(token));
        uint256 callerBefore = token.balanceOf(caller);
        vm.prank(caller);
        vesting.release(address(token));
        require(token.balanceOf(BENEFICIARY) == releasable, "seul le beneficiaire recoit");
        require(token.balanceOf(caller) == callerBefore, "l'appelant ne recoit rien");
        require(
            token.balanceOf(address(vesting)) + token.balanceOf(BENEFICIARY) == LOCKED,
            "aucun token ne doit se perdre"
        );
    }
}
