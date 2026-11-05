// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IV4Router} from "@uniswap/v4-periphery/src/interfaces/IV4Router.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {UniversalRouter} from "@uniswap/universal-router/contracts/UniversalRouter.sol";
import {RouterParameters} from "@uniswap/universal-router/contracts/types/RouterParameters.sol";
import {Commands} from "@uniswap/universal-router/contracts/libraries/Commands.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {WETH} from "solmate/src/tokens/WETH.sol";
import {DemoUSDC} from "../src/DemoUSDC.sol";
import {QuantumAccount} from "../src/QuantumAccount.sol";
import {QuantumAccountFactory} from "../src/QuantumAccountFactory.sol";
import {QuantumGuardHook} from "../src/QuantumGuardHook.sol";
import {SlhDsaVerifier} from "../src/SlhDsaSha2_128s.sol";

/// Real v4 integration: actual PoolManager, UniversalRouter and official Permit2.
/// Forge's prank(account) models the caller provided by a native SENDER frame;
/// it does not replace router locking, hook execution, swaps or token settlement.
contract QuantumGuardHookTest is Test {
    PoolManager internal manager;
    UniversalRouter internal router;
    IAllowanceTransfer internal permit2;
    WETH internal weth;
    DemoUSDC internal usdc;
    SlhDsaVerifier internal verifier;
    QuantumAccountFactory internal factory;
    QuantumGuardHook internal hook;
    QuantumAccount internal account;
    PoolKey internal key;
    address internal liquidityProvider;
    bytes32 internal constant KEY = keccak256("guard integration public key");

    function setUp() public {
        manager = PoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        // Permit2's source pins 0.8.17 and is built separately, unchanged.
        permit2 = IAllowanceTransfer(deployCode("lib/permit2/out/Permit2.sol/Permit2.json"));
        weth = WETH(payable(deployCode("WETH.sol:WETH")));
        usdc = new DemoUSDC(address(this));
        verifier = new SlhDsaVerifier();
        factory = new QuantumAccountFactory(address(verifier), address(0), 0, 0);
        account = factory.createAccount(KEY, bytes32(0));
        RouterParameters memory parameters = RouterParameters({
            permit2: address(permit2),
            weth9: address(weth),
            v2Factory: address(0),
            v3Factory: address(0),
            pairInitCodeHash: bytes32(0),
            poolInitCodeHash: bytes32(0),
            v4PoolManager: address(manager),
            permissionsAdapterFactory: address(0),
            v3NFTPositionManager: address(0),
            v4PositionManager: address(0),
            spokePool: address(0)
        });
        router = UniversalRouter(payable(deployCode("UniversalRouter.sol:UniversalRouter", abi.encode(parameters))));
        hook = new QuantumGuardHook{salt: _mineHookSalt()}(IPoolManager(address(manager)), factory, address(router));
        bool usdcFirst = address(usdc) < address(weth);
        key = PoolKey({
            currency0: Currency.wrap(usdcFirst ? address(usdc) : address(weth)),
            currency1: Currency.wrap(usdcFirst ? address(weth) : address(usdc)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        uint256 price = usdcFirst ? (uint256(1 ether) << 192) / (2000 * 1e6) : (uint256(2000 * 1e6) << 192) / 1 ether;
        manager.initialize(key, uint160(Math.sqrt(price)));

        // An ordinary EOA may seed LP; QuantumGuard gates swaps only.
        liquidityProvider = makeAddr("EOA liquidity provider");
        usdc.mint(liquidityProvider, 1_000_000 * 1e6);
        vm.deal(liquidityProvider, 50 ether);
        PoolModifyLiquidityTest liquidity = new PoolModifyLiquidityTest(IPoolManager(address(manager)));
        vm.startPrank(liquidityProvider);
        weth.deposit{value: 50 ether}();
        usdc.approve(address(liquidity), type(uint256).max);
        weth.approve(address(liquidity), type(uint256).max);
        liquidity.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(60),
                tickUpper: TickMath.maxUsableTick(60),
                liquidityDelta: 1e14,
                salt: bytes32(0)
            }),
            ""
        );
        vm.stopPrank();
        _fundAndApprove(address(account));
    }

    function test_factoryAccountSwapsThroughRealUniversalRouter() public {
        uint256 beforeUsdc = usdc.balanceOf(address(account));
        uint256 beforeWeth = weth.balanceOf(address(account));
        _swap(address(account), 10 * 1e6, "");
        assertEq(usdc.balanceOf(address(account)), beforeUsdc - 10 * 1e6);
        assertGt(weth.balanceOf(address(account)), beforeWeth);
        assertEq(router.msgSender(), address(0));
    }

    function test_eoaCannotSwapThroughTrustedRouter() public {
        address eoa = makeAddr("EOA trader");
        _fundAndApprove(eoa);
        bytes memory failure = _rejectedSwap(eoa, "");
        assertTrue(_containsSelector(failure, QuantumGuardHook.NotQuantumAccount.selector));
        assertEq(usdc.balanceOf(eoa), 1000 * 1e6);
        assertEq(weth.balanceOf(eoa), 0);
    }

    function test_forgedHookDataCannotImpersonateFactoryAccount() public {
        address eoa = makeAddr("hookData forger");
        _fundAndApprove(eoa);
        bytes memory failure = _rejectedSwap(eoa, abi.encode(address(account)));
        assertTrue(_containsSelector(failure, QuantumGuardHook.NotQuantumAccount.selector));
        assertEq(usdc.balanceOf(eoa), 1000 * 1e6);
    }

    function test_nonFactoryQuantumAccountCloneCannotSwap() public {
        QuantumAccount clone = new QuantumAccount(KEY, address(verifier), address(0), 0, 0);
        _fundAndApprove(address(clone));
        bytes memory failure = _rejectedSwap(address(clone), abi.encode(address(account)));
        assertTrue(_containsSelector(failure, QuantumGuardHook.NotQuantumAccount.selector));
        assertFalse(factory.isAccount(address(clone)));
    }

    function test_otherRouterCannotBorrowFactoryIdentityFromHookData() public {
        PoolSwapTest otherRouter = new PoolSwapTest(IPoolManager(address(manager)));
        bool zeroForOne = Currency.unwrap(key.currency0) == address(usdc);
        SwapParams memory params = SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: -int256(10 * 1e6),
            sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        });
        vm.prank(address(account));
        (bool success, bytes memory failure) = address(otherRouter)
            .call(
                abi.encodeCall(
                    otherRouter.swap,
                    (key, params, PoolSwapTest.TestSettings(false, false), abi.encode(address(account)))
                )
            );
        assertFalse(success);
        assertTrue(_containsSelector(failure, QuantumGuardHook.UntrustedRouter.selector));
    }

    function test_directCallbackCannotSpoofPoolManager() public {
        vm.expectRevert(QuantumGuardHook.OnlyPoolManager.selector);
        hook.beforeSwap(address(router), key, _params(), abi.encode(address(account)));
    }

    function test_onlyBeforeSwapPermissionBitIsEnabled() public view {
        assertEq(uint160(address(hook)) & uint160(0x3fff), uint160(0x80));
        Hooks.Permissions memory permissions = hook.getHookPermissions();
        assertTrue(permissions.beforeSwap);
        assertFalse(permissions.beforeSwapReturnDelta);
        assertFalse(permissions.afterSwap);
        assertFalse(permissions.beforeAddLiquidity);
        assertFalse(factory.isAccount(liquidityProvider));
    }

    function test_constructorRejectsIncorrectHookAddressBits() public {
        bytes memory initCode = _hookInitCode();
        bytes32 initHash = keccak256(initCode);
        bytes32 salt;
        address predicted = _predict(salt, initHash);
        while ((uint160(predicted) & uint160(0x3fff)) == uint160(0x80)) {
            salt = bytes32(uint256(salt) + 1);
            predicted = _predict(salt, initHash);
        }
        vm.expectRevert(abi.encodeWithSelector(Hooks.HookAddressNotValid.selector, predicted));
        new QuantumGuardHook{salt: salt}(IPoolManager(address(manager)), factory, address(router));
    }

    function test_registeredAccountCanTradeRepeatedlyWithoutVolumeQuota() public {
        for (uint256 i; i < 3; ++i) {
            _swap(address(account), 10 * 1e6, "");
        }
        assertEq(usdc.balanceOf(address(account)), 970 * 1e6);
        assertGt(weth.balanceOf(address(account)), 0);
    }

    function test_registeredAccountCanTradeLargeAmountWithoutHookLimit() public {
        _swap(address(account), 500 * 1e6, "");
        assertEq(usdc.balanceOf(address(account)), 500 * 1e6);
        assertGt(weth.balanceOf(address(account)), 0);
    }

    function testFuzz_hookDataDoesNotDefineAnAllowedAccount(bytes calldata hookData) public {
        vm.assume(hookData.length <= 512);
        _swap(address(account), 10 * 1e6, hookData);
        assertGt(weth.balanceOf(address(account)), 0);
    }

    function _fundAndApprove(address trader) private {
        usdc.mint(trader, 1000 * 1e6);
        vm.startPrank(trader);
        usdc.approve(address(permit2), type(uint256).max);
        permit2.approve(address(usdc), address(router), type(uint160).max, type(uint48).max);
        vm.stopPrank();
    }

    function _swap(address trader, uint128 amountIn, bytes memory hookData) private {
        (bytes memory commands, bytes[] memory inputs) = _swapData(amountIn, hookData);
        vm.prank(trader);
        router.execute(commands, inputs, block.timestamp);
    }

    function _rejectedSwap(address trader, bytes memory hookData) private returns (bytes memory failure) {
        (bytes memory commands, bytes[] memory inputs) = _swapData(10 * 1e6, hookData);
        vm.prank(trader);
        (bool success, bytes memory data) = address(router)
            .call(abi.encodeWithSignature("execute(bytes,bytes[],uint256)", commands, inputs, block.timestamp));
        assertFalse(success);
        return data;
    }

    function _swapData(uint128 amountIn, bytes memory hookData)
        private
        view
        returns (bytes memory commands, bytes[] memory inputs)
    {
        bytes memory actions = abi.encodePacked(
            uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL)
        );
        bytes[] memory parameters = new bytes[](3);
        parameters[0] = abi.encode(
            IV4Router.ExactInputSingleParams({
                poolKey: key,
                zeroForOne: Currency.unwrap(key.currency0) == address(usdc),
                amountIn: amountIn,
                amountOutMinimum: 1,
                minHopPriceX36: 0,
                hookData: hookData
            })
        );
        parameters[1] = abi.encode(Currency.wrap(address(usdc)), uint256(amountIn));
        parameters[2] = abi.encode(Currency.wrap(address(weth)), uint256(1));
        commands = abi.encodePacked(uint8(Commands.V4_SWAP));
        inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, parameters);
    }

    function _params() private view returns (SwapParams memory) {
        bool zeroForOne = Currency.unwrap(key.currency0) == address(usdc);
        return SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: -int256(10 * 1e6),
            sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        });
    }

    function _hookInitCode() private view returns (bytes memory) {
        return abi.encodePacked(
            type(QuantumGuardHook).creationCode, abi.encode(IPoolManager(address(manager)), factory, address(router))
        );
    }

    function _predict(bytes32 salt, bytes32 initHash) private view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initHash)))));
    }

    function _mineHookSalt() private view returns (bytes32) {
        bytes memory preimage = abi.encodePacked(bytes1(0xff), address(this), bytes32(0), keccak256(_hookInitCode()));
        for (uint256 i; i < 1_000_000; ++i) {
            bytes32 digest;
            assembly ("memory-safe") {
                mstore(add(preimage, 53), i)
                digest := keccak256(add(preimage, 32), 85)
            }
            if ((uint160(uint256(digest)) & uint160(0x3fff)) == uint160(0x80)) return bytes32(i);
        }
        revert("hook salt not found");
    }

    function _containsSelector(bytes memory data, bytes4 wanted) private pure returns (bool) {
        for (uint256 i; i + 4 <= data.length; ++i) {
            bytes4 candidate;
            assembly ("memory-safe") { candidate := mload(add(add(data, 32), i)) }
            if (candidate == wanted) return true;
        }
        return false;
    }
}
