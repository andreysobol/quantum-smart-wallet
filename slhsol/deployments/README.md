# Deploying the shared QuantumGuard demo

Use `demo/deploy.py` for the dedicated **chain 81411338**. Forge produces the
transaction plan; the wrapper sends it sequentially using the live ethrex gas
schedule. Provision [the sealed network](../../infra/devnet/README.md) first and
wait for the required native profile/forks and advancing blocks. These instructions
do not claim that an unmined VPS transaction succeeded.

## Build

From the repository root, with Git, Python 3.10+, Rust and Foundry installed:

```sh
git submodule update --init --recursive
bash slhsol/script/build_permit2.sh
forge build --root slhsol
forge test --root slhsol
python3 -m unittest discover -s demo -p test_deploy.py -v
```

Permit2 pins **Solidity 0.8.17**, so its unchanged official project is built
separately. The main v4 project pins **0.8.26**, Cancun and via IR.
`DeployDemo.s.sol` loads the separate Permit2 artifact when planning its CREATE;
concrete Permit2 source cannot be combined with the v4 compilation unit.

The locked dependency graph supplies official PoolManager, PositionManager,
UniversalRouter, Permit2, V4Quoter and StateView. The wrapping token is pinned
**Solmate WETH**, IWETH9-compatible, not mainnet WETH9 bytecode. PositionManager's
zero metadata descriptor leaves `tokenURI()` unavailable; ownership and liquidity
operations remain functional.

## Sequential deployment

Keep the matching prefunded operator JSON file outside Git, mode `0600`, with
`address` and `private_key` fields. It must belong to the signer funded in the
sealed genesis. Set `QSW_DEPLOYER_KEY_FILE` to that path and `QSW_GENESIS_HASH` to
the expected block-zero hash retained with the network record.

```sh
python3 demo/deploy.py \
  --rpc https://altmempool.bailo.london/rpc \
  --key-file "$QSW_DEPLOYER_KEY_FILE" \
  --genesis-hash "$QSW_GENESIS_HASH" \
  --manifest slhsol/deployments/shared-devnet.json
```

| Option | Meaning |
| --- | --- |
| `--rpc` | Live execution RPC; must report chain 81411338 and ethrex `9aa3645d` |
| `--key-file` | Private operator JSON; its address is checked against the key |
| `--genesis-hash` | Expected network identity, checked against block zero |
| `--manifest` | Verified public output; defaults to `slhsol/deployments/shared-devnet.json` |
| `--staking-registry` | Actual registry; defaults to the sealed genesis address `0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f` |
| `--resume` | Continue the existing wrapper ledger, preserving its exact transaction plan |

Forge receives only the public sender/configuration and runs **without
`--broadcast` or a private key**. Its manifest output is a temporary copy, never
the public target. The wrapper preserves planned nonces and checks every CREATE
prediction. Before each new transaction it requires both latest and pending
operator nonces to match the plan.

Only after the previous receipt succeeds does it call live `eth_estimateGas`.
The gas limit is `ceil(estimate * 1.2) + 50,000`, with a hard **16.7m** cap; a
margin exceeding the cap fails instead of being silently truncated. Transactions
are legacy type with a fixed **1 gwei** gas price. Signing uses offline `cast mktx`
with explicit chain, nonce, decimal value, gas limit and price. The raw signed
transaction/hash is saved before `eth_sendRawTransaction`.

Do not replace this with raw `forge --broadcast` estimates for this profile.
A Permit2 approval planned at 80,692 gas required a live estimate of 130,936 after
prior state changes; the wrapper allocates 207,124. The unit regression covers
that failure, nonce collisions, failed CREATE receipts, manifest preservation and
secret-safe signing timeouts without making network requests.

## Ledger, recovery and publication

The public transaction plan, signed raw bytes and receipts are stored in
Git-ignored `demo/.state/deploy/<genesis>/<operator>/ledger.json`. No private key
is copied into it. A per-operator lock prevents two local deployment processes
from using the same ledger. Avoid other sends from that operator during deployment.

An unfinished ledger requires explicit `--resume` with the same network, operator
and manifest path. It queries saved hashes; if necessary it can rebroadcast only
the **identical** signed bytes while the exact nonce is still available. It never
guesses a new nonce, bumps fees, recreates contracts, ignores a failed receipt or
changes a saved transaction after a timeout. A reverted transaction or unexpected
nonce stops for manual recovery. `--resume` is not an importer for an older Forge
broadcast journal; do not blindly use Forge `--resume` with its stale gas limits.

After all receipts, the wrapper re-runs source deployment checks against mined
addresses and requires a zero-transaction plan. It verifies runtime code, LP
ownership, active pool liquidity, chain/profile and genesis before publishing a
new manifest atomically. An existing manifest is never overwritten. A completed
manifest on the same genesis can be checked again without sending transactions.
Do not serve Forge's intermediate/simulated manifest as completion evidence.

The verified public copy is served at
`https://altmempool.bailo.london/deployment.json`. Keep the sealed bundle, contract
manifest, dependency pins and deployment ledger with network backups. The entire
`demo/.state` tree also contains private PQ run keys, so never publish that tree.

## Provisioned contracts and pool

`script/DeployDemo.s.sol` deploys/reuses the verifier, AMM stack, six-decimal
DemoUSDC, account factory and a small hook CREATE2 origin. Salt mining sets exactly
the `beforeSwap` address bit (`0x80` under mask `0x3fff`). The hook trusts only the
configured factory and UniversalRouter, with no owner registration bypass or
swap amount/volume/daily limits.

The sorted DemoUSDC/WETH pool uses fee 3000 and tick spacing 60, initially
2,000 DemoUSDC/WETH. The operator supplies a full-range position with 20,000
DemoUSDC and approximately 10 WETH via PositionManager and onchain Permit2
approvals. EOA LP creation is allowed because only `beforeSwap` is guarded.
The operator owns the LP NFT, protocol fees and DemoUSDC mint authority.

Factory accounts lock **0.012 ETH / 86,400 seconds**, distinct from spendable gas
funds. The swap runner allocates 2.4m gas to sender validation; the custom mempool
permits up to 2.5m only for a genuinely onchain-staked sender, with other distinct
entities capped at 100k. See [network policy](../../infra/devnet/README.md#sidecar-provenance-and-policy).

Then run [the actual sponsored WASM swap](../../demo/README.md). Its chain receipt
and alternative-mempool admission establish inclusion; the deployment plan alone
does not. Locally generated `local-*` files are disposable, Git-ignored evidence.
