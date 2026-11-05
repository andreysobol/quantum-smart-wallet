// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DemoUSDC} from "../src/DemoUSDC.sol";

contract DemoUSDCTest is Test {
    DemoUSDC internal token;
    address internal constant USER = address(0xbeef);
    address internal constant SPENDER = address(0xcafe);

    function setUp() public {
        token = new DemoUSDC(address(this));
    }

    function test_sixDecimalsAndExplicitDemoIdentity() public view {
        assertEq(token.decimals(), 6);
        assertEq(token.name(), "Demo USD Coin");
        assertEq(token.symbol(), "dUSDC");
        assertEq(token.MINTER(), address(this));
    }

    function test_onlyConfiguredMinterCanIssue() public {
        token.mint(USER, 20_000 * 1e6);
        assertEq(token.balanceOf(USER), 20_000 * 1e6);
        assertEq(token.totalSupply(), 20_000 * 1e6);
        vm.prank(USER);
        vm.expectRevert(DemoUSDC.UnauthorizedMinter.selector);
        token.mint(USER, 1);
    }

    function test_onchainApprovalSupportsAllowanceTransfer() public {
        token.mint(USER, 100 * 1e6);
        vm.prank(USER);
        assertTrue(token.approve(SPENDER, 20 * 1e6));
        vm.prank(SPENDER);
        assertTrue(token.transferFrom(USER, address(this), 15 * 1e6));
        assertEq(token.balanceOf(address(this)), 15 * 1e6);
        assertEq(token.balanceOf(USER), 85 * 1e6);
        assertEq(token.allowance(USER, SPENDER), 5 * 1e6);
    }

    function test_rejectZeroMinter() public {
        vm.expectRevert(DemoUSDC.InvalidMinter.selector);
        new DemoUSDC(address(0));
    }
}
