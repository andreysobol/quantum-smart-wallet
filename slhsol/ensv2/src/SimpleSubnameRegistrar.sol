// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IPermissionedRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IRegistry.sol";
import {RegistryRolesLib} from "@ensdomains/contracts-v2/registry/libraries/RegistryRolesLib.sol";
import {LibLabel} from "@ensdomains/contracts-v2/utils/LibLabel.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Granted to each name owner at registration; the same bitmap as the ETH registrar.
uint256 constant REGISTRATION_ROLE_BITMAP = RegistryRolesLib.ROLE_SET_SUBREGISTRY
    | RegistryRolesLib.ROLE_SET_SUBREGISTRY_ADMIN | RegistryRolesLib.ROLE_SET_RESOLVER
    | RegistryRolesLib.ROLE_SET_RESOLVER_ADMIN | RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN;

/// @title Fixed-price ERC20 subname registrar (ENSv2 contract-developer tutorial pattern).
/// @notice Registers `label` under the parent's registry for a fixed annual price in PAYMENT_TOKEN,
/// pulled from the caller. The parent owner controls the registry, so there is no commit-reveal:
/// the caller approves the price and registers in one atomic batch.
/// @dev Needs ROLE_REGISTRAR and ROLE_RENEW on the registry root. Devnet only; unaudited.
contract SimpleSubnameRegistrar {
    using SafeERC20 for IERC20;

    IPermissionedRegistry public immutable REGISTRY;
    IERC20 public immutable PAYMENT_TOKEN;
    address public immutable BENEFICIARY;
    /// @notice Price per 365 days, in the payment token's smallest unit.
    uint256 public immutable PRICE;
    uint64 public immutable MIN_DURATION;

    error NameNotAvailable(string label);
    error NameNotRegistered(string label);
    error InvalidOwner();
    error DurationTooShort(uint64 duration, uint64 minDuration);

    event NameRegistered(
        uint256 indexed tokenId,
        string label,
        address indexed owner,
        address indexed payer,
        address resolver,
        uint256 price,
        uint64 expiry
    );
    event NameRenewed(uint256 indexed tokenId, string label, address indexed payer, uint256 price, uint64 expiry);

    constructor(
        IPermissionedRegistry registry,
        IERC20 paymentToken,
        address beneficiary,
        uint256 price,
        uint64 minDuration
    ) {
        REGISTRY = registry;
        PAYMENT_TOKEN = paymentToken;
        BENEFICIARY = beneficiary;
        PRICE = price;
        MIN_DURATION = minDuration;
    }

    function isAvailable(string calldata label) public view returns (bool) {
        return REGISTRY.getStatus(LibLabel.id(label)) == IPermissionedRegistry.Status.AVAILABLE;
    }

    /// @dev Rounds down: keep PRICE and MIN_DURATION large enough that no allowed duration is free.
    function getPrice(uint64 duration) public view returns (uint256) {
        return PRICE * duration / 365 days;
    }

    /// @notice Pay getPrice(duration) from the caller and register `label` to `owner`.
    function register(string calldata label, address owner, address resolver, uint64 duration)
        external
        returns (uint256 tokenId)
    {
        if (!isAvailable(label)) revert NameNotAvailable(label);
        if (owner == address(0)) revert InvalidOwner();
        if (duration < MIN_DURATION) revert DurationTooShort(duration, MIN_DURATION);
        uint256 price = getPrice(duration);
        PAYMENT_TOKEN.safeTransferFrom(msg.sender, BENEFICIARY, price);
        uint64 expiry = uint64(block.timestamp) + duration;
        tokenId = REGISTRY.register(label, owner, IRegistry(address(0)), resolver, REGISTRATION_ROLE_BITMAP, expiry);
        emit NameRegistered(tokenId, label, owner, msg.sender, resolver, price, expiry);
    }

    /// @notice Pay getPrice(duration) from the caller and extend `label`. Anyone can renew any name.
    function renew(string calldata label, uint64 duration) external {
        IPermissionedRegistry.State memory state = REGISTRY.getState(LibLabel.id(label));
        if (state.status != IPermissionedRegistry.Status.REGISTERED) revert NameNotRegistered(label);
        if (duration < MIN_DURATION) revert DurationTooShort(duration, MIN_DURATION);
        uint256 price = getPrice(duration);
        PAYMENT_TOKEN.safeTransferFrom(msg.sender, BENEFICIARY, price);
        uint64 expiry = state.expiry + duration;
        REGISTRY.renew(state.tokenId, expiry);
        emit NameRenewed(state.tokenId, label, msg.sender, price, expiry);
    }
}
