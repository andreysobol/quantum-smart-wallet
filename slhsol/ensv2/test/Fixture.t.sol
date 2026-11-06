// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {V2Fixture} from "~test/fixtures/V2Fixture.sol";

contract FixtureTest is V2Fixture {
    function test_officialFixtureDeploys() external {
        deployV2Fixture();
        assertEq(address(rootRegistry.getSubregistry("eth")), address(ethRegistry));
    }
}
