# Solidity contracts

Contracts for [Quantum Smart Wallet](../README.md): a smart account that authorizes operations with SLH-DSA-SHA2-128s signatures, executes sponsored frame transactions, trades through Uniswap v4 and registers ENSv2 names.

The shared deployment runs on chain **81411338**, using the ethrex `9aa3645d` frame-transaction profile.

Research code for a devnet. The contracts have not been audited.

## Contract provenance

### Implemented in this repository

| Contract | Purpose |
| --- | --- |
| [QuantumAccount](src/QuantumAccount.sol) | Checks the user’s PQ signature and approves native execution. Stores the public key and permits self-authorized key rotation. |
| [QuantumAccountFactory](src/QuantumAccountFactory.sol) | Deploys accounts with CREATE2, configures their initial stake and records which accounts it created. |
| [FrameTxSupport](src/FrameTxSupport.sol) | Provides immutable opcode adapters for the pinned EIP-8141 profile, following the workshop’s adapter pattern. |
| [SlhDsaSha2_128s and SlhDsaVerifier](src/SlhDsaSha2_128s.sol) | Our Solidity implementation of the NIST-standardized signature scheme and its external verification interface. |
| [QuantumGuardHook](src/QuantumGuardHook.sol) | Restricts the guarded Uniswap v4 pool to factory-created accounts using the configured Universal Router. |
| [DemoUSDC](src/DemoUSDC.sol) | Six-decimal test ERC20 with a fixed minter. Uses OpenZeppelin’s ERC20 implementation. |
| [DemoHookDeployer](script/DeployDemo.s.sol) | Deploys the hook with CREATE2 at an address carrying the required v4 permission bits. |
| [ENSVault](ensv2/src/ENSVault.sol) | Receives ENS name tokens and executes name-management calls exclusively for its QuantumAccount controller. |
| [ENSVaultFactory](ensv2/src/ENSVaultFactory.sol) | Deploys one deterministic vault per factory-created account. |
| [SimpleSubnameRegistrar](ensv2/src/SimpleSubnameRegistrar.sol) | Our adaptation of the official ENSv2 ERC20 registrar tutorial, with fixed-price dUSDC registration and renewal. |

The staking registry is a [local implementation](../infra/devnet/genesis/NaiveStakingRegistry.sol) predeployed in the devnet genesis.

### Upstream contracts deployed on the devnet

We deployed these existing open-source contracts without changing their Solidity implementations:

| Project | Contracts |
| --- | --- |
| [Uniswap v4 core](https://github.com/Uniswap/v4-core) | PoolManager |
| [Uniswap v4 periphery](https://github.com/Uniswap/v4-periphery) | PositionManager, V4Quoter, StateView |
| [Uniswap Universal Router](https://github.com/Uniswap/universal-router) | UniversalRouter |
| [Uniswap Permit2](https://github.com/Uniswap/permit2) | Permit2 |
| [Solmate](https://github.com/transmissions11/solmate) | WETH |
| [ENSv2](https://github.com/ensdomains/contracts-v2) | PermissionedRegistry, PermissionedResolver, UniversalResolverV2, VerifiableFactory, LabelStore, ContractNamer and BatchGatewayProvider |

The dependency revisions are pinned in Git submodules and recorded in the deployment manifests.

## SLH-DSA verifier

Solidity verifier for **SLH-DSA-SHA2-128s**, a hash-based post-quantum signature scheme specified in [NIST FIPS 205](https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.205.pdf).

It implements pure SLH-DSA verification with a context string and uses the SHA-256 precompile.

```solidity
bool valid = verifier.verify(publicKey, message, context, signature);
```

- Public key: 32 bytes, `PK.seed || PK.root`.
- Signature: 7,856 bytes.
- Context: up to 255 bytes; use empty bytes if unused.

Returns `false` for invalid signatures or incorrect key/signature lengths. Reverts if the context exceeds 255 bytes.

For QuantumAccount, the message is the raw 32-byte native signing hash. The account requires this exact context:

```text
QuantumSmartWallet/SLH-DSA-SHA2-128s/v1
```

The general verifier accepts the context supplied by its caller; QuantumAccount fixes it for wallet authorization.

## Smart account and frame transactions

[EIP-8141](https://eips.ethereum.org/EIPS/eip-8141) separates account validation, fee approval and execution into frames.

`QuantumAccount.validateFrame()` checks the native caller, transaction sender, frame mode, approval scope and signature entry. It reads the signing hash and signature from the native envelope, calls SlhDsaVerifier and executes `APPROVE` after successful verification.

The account’s spending authority is its SLH-DSA key. A separate secp256k1 signature authorizes the sponsor’s gas payment.

A sponsored swap contains five frames:

| Frame | Mode | Operation |
| --- | --- | --- |
| 0 | `VERIFY` | QuantumAccount verifies the PQ signature and approves execution. |
| 1 | `VERIFY` | The sponsor approves fee payment. |
| 2 | `SENDER` | Approve the input token for Permit2. |
| 3 | `SENDER` | Approve Universal Router through Permit2. |
| 4 | `SENDER` | Execute the Uniswap v4 swap. |

The three execution frames form one atomic batch. Targets, amounts, fee limits, minimum output and deadline are covered by the signed envelope.

The protocol handles nonces. `rotateKey(bytes32)` changes the public key through a self-call authorized by the current key.

### Factory and native opcode support

QuantumAccountFactory binds the initial key and account configuration into the CREATE2 address. Its `isAccount(address)` registry contains accounts it deployed.

The shared factory configures **0.012 ETH** of stake and an **86,400-second** unstake delay. The operator funds account creation and stake.

FrameTxSupport deploys fixed opcode adapters because stock Solidity does not emit the required native instructions. Reads use `STATICCALL`; `APPROVE` uses `DELEGATECALL` to preserve the account context.

Use the repository’s codec when constructing transactions. It targets the tested devnet profile, whose encoding can differ from newer EIP drafts.

## ERC-8421 alternative mempool

The shared devnet uses a custom [ERC-8421 alternative mempool](https://ethereum-magicians.org/t/erc-8421-frame-transaction-alternative-mempools/29800) for simulation, admission and relay.

The recorded swap spends approximately **1.1 million execution gas on account validation**. The custom policy grants an onchain-staked sender a verification budget of **2.5 million gas**; other distinct entities retain the 100,000-gas budget.

Sender verification and batch execution have separate limits. The policy retains signature, trace, opcode, storage and balance checks.

Stake is locked collateral. Transaction fees come from the sponsor’s ETH balance.

See the [policy configuration](../infra/devnet/policy.yaml) and [devnet guide](../infra/devnet/README.md).

## Uniswap v4

The official contracts provide the AMM, routing, allowances, liquidity positions and pool-state reads. Our integration adds QuantumGuardHook and the native transaction flow.

`QuantumGuardHook.beforeSwap()` checks:

1. The caller is PoolManager.
2. The swap uses the configured Universal Router.
3. The router’s actual initiator is registered by QuantumAccountFactory.

The hook checks account provenance. QuantumAccount and SlhDsaVerifier perform signature verification.

The guarded dUSDC/WETH pool uses a **0.3% fee** and **tick spacing 60**. It was initially funded with **20,000 dUSDC and approximately 10 WETH**. The hook imposes no volume or daily limits.

The pool is state inside PoolManager, identified by:

```text
0x91ea57c02be0f80cc7409964629262064ba5258cd9db38dc1a7bb6ab7c292e8b
```

Quotes use router simulation or pool-state calculations. The standalone V4Quoter callback does not pass the hook’s trusted-router check.

## Demo tokens

**DemoUSDC (`dUSDC`)** is our test token. It has six decimals and a fixed operator minter. It funds the pool, wallet faucet and ENS registration payments.

**WETH** is the upstream Solmate implementation. Depositing test ETH mints an equal amount of WETH; withdrawing burns WETH and returns ETH. It is IWETH9-compatible.

Both assets belong to this devnet and have no monetary value.

## ENSv2

The local namespace issues names such as `alice.qsw.eth`, paid in dUSDC. These names exist on chain 81411338 and do not reserve public `.eth` names.

The upstream ENSv2 contracts are pinned to:

```text
ensdomains/contracts-v2
v2-mainnet-deployment-1
62778d80038e50cb23514eab1b7d66ceb8a41e1c
```

### Vault and factory

ENSv2 registries mint names as ERC-1155 tokens. The deployed QuantumAccount lacks the receiver hooks required to accept them.

ENSVault provides that receiver:

- **Token owner:** ENSVault.
- **Controller:** QuantumAccount, fixed at vault construction.
- **Address record:** resolves to QuantumAccount.
- **Resolver:** an official PermissionedResolver proxy controlled by the vault.

Only the controller can call `vault.execute(target, data)`. The vault accepts ERC-1155 and ERC-721 tokens and implements ERC-165.

ENSVaultFactory creates one deterministic vault per factory-created account. Creation is permissionless and idempotent; creating another account’s vault grants no control over it.

### Registrar

SimpleSubnameRegistrar follows the official ENSv2 ERC20 registrar tutorial. It charges **5 dUSDC per year**, with a minimum duration of **one year**. Fees go to the configured beneficiary.

Registration is one six-frame transaction. After the account and sponsor `VERIFY` frames, an atomic batch:

1. Creates the vault if needed.
2. Approves the registration price in dUSDC.
3. Registers the name to the vault.
4. Sets the address record through the vault’s resolver.

The user pays the name price in dUSDC; the sponsor pays gas.

See the [ENSv2 guide](ensv2/README.md) for namespace permissions, deployment and tests.

## Shared devnet addresses

### Shared contracts

| Contract | Address |
| --- | --- |
| QuantumAccountFactory | `0x573b8fC3b0d72b3B859eACBA67fA3224Ecb55181` |
| SlhDsaVerifier | `0xC5e49792793820a75e4979b442058c95456FdB01` |
| QuantumGuardHook | `0xc83EE6088f08ca9307c10a54A32F7CfB748F4080` |
| Hook CREATE2 deployer | `0x2C20466dfc4D022Fbb593483086E38E27dAE2652` |
| Staking registry | `0xD51c04d7A0B01124E84DE152F4e56d9eeCB22D2F` |
| PoolManager | `0x80E825e141C8f1d58C4d8DB19FB11f05D098a549` |
| UniversalRouter | `0xBf8badae6056b59beC3d993936Ab8627aA2A4D34` |
| Permit2 | `0x389e7536AB422DF13370e7D713Cabd22BDe9d6C9` |
| PositionManager | `0xE5F2b614f2033CeA373BBDb649143BD8973E8858` |
| V4Quoter | `0x9939150f48CA03bbF72791321BaebF83E0BfDd21` |
| StateView | `0x25FC0eCfB3aA85bf1562c945B9d34235038d3cF7` |
| DemoUSDC | `0x3636a1d9A30C46264822F1A47975707793770F42` |
| Solmate WETH | `0xeDae4f23AdD2AabBFcAd8972801e6fa90aD4bBF2` |
| ENS root registry | `0xFE65cfc45b406F2D95d0de80a1eA89a7C6dE9c1C` |
| ENS `.eth` registry | `0x7f2DC8E732adb8C55AE9787c8ed4D78Ea7F35639` |
| ENS `qsw.eth` registry | `0x5Bb30cD38cC07029729A1B614e5c834ce166c9aE` |
| ENS UniversalResolverV2 | `0x6F36B098566f113021BB0eab239f0ba952c4b6CD` |
| SimpleSubnameRegistrar | `0xc1784536C1dF5FBAAA705F4b51e542F14215E257` |
| ENSVaultFactory | `0xA9aBbA3d31F832B3258955FA8aD0DB1B49A96e24` |
| PermissionedResolver implementation | `0xd77E82fF952C9b9E80771F42C4D0344795C6d187` |
| VerifiableFactory | `0x6c7C51937c2Af20bf7f59edaf471Bf0D8907930E` |
| LabelStore | `0x9a5F29C3d7782f4bFb1A7e399c5f3C7569df630d` |
| BatchGatewayProvider | `0xF8AF1d5BD6Df31ABf3Be64a295059f93D0678a1D` |
| ContractNamer proxy | `0x8B28fbFdAbC7a510c3912D3E4879e896C6601b91` |
| ContractNamer implementation | `0x1db412F8Ae3BBFcc32e813251FE8a0B8F09b0B1b` |

The operator and sponsor EOA is:

```text
0xb7Ca4C821205f6721bacbd48052bEbF6A1f252c1
```

### Per-account examples

Accounts, opcode adapters, vaults and resolver proxies are created per account.

| Instance | Address |
| --- | --- |
| Swap demo account | `0x19b17f47284db0b254c62eb9ad6ce95538e3bc30` |
| ENS demo account | `0xc19245E98CAa3680179F81b8a0C8795810Cd5775` |
| Its ENSVault | `0xB6a82373C7531d4064e3A7DFE398aa4c02d7Ae36` |
| Its resolver proxy | `0x0515e5f0302569115102747af12641C0EE3086ED` |

Use `ENSVaultFactory.vaultAddress(account)` and `resolverAddress(account)` for another account.

Deployment records: [shared manifest](deployments/shared-devnet.json) and [ENSv2 manifest](ensv2/deployments/shared-devnet.json).

| Service | URL |
| --- | --- |
| Wallet | https://quantum-smart-wallet.vercel.app/ |
| Execution RPC | https://altmempool.bailo.london/rpc |
| Alternative mempool | https://altmempool.bailo.london/mempool |
| Explorer | https://altmempool.bailo.london/explorer/ |

## Verified transactions

| Operation | Block | Result |
| --- | --- | --- |
| [Sponsored swap](https://altmempool.bailo.london/explorer/chain/tx/0x5372c2b13aa087361c62475f8b28f843012a9fb2ae4e4692878d80efcb28fa1e) | 408 | 1 dUSDC → 0.000498475151013721 WETH; all five frames succeeded. |
| [ENSv2 registration](https://altmempool.bailo.london/explorer/chain/tx/0xfcf79147e658857dca200fb97c7f6af3b440298340fa3ebf798745fa7012a7ab) | 8139 | `qswmw56wsx5.qsw.eth`; all six frames succeeded. |

Swap receipts, signed transaction bytes and admission reports are saved in [the demo evidence](../demo/evidence/shared-devnet/).

## Build and test

From the repository root, with Git and Foundry installed:

```bash
git submodule update --init --recursive
bash slhsol/script/build_permit2.sh
forge build --root slhsol
forge test --root slhsol
```

The main project uses Solidity 0.8.26, Cancun, via IR and 200 optimizer runs. Permit2 uses a separate Solidity 0.8.17 build.

ENSv2 is a separate Foundry project. Initialize its pinned dependencies using the [ENSv2 guide](ensv2/README.md#build-test-deploy), then run:

```bash
forge test --root slhsol/ensv2
```

Forge and Anvil do not execute the devnet’s EIP-8141 opcodes. Unit tests mock the native context; the shared-devnet transactions above exercise native execution.

Deployment instructions: [wallet and Uniswap v4](deployments/README.md), [ENSv2](ensv2/README.md), and [the sponsored WASM swap](../demo/README.md).
