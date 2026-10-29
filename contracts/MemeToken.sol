// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MemeToken
/// @notice ERC-20 à offre fixe : la totalité est émise une seule fois, au
///         déploiement, vers l'adresse qui déploie.
/// @dev Volontairement minimal. Aucune fonction d'administration n'existe :
///      pas d'owner, pas d'émission après le constructeur, pas de pause,
///      pas de liste noire, pas de taxe, pas de limite par transaction.
///      Le contrat n'accepte pas d'ETH (ni receive, ni fallback).
///
///      L'offre, exprimée en unités de base (18 décimales), est bornée à
///      type(uint112).max : c'est la taille des réserves d'une paire Uniswap v2,
///      donc toute l'offre peut entrer dans le pool et en ressortir. Cette borne
///      tient aussi dans un uint128 (CW20 en Uint128, Balance Substrate en u128)
///      si le token est un jour ponté par verrouillage (lock-and-mint).
contract MemeToken is ERC20 {
    /// @dev 10^18 : une unité entière du token en unités de base.
    uint256 private constant UNIT = 1e18;

    /// @dev Plus grande offre (en tokens entiers) dont la valeur en unités de
    ///      base tient dans un uint112 : floor((2^112 - 1) / 10^18).
    uint256 private constant MAX_WHOLE_TOKENS = type(uint112).max / UNIT;

    /// @notice L'offre demandée est nulle ou dépasse la borne uint112.
    /// @param wholeTokens Offre demandée, en tokens entiers.
    error InvalidSupply(uint256 wholeTokens);

    /// @param name_ Nom du token.
    /// @param symbol_ Symbole (ticker) du token.
    /// @param wholeTokens Offre totale en tokens entiers ; les 18 décimales
    ///        sont ajoutées ici.
    constructor(string memory name_, string memory symbol_, uint256 wholeTokens) ERC20(name_, symbol_) {
        if (wholeTokens == 0 || wholeTokens > MAX_WHOLE_TOKENS) {
            revert InvalidSupply(wholeTokens);
        }
        _mint(msg.sender, wholeTokens * UNIT);
    }
}
