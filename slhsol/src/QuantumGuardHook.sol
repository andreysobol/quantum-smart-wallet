// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {QuantumAccountFactory} from "./QuantumAccountFactory.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";

interface IUniversalRouterInitiator {
    function msgSender() external view returns (address);
}

/// @notice A beforeSwap-only pool guard for factory-created QuantumAccounts.
/// @dev The native transaction already checked PQ authorization. This hook checks
/// account provenance without re-verifying the expensive signature. It trusts only
/// the pinned UniversalRouter, whose Dispatcher.msgSender() returns the initiator
/// held in its reentrancy lock. Untrusted hookData never supplies identity.
contract QuantumGuardHook {
    IPoolManager public immutable POOL_MANAGER;
    QuantumAccountFactory public immutable FACTORY;
    IUniversalRouterInitiator public immutable UNIVERSAL_ROUTER;

    error InvalidConfiguration();
    error OnlyPoolManager();
    error UntrustedRouter();
    error NotQuantumAccount(address initiator);

    constructor(IPoolManager manager, QuantumAccountFactory factory, address universalRouter) {
        if (address(manager).code.length == 0 || address(factory).code.length == 0 || universalRouter.code.length == 0)
        {
            revert InvalidConfiguration();
        }
        POOL_MANAGER = manager;
        FACTORY = factory;
        UNIVERSAL_ROUTER = IUniversalRouterInitiator(universalRouter);
        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
    }

    /// @notice Only beforeSwap is enabled; no amount, volume or daily limit exists.
    function getHookPermissions() public pure returns (Hooks.Permissions memory permissions) {
        permissions.beforeSwap = true;
    }

    /// @dev The other IHooks callbacks are intentionally absent. Address permission
    /// validation guarantees the PoolManager invokes only beforeSwap on this hook.
    function beforeSwap(address sender, PoolKey calldata, SwapParams calldata, bytes calldata)
        external
        view
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (msg.sender != address(POOL_MANAGER)) revert OnlyPoolManager();
        if (sender != address(UNIVERSAL_ROUTER)) revert UntrustedRouter();
        address initiator = UNIVERSAL_ROUTER.msgSender();
        if (!FACTORY.isAccount(initiator)) revert NotQuantumAccount(initiator);
        return (IHooks.beforeSwap.selector, BeforeSwapDelta.wrap(0), 0);
    }
}
