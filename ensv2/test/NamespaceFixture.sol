// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {RegistryRolesLib} from "@ensdomains/contracts-v2/registry/libraries/RegistryRolesLib.sol";
import {PermissionedRegistry} from "@ensdomains/contracts-v2/registry/PermissionedRegistry.sol";
import {PermissionedResolver} from "@ensdomains/contracts-v2/resolver/PermissionedResolver.sol";
import {V2Fixture} from "~test/fixtures/V2Fixture.sol";
import {QuantumAccountFactory} from "quantum/QuantumAccountFactory.sol";

import {ENSVaultFactory, IQuantumAccountRegistry} from "../src/ENSVaultFactory.sol";

/// Stands in for the SLH-DSA verifier: QuantumAccount only requires the verifier to have code.
contract StubVerifier {
    function verify(bytes calldata, bytes calldata, bytes calldata, bytes calldata) external pure returns (bool) {
        return false;
    }
}

/// The official V2Fixture (root + .eth) plus the devnet layout: qsw.eth with its own PermissionedRegistry,
/// real QuantumAccounts from the unmodified QuantumAccountFactory, and the vault factory.
abstract contract NamespaceFixture is V2Fixture {
    PermissionedRegistry qswRegistry;
    PermissionedResolver resolverImplementation;
    QuantumAccountFactory accountFactory;
    ENSVaultFactory vaultFactory;

    /// Root roles the operator keeps on qsw.eth: grant registrars and renewers, nothing that can take a name.
    uint256 constant QSW_REGISTRY_ROOT_ROLES =
        RegistryRolesLib.ROLE_REGISTRAR_ADMIN | RegistryRolesLib.ROLE_RENEW_ADMIN | RegistryRolesLib.ROLE_SET_PARENT;

    function deployNamespace() internal {
        deployV2Fixture();
        qswRegistry = new PermissionedRegistry(labelStore, address(this), QSW_REGISTRY_ROOT_ROLES);
        ethRegistry.register("qsw", address(this), qswRegistry, address(0), _ethTokenRoles(), type(uint64).max);
        qswRegistry.setParent(ethRegistry, "qsw");
        resolverImplementation = new PermissionedResolver(address(contractNamer));
        accountFactory = new QuantumAccountFactory(address(new StubVerifier()), address(0), 0, 0);
        vaultFactory = new ENSVaultFactory(
            IQuantumAccountRegistry(address(accountFactory)), verifiableFactory, address(resolverImplementation)
        );
    }

    function newAccount(bytes32 publicKey) internal returns (address) {
        return address(accountFactory.createAccount(publicKey, keccak256(abi.encode(publicKey))));
    }
}
