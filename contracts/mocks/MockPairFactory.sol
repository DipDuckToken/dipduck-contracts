// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title MockPairFactory
/// @notice Factory Uniswap v2 d'essai (tests uniquement) : `createPair` enregistre
///         une adresse de paire fictive, sans déployer de contrat.
contract MockPairFactory {
    mapping(address => mapping(address => address)) public getPair;

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        pair = address(uint160(uint256(keccak256(abi.encode(tokenA, tokenB)))));
        getPair[tokenA][tokenB] = pair;
        getPair[tokenB][tokenA] = pair;
    }

    /// @notice Simule une paire créée d'avance par un tiers.
    function setPair(address tokenA, address tokenB, address pair) external {
        getPair[tokenA][tokenB] = pair;
        getPair[tokenB][tokenA] = pair;
    }
}
