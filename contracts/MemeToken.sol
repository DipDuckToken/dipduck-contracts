// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IUniswapV3PoolFactory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
}

/// @title MemeToken
/// @notice ERC-20 à offre fixe : la totalité est émise une seule fois, au
///         déploiement, vers l'adresse qui déploie (LAUNCHER, le contrat de lancement).
/// @dev Volontairement minimal. Aucune fonction d'administration n'existe :
///      pas d'owner, pas d'émission après le constructeur, pas de pause,
///      pas de liste noire, pas de taxe. Le contrat n'accepte pas d'ETH
///      (ni receive, ni fallback).
///
///      Pool : le token crée lui-même, au déploiement, son pool Uniswap v3
///      TOKEN/WETH (niveau de frais FEE). Un pool déjà existant est refusé : son
///      prix aurait pu être fixé par quelqu'un d'autre.
///
///      Ouverture à heure fixe (OPEN_AT), figée dans le code :
///      - avant OPEN_AT, seul LAUNCHER peut envoyer des tokens (part bloquée,
///        réserve, liquidité de départ) : personne ne peut acheter, rien ne sort du
///        pool, et aucun autre marché (autre pool, autre plateforme) ne peut
///        s'ouvrir plus tôt ;
///      - pendant les 24 h qui suivent OPEN_AT, un wallet ne peut pas détenir plus
///        de 0,5 % de l'offre (1re heure), puis 1 % (jusqu'à 6 h), puis 2 %
///        (jusqu'à 24 h). Ensuite, plus aucune limite, pour toujours. Le pool et
///        l'adresse morte échappent à la limite ; les envois faits avant OPEN_AT
///        (part bloquée, réserve communauté) n'y sont pas soumis.
///      Personne ne peut ni avancer, ni retarder, ni désactiver ces règles.
///      Avec `factory` = 0 (tests), il n'y a pas de pool : seule la limite s'applique.
///
///      L'offre, exprimée en unités de base (18 décimales), est bornée à
///      type(uint112).max : elle tient dans un uint128 (CW20 en Uint128, Balance
///      Substrate en u128) si le token est un jour ponté par verrouillage.
contract MemeToken is ERC20 {
    /// @dev Adresse morte : les tokens qu'on y envoie sont brûlés, sans limite.
    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @dev 10^18 : une unité entière du token en unités de base.
    uint256 private constant UNIT = 1e18;

    /// @dev Plus grande offre (en tokens entiers) dont la valeur en unités de
    ///      base tient dans un uint112 : floor((2^112 - 1) / 10^18).
    uint256 private constant MAX_WHOLE_TOKENS = type(uint112).max / UNIT;

    /// @notice Durée totale de la limite anti-bot après l'ouverture.
    uint256 public constant LIMIT_DURATION = 24 hours;

    /// @notice Pool Uniswap v3 TOKEN/WETH (0 si aucune factory n'a été donnée).
    address public immutable PAIR;

    /// @notice Contrat qui a déployé le token : seul à pouvoir alimenter le pool avant OPEN_AT.
    address public immutable LAUNCHER;

    /// @notice Heure d'ouverture des échanges ; la limite anti-bot dure 24 h à partir d'ici.
    uint256 public immutable OPEN_AT;

    /// @notice L'offre demandée est nulle ou dépasse la borne uint112.
    /// @param wholeTokens Offre demandée, en tokens entiers.
    error InvalidSupply(uint256 wholeTokens);

    /// @notice Le pool existait déjà avant ce token.
    error PoolAlreadyExists(address pool);

    /// @notice Le destinataire détiendrait plus que la limite anti-bot du moment.
    error WalletLimit(uint256 limit);

    /// @notice Échange avec le pool avant OPEN_AT.
    error PoolNotOpen();

    /// @param name_ Nom du token.
    /// @param symbol_ Symbole (ticker) du token.
    /// @param wholeTokens Offre totale en tokens entiers ; les 18 décimales sont ajoutées ici.
    /// @param factory Factory Uniswap v3 (0 = pas de pool).
    /// @param weth WETH du pool.
    /// @param fee Niveau de frais du pool (ex. 10000 = 1 %).
    /// @param openAt Heure d'ouverture des échanges.
    constructor(
        string memory name_,
        string memory symbol_,
        uint256 wholeTokens,
        address factory,
        address weth,
        uint24 fee,
        uint256 openAt
    ) ERC20(name_, symbol_) {
        if (wholeTokens == 0 || wholeTokens > MAX_WHOLE_TOKENS) {
            revert InvalidSupply(wholeTokens);
        }
        if (factory != address(0)) {
            address existing = IUniswapV3PoolFactory(factory).getPool(address(this), weth, fee);
            if (existing != address(0)) revert PoolAlreadyExists(existing);
            PAIR = IUniswapV3PoolFactory(factory).createPool(address(this), weth, fee);
        }
        LAUNCHER = msg.sender;
        OPEN_AT = openAt;
        _mint(msg.sender, wholeTokens * UNIT);
    }

    /// @notice Solde maximal par wallet en ce moment, en unités de base
    ///         (type(uint256).max quand il n'y a pas de limite).
    function walletLimit() public view returns (uint256) {
        if (block.timestamp < OPEN_AT) return type(uint256).max;
        uint256 elapsed = block.timestamp - OPEN_AT;
        if (elapsed >= LIMIT_DURATION) return type(uint256).max;
        uint256 supply = totalSupply();
        if (elapsed < 1 hours) return supply / 200; // 0,5 %
        if (elapsed < 6 hours) return supply / 100; // 1 %
        return supply / 50; // 2 %
    }

    function _update(address from, address to, uint256 value) internal override {
        // Avant l'ouverture, seul LAUNCHER fait bouger des tokens (répartition et liquidité de
        // départ) : rien ne sort du pool, et personne ne peut ouvrir un autre marché plus tôt.
        if (block.timestamp < OPEN_AT && from != LAUNCHER && from != address(0)) revert PoolNotOpen();
        address pool = PAIR;
        super._update(from, to, value);
        if (to == address(0) || to == DEAD || (to == pool && pool != address(0))) return;
        uint256 limit = walletLimit();
        if (balanceOf(to) > limit) revert WalletLimit(limit);
    }
}
