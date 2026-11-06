// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IAddrResolver} from "@ens/contracts/resolvers/profiles/IAddrResolver.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {IPermissionedRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IRegistry.sol";
import {RegistryRolesLib} from "@ensdomains/contracts-v2/registry/libraries/RegistryRolesLib.sol";
import {IAddressSetter} from "@ensdomains/contracts-v2/resolver/interfaces/setters/IAddressSetter.sol";
import {LibLabel} from "@ensdomains/contracts-v2/utils/LibLabel.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DemoUSDC} from "quantum/DemoUSDC.sol";

import {ENSVault} from "../src/ENSVault.sol";
import {SimpleSubnameRegistrar} from "../src/SimpleSubnameRegistrar.sol";
import {NamespaceFixture} from "./NamespaceFixture.sol";

contract SimpleSubnameRegistrarTest is NamespaceFixture {
    uint256 constant PRICE = 5_000_000; // 5 dUSDC per year
    uint64 constant YEAR = 365 days;

    DemoUSDC usdc;
    SimpleSubnameRegistrar registrar;
    address beneficiary = makeAddr("beneficiary");
    address account;

    function setUp() external {
        deployNamespace();
        usdc = new DemoUSDC(address(this));
        registrar = new SimpleSubnameRegistrar(qswRegistry, IERC20(address(usdc)), beneficiary, PRICE, YEAR);
        qswRegistry.grantRootRoles(RegistryRolesLib.ROLE_REGISTRAR | RegistryRolesLib.ROLE_RENEW, address(registrar));
        account = newAccount(keccak256("alice key"));
        usdc.mint(account, 100_000_000);
    }

    /// The SENDER frames of the wallet's registration transaction, in order, as the account.
    function _registerAsAccount(string memory label, uint64 duration) internal returns (ENSVault vault, uint256 tokenId) {
        bytes memory name = NameCoder.encode(string.concat(label, ".qsw.eth"));
        vm.startPrank(account);
        vault = vaultFactory.createVault(account);
        usdc.approve(address(registrar), registrar.getPrice(duration));
        tokenId = registrar.register(label, address(vault), vault.RESOLVER(), duration);
        vault.execute(vault.RESOLVER(), abi.encodeCall(IAddressSetter.setAddress, (name, 60, abi.encodePacked(account))));
        vm.stopPrank();
    }

    function _resolveAddr(string memory fullName) internal view returns (address) {
        bytes memory name = NameCoder.encode(fullName);
        (bytes memory result,) =
            universalResolver.resolve(name, abi.encodeCall(IAddrResolver.addr, (NameCoder.namehash(name, 0))));
        return abi.decode(result, (address));
    }

    function test_priceIsTheAnnualPriceTimesYears() external view {
        assertEq(registrar.getPrice(YEAR), PRICE);
        assertEq(registrar.getPrice(3 * YEAR), 3 * PRICE);
    }

    function test_registrationPaysInDusdcMintsToTheVaultAndResolvesToTheAccount() external {
        assertTrue(registrar.isAvailable("alice"));
        vm.startPrank(account);
        ENSVault vault = vaultFactory.createVault(account);
        address resolver = vault.RESOLVER();
        usdc.approve(address(registrar), 2 * PRICE);
        vm.expectEmit(false, true, true, true, address(registrar));
        emit SimpleSubnameRegistrar.NameRegistered(
            0, "alice", address(vault), account, resolver, 2 * PRICE, uint64(block.timestamp + 2 * YEAR)
        );
        uint256 tokenId = registrar.register("alice", address(vault), resolver, 2 * YEAR);
        bytes memory name = NameCoder.encode("alice.qsw.eth");
        vault.execute(resolver, abi.encodeCall(IAddressSetter.setAddress, (name, 60, abi.encodePacked(account))));
        vm.stopPrank();

        assertEq(usdc.balanceOf(account), 100_000_000 - 2 * PRICE);
        assertEq(usdc.balanceOf(beneficiary), 2 * PRICE);
        assertEq(usdc.allowance(account, address(registrar)), 0);
        assertEq(qswRegistry.ownerOf(tokenId), address(vault));
        assertEq(vault.CONTROLLER(), account);
        IPermissionedRegistry.State memory state = qswRegistry.getState(LibLabel.id("alice"));
        assertEq(uint8(state.status), uint8(IPermissionedRegistry.Status.REGISTERED));
        assertEq(state.expiry, block.timestamp + 2 * YEAR);
        assertEq(qswRegistry.getResolver("alice"), vault.RESOLVER());
        assertEq(_resolveAddr("alice.qsw.eth"), account);
        assertFalse(registrar.isAvailable("alice"));
    }

    function test_takenNamesAreRejected() external {
        _registerAsAccount("alice", YEAR);
        address other = newAccount(keccak256("bob key"));
        usdc.mint(other, PRICE);
        address otherVault = vaultFactory.vaultAddress(other);
        vm.startPrank(other);
        usdc.approve(address(registrar), PRICE);
        vm.expectRevert(abi.encodeWithSelector(SimpleSubnameRegistrar.NameNotAvailable.selector, "alice"));
        registrar.register("alice", otherVault, address(0), YEAR);
        vm.stopPrank();
    }

    function test_invalidRegistrationsAreRejected() external {
        address vault = address(vaultFactory.createVault(account));
        vm.startPrank(account);
        vm.expectRevert(abi.encodeWithSelector(SimpleSubnameRegistrar.DurationTooShort.selector, YEAR - 1, YEAR));
        registrar.register("alice", vault, address(0), YEAR - 1);
        vm.expectRevert(SimpleSubnameRegistrar.InvalidOwner.selector);
        registrar.register("alice", address(0), address(0), YEAR);
        // No approval: the payment cannot be pulled.
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(registrar), 0, PRICE)
        );
        registrar.register("alice", vault, address(0), YEAR);
        vm.stopPrank();
    }

    function test_onlyTheRegistrarCanRegisterUnderQsw() external {
        vm.prank(account);
        vm.expectRevert();
        qswRegistry.register("alice", account, IRegistry(address(0)), address(0), 0, uint64(block.timestamp + YEAR));
    }

    function test_renewalExtendsTheExpiry() external {
        _registerAsAccount("alice", YEAR);
        uint64 expiry = qswRegistry.getState(LibLabel.id("alice")).expiry;
        vm.startPrank(account);
        usdc.approve(address(registrar), PRICE);
        registrar.renew("alice", YEAR);
        vm.stopPrank();
        assertEq(qswRegistry.getState(LibLabel.id("alice")).expiry, expiry + YEAR);
        vm.expectRevert(abi.encodeWithSelector(SimpleSubnameRegistrar.NameNotRegistered.selector, "nobody"));
        registrar.renew("nobody", YEAR);
    }
}
