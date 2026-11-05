// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {QuantumAccount} from "../src/QuantumAccount.sol";
import {QuantumAccountFactory} from "../src/QuantumAccountFactory.sol";
import {SlhDsaVerifier} from "../src/SlhDsaSha2_128s.sol";

contract FactoryTestRegistry {
    mapping(address => uint256) public stakeOf;
    mapping(address => uint32) public delayOf;

    function addStake(uint32 delay) external payable {
        stakeOf[msg.sender] += msg.value;
        delayOf[msg.sender] = delay;
    }
}

contract QuantumAccountFactoryTest is Test {
    SlhDsaVerifier internal verifier;
    QuantumAccountFactory internal factory;
    bytes32 internal constant KEY = keccak256("factory test public key");
    bytes32 internal constant SALT = keccak256("factory test salt");

    function setUp() public {
        verifier = new SlhDsaVerifier();
        factory = new QuantumAccountFactory(address(verifier), address(0), 0, 0);
    }

    function test_predictionAndRegistrationAreExact() public {
        address predicted = factory.getAddress(KEY, SALT);
        assertFalse(factory.isAccount(predicted));
        QuantumAccount account = factory.createAccount(KEY, SALT);
        assertEq(address(account), predicted);
        assertTrue(factory.isAccount(predicted));
        assertEq(account.publicKey(), KEY);
        assertEq(address(account.VERIFIER()), address(verifier));
    }

    function test_createIsPermissionlessButDoesNotAssignDeployerAuthority() public {
        address caller = makeAddr("arbitrary deployer");
        vm.prank(caller);
        QuantumAccount account = factory.createAccount(KEY, SALT);
        vm.prank(caller);
        vm.expectRevert(QuantumAccount.UnauthorizedCaller.selector);
        account.rotateKey(bytes32(uint256(2)));
    }

    function test_getAndCreateAreIdempotentWithoutRedeployment() public {
        QuantumAccount first = factory.createAccount(KEY, SALT);
        uint64 nonce = vm.getNonce(address(factory));
        QuantumAccount second = factory.createAccount(KEY, SALT);
        assertEq(address(second), address(first));
        assertEq(vm.getNonce(address(factory)), nonce);
    }

    function test_nonzeroValueRepeatRevertsAndDoesNotTrapFunds() public {
        QuantumAccount account = factory.createAccount(KEY, SALT);
        vm.deal(address(this), 1 ether);
        vm.expectRevert(QuantumAccountFactory.UnexpectedValueForExistingAccount.selector);
        factory.createAccount{value: 1 ether}(KEY, SALT);
        assertEq(address(this).balance, 1 ether);
        assertEq(address(factory).balance, 0);
        assertEq(address(account).balance, 0);
    }

    function test_keyAndSaltEachBindTheAddress() public view {
        address predicted = factory.getAddress(KEY, SALT);
        assertNotEq(predicted, factory.getAddress(bytes32(uint256(2)), SALT));
        assertNotEq(predicted, factory.getAddress(KEY, bytes32(uint256(2))));
    }

    function test_directQuantumAccountCloneIsNotRegistered() public {
        QuantumAccount clone = new QuantumAccount(KEY, address(verifier), address(0), 0, 0);
        assertFalse(factory.isAccount(address(clone)));
        (bool success,) = address(factory).call(abi.encodeWithSignature("registerAccount(address)", address(clone)));
        assertFalse(success);
        assertFalse(factory.isAccount(address(clone)));
    }

    function test_registrationSurvivesAuthorizedKeyRotation() public {
        QuantumAccount account = factory.createAccount(KEY, SALT);
        vm.prank(address(account));
        account.rotateKey(bytes32(uint256(2)));
        assertTrue(factory.isAccount(address(account)));
    }

    function test_constructorStakeBelongsToAccountAndRemainderIsSpendable() public {
        FactoryTestRegistry registry = new FactoryTestRegistry();
        QuantumAccountFactory staked =
            new QuantumAccountFactory(address(verifier), address(registry), 0.012 ether, 1 days);
        vm.deal(address(this), 1 ether);
        QuantumAccount account = staked.createAccount{value: 0.02 ether}(KEY, SALT);
        assertEq(registry.stakeOf(address(account)), 0.012 ether);
        assertEq(registry.stakeOf(address(staked)), 0);
        assertEq(registry.delayOf(address(account)), 1 days);
        assertEq(address(account).balance, 0.008 ether);
        assertEq(address(staked).balance, 0);
        assertTrue(staked.isAccount(address(account)));
    }

    function test_insufficientStakeCannotRegisterAccount() public {
        FactoryTestRegistry registry = new FactoryTestRegistry();
        QuantumAccountFactory staked =
            new QuantumAccountFactory(address(verifier), address(registry), 0.012 ether, 1 days);
        vm.expectRevert(QuantumAccountFactory.InsufficientValue.selector);
        staked.createAccount(KEY, SALT);
        assertFalse(staked.isAccount(staked.getAddress(KEY, SALT)));
    }

    function test_zeroPublicKeyRejected() public {
        vm.expectRevert(QuantumAccountFactory.InvalidPublicKey.selector);
        factory.createAccount(bytes32(0), SALT);
    }

    function test_invalidVerifierRejected() public {
        vm.expectRevert(QuantumAccountFactory.InvalidConfiguration.selector);
        new QuantumAccountFactory(address(0), address(0), 0, 0);
    }

    function test_invalidStakingConfigurationRejected() public {
        FactoryTestRegistry registry = new FactoryTestRegistry();
        vm.expectRevert(QuantumAccountFactory.InvalidConfiguration.selector);
        new QuantumAccountFactory(address(verifier), address(registry), 0, 0);
        vm.expectRevert(QuantumAccountFactory.InvalidConfiguration.selector);
        new QuantumAccountFactory(address(verifier), address(0), 1, 1 days);
        vm.expectRevert(QuantumAccountFactory.InvalidConfiguration.selector);
        new QuantumAccountFactory(address(verifier), address(registry), 1, 1 days - 1);
    }

    function testFuzz_predictionMatchesDeployedAccount(bytes32 key, bytes32 salt) public {
        vm.assume(key != bytes32(0));
        address predicted = factory.getAddress(key, salt);
        assertEq(address(factory.createAccount(key, salt)), predicted);
        assertTrue(factory.isAccount(predicted));
    }
}
