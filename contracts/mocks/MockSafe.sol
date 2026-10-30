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
    address private module;

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

    /// @notice Active un module (tests du refus des Safes à module).
    function enableModule(address module_) external {
        module = module_;
    }

    function getModulesPaginated(address, uint256) external view returns (address[] memory array, address next) {
        array = new address[](module == address(0) ? 0 : 1);
        if (module != address(0)) array[0] = module;
        next = address(1);
    }

    receive() external payable {}
}
