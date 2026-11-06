// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IVerifiableFactory} from "@ensdomains/verifiable-factory/IVerifiableFactory.sol";

import {ENSVault} from "./ENSVault.sol";

interface IQuantumAccountRegistry {
    function isAccount(address account) external view returns (bool);
}

/// @notice Deterministic, permissionless ENSVault deployment: one vault per factory-created QuantumAccount.
/// @dev Anyone may create an account's vault, but its controller is fixed to that account by the CREATE2
/// address, so creating it grants nothing. createVault() is idempotent, so a registration transaction can
/// always include it.
contract ENSVaultFactory {
    IQuantumAccountRegistry public immutable ACCOUNT_FACTORY;
    IVerifiableFactory public immutable PROXY_FACTORY;
    address public immutable RESOLVER_IMPLEMENTATION;

    error InvalidConfiguration();
    error NotQuantumAccount(address account);

    event VaultCreated(address indexed controller, address indexed vault, address resolver);

    constructor(IQuantumAccountRegistry accountFactory, IVerifiableFactory proxyFactory, address resolverImplementation) {
        if (
            address(accountFactory).code.length == 0 || address(proxyFactory).code.length == 0
                || resolverImplementation.code.length == 0
        ) revert InvalidConfiguration();
        ACCOUNT_FACTORY = accountFactory;
        PROXY_FACTORY = proxyFactory;
        RESOLVER_IMPLEMENTATION = resolverImplementation;
    }

    /// @notice The vault address of `controller`, deployed or not.
    function vaultAddress(address controller) public view returns (address) {
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(ENSVault).creationCode, abi.encode(controller, PROXY_FACTORY, RESOLVER_IMPLEMENTATION)
            )
        );
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), _salt(controller), initCodeHash))))
        );
    }

    /// @notice The PermissionedResolver proxy the vault of `controller` deploys for itself.
    function resolverAddress(address controller) external view returns (address) {
        return PROXY_FACTORY.predictProxyAddress(vaultAddress(controller), 0);
    }

    /// @notice Deploy the vault of a factory-created QuantumAccount, or return the existing one.
    function createVault(address controller) external returns (ENSVault vault) {
        address predicted = vaultAddress(controller);
        if (predicted.code.length != 0) return ENSVault(predicted);
        if (!ACCOUNT_FACTORY.isAccount(controller)) revert NotQuantumAccount(controller);
        vault = new ENSVault{salt: _salt(controller)}(controller, PROXY_FACTORY, RESOLVER_IMPLEMENTATION);
        emit VaultCreated(controller, address(vault), vault.RESOLVER());
    }

    function _salt(address controller) private pure returns (bytes32) {
        return bytes32(uint256(uint160(controller)));
    }
}
