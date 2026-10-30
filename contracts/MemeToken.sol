// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IUniswapV2PairFactory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
    function createPair(address tokenA, address tokenB) external returns (address pair);
}

/// @title MemeToken
/// @notice ERC-20 à offre fixe : la totalité est émise une seule fois, au
///         déploiement, vers l'adresse qui déploie.
/// @dev Volontairement minimal. Aucune fonction d'administration n'existe :
///      pas d'owner, pas d'émission après le constructeur, pas de pause,
///      pas de liste noire, pas de taxe. Le contrat n'accepte pas d'ETH
///      (ni receive, ni fallback).
///
///      Anti-bot, figé dans le code et sans exception possible : pendant les
///      24 h qui suivent l'ouverture du pool, un wallet ne peut pas détenir plus
///      de 0,5 % de l'offre (1re heure), puis 1 % (jusqu'à 6 h), puis 2 %
///      (jusqu'à 24 h). Ensuite, plus aucune limite, pour toujours.
///      L'ouverture du pool est le premier transfert de tokens vers la paire
///      TOKEN/WETH, créée (ou retrouvée) au déploiement. Seule la paire échappe
///      à la limite ; les envois faits avant l'ouverture (blocage de la part,
///      réserve communauté) n'y sont pas soumis. Personne ne peut ni prolonger,
///      ni raccourcir, ni désactiver cette limite.
///      Avec `factory` = 0 (testnet sans Uniswap, tests), il n'y a pas de paire :
///      la limite ne s'active jamais.
///
///      Ouverture réservée : avant l'ouverture, seul LAUNCHER (le contrat qui a
///      déployé le token, normalement la courbe de lancement) peut envoyer des
///      tokens à la paire. Personne ne peut donc ajouter de liquidité à la paire
///      avant la courbe, ni fixer le prix de départ du pool à sa place.
///
///      L'offre, exprimée en unités de base (18 décimales), est bornée à
///      type(uint112).max : c'est la taille des réserves d'une paire Uniswap v2,
///      donc toute l'offre peut entrer dans le pool et en ressortir. Cette borne
///      tient aussi dans un uint128 (CW20 en Uint128, Balance Substrate en u128)
///      si le token est un jour ponté par verrouillage (lock-and-mint).
contract MemeToken is ERC20 {
    /// @dev Adresse morte : les tokens qu'on y envoie sont brûlés, sans limite.
    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @dev 10^18 : une unité entière du token en unités de base.
    uint256 private constant UNIT = 1e18;

    /// @dev Plus grande offre (en tokens entiers) dont la valeur en unités de
    ///      base tient dans un uint112 : floor((2^112 - 1) / 10^18).
    uint256 private constant MAX_WHOLE_TOKENS = type(uint112).max / UNIT;

    /// @notice Durée totale de la limite anti-bot après l'ouverture du pool.
    uint256 public constant LIMIT_DURATION = 24 hours;

    /// @notice Paire Uniswap v2 TOKEN/WETH (0 si aucune factory n'a été donnée).
    address public immutable PAIR;

    /// @notice Seule adresse qui peut ouvrir le pool : celle qui a déployé le token.
    address public immutable LAUNCHER;

    /// @notice Heure d'ouverture du pool (0 tant qu'il n'est pas ouvert).
    uint256 public launchedAt;

    /// @notice L'offre demandée est nulle ou dépasse la borne uint112.
    /// @param wholeTokens Offre demandée, en tokens entiers.
    error InvalidSupply(uint256 wholeTokens);

    /// @notice Le destinataire détiendrait plus que la limite anti-bot du moment.
    error WalletLimit(uint256 limit);

    /// @notice Envoi vers la paire avant son ouverture, par une autre adresse que LAUNCHER.
    error PoolNotOpen();

    /// @notice Le pool vient d'être ouvert : la limite anti-bot démarre.
    event Launched(uint256 timestamp);

    /// @param name_ Nom du token.
    /// @param symbol_ Symbole (ticker) du token.
    /// @param wholeTokens Offre totale en tokens entiers ; les 18 décimales
    ///        sont ajoutées ici.
    /// @param factory Factory Uniswap v2 (0 = pas de paire, pas de limite).
    /// @param weth WETH de la paire.
    constructor(string memory name_, string memory symbol_, uint256 wholeTokens, address factory, address weth)
        ERC20(name_, symbol_)
    {
        if (wholeTokens == 0 || wholeTokens > MAX_WHOLE_TOKENS) {
            revert InvalidSupply(wholeTokens);
        }
        if (factory != address(0)) {
            // Une paire créée d'avance par un tiers (l'adresse du token est prévisible)
            // est simplement reprise : elle est vide, et la courbe (LAUNCHER) gère les dons.
            address pair = IUniswapV2PairFactory(factory).getPair(address(this), weth);
            PAIR = pair != address(0) ? pair : IUniswapV2PairFactory(factory).createPair(address(this), weth);
        }
        LAUNCHER = msg.sender;
        _mint(msg.sender, wholeTokens * UNIT);
    }

    /// @notice Solde maximal par wallet en ce moment, en unités de base
    ///         (type(uint256).max quand il n'y a pas de limite).
    function walletLimit() public view returns (uint256) {
        uint256 start = launchedAt;
        if (start == 0) return type(uint256).max;
        uint256 elapsed = block.timestamp - start;
        if (elapsed >= LIMIT_DURATION) return type(uint256).max;
        uint256 supply = totalSupply();
        if (elapsed < 1 hours) return supply / 200; // 0,5 %
        if (elapsed < 6 hours) return supply / 100; // 1 %
        return supply / 50; // 2 %
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (to == PAIR) {
            if (launchedAt == 0 && to != address(0)) {
                if (from != LAUNCHER) revert PoolNotOpen();
                launchedAt = block.timestamp;
                emit Launched(block.timestamp);
            }
            return;
        }
        uint256 limit = walletLimit();
        if (to != address(0) && to != DEAD && balanceOf(to) > limit) revert WalletLimit(limit);
    }
}
