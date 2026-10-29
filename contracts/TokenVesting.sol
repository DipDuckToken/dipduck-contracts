// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {VestingWallet} from "@openzeppelin/contracts/finance/VestingWallet.sol";
import {VestingWalletCliff} from "@openzeppelin/contracts/finance/VestingWalletCliff.sol";

/// @title TokenVesting
/// @notice Bloque la part de tokens gardée par le créateur et la libère
///         progressivement : rien avant la falaise (cliff), puis une
///         libération linéaire jusqu'à la fin. N'importe qui peut appeler
///         `release(token)`, mais les tokens vont toujours au bénéficiaire.
///         Aucune fonction ne permet de retirer plus tôt, pas même au
///         bénéficiaire.
/// @dev `VestingWalletCliff` d'OpenZeppelin 5.6.1 sans modification, à une
///      exception près : `renounceOwnership` est désactivée. Sans propriétaire,
///      `release` enverrait les tokens à l'adresse 0, ce que l'ERC-20 refuse :
///      la part resterait bloquée pour toujours. Le bénéficiaire peut toujours
///      se faire remplacer par une autre adresse (`transferOwnership`), ce qui
///      ne change ni le calendrier ni les montants.
contract TokenVesting is VestingWalletCliff {
    error RenounceDisabled();

    constructor(
        address beneficiary,
        uint64 startTimestamp,
        uint64 durationSeconds,
        uint64 cliffSeconds
    ) VestingWallet(beneficiary, startTimestamp, durationSeconds) VestingWalletCliff(cliffSeconds) {}

    /// @notice Désactivée : la part serait perdue (voir plus haut).
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }
}
