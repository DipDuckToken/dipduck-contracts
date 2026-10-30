// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title MockSafeSingleton
/// @notice Contrat de base d'essai (tests uniquement) : annonce une version comme Safe.
contract MockSafeSingleton {
    string public VERSION;

    constructor(string memory version) {
        VERSION = version;
    }
}

/// @title MockSafe
/// @notice Safe d'essai (tests uniquement) : le contrat de base est rangé dans
///         l'emplacement 0, comme dans le proxy officiel ; propriétaires et seuil fixés.
contract MockSafe {
    address private singleton;
    address[] private owners;
    uint256 private threshold;

    constructor(address singleton_, address[] memory owners_, uint256 threshold_) {
        singleton = singleton_;
        owners = owners_;
        threshold = threshold_;
    }

    function getOwners() external view returns (address[] memory) {
        return owners;
    }

    function getThreshold() external view returns (uint256) {
        return threshold;
    }

    receive() external payable {}
}
