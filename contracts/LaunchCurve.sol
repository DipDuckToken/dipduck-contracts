// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {MemeToken} from "./MemeToken.sol";

interface ILaunchPair {
    function totalSupply() external view returns (uint256);
    function mint(address to) external returns (uint256 liquidity);
}

interface ILaunchWETH {
    function deposit() external payable;
}

/// @title LaunchCurve
/// @notice Courbe de lancement (inspirée de pump.fun) : déploie le token et en garde TOUTE
///         l'offre (personne d'autre n'en détient avant les acheteurs), en vend une partie
///         à prix croissant contre de l'ETH, puis, quand la cible d'ETH est atteinte, ouvre
///         TOUT SEUL le pool Uniswap v2 avec cet ETH et le reste des tokens, et brûle les
///         parts LP. Le créateur n'apporte aucun ETH. La part équipe et la réserve communauté
///         partent à l'ouverture du pool vers des adresses fixées au déploiement (blocage, Safe) :
///         avant, aucun token hors des acheteurs ne peut être revendu à la courbe ; si la cible
///         n'est jamais atteinte, elles restent dans la courbe pour toujours.
/// @dev Aucun owner, aucune fonction d'administration, aucun frais, rien de modifiable.
///
///      Prix : produit constant avec des réserves VIRTUELLES. x = VIRTUAL_ETH + ETH reçu,
///      y = VIRTUAL_TOKENS − tokens vendus, x × y >= K = VIRTUAL_ETH × VIRTUAL_TOKENS ; les
///      arrondis vont toujours en faveur de la courbe, qui ne doit donc jamais plus d'ETH
///      qu'elle n'en détient. Le prix de départ vient des réserves virtuelles : un robot paie
///      dès le premier bloc un vrai prix, sans que personne n'ait mis d'ETH réel.
///
///      Vente et rachat : tant que la cible n'est pas atteinte, tout le monde peut acheter
///      (`buy`) et revendre à la courbe (`sell`), au plus les tokens qu'elle a vendus. Pas de
///      date limite : sans cible atteinte, la courbe continue simplement de fonctionner.
///
///      Ouverture du pool (graduation), dans la transaction de l'achat qui atteint la cible :
///      cet achat est plafonné à l'ETH manquant (le surplus est rendu), puis l'ETH reçu et
///      LP_TOKENS tokens vont dans la paire au prix EXACT de fin de courbe (aucun écart à
///      exploiter), et les parts LP vont à l'adresse morte. Le token interdit à toute autre
///      adresse que cette courbe d'envoyer des tokens à la paire avant ce moment : personne
///      ne peut créer le pool avant elle ni fixer son prix. Un don d'ETH, de WETH ou de tokens
///      ne peut pas bloquer l'ouverture (les tokens donnés à la courbe sont brûlés, le WETH
///      donné à la paire s'ajoute au pool aux frais du donateur).
///
///      Anti-bot : ouverture à une heure annoncée (OPEN_AT), puis pendant 24 h un wallet ne
///      peut pas détenir plus de 0,5 % de l'offre (1re heure), 1 % (jusqu'à 6 h), 2 % (jusqu'à
///      24 h). Après l'ouverture du pool, le token applique à son tour ses propres 24 h de
///      limite. Achat et revente ont un minimum reçu et une date limite (anti-sandwich).
contract LaunchCurve is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @notice Destinataire des parts LP et des tokens en trop : personne n'en a la clé.
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @notice Durée de la limite par wallet après OPEN_AT.
    uint256 public constant LIMIT_DURATION = 24 hours;

    /// @dev 10^18 : une unité entière du token en unités de base.
    uint256 private constant UNIT = 1e18;

    MemeToken public immutable TOKEN;
    address public immutable PAIR;
    address public immutable WETH;
    /// @notice Heure d'ouverture des achats.
    uint256 public immutable OPEN_AT;
    /// @notice Réserve d'ETH virtuelle (fixe le prix de départ).
    uint256 public immutable VIRTUAL_ETH;
    /// @notice Réserve de tokens virtuelle.
    uint256 public immutable VIRTUAL_TOKENS;
    /// @notice ETH à réunir pour ouvrir le pool.
    uint256 public immutable TARGET_ETH;
    /// @notice Tokens vendus par la courbe jusqu'à la cible.
    uint256 public immutable CURVE_TOKENS;
    /// @notice Tokens mis dans le pool avec TARGET_ETH, au prix de fin de courbe.
    uint256 public immutable LP_TOKENS;
    /// @notice Contrat de blocage de la part équipe, et cette part (versée à l'ouverture du pool).
    address public immutable VESTING;
    uint256 public immutable VESTING_TOKENS;
    /// @notice Safe de la réserve communauté, et cette réserve (versée à l'ouverture du pool).
    address public immutable COMMUNITY;
    uint256 public immutable COMMUNITY_TOKENS;

    /// @notice ETH reçu par la courbe (net des reventes).
    uint256 public ethReserve;
    /// @notice Tokens vendus par la courbe (net des reventes).
    uint256 public tokensSold;
    /// @notice Pool ouvert : la courbe est fermée pour toujours.
    bool public graduated;

    event Bought(address indexed buyer, uint256 ethIn, uint256 tokensOut, uint256 ethReserve, uint256 tokensSold);
    event Sold(address indexed seller, uint256 tokensIn, uint256 ethOut, uint256 ethReserve, uint256 tokensSold);
    event Graduated(address indexed pair, uint256 ethAmount, uint256 tokenAmount, uint256 liquidityBurned, uint256 tokensBurned);

    error InvalidParams();
    error NotOpen();
    error AlreadyGraduated();
    error Expired();
    error ZeroAmount();
    error Slippage();
    error TooManyTokens(uint256 max);
    error WalletLimit(uint256 limit);
    error EthTransferFailed();

    /// @notice Paramètres du lancement (montants de tokens en tokens ENTIERS, ETH en wei).
    /// @param supply Offre totale.
    /// @param vesting Contrat de blocage de la part équipe (déjà déployé), 0 si aucune part.
    /// @param vestingTokens Part équipe, versée au blocage à l'ouverture du pool.
    /// @param community Safe de la réserve communauté, 0 si aucune réserve.
    /// @param communityTokens Réserve communauté, versée au Safe à l'ouverture du pool.
    /// @param virtualEth Réserve d'ETH virtuelle.
    /// @param targetEth ETH à réunir pour ouvrir le pool.
    /// @param openAt Heure d'ouverture des achats (dans le futur, à 30 jours au plus).
    /// @param factory Factory Uniswap v2.
    /// @param weth WETH de la paire.
    struct Config {
        uint256 supply;
        address vesting;
        uint256 vestingTokens;
        address community;
        uint256 communityTokens;
        uint256 virtualEth;
        uint256 targetEth;
        uint256 openAt;
        address factory;
        address weth;
    }

    /// @param name_ Nom du token.
    /// @param symbol_ Symbole du token.
    /// @param c Paramètres du lancement ; la courbe vend et met en pool supply − vestingTokens − communityTokens.
    constructor(string memory name_, string memory symbol_, Config memory c) {
        if (
            c.virtualEth == 0 || c.targetEth == 0 || c.virtualEth > 1e6 ether || c.targetEth > 1e6 ether
                || c.openAt <= block.timestamp || c.openAt > block.timestamp + 30 days || c.factory.code.length == 0
                || c.weth.code.length == 0 || c.vestingTokens + c.communityTokens >= c.supply
                || (c.vestingTokens > 0 && c.vesting.code.length == 0)
                || (c.communityTokens > 0 && c.community.code.length == 0)
                || (c.vestingTokens > 0 && c.vesting == c.community)
        ) revert InvalidParams();

        // Le token est déployé ici, toute l'offre à la courbe : elle est son LAUNCHER, seule à
        // pouvoir ouvrir le pool, et personne d'autre ne détient de token avant les acheteurs.
        MemeToken token = new MemeToken(name_, symbol_, c.supply, c.factory, c.weth);
        address pair = token.PAIR();
        if (pair == address(0)) revert InvalidParams();
        (uint256 y, uint256 sold, uint256 lp) =
            _reserves((c.supply - c.vestingTokens - c.communityTokens) * UNIT, c.virtualEth, c.targetEth);

        TOKEN = token;
        PAIR = pair;
        WETH = c.weth;
        OPEN_AT = c.openAt;
        VIRTUAL_ETH = c.virtualEth;
        VIRTUAL_TOKENS = y;
        TARGET_ETH = c.targetEth;
        CURVE_TOKENS = sold;
        LP_TOKENS = lp;
        VESTING = c.vesting;
        VESTING_TOKENS = c.vestingTokens * UNIT;
        COMMUNITY = c.community;
        COMMUNITY_TOKENS = c.communityTokens * UNIT;
    }

    /// @dev Réserves virtuelles telles que les tokens vendus jusqu'à la cible, plus ceux du pool
    ///      au prix de fin de courbe, fassent exactement la part confiée `p` (à l'arrondi près) :
    ///      vendus = Y × E / (V + E), pool = E × (Y − vendus) / (V + E) = Y × E × V / (V + E)².
    ///      Au moins 10^6 unités de token par wei de la cible : aucun achat ne reçoit 0 token
    ///      avant la cible, et K = V × Y tient toujours dans 256 bits.
    function _reserves(uint256 p, uint256 v, uint256 e) private pure returns (uint256 y, uint256 sold, uint256 lp) {
        if (p / e < 1e6) revert InvalidParams();
        y = Math.mulDiv(p, (v + e) * (v + e), e * (2 * v + e));
        if (y > type(uint256).max / v) revert InvalidParams();
        sold = y - Math.ceilDiv(v * y, v + e);
        lp = Math.mulDiv(e, y - sold, v + e);
        if (sold == 0 || lp == 0 || sold + lp > p || lp > type(uint112).max) revert InvalidParams();
    }

    // --- Lecture -------------------------------------------------------------------------

    /// @notice Solde maximal par wallet acheteur en ce moment (type(uint256).max = aucune limite).
    function walletLimit() public view returns (uint256) {
        if (block.timestamp < OPEN_AT) return 0;
        uint256 elapsed = block.timestamp - OPEN_AT;
        if (elapsed >= LIMIT_DURATION) return type(uint256).max;
        uint256 supply = TOKEN.totalSupply();
        if (elapsed < 1 hours) return supply / 200; // 0,5 %
        if (elapsed < 6 hours) return supply / 100; // 1 %
        return supply / 50; // 2 %
    }

    /// @notice Tokens reçus et ETH réellement utilisé pour un achat de `ethIn` (le reste est
    ///         rendu si l'achat atteint la cible). Ne tient pas compte de la limite par wallet.
    function quoteBuy(uint256 ethIn) public view returns (uint256 tokensOut, uint256 ethUsed) {
        if (graduated) return (0, 0);
        uint256 room = TARGET_ETH - ethReserve;
        if (ethIn >= room) return (CURVE_TOKENS - tokensSold, room);
        uint256 y = VIRTUAL_TOKENS - tokensSold;
        uint256 newY = Math.ceilDiv(VIRTUAL_ETH * VIRTUAL_TOKENS, VIRTUAL_ETH + ethReserve + ethIn);
        return (y - newY, ethIn);
    }

    /// @notice ETH reçu pour la revente de `tokensIn` (au plus `tokensSold`).
    function quoteSell(uint256 tokensIn) public view returns (uint256 ethOut) {
        if (graduated || tokensIn > tokensSold) return 0;
        uint256 newY = VIRTUAL_TOKENS - tokensSold + tokensIn;
        uint256 newX = Math.ceilDiv(VIRTUAL_ETH * VIRTUAL_TOKENS, newY);
        return VIRTUAL_ETH + ethReserve - newX;
    }

    /// @notice Prix marginal actuel en wei par token entier.
    function price() external view returns (uint256) {
        return Math.mulDiv(VIRTUAL_ETH + ethReserve, UNIT, VIRTUAL_TOKENS - tokensSold);
    }

    // --- Achat et revente ----------------------------------------------------------------

    /// @notice Achète des tokens avec tout l'ETH envoyé (plafonné à l'ETH manquant pour la
    ///         cible : le surplus est rendu). Les tokens vont à l'appelant.
    /// @param minTokensOut Minimum de tokens accepté (protection contre le sandwich).
    /// @param deadline Heure au-delà de laquelle l'achat est refusé.
    function buy(uint256 minTokensOut, uint256 deadline) external payable nonReentrant returns (uint256 tokensOut) {
        if (block.timestamp < OPEN_AT) revert NotOpen();
        if (graduated) revert AlreadyGraduated();
        if (block.timestamp > deadline) revert Expired();
        if (msg.value == 0) revert ZeroAmount();

        uint256 ethUsed;
        (tokensOut, ethUsed) = quoteBuy(msg.value);
        if (tokensOut == 0 || tokensOut < minTokensOut) revert Slippage();
        uint256 limit = walletLimit();
        if (limit != type(uint256).max && TOKEN.balanceOf(msg.sender) + tokensOut > limit) revert WalletLimit(limit);

        ethReserve += ethUsed;
        tokensSold += tokensOut;
        IERC20(address(TOKEN)).safeTransfer(msg.sender, tokensOut);
        emit Bought(msg.sender, ethUsed, tokensOut, ethReserve, tokensSold);

        if (ethReserve == TARGET_ETH) _graduate();
        if (msg.value > ethUsed) _sendEth(msg.sender, msg.value - ethUsed);
    }

    /// @notice Revend des tokens à la courbe (autorisation `approve` préalable).
    /// @param tokensIn Tokens revendus, au plus `tokensSold`.
    /// @param minEthOut Minimum d'ETH accepté (protection contre le sandwich).
    /// @param deadline Heure au-delà de laquelle la revente est refusée.
    function sell(uint256 tokensIn, uint256 minEthOut, uint256 deadline) external nonReentrant returns (uint256 ethOut) {
        if (block.timestamp < OPEN_AT) revert NotOpen();
        if (graduated) revert AlreadyGraduated();
        if (block.timestamp > deadline) revert Expired();
        if (tokensIn == 0) revert ZeroAmount();
        if (tokensIn > tokensSold) revert TooManyTokens(tokensSold);

        ethOut = quoteSell(tokensIn);
        if (ethOut == 0 || ethOut < minEthOut) revert Slippage();

        ethReserve -= ethOut;
        tokensSold -= tokensIn;
        IERC20(address(TOKEN)).safeTransferFrom(msg.sender, address(this), tokensIn);
        emit Sold(msg.sender, tokensIn, ethOut, ethReserve, tokensSold);
        _sendEth(msg.sender, ethOut);
    }

    // --- Ouverture du pool ---------------------------------------------------------------

    /// @dev Toute la cible est réunie : le pool s'ouvre au prix exact de fin de courbe.
    function _graduate() private {
        graduated = true;
        IERC20 token = IERC20(address(TOKEN));
        // Part équipe, réserve communauté, puis tokens en trop (arrondis, dons) brûlés : tout part
        // AVANT l'ouverture, quand le token n'a encore aucune limite par wallet (sinon un gros
        // envoi pourrait bloquer l'ouverture).
        if (VESTING_TOKENS > 0) token.safeTransfer(VESTING, VESTING_TOKENS);
        if (COMMUNITY_TOKENS > 0) token.safeTransfer(COMMUNITY, COMMUNITY_TOKENS);
        uint256 extra = token.balanceOf(address(this)) - LP_TOKENS;
        if (extra > 0) token.safeTransfer(DEAD, extra);

        uint256 eth = ethReserve;
        ILaunchWETH(WETH).deposit{value: eth}();
        IERC20(WETH).safeTransfer(PAIR, eth);
        token.safeTransfer(PAIR, LP_TOKENS); // ouvre le pool côté token (seule la courbe le peut)
        uint256 liquidity = ILaunchPair(PAIR).mint(DEAD);
        emit Graduated(PAIR, eth, LP_TOKENS, liquidity, extra);
    }

    function _sendEth(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }
}
