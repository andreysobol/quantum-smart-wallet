# Sponsored WASM swap on the shared devnet

This operator runner exercises the actual path: a fresh SLH-DSA WASM key, a
factory-created account, sponsored native frame validation, the alternative
mempool, and a guarded Uniswap v4 swap. It reports success only after receipt,
frame, balance and admission checks pass. The verified shared deployment is linked
below.

| Public interface | URL |
| --- | --- |
| Execution RPC | https://altmempool.bailo.london/rpc |
| Alternative mempool | https://altmempool.bailo.london/mempool |
| Explorer | https://altmempool.bailo.london/explorer/ |
| Public contract manifest | https://altmempool.bailo.london/deployment.json |

The dedicated chain is **81411338**, with the pinned ethrex `9aa3645d` native
profile. The runner checks chain ID, genesis hash and execution-client profile
before signing. The manifest is tied to that genesis; chain ID alone is insufficient.

## Build once

From the repository root, with Git, Python 3.10+, Node 24+, npm, Rust and Foundry
(`forge`, `cast`) installed:

```sh
git submodule update --init --recursive
bash slhsol/script/build_permit2.sh
forge build --root slhsol
forge test --root slhsol
python3 -m unittest discover -s demo -p test_deploy.py -v

rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130 --locked
npm --prefix slhts ci
npm --prefix slhts run build
```

The `wasm-bindgen-cli` version must match `rslh/Cargo.lock`. The helper loads the
built `slhts/dist/index.js` and `slhts/pkg/rslh_bg.wasm` through a temporary
localhost HTTP server. Python uses the standard library and Foundry `cast`; no
Python package installation is needed. For the browser signer regression tests:

```sh
cargo build --release --locked --manifest-path rslh/Cargo.toml
(cd slhts && npx playwright install chromium && npm test)
```

## Operator inputs and execution

Start the shared network using [the infrastructure guide](../infra/devnet/README.md).
Use its matching prefunded operator key: the same operator deploys DemoUSDC,
provides liquidity, mints demo input tokens and sponsors the later swap. Set
`QSW_DEPLOYER_KEY_FILE` to the existing private JSON file outside Git, mode `0600`,
with fields `address` and `private_key` (both `0x`-prefixed). Do not generate a
replacement operator key after prefunding the sealed genesis.

For a new stand, set `QSW_GENESIS_HASH` to the expected hash from the retained
network record and run the sequential deployment wrapper from the repository root:

```sh
python3 demo/deploy.py \
  --rpc https://altmempool.bailo.london/rpc \
  --key-file "$QSW_DEPLOYER_KEY_FILE" \
  --genesis-hash "$QSW_GENESIS_HASH" \
  --manifest slhsol/deployments/shared-devnet.json
```

The wrapper dry-runs Forge without a key, then estimates and confirms each real
transaction sequentially. It publishes a new manifest only after onchain checks.
It preserves an existing manifest and validates a completed deployment without
sending new transactions. See [deployment/resume details](../slhsol/deployments/README.md).
Use `--resume` only for this wrapper's saved plan; do not reuse Forge's stale gas
estimates or recreate addresses after a failed transaction.

For an existing stand, retain its verified manifest, or download the published
`/deployment.json` to a fresh filename and check its genesis before using it.
Never overwrite an in-progress deployment record. The swap operator must still
be the deployed DemoUSDC minter and hold funded sponsor credentials.

Choose `MIN_OUT_WEI` from a fresh quote/simulation, in raw 18-decimal WETH units.
`--amount-in` uses raw 6-decimal DemoUSDC units: `1000000` means 1 DemoUSDC.
The initial 2,000 USDC/WETH provisioning price is not a live quote. Run one operator
invocation at a time so its exact sponsor-balance fee check is not mixed with
another transaction from the same sponsor.

```sh
python3 demo/sponsored_swap.py \
  --manifest slhsol/deployments/shared-devnet.json \
  --rpc https://altmempool.bailo.london/rpc \
  --mempool https://altmempool.bailo.london/mempool \
  --simulation-rpc "$QSW_PRIVATE_RPC_URL" \
  --deployer-key-file "$QSW_DEPLOYER_KEY_FILE" \
  --amount-in 1000000 \
  --min-out "$MIN_OUT_WEI"
```

Set `QSW_PRIVATE_RPC_URL=http://127.0.0.1:18545` after opening an operator SSH
forward to the internal EL RPC. Discover its current address with:

```sh
ssh root@138.68.170.10 'cd /home/research/quantum-smart-wallet; task_node=$(docker compose --env-file infra/devnet/.generated/runtime.env -f infra/devnet/compose.yaml ps -q ethrex); docker inspect --format "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}" "$task_node"'
ssh -N -L "127.0.0.1:18545:${QSW_EL_IP}:8545" root@138.68.170.10
```

Use the returned address as `QSW_EL_IP` in the second command. The private
endpoint supplies exact custom-error bytes and a traced preflight of the signed
transaction. Submission and admission still use the public mempool. Debug and
privileged ingress remain private.

## What is signed and checked

Each run creates a new PQ account through `QuantumAccountFactory`, locks its
0.012 ETH stake with a one-day delay, and mints the requested DemoUSDC to it. The
user account starts and finishes the swap with **zero spendable ETH**.

The actual WASM implementation signs the raw 32-byte native digest with `sha2`
and context `QuantumSmartWallet/SLH-DSA-SHA2-128s/v1`. Entry 0 is an `ARBITRARY`
7,856-byte PQ signature. Entry 1 is the operator's ECDSA **fee sponsorship**;
there is no ECDSA user-owner key or account spending fallback.

The five frames are:

1. Account `VERIFY`, execution scope 2, with a 2.4m execution-gas budget.
2. Sponsor `VERIFY`, payment scope 1, with a 30k budget.
3. `SENDER`: ERC20 approval of Permit2.
4. `SENDER`: Permit2 allowance approval of UniversalRouter.
5. `SENDER`: UniversalRouter executes the v4 exact-input swap, settlement and take.

The last three form one atomic group. Both approvals are onchain: the ERC20
allowance equals the input amount; the Permit2 allowance also expires at the
signed deadline. No user ERC-1271/Permit2 signature is needed. The
pinned `IV4Router.ExactInputSingleParams` includes `minHopPriceX36`; the runner sets
that optional field to zero while retaining the caller's positive
`amountOutMinimum`, take minimum and signed deadline.

QuantumGuard accepts swaps only through the pinned UniversalRouter when its
actual `msgSender()` is registered by the trusted factory. It adds no volume,
amount or daily limits. The standalone V4Quoter cannot quote this guarded pool:
its callback is not UniversalRouter. Use router simulation from a registered
account, or StateView to inspect pool state.

## Evidence and next integration

Private run material goes under Git-ignored `demo/.state/<run>/`. The owner key is
created with mode `0600`. Publish only selected sanitized reports/receipts, never
the directory or key files. `report.json` is written after checks including:

- type `0x06`, all frames successful, nonce advanced once, and account ETH still zero;
- exact input-token debit and output at least the signed minimum;
- actual sponsor fee debit and reported payer;
- included alternative-mempool admission with every recorded check passing.

Use the reported transaction hash in the public explorer. Save the admission
report separately: explorer history is bounded and clears on sidecar restart.

A future SSR/Vercel frontend can fetch `/deployment.json` to discover the chain,
factory, tokens, router and pool key. The frontend UI and a public sponsorship
service are **not implemented by this operator step**. Never ship the operator key
in frontend code or `NEXT_PUBLIC_*` variables; this runner currently holds the
operator role locally. Browser key generation/signing belongs on the user's
device, with a worker for the synchronous WASM computation.

## Verified shared deployment

The VPS demo transaction is
[0x5372…fa1e](https://altmempool.bailo.london/explorer/tx/0x5372c2b13aa087361c62475f8b28f843012a9fb2ae4e4692878d80efcb28fa1e?node=https%3A%2F%2Faltmempool.bailo.london%2Fmempool),
block 408: 1 dUSDC became 0.000498475151013721 WETH. All five native frames and
24 admission checks passed; the wallet kept zero ETH and the sponsor paid fees.
The [public evidence](evidence/shared-devnet/report.json) includes receipts,
exact wire/raw bytes and the signing hash for codec integration checks.

The pinned client's ordinary `eth_call` drops nested custom-error bytes. Pass
`--simulation-rpc` through an operator SSH forward for the exact QuantumGuard
negative proof and full native preflight. `debug_traceCall` stays private. The
runner checks that the private endpoint has the same chain and genesis before
using it; a normal EOA must return `NotQuantumAccount(address)` in its trace.
