// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title MockAggregator
/// @notice Flux de prix d'essai au format Chainlink AggregatorV3 (8 décimales), avec historique
///         des rounds (`getRoundData`) et phases (roundId = phaseId << 64 | numéro), pour les
///         tests et le testnet uniquement : n'importe qui peut publier un prix. Jamais sur le mainnet.
contract MockAggregator {
    uint8 public constant decimals = 8;

    struct Round {
        int256 answer;
        uint256 updatedAt;
    }

    mapping(uint80 roundId => Round) private _rounds;
    uint80 public latestRound;
    uint16 public phaseId;

    error NoDataPresent();

    /// @notice Premier round (phase 1, numéro 1) publié maintenant.
    constructor(int256 answer) {
        phaseId = 1;
        _publish((uint80(1) << 64) | 1, answer, block.timestamp);
    }

    /// @notice Publie un nouveau round dans la phase courante ; `updatedAt` = 0 pour maintenant.
    function setAnswer(int256 answer, uint256 updatedAt) external {
        _publish(latestRound + 1, answer, updatedAt == 0 ? block.timestamp : updatedAt);
    }

    /// @notice Change d'agrégateur : le round suivant est le n° 1 de la phase suivante.
    function newPhase(int256 answer, uint256 updatedAt) external {
        phaseId += 1;
        _publish((uint80(phaseId) << 64) | 1, answer, updatedAt == 0 ? block.timestamp : updatedAt);
    }

    function _publish(uint80 id, int256 answer, uint256 updatedAt) private {
        _rounds[id] = Round(answer, updatedAt);
        latestRound = id;
    }

    function getRoundData(uint80 roundId)
        public
        view
        returns (uint80 id, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        Round memory r = _rounds[roundId];
        if (r.updatedAt == 0) revert NoDataPresent(); // comme le proxy Chainlink
        return (roundId, r.answer, r.updatedAt, r.updatedAt, roundId);
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return getRoundData(latestRound);
    }
}
