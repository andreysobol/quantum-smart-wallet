// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {V4Quoter} from "@uniswap/v4-periphery/src/lens/V4Quoter.sol";
import {StateView} from "@uniswap/v4-periphery/src/lens/StateView.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {WETH} from "../lib/universal-router/lib/solmate/src/tokens/WETH.sol";
import {UniversalRouter} from "../lib/universal-router/contracts/UniversalRouter.sol";
import {RouterParameters} from "../lib/universal-router/contracts/types/RouterParameters.sol";
import {DemoUSDC} from "../src/DemoUSDC.sol";
import {QuantumAccountFactory} from "../src/QuantumAccountFactory.sol";
import {QuantumGuardHook} from "../src/QuantumGuardHook.sol";
import {SlhDsaVerifier} from "../src/SlhDsaSha2_128s.sol";

/// @dev Dedicated CREATE2 origin: no dependency on a preinstalled 0x4e59 proxy.
contract DemoHookDeployer {
    error DeploymentFailed();

    function deploy(bytes32 salt, bytes memory initCode) external returns (address deployed) {
        assembly ("memory-safe") {
            deployed := create2(0, add(initCode, 0x20), mload(initCode), salt)
        }
        if (deployed == address(0)) revert DeploymentFailed();
    }
}

/// @notice Reproducible official Uniswap v4 stack and QuantumGuard demo pool.
/// @dev Requires public DEMO_DEPLOYER, DEMO_STAKING_REGISTRY and DEMO_GENESIS_HASH.
/// Pass the signer to Forge; this script never reads or serializes private keys.
/// A completed deployment manifest may be reused on the same genesis. For an
/// interrupted broadcast, use Forge --resume before reusing its manifest.
contract DeployDemo is Script {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 public constant DEMO_CHAIN_ID = 81411338;
    uint256 public constant ACCOUNT_STAKE = 0.012 ether;
    uint32 public constant UNSTAKE_DELAY = 1 days;
    uint24 public constant LP_FEE = 3000;
    int24 public constant TICK_SPACING = 60;
    uint256 public constant LP_USDC = 20_000 * 1e6;
    uint256 public constant LP_WETH = 10 ether;
    uint256 private constant HOOK_MASK = 0x3fff;
    uint256 private constant BEFORE_SWAP_FLAG = 0x80;

    struct Deployment {
        address verifier;
        address stakingRegistry;
        address poolManager;
        address permit2;
        address weth9;
        address positionManager;
        address universalRouter;
        address quoter;
        address stateView;
        address demoUsdc;
        address accountFactory;
        address hookDeployer;
        address quantumGuardHook;
        bytes32 hookSalt;
        uint256 positionTokenId;
        uint128 liquidity;
    }

    function run() external returns (Deployment memory deployment) {
        require(block.chainid == DEMO_CHAIN_ID, "wrong dedicated demo chain");
        address deployer = vm.envAddress("DEMO_DEPLOYER");
        require(deployer != address(0), "zero demo deployer");
        bytes32 genesis = vm.envBytes32("DEMO_GENESIS_HASH");
        require(genesis != bytes32(0), "missing genesis hash");
        string memory output = vm.envOr("DEMO_OUTPUT", string.concat(vm.projectRoot(), "/deployments/demo.json"));
        deployment = _load(output, genesis);
        deployment.stakingRegistry = vm.envOr("DEMO_STAKING_REGISTRY", deployment.stakingRegistry);
        require(deployment.stakingRegistry.code.length != 0, "staking registry has no code");
        deployment.verifier = vm.envOr("DEMO_VERIFIER", deployment.verifier);
        deployment.permit2 = vm.envOr("DEMO_PERMIT2", deployment.permit2);

        vm.startBroadcast(deployer);
        _deployProtocols(deployment, deployer);
        _deployQuantumGuard(deployment);
        PoolKey memory key = poolKey(deployment.demoUsdc, deployment.weth9, deployment.quantumGuardHook);
        _provisionPool(deployment, key, deployer);
        vm.stopBroadcast();

        _write(output, genesis, deployer, deployment, key);
        // Read only the public address manifest produced immediately above.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        console2.log(vm.readFile(output));
    }

    function _deployProtocols(Deployment memory d, address deployer) internal {
        if (d.verifier == address(0)) d.verifier = address(new SlhDsaVerifier());
        _requireCode(d.verifier);
        if (d.poolManager == address(0)) d.poolManager = address(new PoolManager(deployer));
        _requireCode(d.poolManager);
        require(PoolManager(d.poolManager).owner() == deployer, "unexpected protocol fee owner");
        if (d.permit2 == address(0)) d.permit2 = _deployPermit2();
        _requireCode(d.permit2);
        if (d.weth9 == address(0)) d.weth9 = address(new WETH());
        _requireCode(d.weth9);
        if (d.demoUsdc == address(0)) d.demoUsdc = address(new DemoUSDC(deployer));
        _requireCode(d.demoUsdc);
        require(DemoUSDC(d.demoUsdc).MINTER() == deployer, "unexpected token minter");
        if (d.positionManager == address(0)) {
            d.positionManager = address(
                new PositionManager(
                    IPoolManager(d.poolManager),
                    IAllowanceTransfer(d.permit2),
                    250_000,
                    IPositionDescriptor(address(0)),
                    IWETH9(d.weth9)
                )
            );
        }
        _requireCode(d.positionManager);
        require(
            address(PositionManager(payable(d.positionManager)).poolManager()) == d.poolManager,
            "position manager mismatch"
        );
        if (d.universalRouter == address(0)) {
            d.universalRouter = address(
                new UniversalRouter(
                    RouterParameters({
                        permit2: d.permit2,
                        weth9: d.weth9,
                        v2Factory: address(0),
                        v3Factory: address(0),
                        pairInitCodeHash: bytes32(0),
                        poolInitCodeHash: bytes32(0),
                        v4PoolManager: d.poolManager,
                        permissionsAdapterFactory: address(0),
                        v3NFTPositionManager: address(0),
                        v4PositionManager: d.positionManager,
                        spokePool: address(0)
                    })
                )
            );
        }
        _requireCode(d.universalRouter);
        if (d.quoter == address(0)) d.quoter = address(new V4Quoter(IPoolManager(d.poolManager)));
        _requireCode(d.quoter);
        if (d.stateView == address(0)) d.stateView = address(new StateView(IPoolManager(d.poolManager)));
        _requireCode(d.stateView);
    }

    /// @dev Permit2 pins solc 0.8.17; v4 pins 0.8.26. Build its unchanged
    /// official project separately, then broadcast CREATE with that artifact.
    function _deployPermit2() internal returns (address deployed) {
        bytes memory code = vm.getCode(string.concat(vm.projectRoot(), "/lib/permit2/out/Permit2.sol/Permit2.json"));
        assembly ("memory-safe") {
            deployed := create(0, add(code, 0x20), mload(code))
        }
        require(deployed != address(0), "Permit2 deployment failed");
    }

    function _deployQuantumGuard(Deployment memory d) internal {
        if (d.accountFactory == address(0)) {
            d.accountFactory =
                address(new QuantumAccountFactory(d.verifier, d.stakingRegistry, ACCOUNT_STAKE, UNSTAKE_DELAY));
        }
        _requireCode(d.accountFactory);
        QuantumAccountFactory factory = QuantumAccountFactory(d.accountFactory);
        require(
            factory.VERIFIER() == d.verifier && factory.STAKING_REGISTRY() == d.stakingRegistry,
            "factory trust mismatch"
        );
        require(
            factory.INITIAL_STAKE() == ACCOUNT_STAKE && factory.UNSTAKE_DELAY() == UNSTAKE_DELAY,
            "factory stake mismatch"
        );
        if (d.hookDeployer == address(0)) d.hookDeployer = address(new DemoHookDeployer());
        _requireCode(d.hookDeployer);
        if (d.quantumGuardHook == address(0)) {
            bytes memory initCode = abi.encodePacked(
                type(QuantumGuardHook).creationCode, abi.encode(IPoolManager(d.poolManager), factory, d.universalRouter)
            );
            address predicted;
            (d.hookSalt, predicted) = mineHookSalt(d.hookDeployer, keccak256(initCode));
            d.quantumGuardHook = DemoHookDeployer(d.hookDeployer).deploy(d.hookSalt, initCode);
            require(d.quantumGuardHook == predicted, "unexpected hook address");
        }
        _requireCode(d.quantumGuardHook);
        require(uint160(d.quantumGuardHook) & HOOK_MASK == BEFORE_SWAP_FLAG, "wrong hook permissions");
        QuantumGuardHook hook = QuantumGuardHook(d.quantumGuardHook);
        require(
            address(hook.POOL_MANAGER()) == d.poolManager && address(hook.FACTORY()) == d.accountFactory,
            "hook trust mismatch"
        );
        require(address(hook.UNIVERSAL_ROUTER()) == d.universalRouter, "hook router mismatch");
    }

    function _provisionPool(Deployment memory d, PoolKey memory key, address deployer) internal {
        IPoolManager manager = IPoolManager(d.poolManager);
        (uint160 sqrtPriceX96,,,) = manager.getSlot0(key.toId());
        if (sqrtPriceX96 == 0) {
            sqrtPriceX96 = initialSqrtPriceX96(d.demoUsdc < d.weth9);
            manager.initialize(key, sqrtPriceX96);
        }
        PositionManager positions = PositionManager(payable(d.positionManager));
        if (d.positionTokenId != 0) {
            require(positions.ownerOf(d.positionTokenId) == deployer, "saved LP position missing");
            d.liquidity = manager.getLiquidity(key.toId());
            require(d.liquidity != 0, "saved pool has no liquidity");
            return;
        }
        DemoUSDC usdc = DemoUSDC(d.demoUsdc);
        WETH weth = WETH(payable(d.weth9));
        if (usdc.balanceOf(deployer) < LP_USDC) usdc.mint(deployer, 1_000_000 * 1e6);
        if (weth.balanceOf(deployer) < LP_WETH) weth.deposit{value: LP_WETH - weth.balanceOf(deployer)}();
        usdc.approve(d.permit2, type(uint256).max);
        weth.approve(d.permit2, type(uint256).max);
        IAllowanceTransfer(d.permit2).approve(d.demoUsdc, d.positionManager, type(uint160).max, type(uint48).max);
        IAllowanceTransfer(d.permit2).approve(d.weth9, d.positionManager, type(uint160).max, type(uint48).max);

        int24 lower = TickMath.minUsableTick(TICK_SPACING);
        int24 upper = TickMath.maxUsableTick(TICK_SPACING);
        uint256 amount0 = d.demoUsdc < d.weth9 ? LP_USDC : LP_WETH;
        uint256 amount1 = d.demoUsdc < d.weth9 ? LP_WETH : LP_USDC;
        d.liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), amount0, amount1
        );
        require(d.liquidity != 0, "zero initial liquidity");
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            key,
            lower,
            upper,
            uint256(d.liquidity),
            SafeCast.toUint128(amount0),
            SafeCast.toUint128(amount1),
            deployer,
            bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);
        bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        d.positionTokenId = positions.nextTokenId();
        positions.modifyLiquidities(abi.encode(actions, params), block.timestamp + 1 hours);
        require(positions.ownerOf(d.positionTokenId) == deployer, "LP mint failed");
        require(manager.getLiquidity(key.toId()) != 0, "pool not funded");
    }

    function poolKey(address usdc, address weth, address hook) public pure returns (PoolKey memory) {
        require(usdc != address(0) && weth != address(0) && usdc != weth, "invalid pool tokens");
        return PoolKey({
            currency0: Currency.wrap(usdc < weth ? usdc : weth),
            currency1: Currency.wrap(usdc < weth ? weth : usdc),
            fee: LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(hook)
        });
    }

    /// @dev floor(sqrt(raw token1/token0) * 2**96), at 2,000 USDC/WETH.
    function initialSqrtPriceX96(bool usdcIsToken0) public pure returns (uint160) {
        return usdcIsToken0 ? uint160(1771595571142957102961017161607260) : uint160(3543191142285914205922034);
    }

    function mineHookSalt(address deployer, bytes32 initCodeHash)
        public
        pure
        returns (bytes32 salt, address predicted)
    {
        for (uint256 i; i < 1_000_000; ++i) {
            salt = bytes32(i);
            predicted =
                address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)))));
            if (uint160(predicted) & HOOK_MASK == BEFORE_SWAP_FLAG) return (salt, predicted);
        }
        revert("hook salt search exhausted");
    }

    function _load(string memory path, bytes32 genesis) internal view returns (Deployment memory d) {
        if (!vm.exists(path)) return d;
        // This is the explicitly selected public deployment manifest, never a key file.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory saved = vm.readFile(path);
        require(vm.parseJsonUint(saved, ".chainId") == block.chainid, "manifest chain mismatch");
        require(vm.parseJsonBytes32(saved, ".genesisHash") == genesis, "manifest genesis mismatch");
        d.verifier = vm.parseJsonAddress(saved, ".verifier");
        d.stakingRegistry = vm.parseJsonAddress(saved, ".stakingRegistry");
        d.poolManager = vm.parseJsonAddress(saved, ".poolManager");
        d.permit2 = vm.parseJsonAddress(saved, ".permit2");
        d.weth9 = vm.parseJsonAddress(saved, ".weth9");
        d.positionManager = vm.parseJsonAddress(saved, ".positionManager");
        d.universalRouter = vm.parseJsonAddress(saved, ".universalRouter");
        d.quoter = vm.parseJsonAddress(saved, ".quoter");
        d.stateView = vm.parseJsonAddress(saved, ".stateView");
        d.demoUsdc = vm.parseJsonAddress(saved, ".demoUSDC");
        d.accountFactory = vm.parseJsonAddress(saved, ".accountFactory");
        d.hookDeployer = vm.parseJsonAddress(saved, ".hookDeployer");
        d.quantumGuardHook = vm.parseJsonAddress(saved, ".quantumGuardHook");
        d.hookSalt = vm.parseJsonBytes32(saved, ".hookSalt");
        d.positionTokenId = vm.parseJsonUint(saved, ".positionTokenId");
    }

    function _requireCode(address deployed) private view {
        require(deployed.code.length != 0, "saved deployment has no code; resume broadcast first");
    }

    function _write(string memory path, bytes32 genesis, address deployer, Deployment memory d, PoolKey memory key)
        internal
    {
        string memory name = "demo";
        vm.serializeUint(name, "chainId", block.chainid);
        vm.serializeBytes32(name, "genesisHash", genesis);
        vm.serializeAddress(name, "deployer", deployer);
        vm.serializeString(
            name, "nativeProfile", vm.envOr("DEMO_NATIVE_PROFILE", string("ethrex/eip8141-tracer@9aa3645d"))
        );
        vm.serializeAddress(name, "verifier", d.verifier);
        vm.serializeAddress(name, "stakingRegistry", d.stakingRegistry);
        vm.serializeAddress(name, "poolManager", d.poolManager);
        vm.serializeAddress(name, "permit2", d.permit2);
        vm.serializeAddress(name, "weth9", d.weth9);
        vm.serializeAddress(name, "positionManager", d.positionManager);
        vm.serializeAddress(name, "universalRouter", d.universalRouter);
        vm.serializeAddress(name, "quoter", d.quoter);
        vm.serializeAddress(name, "stateView", d.stateView);
        vm.serializeAddress(name, "demoUSDC", d.demoUsdc);
        vm.serializeAddress(name, "accountFactory", d.accountFactory);
        vm.serializeAddress(name, "hookDeployer", d.hookDeployer);
        vm.serializeAddress(name, "quantumGuardHook", d.quantumGuardHook);
        vm.serializeBytes32(name, "hookSalt", d.hookSalt);
        vm.serializeUint(name, "positionTokenId", d.positionTokenId);
        vm.serializeUint(name, "liquidity", d.liquidity);
        vm.serializeUint(name, "accountInitialStake", ACCOUNT_STAKE);
        vm.serializeUint(name, "accountUnstakeDelay", UNSTAKE_DELAY);
        vm.serializeUint(name, "initialUsdcPerWeth", 2000);
        vm.serializeString(
            name, "wethImplementation", "pinned solmate WETH; IWETH9 compatible, not mainnet WETH9 bytecode"
        );
        vm.serializeString(
            name, "positionMetadata", "zero descriptor; tokenURI unavailable, positions/liquidity operational"
        );
        vm.serializeString(
            name,
            "guardedQuoteMode",
            "simulate UniversalRouter from registered QuantumAccount; V4Quoter is rejected by the guard"
        );
        vm.serializeString(name, "universalRouterCommit", "64027f3372aa235734207c4e05667204f6f927e1");
        vm.serializeString(name, "v4PeripheryCommit", "a7af5b345b479b05fde9182d7e40913a73b3e18f");
        vm.serializeString(name, "v4CoreCommit", "59d3ecf53afa9264a16bba0e38f4c5d2231f80bc");
        string memory json = vm.serializeString(name, "permit2Commit", "cc56ad0f3439c502c246fc5cfcc3db92bb8b7219");
        vm.createDir(string.concat(vm.projectRoot(), "/deployments"), true);
        vm.writeJson(json, path);
        vm.serializeAddress("poolKey", "currency0", Currency.unwrap(key.currency0));
        vm.serializeAddress("poolKey", "currency1", Currency.unwrap(key.currency1));
        vm.serializeUint("poolKey", "fee", key.fee);
        vm.serializeInt("poolKey", "tickSpacing", key.tickSpacing);
        string memory keyJson = vm.serializeAddress("poolKey", "hooks", address(key.hooks));
        vm.writeJson(keyJson, path, ".poolKey");
        vm.writeJson(string.concat('"', vm.toString(PoolId.unwrap(key.toId())), '"'), path, ".poolId");
    }
}
