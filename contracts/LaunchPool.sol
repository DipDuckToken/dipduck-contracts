// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {MemeToken} from "./MemeToken.sol";

interface ILaunchV3Pool {
    function initialize(uint160 sqrtPriceX96) external;
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
    function token0() external view returns (address);
}

interface ILaunchPositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function factory() external view returns (address);
    function WETH9() external view returns (address);
    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);
}

/// @title LaunchPool
/// @notice Lancement sur Uniswap v3, sans ETH apporté : déploie le token, crée son pool
///         TOKEN/WETH à 1 % de frais, et y place la part des acheteurs D'UN SEUL CÔTÉ (que des
///         tokens), à partir d'un prix de départ choisi et jusqu'à l'infini. Chaque achat fait
///         monter le prix, l'ETH des acheteurs reste dans le pool, et chacun peut revendre à tout
///         moment. Le pool est un vrai pool Uniswap : visible et échangeable partout dès OPEN_AT.
/// @dev Aucun owner, aucune fonction d'administration, rien de modifiable.
///
///      Liquidité verrouillée à vie : la position Uniswap (le NFT, « clé » du pool) reste dans
///      ce contrat, qui n'a AUCUNE fonction pour la retirer, la réduire ou la transférer.
///      Seuls les frais d'échange de la position peuvent en sortir, avec `collectFees`, que
///      n'importe qui peut appeler, et toujours partagés de la même façon (fixée au déploiement) :
///      TEAM_FEE_PERCENT % vers TEAM_FEE_RECIPIENT (Safe de l'équipe), le reste vers
///      FEE_RECIPIENT (Safe communauté).
///
///      Pool impossible à piéger : le token est créé avec CREATE2 et un sel inconnu avant la
///      transaction, et il crée lui-même son pool ; un pool déjà existant est refusé (le token
///      revert). Le pool est initialisé ici au prix de départ, puis la position est placée dans
///      la même transaction. Avant OPEN_AT, le token interdit tout achat et tout autre dépôt.
///
///      Répartition, toute faite au déploiement (avant OPEN_AT, donc hors limite anti-bot) :
///      part équipe vers le contrat de blocage, réserve vers le Safe communauté, le reste dans
///      la position. Les arrondis de la position sont brûlés.
contract LaunchPool {
    using SafeERC20 for IERC20;

    /// @notice Destinataire des tokens en trop : personne n'en a la clé.
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    /// @notice Niveau de frais du pool (1 %) et son espacement de ticks.
    uint24 public constant FEE = 10_000;
    int24 public constant TICK_SPACING = 200;
    /// @dev Tick extrême utilisable avec cet espacement (887272 arrondi à 200).
    int24 private constant MAX_TICK = 887_200;

    /// @notice Part des frais d'échange versée à l'équipe ; le reste va à la communauté.
    uint256 public constant TEAM_FEE_PERCENT = 40;

    /// @dev 10^18 : une unité entière du token en unités de base.
    uint256 private constant UNIT = 1e18;

    MemeToken public immutable TOKEN;
    address public immutable POOL;
    address public immutable WETH;
    ILaunchPositionManager public immutable POSITION_MANAGER;
    /// @notice Numéro de la position Uniswap (NFT), gardée ici pour toujours.
    uint256 public immutable POSITION_ID;
    /// @notice Tokens placés dans la position.
    uint256 public immutable POOL_TOKENS;
    /// @notice Heure d'ouverture des échanges.
    uint256 public immutable OPEN_AT;
    /// @notice Prix de départ : tick du prix « WETH par token » (tick ≈ log1,0001(prix)).
    int24 public immutable START_TICK;
    /// @notice Reçoit 60 % des frais d'échange de la position (WETH et tokens) : Safe communauté.
    address public immutable FEE_RECIPIENT;
    /// @notice Reçoit 40 % des frais d'échange de la position : Safe de l'équipe.
    address public immutable TEAM_FEE_RECIPIENT;
    address public immutable VESTING;
    uint256 public immutable VESTING_TOKENS;
    address public immutable COMMUNITY;
    uint256 public immutable COMMUNITY_TOKENS;

    event Launched(address indexed token, address indexed pool, uint256 positionId, uint256 poolTokens, int24 startTick);
    event FeesCollected(uint256 amount0, uint256 amount1, uint256 team0, uint256 team1);

    error InvalidParams();

    /// @notice Paramètres du lancement (montants de tokens en tokens ENTIERS).
    /// @param supply Offre totale.
    /// @param vesting Contrat de blocage de la part équipe (déjà déployé), 0 si aucune part.
    /// @param vestingTokens Part équipe.
    /// @param community Safe de la réserve communauté, 0 si aucune réserve.
    /// @param communityTokens Réserve communauté.
    /// @param feeRecipient Reçoit 60 % des frais d'échange de la position (le Safe communauté).
    /// @param teamFeeRecipient Reçoit 40 % des frais d'échange (le Safe de l'équipe).
    /// @param startTick Prix de départ en tick « WETH par token », multiple de 200 (le prix de
    ///        départ par token vaut 1,0001^startTick ETH ; ex. −195 600 ≈ 3,2e-9 ETH).
    /// @param openAt Heure d'ouverture des échanges (dans le futur, à 30 jours au plus).
    /// @param positionManager NonfungiblePositionManager d'Uniswap v3 (sa factory et son WETH sont lus).
    struct Config {
        uint256 supply;
        address vesting;
        uint256 vestingTokens;
        address community;
        uint256 communityTokens;
        address feeRecipient;
        address teamFeeRecipient;
        int24 startTick;
        uint256 openAt;
        address positionManager;
    }

    /// @param name_ Nom du token.
    /// @param symbol_ Symbole du token.
    /// @param c Paramètres du lancement.
    /// @param salt Sel CREATE2 du token : gardé secret jusqu'à la diffusion de la transaction.
    constructor(string memory name_, string memory symbol_, Config memory c, bytes32 salt) {
        if (
            c.openAt <= block.timestamp || c.openAt > block.timestamp + 30 days
                || c.positionManager.code.length == 0 || c.feeRecipient.code.length == 0
                || c.teamFeeRecipient.code.length == 0 || c.teamFeeRecipient == c.feeRecipient
                || c.vestingTokens + c.communityTokens >= c.supply
                || (c.vestingTokens > 0 && c.vesting.code.length == 0)
                || (c.communityTokens > 0 && c.community.code.length == 0)
                || (c.vestingTokens > 0 && c.vesting == c.community)
                || c.startTick % TICK_SPACING != 0 || c.startTick <= -MAX_TICK + TICK_SPACING || c.startTick >= 0
        ) revert InvalidParams();

        ILaunchPositionManager npm = ILaunchPositionManager(c.positionManager);
        address weth = npm.WETH9();
        MemeToken token =
            new MemeToken{salt: salt}(name_, symbol_, c.supply, npm.factory(), weth, FEE, c.openAt);
        address pool = token.PAIR();

        // Part équipe et réserve, avant OPEN_AT (hors limite anti-bot).
        IERC20 t = IERC20(address(token));
        uint256 vestingAmount = c.vestingTokens * UNIT;
        uint256 communityAmount = c.communityTokens * UNIT;
        if (vestingAmount > 0) t.safeTransfer(c.vesting, vestingAmount);
        if (communityAmount > 0) t.safeTransfer(c.community, communityAmount);

        (uint256 id, uint256 used) = _placeLiquidity(npm, address(token), weth, pool, c.startTick);

        TOKEN = token;
        POOL = pool;
        WETH = weth;
        POSITION_MANAGER = npm;
        POSITION_ID = id;
        POOL_TOKENS = used;
        OPEN_AT = c.openAt;
        START_TICK = c.startTick;
        FEE_RECIPIENT = c.feeRecipient;
        TEAM_FEE_RECIPIENT = c.teamFeeRecipient;
        VESTING = c.vesting;
        VESTING_TOKENS = vestingAmount;
        COMMUNITY = c.community;
        COMMUNITY_TOKENS = communityAmount;
        emit Launched(address(token), pool, id, used, c.startTick);
    }

    /// @dev Initialise le pool au prix de départ et y place tous les tokens restants d'un seul
    ///      côté, du prix de départ à l'infini. Token en token0 : prix = WETH par token, il monte
    ///      quand on achète, la position va de startTick à MAX_TICK. Token en token1 : prix =
    ///      token par WETH, il baisse quand on achète, la position va de −MAX_TICK à −startTick.
    ///      Les arrondis de la position sont brûlés.
    function _placeLiquidity(ILaunchPositionManager npm, address token, address weth, address pool, int24 startTick)
        private
        returns (uint256 id, uint256 used)
    {
        bool tokenIsToken0 = ILaunchV3Pool(pool).token0() == token;
        int24 tick = tokenIsToken0 ? startTick : -startTick;
        ILaunchV3Pool(pool).initialize(TickMath.getSqrtPriceAtTick(tick));

        IERC20 t = IERC20(token);
        uint256 amount = t.balanceOf(address(this));
        t.forceApprove(address(npm), amount);
        uint256 used0;
        uint256 used1;
        (id,, used0, used1) = npm.mint(
            ILaunchPositionManager.MintParams({
                token0: tokenIsToken0 ? token : weth,
                token1: tokenIsToken0 ? weth : token,
                fee: FEE,
                tickLower: tokenIsToken0 ? tick : -MAX_TICK,
                tickUpper: tokenIsToken0 ? MAX_TICK : tick,
                amount0Desired: tokenIsToken0 ? amount : 0,
                amount1Desired: tokenIsToken0 ? 0 : amount,
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(this),
                deadline: block.timestamp
            })
        );
        used = tokenIsToken0 ? used0 : used1;
        if ((tokenIsToken0 ? used1 : used0) != 0 || used == 0) revert InvalidParams();
        t.forceApprove(address(npm), 0);
        uint256 extra = t.balanceOf(address(this));
        if (extra > 0) t.safeTransfer(DEAD, extra);
    }

    /// @notice Partage les frais d'échange accumulés par la position : TEAM_FEE_PERCENT % au Safe
    ///         de l'équipe, le reste au Safe communauté. N'importe qui peut l'appeler ; la
    ///         liquidité, elle, ne peut jamais sortir. Pendant les 24 h de limite anti-bot, l'envoi
    ///         de tokens peut être refusé si un destinataire dépasse la limite (le Safe communauté
    ///         détient déjà 3 %) : il suffit de rappeler plus tard.
    function collectFees() external returns (uint256 amount0, uint256 amount1) {
        (amount0, amount1) = POSITION_MANAGER.collect(
            ILaunchPositionManager.CollectParams({
                tokenId: POSITION_ID,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        address token0 = ILaunchV3Pool(POOL).token0();
        address token1 = token0 == address(TOKEN) ? WETH : address(TOKEN);
        uint256 team0 = _split(token0, amount0);
        uint256 team1 = _split(token1, amount1);
        emit FeesCollected(amount0, amount1, team0, team1);
    }

    /// @dev Envoie TEAM_FEE_PERCENT % de `amount` à l'équipe et le reste à la communauté.
    function _split(address asset, uint256 amount) private returns (uint256 team) {
        if (amount == 0) return 0;
        team = amount * TEAM_FEE_PERCENT / 100;
        if (team > 0) IERC20(asset).safeTransfer(TEAM_FEE_RECIPIENT, team);
        IERC20(asset).safeTransfer(FEE_RECIPIENT, amount - team);
    }
}
