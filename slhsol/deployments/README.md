# Deploying the shared QuantumGuard demo

The checked-in deployment program is `script/DeployDemo.s.sol`. Its target is the
dedicated chain **81411338**. Provision the sealed network first using
[infra/devnet](../../infra/devnet/README.md); Hegota activation, matching native
profile and advancing blocks are prerequisites. An HTTP response alone is not
readiness evidence.

## Pinned build

From the repository root:

```sh
git submodule update --init --recursive
bash slhsol/script/build_permit2.sh
forge build --root slhsol
forge test --root slhsol
```

Permit2 pins Solidity **0.8.17**, so its unchanged official project is built
separately. DeployDemo loads `lib/permit2/out/Permit2.sol/Permit2.json` and broadcasts
CREATE with that artifact. The main project pins **0.8.26**, Cancun and via IR,
matching PoolManager/PositionManager's compiler requirements and UniversalRouter's
code-generation requirements. Do not combine concrete Permit2 source into the
main compilation unit.

The locked UniversalRouter 2.2.0 dependency graph supplies the official PoolManager,
PositionManager, router, Permit2, V4Quoter and StateView. The wrapping token is the
pinned **Solmate WETH**, compatible with IWETH9, explicitly not mainnet WETH9
bytecode. PositionManager uses a zero metadata descriptor: liquidity/NFT ownership
work; `tokenURI()` metadata is unavailable.

## Public deployment inputs

Use the matching prefunded operator signer through Foundry's normal signer
options. The script itself never reads a private key. Public variables:

| Variable | Meaning |
| --- | --- |
| `DEMO_DEPLOYER` | Prefunded signer; becomes protocol-fee owner, DemoUSDC minter and LP NFT owner |
| `DEMO_STAKING_REGISTRY` | Actual registry with deployed code; sealed demo genesis uses `0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f` |
| `DEMO_GENESIS_HASH` | Actual `eth_getBlockByNumber("0x0")` hash from the target network |
| `DEMO_OUTPUT` | Set to the absolute path of `slhsol/deployments/shared-devnet.json`; default is `deployments/demo.json` |
| `DEMO_NATIVE_PROFILE` | Public implementation/profile description; default identifies ethrex `9aa3645d` |
| `DEMO_VERIFIER` | Optional existing trusted verifier; otherwise deploy the repository's SlhDsaVerifier |
| `DEMO_PERMIT2` | Optional existing official Permit2; otherwise deploy the separately built artifact |

Set `QSW_RPC=https://altmempool.bailo.london/rpc`. Obtain the genesis hash and
confirm `web3_clientVersion` before setting the public inputs:

```sh
cast chain-id --rpc-url "$QSW_RPC"
cast block 0 --json --rpc-url "$QSW_RPC"
cast client --rpc-url "$QSW_RPC"
```

Run from **`slhsol/`** so Forge resolves the script path correctly. For example,
with a locally configured, matching Foundry keystore account:

```sh
cd slhsol
forge script script/DeployDemo.s.sol:DeployDemo \
  --rpc-url "$QSW_RPC" \
  --sender "$DEMO_DEPLOYER" \
  --account "$QSW_FOUNDRY_ACCOUNT" \
  --broadcast
```

A command without `--broadcast` is only a dry run. The ethrex profile charges
state resources differently from standard Anvil; use actual client gas estimates
or explicitly sufficient limits for large creations. A local gas estimate alone
does not prove a remote deployment fits. Retain the broadcast journal and check
every remote receipt before publishing the generated manifest.

## Provisioning and restart behavior

DeployDemo deploys/reuses the verifier, official AMM contracts, DemoUSDC, account
factory and a tiny hook CREATE2 origin. Salt mining sets exactly the
`beforeSwap` address bit (`0x80` under mask `0x3fff`). The hook trusts only the
configured factory and UniversalRouter; the factory has no arbitrary registration
or owner bypass.

The pool sorts DemoUSDC/WETH addresses, uses fee 3000 and tick spacing 60, and
starts at 2,000 DemoUSDC per WETH. The operator seeds a full-range position with
20,000 DemoUSDC and approximately 10 WETH, through PositionManager and ordinary
onchain Permit2 approvals. LP creation is open to the EOA because the hook only
implements `beforeSwap`. Factory accounts lock **0.012 ETH / 86,400 seconds**;
locked stake is distinct from spendable fee balance.

The native sender VERIFY budget in the operator runner is 2.4m gas. The custom
mempool allows up to 2.5m only for a genuinely onchain-staked sender; other distinct
entities remain capped at 100k. These admission rules do not impose swap-volume
limits. See [network policy](../../infra/devnet/README.md#sidecar-provenance-and-policy).

A completed manifest on the same genesis is reusable: code and trust bindings
are checked, an initialized pool is retained, and a saved LP position is not minted
again. A different chain/genesis is rejected. **The manifest is written during
Forge simulation, before broadcast has finished.** If broadcast stops partway,
resume the original broadcast with Forge `--resume`; do not treat its manifest as
proof that every address exists. Preserve the same signer, network and journal.
Use a new manifest/genesis only for an intentional new network.

`shared-devnet.json` is the public contract-address/pool-key record, with genesis,
profile and dependency pins. Publish its verified copy at
`https://altmempool.bailo.london/deployment.json`; it contains no private keys.
Locally generated `local-*` files describe disposable tests and are Git-ignored.
Private operator/validator/PQ key files stay outside tracked/public artifacts.

After deployment, run [the actual sponsored WASM swap](../../demo/README.md).
Receipt and admission evidence from that run establishes inclusion; this guide
and a generated manifest do not claim an unmined VPS transaction succeeded.
