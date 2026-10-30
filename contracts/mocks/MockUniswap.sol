// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title MockWETH
/// @notice WETH d'essai (tests uniquement).
contract MockWETH is ERC20("Wrapped Ether", "WETH") {
    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }
}

/// @title MockUniPair
/// @notice Paire d'essai (tests uniquement) : `mint` et `sync` comme Uniswap v2 (premier
///         dépôt : sqrt(a × b) − 1000), sans échange.
contract MockUniPair {
    address public immutable token0;
    address public immutable token1;
    uint256 public totalSupply;
    uint256 public reserve0;
    uint256 public reserve1;
    mapping(address => uint256) public balanceOf;

    constructor(address a, address b) {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }

    function mint(address to) external returns (uint256 liquidity) {
        uint256 b0 = IERC20(token0).balanceOf(address(this));
        uint256 b1 = IERC20(token1).balanceOf(address(this));
        uint256 a0 = b0 - reserve0;
        uint256 a1 = b1 - reserve1;
        if (totalSupply == 0) {
            liquidity = Math.sqrt(a0 * a1) - 1000;
            totalSupply = 1000;
            balanceOf[address(0)] = 1000;
        } else {
            liquidity = Math.min(a0 * totalSupply / reserve0, a1 * totalSupply / reserve1);
        }
        require(liquidity > 0, "INSUFFICIENT_LIQUIDITY_MINTED");
        totalSupply += liquidity;
        balanceOf[to] += liquidity;
        (reserve0, reserve1) = (b0, b1);
    }

    function sync() external {
        reserve0 = IERC20(token0).balanceOf(address(this));
        reserve1 = IERC20(token1).balanceOf(address(this));
    }
}

/// @title MockUniFactory
/// @notice Factory d'essai (tests uniquement) qui déploie de vraies paires `MockUniPair`.
contract MockUniFactory {
    mapping(address => mapping(address => address)) public getPair;

    function createPair(address a, address b) external returns (address pair) {
        require(getPair[a][b] == address(0), "PAIR_EXISTS");
        pair = address(new MockUniPair(a, b));
        getPair[a][b] = pair;
        getPair[b][a] = pair;
    }
}
