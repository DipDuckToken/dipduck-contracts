// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title MockPairFactory
/// @notice Factory Uniswap v3 d'essai (tests uniquement) : `createPool` enregistre
///         une adresse de pool fictive, sans déployer de contrat.
contract MockPairFactory {
    mapping(address => mapping(address => mapping(uint24 => address))) public getPool;

    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool) {
        pool = address(uint160(uint256(keccak256(abi.encode(tokenA, tokenB, fee)))));
        getPool[tokenA][tokenB][fee] = pool;
        getPool[tokenB][tokenA][fee] = pool;
    }

    /// @notice Simule un pool créé d'avance par un tiers.
    function setPool(address tokenA, address tokenB, uint24 fee, address pool) external {
        getPool[tokenA][tokenB][fee] = pool;
        getPool[tokenB][tokenA][fee] = pool;
    }
}
