// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {QuantumAccount} from "./QuantumAccount.sol";

/// @notice Permissionless CREATE2 deployment and provenance for native PQ accounts.
/// @dev Registration is earned only by deploying this exact QuantumAccount
/// creation code with the factory's immutable verifier/staking configuration.
/// There is no owner, arbitrary registration API, upgrade or identity override.
contract QuantumAccountFactory {
    address public immutable VERIFIER;
    address public immutable STAKING_REGISTRY;
    uint256 public immutable INITIAL_STAKE;
    uint32 public immutable UNSTAKE_DELAY;

    mapping(address account => bool registered) public isAccount;

    error InvalidConfiguration();
    error InvalidPublicKey();
    error InsufficientValue();
    error UnexpectedValueForExistingAccount();

    event AccountCreated(address indexed account, bytes32 indexed publicKey, bytes32 indexed salt);

    constructor(address verifier, address stakingRegistry, uint256 initialStake, uint32 unstakeDelaySec) {
        if (verifier.code.length == 0) revert InvalidConfiguration();
        if (initialStake == 0) {
            if (stakingRegistry != address(0) || unstakeDelaySec != 0) revert InvalidConfiguration();
        } else if (stakingRegistry.code.length == 0 || unstakeDelaySec < 1 days) {
            revert InvalidConfiguration();
        }
        VERIFIER = verifier;
        STAKING_REGISTRY = stakingRegistry;
        INITIAL_STAKE = initialStake;
        UNSTAKE_DELAY = unstakeDelaySec;
    }

    /// @notice Predict the address without deploying or funding an account.
    /// The initial key and all immutable account parameters are bound by initcode.
    function getAddress(bytes32 publicKey, bytes32 salt) public view returns (address) {
        if (publicKey == bytes32(0)) revert InvalidPublicKey();
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(QuantumAccount).creationCode,
                abi.encode(publicKey, VERIFIER, STAKING_REGISTRY, INITIAL_STAKE, UNSTAKE_DELAY)
            )
        );
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))));
    }

    /// @notice Deploy with stake plus any additional spendable ETH as msg.value.
    /// Repeating an existing deployment with zero value returns the same account.
    /// @dev A nonzero-value repeat reverts, so it never silently stakes twice or
    /// traps a caller's payment in the factory. Send top-ups directly to the account.
    function createAccount(bytes32 publicKey, bytes32 salt) external payable returns (QuantumAccount account) {
        address predicted = getAddress(publicKey, salt);
        if (isAccount[predicted]) {
            if (msg.value != 0) revert UnexpectedValueForExistingAccount();
            return QuantumAccount(payable(predicted));
        }
        if (msg.value < INITIAL_STAKE) revert InsufficientValue();
        account = new QuantumAccount{salt: salt, value: msg.value}(
            publicKey, VERIFIER, STAKING_REGISTRY, INITIAL_STAKE, UNSTAKE_DELAY
        );
        isAccount[address(account)] = true;
        emit AccountCreated(address(account), publicKey, salt);
    }
}
