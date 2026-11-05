// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployQuantumAccount} from "../script/DeployQuantumAccount.s.sol";

contract DeployQuantumAccountTest is Test {
    function test_wrongNetworkRejectedBeforeReadingDeploymentConfiguration() public {
        vm.chainId(1);
        DeployQuantumAccount deployer = new DeployQuantumAccount();
        vm.expectRevert("unsupported native frame profile");
        deployer.run();
    }
}
