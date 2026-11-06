# ENSv2 names for Quantum Smart Wallet

Register `<name>.qsw.eth` with a post-quantum smart account. Names cost **5 dUSDC per year**; the sponsor pays transaction gas.

Runs on the shared devnet, chain **81411338**.

## Contracts

Three contracts implement the wallet integration:

| Contract | Purpose |
|---|---|
| [ENSVault](src/ENSVault.sol) | Holds name tokens and controls their resolver. Only its QuantumAccount controller can execute calls through it. |
| [ENSVaultFactory](src/ENSVaultFactory.sol) | Creates one deterministic vault per account registered with our QuantumAccountFactory. |
| [SimpleSubnameRegistrar](src/SimpleSubnameRegistrar.sol) | Registers and renews `qsw.eth` subnames for dUSDC. Adapted from the ENSv2 ERC-20 registrar tutorial. |

The registries, resolver implementation, UniversalResolverV2 and supporting contracts come from official [ENSv2 contracts](https://github.com/ensdomains/contracts-v2/tree/62778d80038e50cb23514eab1b7d66ceb8a41e1c), deployed without source changes. The dependency is pinned to `v2-mainnet-deployment-1`.

### Why a vault?

ENSv2 names are ERC-1155 tokens. The deployed QuantumAccount does not implement the receiver callback required to accept them.

Each account therefore controls a vault that accepts the tokens:

- **Name owner:** ENSVault.
- **Vault controller:** QuantumAccount.
- **Resolved address:** QuantumAccount.

The vault also controls its own official PermissionedResolver proxy. It has no separate operator or recovery key.

## Registration flow

The browser signs with SLH-DSA through WASM. One sponsored **EIP-8141** transaction contains two verification frames and four execution frames:

1. Verify the account’s post-quantum signature.
2. Verify the sponsor’s gas authorization.
3. Create the account’s vault if needed.
4. Approve the exact dUSDC registration fee.
5. Register the name to the vault.
6. Set the name’s Ethereum address record to the QuantumAccount.

The four execution frames run atomically. The transaction is submitted through the **ERC-8421 alternative mempool**.

The sponsor checks the transaction template, account, nonce, name availability, duration, payment and signature before authorizing it. The wallet supports registration for **1–5 whole years**, without commit-reveal. The account needs dUSDC for the name fee and no ETH for gas.

## Try it

1. Open [Quantum Smart Wallet](https://quantum-smart-wallet.vercel.app/) and create or restore an account.
2. Get test dUSDC from the wallet’s faucet.
3. Open **Names**, choose an available name and registration duration.
4. Confirm registration and follow the transaction link.

An existing registration is **`qswmw56wsx5.qsw.eth`**, resolving to `0xc19245E98CAa3680179F81b8a0C8795810Cd5775`.

[View its registration transaction](https://altmempool.bailo.london/explorer/chain/tx/0xfcf79147e658857dca200fb97c7f6af3b440298340fa3ebf798745fa7012a7ab).

## Shared devnet addresses

| Contract | Address |
|---|---|
| Root registry | `0xFE65cfc45b406F2D95d0de80a1eA89a7C6dE9c1C` |
| `.eth` registry | `0x7f2DC8E732adb8C55AE9787c8ed4D78Ea7F35639` |
| `qsw.eth` registry | `0x5Bb30cD38cC07029729A1B614e5c834ce166c9aE` |
| UniversalResolverV2 | `0x6F36B098566f113021BB0eab239f0ba952c4b6CD` |
| SimpleSubnameRegistrar | `0xc1784536C1dF5FBAAA705F4b51e542F14215E257` |
| ENSVaultFactory | `0xA9aBbA3d31F832B3258955FA8aD0DB1B49A96e24` |
| dUSDC | `0x3636a1d9A30C46264822F1A47975707793770F42` |

All ENS contract addresses and deployment transactions are in [deployments/shared-devnet.json](deployments/shared-devnet.json). Vault and resolver addresses are specific to each account.
