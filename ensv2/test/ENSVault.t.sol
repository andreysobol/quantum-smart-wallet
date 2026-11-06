// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IAddrResolver} from "@ens/contracts/resolvers/profiles/IAddrResolver.sol";
import {ITextResolver} from "@ens/contracts/resolvers/profiles/ITextResolver.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {IRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IRegistry.sol";
import {RegistryRolesLib} from "@ensdomains/contracts-v2/registry/libraries/RegistryRolesLib.sol";
import {IAddressSetter} from "@ensdomains/contracts-v2/resolver/interfaces/setters/IAddressSetter.sol";
import {ITextSetter} from "@ensdomains/contracts-v2/resolver/interfaces/setters/ITextSetter.sol";
import {PermissionedResolver} from "@ensdomains/contracts-v2/resolver/PermissionedResolver.sol";
import {IERC1155Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";

import {ENSVault} from "../src/ENSVault.sol";
import {ENSVaultFactory} from "../src/ENSVaultFactory.sol";
import {NamespaceFixture} from "./NamespaceFixture.sol";

contract ENSVaultTest is NamespaceFixture {
    uint256 constant OWNER_ROLES = RegistryRolesLib.ROLE_SET_SUBREGISTRY | RegistryRolesLib.ROLE_SET_SUBREGISTRY_ADMIN
        | RegistryRolesLib.ROLE_SET_RESOLVER | RegistryRolesLib.ROLE_SET_RESOLVER_ADMIN
        | RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN;

    address account;
    address operator = makeAddr("operator");
    bytes aliceName = NameCoder.encode("alice.qsw.eth");

    function setUp() external {
        deployNamespace();
        qswRegistry.grantRootRoles(RegistryRolesLib.ROLE_REGISTRAR, address(this));
        account = newAccount(keccak256("alice key"));
    }

    function _register(string memory label, address owner, address resolver) internal returns (uint256) {
        return qswRegistry.register(label, owner, IRegistry(address(0)), resolver, OWNER_ROLES, uint64(block.timestamp + 365 days));
    }

    function _resolveAddr(bytes memory name) internal view returns (address) {
        (bytes memory result,) =
            universalResolver.resolve(name, abi.encodeCall(IAddrResolver.addr, (NameCoder.namehash(name, 0))));
        return abi.decode(result, (address));
    }

    function test_quantumAccountCannotOwnNamesDirectly() external {
        vm.expectRevert(abi.encodeWithSelector(IERC1155Errors.ERC1155InvalidReceiver.selector, account));
        _register("alice", account, address(0));
    }

    function test_vaultAndResolverAddressesArePredicted() external {
        address predictedVault = vaultFactory.vaultAddress(account);
        address predictedResolver = vaultFactory.resolverAddress(account);
        vm.expectEmit(address(vaultFactory));
        emit ENSVaultFactory.VaultCreated(account, predictedVault, predictedResolver);
        ENSVault vault = vaultFactory.createVault(account);
        assertEq(address(vault), predictedVault);
        assertEq(vault.CONTROLLER(), account);
        assertEq(vault.RESOLVER(), predictedResolver);
        assertEq(verifiableFactory.verifyContract(predictedResolver), address(resolverImplementation));
        // Idempotent: a repeat returns the same vault without deploying again.
        vm.recordLogs();
        assertEq(address(vaultFactory.createVault(account)), predictedVault);
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_createVaultRejectsAddressesThatAreNotFactoryAccounts() external {
        vm.expectRevert(abi.encodeWithSelector(ENSVaultFactory.NotQuantumAccount.selector, operator));
        vaultFactory.createVault(operator);
        vm.expectRevert(abi.encodeWithSelector(ENSVaultFactory.NotQuantumAccount.selector, address(this)));
        vaultFactory.createVault(address(this));
    }

    function test_vaultHoldsTheNameAndItsRoles() external {
        ENSVault vault = vaultFactory.createVault(account);
        assertTrue(vault.supportsInterface(type(IERC1155Receiver).interfaceId));
        uint256 tokenId = _register("alice", address(vault), vault.RESOLVER());
        assertEq(qswRegistry.ownerOf(tokenId), address(vault));
        assertTrue(qswRegistry.hasRoles(tokenId, RegistryRolesLib.ROLE_SET_RESOLVER, address(vault)));
        assertFalse(qswRegistry.hasRoles(tokenId, RegistryRolesLib.ROLE_SET_RESOLVER, account));
    }

    function test_onlyTheControllerCanActThroughTheVault() external {
        ENSVault vault = vaultFactory.createVault(account);
        address resolver = vault.RESOLVER();
        bytes memory setAddr = abi.encodeCall(IAddressSetter.setAddress, (aliceName, 60, abi.encodePacked(operator)));
        address[3] memory strangers = [operator, address(this), address(vaultFactory)];
        for (uint256 i; i < strangers.length; ++i) {
            vm.prank(strangers[i]);
            vm.expectRevert(abi.encodeWithSelector(ENSVault.UnauthorizedCaller.selector, strangers[i]));
            vault.execute(resolver, setAddr);
        }
        // The vault's resolver grants nothing to the account, the deployer or the factory directly.
        address[3] memory direct = [account, address(this), address(vaultFactory)];
        for (uint256 i; i < direct.length; ++i) {
            vm.prank(direct[i]);
            vm.expectRevert();
            PermissionedResolver(resolver).setAddress(aliceName, 60, abi.encodePacked(direct[i]));
        }
    }

    function test_controllerManagesNamesThroughTheVault() external {
        ENSVault vault = vaultFactory.createVault(account);
        address resolver = vault.RESOLVER();
        uint256 tokenId = _register("alice", address(vault), resolver);

        vm.startPrank(account);
        vault.execute(resolver, abi.encodeCall(IAddressSetter.setAddress, (aliceName, 60, abi.encodePacked(account))));
        vault.execute(resolver, abi.encodeCall(ITextSetter.setText, (aliceName, "description", "devnet")));
        vm.stopPrank();
        assertEq(_resolveAddr(aliceName), account);
        (bytes memory text,) = universalResolver.resolve(
            aliceName, abi.encodeCall(ITextResolver.text, (NameCoder.namehash(aliceName, 0), "description"))
        );
        assertEq(abi.decode(text, (string)), "devnet");

        // The controller can also move the name out of its vault.
        vm.prank(account);
        vault.execute(
            address(qswRegistry),
            abi.encodeCall(IERC1155.safeTransferFrom, (address(vault), operator, tokenId, 1, ""))
        );
        assertEq(qswRegistry.ownerOf(tokenId), operator);
    }

    function test_executeBubblesTheTargetRevert() external {
        ENSVault vault = vaultFactory.createVault(account);
        uint256 tokenId = _register("alice", address(vault), vault.RESOLVER());
        vm.prank(account);
        vm.expectRevert(
            abi.encodeWithSelector(IERC1155Errors.ERC1155InvalidReceiver.selector, account)
        );
        vault.execute(
            address(qswRegistry), abi.encodeCall(IERC1155.safeTransferFrom, (address(vault), account, tokenId, 1, ""))
        );
    }
}
