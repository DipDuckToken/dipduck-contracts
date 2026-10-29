// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IUniswapV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
    function createPair(address tokenA, address tokenB) external returns (address pair);
}

interface IUniswapV2Pair {
    function totalSupply() external view returns (uint256);
    function mint(address to) external returns (uint256 liquidity);
}

interface IWETH {
    function deposit() external payable;
}

/// @title PoolSeeder
/// @notice Ouvre un pool Uniswap v2 TOKEN/WETH en une seule transaction et
///         émet toutes les parts LP directement vers l'adresse morte.
/// @dev Fait exactement ce que fait le routeur Uniswap pour un premier dépôt
///      (tokens et WETH envoyés à la paire, puis `mint`), mais d'un seul bloc :
///      - personne ne peut s'intercaler entre les transferts et le `mint` ;
///      - un don de WETH fait à la paire avant le lancement, synchronisé ou non,
///        ne bloque pas le dépôt : il s'ajoute au pool. Comme il relève le prix
///        de départ, l'appelant fixe le maximum de WETH qu'il accepte de
///        trouver déjà dans la paire (`maxPairWeth`) ;
///      - le dépôt est refusé si des parts LP existent déjà, car alors ce
///        n'est plus ce dépôt qui fixe le prix.
///      Aucun owner, aucun état modifiable ; le contrat ne garde jamais ni
///      token, ni WETH, ni ETH, ni part LP.
contract PoolSeeder {
    using SafeERC20 for IERC20;

    /// @notice Destinataire des parts LP : personne n'en possède la clé.
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    IUniswapV2Factory public immutable FACTORY;
    address public immutable WETH;

    /// @notice Le pool a été ouvert et toutes les parts LP créées ont été brûlées.
    event PoolSeeded(
        address indexed token,
        address indexed pair,
        address indexed seeder,
        uint256 tokenAmount,
        uint256 ethAmount,
        uint256 liquidityBurned
    );

    /// @notice Des parts LP existent déjà pour cette paire.
    error PoolAlreadySeeded(address pair);

    /// @notice La paire contient déjà plus de WETH (dons) que l'appelant n'en accepte.
    error DonationAboveLimit(uint256 pairWeth, uint256 maxPairWeth);

    /// @notice Le montant de tokens ou d'ETH est nul.
    error ZeroAmount();

    constructor(IUniswapV2Factory factory, address weth) {
        FACTORY = factory;
        WETH = weth;
    }

    /// @notice Crée la paire si besoin, y dépose `tokenAmount` tokens (pris à
    ///         l'appelant, qui doit avoir autorisé ce contrat) et tout l'ETH
    ///         envoyé, puis brûle les parts LP.
    /// @param maxPairWeth WETH déjà présent dans la paire (dons de tiers) au-delà
    ///        duquel le dépôt est refusé, car le prix de départ serait plus haut
    ///        que prévu.
    function seed(IERC20 token, uint256 tokenAmount, uint256 maxPairWeth)
        external
        payable
        returns (address pair, uint256 liquidity)
    {
        if (tokenAmount == 0 || msg.value == 0) {
            revert ZeroAmount();
        }

        pair = FACTORY.getPair(address(token), WETH);
        if (pair == address(0)) {
            pair = FACTORY.createPair(address(token), WETH);
        }
        if (IUniswapV2Pair(pair).totalSupply() != 0) {
            revert PoolAlreadySeeded(pair);
        }
        uint256 pairWeth = IERC20(WETH).balanceOf(pair);
        if (pairWeth > maxPairWeth) {
            revert DonationAboveLimit(pairWeth, maxPairWeth);
        }

        token.safeTransferFrom(msg.sender, pair, tokenAmount);
        IWETH(WETH).deposit{value: msg.value}();
        IERC20(WETH).safeTransfer(pair, msg.value);
        liquidity = IUniswapV2Pair(pair).mint(DEAD);

        emit PoolSeeded(address(token), pair, msg.sender, tokenAmount, msg.value, liquidity);
    }
}
