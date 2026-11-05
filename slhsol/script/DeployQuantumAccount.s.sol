// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {QuantumAccount} from "../src/QuantumAccount.sol";
import {SlhDsaVerifier} from "../src/SlhDsaSha2_128s.sol";

/// @dev Dry run by default. A broadcast requires explicitly adding --broadcast
/// and choosing the funded deployer with Foundry's --account/--sender options.
contract DeployQuantumAccount is Script {
    function run() external returns (QuantumAccount account, SlhDsaVerifier verifier) {
        require(block.chainid == 1337, "unsupported native frame profile");
        bytes32 publicKey = vm.envBytes32("QSW_PUBLIC_KEY");
        address registry = vm.envOr("QSW_STAKING_REGISTRY", address(0));
        uint256 stake = vm.envOr("QSW_INITIAL_STAKE", uint256(0));
        uint256 funding = vm.envOr("QSW_SPENDABLE_ETH", uint256(0));
        uint256 delay = vm.envOr("QSW_UNSTAKE_DELAY", uint256(stake == 0 ? 0 : 1 days));
        require(delay <= type(uint32).max, "unstake delay exceeds uint32");
        // The preceding bound check makes the conversion exact.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 checkedDelay = uint32(delay);

        vm.startBroadcast();
        verifier = new SlhDsaVerifier();
        account =
            new QuantumAccount{value: stake + funding}(publicKey, address(verifier), registry, stake, checkedDelay);
        vm.stopBroadcast();
    }
}
