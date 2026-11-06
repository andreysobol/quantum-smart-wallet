/**
 * Contract ABIs for the shared devnet deployment (viem `as const`), generated from the
 * pinned Foundry artifacts (slhsol out/, lib/permit2/out/) and the genesis staking
 * registry ABI. StateView adds getTickBitmap/getTickLiquidity from v4-periphery.
 * UniversalRouter keeps execute/msgSender and the errors a swap can surface.
 */

export const factoryAbi = [
  {"type": "function", "name": "getAddress", "inputs": [{"name": "publicKey", "type": "bytes32"}, {"name": "salt", "type": "bytes32"}], "outputs": [{"name": "", "type": "address"}], "stateMutability": "view"},
  {"type": "function", "name": "createAccount", "inputs": [{"name": "publicKey", "type": "bytes32"}, {"name": "salt", "type": "bytes32"}], "outputs": [{"name": "account", "type": "address"}], "stateMutability": "payable"},
  {"type": "function", "name": "isAccount", "inputs": [{"name": "account", "type": "address"}], "outputs": [{"name": "registered", "type": "bool"}], "stateMutability": "view"},
  {"type": "function", "name": "INITIAL_STAKE", "inputs": [], "outputs": [{"name": "", "type": "uint256"}], "stateMutability": "view"},
  {"type": "function", "name": "UNSTAKE_DELAY", "inputs": [], "outputs": [{"name": "", "type": "uint32"}], "stateMutability": "view"},
  {"type": "function", "name": "VERIFIER", "inputs": [], "outputs": [{"name": "", "type": "address"}], "stateMutability": "view"},
  {"type": "function", "name": "STAKING_REGISTRY", "inputs": [], "outputs": [{"name": "", "type": "address"}], "stateMutability": "view"},
  {"type": "event", "name": "AccountCreated", "inputs": [{"name": "account", "type": "address", "indexed": true}, {"name": "publicKey", "type": "bytes32", "indexed": true}, {"name": "salt", "type": "bytes32", "indexed": true}], "anonymous": false},
  {"type": "error", "name": "InsufficientValue", "inputs": []},
  {"type": "error", "name": "InvalidConfiguration", "inputs": []},
  {"type": "error", "name": "InvalidPublicKey", "inputs": []},
  {"type": "error", "name": "UnexpectedValueForExistingAccount", "inputs": []},
] as const;

export const accountAbi = [
  {"type": "function", "name": "publicKey", "inputs": [], "outputs": [{"name": "", "type": "bytes32"}], "stateMutability": "view"},
  {"type": "function", "name": "validateFrame", "inputs": [], "outputs": [], "stateMutability": "nonpayable"},
  {"type": "function", "name": "rotateKey", "inputs": [{"name": "newPublicKey", "type": "bytes32"}], "outputs": [], "stateMutability": "nonpayable"},
  {"type": "function", "name": "SIGNING_CONTEXT", "inputs": [], "outputs": [{"name": "", "type": "bytes"}], "stateMutability": "view"},
  {"type": "function", "name": "SIGNATURE_LENGTH", "inputs": [], "outputs": [{"name": "", "type": "uint256"}], "stateMutability": "view"},
  {"type": "function", "name": "NATIVE_ENTRY_POINT", "inputs": [], "outputs": [{"name": "", "type": "address"}], "stateMutability": "view"},
  {"type": "function", "name": "VERIFIER", "inputs": [], "outputs": [{"name": "", "type": "address"}], "stateMutability": "view"},
  {"type": "event", "name": "PublicKeyRotated", "inputs": [{"name": "previousKey", "type": "bytes32", "indexed": true}, {"name": "newKey", "type": "bytes32", "indexed": true}], "anonymous": false},
  {"type": "error", "name": "InsufficientDeploymentValue", "inputs": []},
  {"type": "error", "name": "InvalidApprovalScope", "inputs": []},
  {"type": "error", "name": "InvalidFrameContext", "inputs": []},
  {"type": "error", "name": "InvalidNativeReturnLength", "inputs": [{"name": "opcode", "type": "uint8"}, {"name": "expected", "type": "uint256"}, {"name": "actual", "type": "uint256"}]},
  {"type": "error", "name": "InvalidPublicKey", "inputs": []},
  {"type": "error", "name": "InvalidSignature", "inputs": []},
  {"type": "error", "name": "InvalidSignatureEntry", "inputs": []},
  {"type": "error", "name": "InvalidSignatureLength", "inputs": []},
  {"type": "error", "name": "InvalidStakeConfiguration", "inputs": []},
  {"type": "error", "name": "InvalidVerifier", "inputs": []},
  {"type": "error", "name": "NativeOpcodeFailed", "inputs": [{"name": "opcode", "type": "uint8"}]},
  {"type": "error", "name": "UnauthorizedCaller", "inputs": []},
] as const;

export const verifierAbi = [
  {"type": "function", "name": "verify", "inputs": [{"name": "pk", "type": "bytes"}, {"name": "message", "type": "bytes"}, {"name": "ctx", "type": "bytes"}, {"name": "sig", "type": "bytes"}], "outputs": [{"name": "", "type": "bool"}], "stateMutability": "view"},
  {"type": "error", "name": "ContextTooLong", "inputs": []},
] as const;

export const demoUsdcAbi = [
  {"type": "function", "name": "mint", "inputs": [{"name": "recipient", "type": "address"}, {"name": "amount", "type": "uint256"}], "outputs": [], "stateMutability": "nonpayable"},
  {"type": "function", "name": "MINTER", "inputs": [], "outputs": [{"name": "", "type": "address"}], "stateMutability": "view"},
  {"type": "function", "name": "balanceOf", "inputs": [{"name": "account", "type": "address"}], "outputs": [{"name": "", "type": "uint256"}], "stateMutability": "view"},
  {"type": "function", "name": "decimals", "inputs": [], "outputs": [{"name": "", "type": "uint8"}], "stateMutability": "pure"},
  {"type": "function", "name": "symbol", "inputs": [], "outputs": [{"name": "", "type": "string"}], "stateMutability": "view"},
  {"type": "function", "name": "name", "inputs": [], "outputs": [{"name": "", "type": "string"}], "stateMutability": "view"},
  {"type": "event", "name": "Transfer", "inputs": [{"name": "from", "type": "address", "indexed": true}, {"name": "to", "type": "address", "indexed": true}, {"name": "value", "type": "uint256", "indexed": false}], "anonymous": false},
  {"type": "error", "name": "ERC20InsufficientAllowance", "inputs": [{"name": "spender", "type": "address"}, {"name": "allowance", "type": "uint256"}, {"name": "needed", "type": "uint256"}]},
  {"type": "error", "name": "ERC20InsufficientBalance", "inputs": [{"name": "sender", "type": "address"}, {"name": "balance", "type": "uint256"}, {"name": "needed", "type": "uint256"}]},
  {"type": "error", "name": "ERC20InvalidApprover", "inputs": [{"name": "approver", "type": "address"}]},
  {"type": "error", "name": "ERC20InvalidReceiver", "inputs": [{"name": "receiver", "type": "address"}]},
  {"type": "error", "name": "ERC20InvalidSender", "inputs": [{"name": "sender", "type": "address"}]},
  {"type": "error", "name": "ERC20InvalidSpender", "inputs": [{"name": "spender", "type": "address"}]},
  {"type": "error", "name": "InvalidMinter", "inputs": []},
  {"type": "error", "name": "UnauthorizedMinter", "inputs": []},
] as const;

export const erc20Abi = [
  {"type": "function", "name": "approve", "inputs": [{"name": "spender", "type": "address"}, {"name": "value", "type": "uint256"}], "outputs": [{"name": "", "type": "bool"}], "stateMutability": "nonpayable"},
  {"type": "function", "name": "allowance", "inputs": [{"name": "owner", "type": "address"}, {"name": "spender", "type": "address"}], "outputs": [{"name": "", "type": "uint256"}], "stateMutability": "view"},
  {"type": "function", "name": "balanceOf", "inputs": [{"name": "account", "type": "address"}], "outputs": [{"name": "", "type": "uint256"}], "stateMutability": "view"},
  {"type": "function", "name": "decimals", "inputs": [], "outputs": [{"name": "", "type": "uint8"}], "stateMutability": "pure"},
  {"type": "function", "name": "symbol", "inputs": [], "outputs": [{"name": "", "type": "string"}], "stateMutability": "view"},
  {"type": "event", "name": "Transfer", "inputs": [{"name": "from", "type": "address", "indexed": true}, {"name": "to", "type": "address", "indexed": true}, {"name": "value", "type": "uint256", "indexed": false}], "anonymous": false},
  {"type": "event", "name": "Approval", "inputs": [{"name": "owner", "type": "address", "indexed": true}, {"name": "spender", "type": "address", "indexed": true}, {"name": "value", "type": "uint256", "indexed": false}], "anonymous": false},
] as const;

export const wethAbi = [
  {"type": "function", "name": "deposit", "inputs": [], "outputs": [], "stateMutability": "payable"},
  {"type": "function", "name": "withdraw", "inputs": [{"name": "amount", "type": "uint256"}], "outputs": [], "stateMutability": "nonpayable"},
  {"type": "function", "name": "balanceOf", "inputs": [{"name": "", "type": "address"}], "outputs": [{"name": "", "type": "uint256"}], "stateMutability": "view"},
  {"type": "function", "name": "approve", "inputs": [{"name": "spender", "type": "address"}, {"name": "amount", "type": "uint256"}], "outputs": [{"name": "", "type": "bool"}], "stateMutability": "nonpayable"},
  {"type": "function", "name": "allowance", "inputs": [{"name": "", "type": "address"}, {"name": "", "type": "address"}], "outputs": [{"name": "", "type": "uint256"}], "stateMutability": "view"},
  {"type": "function", "name": "decimals", "inputs": [], "outputs": [{"name": "", "type": "uint8"}], "stateMutability": "view"},
  {"type": "function", "name": "symbol", "inputs": [], "outputs": [{"name": "", "type": "string"}], "stateMutability": "view"},
  {"type": "event", "name": "Deposit", "inputs": [{"name": "from", "type": "address", "indexed": true}, {"name": "amount", "type": "uint256", "indexed": false}], "anonymous": false},
  {"type": "event", "name": "Withdrawal", "inputs": [{"name": "to", "type": "address", "indexed": true}, {"name": "amount", "type": "uint256", "indexed": false}], "anonymous": false},
  {"type": "event", "name": "Transfer", "inputs": [{"name": "from", "type": "address", "indexed": true}, {"name": "to", "type": "address", "indexed": true}, {"name": "amount", "type": "uint256", "indexed": false}], "anonymous": false},
  {"type": "event", "name": "Approval", "inputs": [{"name": "owner", "type": "address", "indexed": true}, {"name": "spender", "type": "address", "indexed": true}, {"name": "amount", "type": "uint256", "indexed": false}], "anonymous": false},
] as const;

export const permit2Abi = [
  {"type": "function", "name": "approve", "inputs": [{"name": "token", "type": "address"}, {"name": "spender", "type": "address"}, {"name": "amount", "type": "uint160"}, {"name": "expiration", "type": "uint48"}], "outputs": [], "stateMutability": "nonpayable"},
  {"type": "function", "name": "allowance", "inputs": [{"name": "", "type": "address"}, {"name": "", "type": "address"}, {"name": "", "type": "address"}], "outputs": [{"name": "amount", "type": "uint160"}, {"name": "expiration", "type": "uint48"}, {"name": "nonce", "type": "uint48"}], "stateMutability": "view"},
  {"type": "event", "name": "Approval", "inputs": [{"name": "owner", "type": "address", "indexed": true}, {"name": "token", "type": "address", "indexed": true}, {"name": "spender", "type": "address", "indexed": true}, {"name": "amount", "type": "uint160", "indexed": false}, {"name": "expiration", "type": "uint48", "indexed": false}], "anonymous": false},
  {"type": "error", "name": "AllowanceExpired", "inputs": [{"name": "deadline", "type": "uint256"}]},
  {"type": "error", "name": "InsufficientAllowance", "inputs": [{"name": "amount", "type": "uint256"}]},
] as const;

export const universalRouterAbi = [
  {"type": "function", "name": "execute", "inputs": [{"name": "commands", "type": "bytes"}, {"name": "inputs", "type": "bytes[]"}, {"name": "deadline", "type": "uint256"}], "outputs": [], "stateMutability": "payable"},
  {"type": "function", "name": "msgSender", "inputs": [], "outputs": [{"name": "", "type": "address"}], "stateMutability": "view"},
  {"type": "error", "name": "ContractLocked", "inputs": []},
  {"type": "error", "name": "DeltaNotNegative", "inputs": [{"name": "currency", "type": "address"}]},
  {"type": "error", "name": "DeltaNotPositive", "inputs": [{"name": "currency", "type": "address"}]},
  {"type": "error", "name": "ExecutionFailed", "inputs": [{"name": "commandIndex", "type": "uint256"}, {"name": "message", "type": "bytes"}]},
  {"type": "error", "name": "InsufficientETH", "inputs": []},
  {"type": "error", "name": "InsufficientToken", "inputs": []},
  {"type": "error", "name": "TransactionDeadlinePassed", "inputs": []},
  {"type": "error", "name": "V4TooLittleReceived", "inputs": [{"name": "minAmountOutReceived", "type": "uint256"}, {"name": "amountReceived", "type": "uint256"}]},
  {"type": "error", "name": "V4TooMuchRequested", "inputs": [{"name": "maxAmountInRequested", "type": "uint256"}, {"name": "amountRequested", "type": "uint256"}]},
] as const;

export const stateViewAbi = [
  {"type": "function", "name": "getSlot0", "inputs": [{"name": "poolId", "type": "bytes32"}], "outputs": [{"name": "sqrtPriceX96", "type": "uint160"}, {"name": "tick", "type": "int24"}, {"name": "protocolFee", "type": "uint24"}, {"name": "lpFee", "type": "uint24"}], "stateMutability": "view"},
  {"type": "function", "name": "getLiquidity", "inputs": [{"name": "poolId", "type": "bytes32"}], "outputs": [{"name": "liquidity", "type": "uint128"}], "stateMutability": "view"},
  {"type": "function", "name": "getTickBitmap", "inputs": [{"name": "poolId", "type": "bytes32"}, {"name": "tick", "type": "int16"}], "outputs": [{"name": "tickBitmap", "type": "uint256"}], "stateMutability": "view"},
  {"type": "function", "name": "getTickLiquidity", "inputs": [{"name": "poolId", "type": "bytes32"}, {"name": "tick", "type": "int24"}], "outputs": [{"name": "liquidityGross", "type": "uint128"}, {"name": "liquidityNet", "type": "int128"}], "stateMutability": "view"},
] as const;

export const poolManagerAbi = [
  {"type": "event", "name": "Swap", "inputs": [{"name": "id", "type": "bytes32", "indexed": true}, {"name": "sender", "type": "address", "indexed": true}, {"name": "amount0", "type": "int128", "indexed": false}, {"name": "amount1", "type": "int128", "indexed": false}, {"name": "sqrtPriceX96", "type": "uint160", "indexed": false}, {"name": "liquidity", "type": "uint128", "indexed": false}, {"name": "tick", "type": "int24", "indexed": false}, {"name": "fee", "type": "uint24", "indexed": false}], "anonymous": false},
  {"type": "error", "name": "AlreadyUnlocked", "inputs": []},
  {"type": "error", "name": "CurrenciesOutOfOrderOrEqual", "inputs": [{"name": "currency0", "type": "address"}, {"name": "currency1", "type": "address"}]},
  {"type": "error", "name": "CurrencyNotSettled", "inputs": []},
  {"type": "error", "name": "DelegateCallNotAllowed", "inputs": []},
  {"type": "error", "name": "InvalidCaller", "inputs": []},
  {"type": "error", "name": "ManagerLocked", "inputs": []},
  {"type": "error", "name": "MustClearExactPositiveDelta", "inputs": []},
  {"type": "error", "name": "NonzeroNativeValue", "inputs": []},
  {"type": "error", "name": "PoolNotInitialized", "inputs": []},
  {"type": "error", "name": "ProtocolFeeCurrencySynced", "inputs": []},
  {"type": "error", "name": "ProtocolFeeTooLarge", "inputs": [{"name": "fee", "type": "uint24"}]},
  {"type": "error", "name": "SwapAmountCannotBeZero", "inputs": []},
  {"type": "error", "name": "TickSpacingTooLarge", "inputs": [{"name": "tickSpacing", "type": "int24"}]},
  {"type": "error", "name": "TickSpacingTooSmall", "inputs": [{"name": "tickSpacing", "type": "int24"}]},
  {"type": "error", "name": "UnauthorizedDynamicLPFeeUpdate", "inputs": []},
  {"type": "error", "name": "WrappedError", "inputs": [{"name": "target", "type": "address"}, {"name": "selector", "type": "bytes4"}, {"name": "reason", "type": "bytes"}, {"name": "details", "type": "bytes"}]},
  {"type": "error", "name": "HookCallFailed", "inputs": []},
] as const;

export const guardHookAbi = [
  {"type": "function", "name": "FACTORY", "inputs": [], "outputs": [{"name": "", "type": "address"}], "stateMutability": "view"},
  {"type": "function", "name": "UNIVERSAL_ROUTER", "inputs": [], "outputs": [{"name": "", "type": "address"}], "stateMutability": "view"},
  {"type": "function", "name": "POOL_MANAGER", "inputs": [], "outputs": [{"name": "", "type": "address"}], "stateMutability": "view"},
  {"type": "error", "name": "InvalidConfiguration", "inputs": []},
  {"type": "error", "name": "NotQuantumAccount", "inputs": [{"name": "initiator", "type": "address"}]},
  {"type": "error", "name": "OnlyPoolManager", "inputs": []},
  {"type": "error", "name": "UntrustedRouter", "inputs": []},
] as const;

export const stakingRegistryAbi = [
  {"type": "function", "name": "addStake", "inputs": [{"name": "unstakeDelaySec", "type": "uint32"}], "outputs": [], "stateMutability": "payable"},
  {"type": "function", "name": "getDepositInfo", "inputs": [{"name": "account", "type": "address"}], "outputs": [{"name": "stake", "type": "uint256"}, {"name": "unstakeDelaySec", "type": "uint32"}, {"name": "withdrawTime", "type": "uint64"}], "stateMutability": "view"},
  {"type": "function", "name": "unlockStake", "inputs": [], "outputs": [], "stateMutability": "nonpayable"},
  {"type": "function", "name": "withdrawStake", "inputs": [{"name": "withdrawAddress", "type": "address"}], "outputs": [], "stateMutability": "nonpayable"},
] as const;
