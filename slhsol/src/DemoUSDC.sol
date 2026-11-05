// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Six-decimal test currency for the dedicated Quantum Wallet devnet.
/// @dev Uses ordinary ERC20 approvals; Permit2 signatures are not required.
contract DemoUSDC is ERC20 {
    address public immutable MINTER;

    error InvalidMinter();
    error UnauthorizedMinter();

    constructor(address minter) ERC20("Demo USD Coin", "dUSDC") {
        if (minter == address(0)) revert InvalidMinter();
        MINTER = minter;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address recipient, uint256 amount) external {
        if (msg.sender != MINTER) revert UnauthorizedMinter();
        _mint(recipient, amount);
    }
}
