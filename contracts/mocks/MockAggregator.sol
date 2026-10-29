// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title MockAggregator
/// @notice Flux de prix d'essai au format Chainlink AggregatorV3 (8 décimales), pour les tests
///         et le testnet uniquement : n'importe qui peut changer le prix. Jamais sur le mainnet.
contract MockAggregator {
    uint8 public constant decimals = 8;

    int256 private _answer;
    /// @dev 0 = « toujours frais » : `latestRoundData` rend l'horodatage du bloc.
    uint256 private _updatedAt;
    uint80 private _round;

    constructor(int256 answer) {
        _answer = answer;
        _round = 1;
    }

    /// @notice Change le prix ; `updatedAt` = 0 pour un prix toujours frais.
    function setAnswer(int256 answer, uint256 updatedAt) external {
        _answer = answer;
        _updatedAt = updatedAt;
        ++_round;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        uint256 at = _updatedAt == 0 ? block.timestamp : _updatedAt;
        return (_round, _answer, at, at, _round);
    }
}
