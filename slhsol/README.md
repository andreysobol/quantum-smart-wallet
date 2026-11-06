## slhsol

Solidity verifier for SLH-DSA-SHA2-128s, a hash-based post-quantum signature scheme specified in NIST FIPS 205.

Supports pure verification with a context string. Uses the SHA-256 precompile.

### Usage

```solidity
bool valid = verifier.verify(publicKey, message, context, signature);
```

- Public key: 32 bytes (`PK.seed || PK.root`).
- Signature: 7,856 bytes.
- Context: up to 255 bytes; use empty bytes if unused.

Returns `false` for invalid signatures or incorrect key/signature lengths. Reverts if the context exceeds 255 bytes.

### Development

```bash
forge build
forge test
```

## Anvil evaluation

Anvil evaluation checks Rust-generated SLH-DSA-SHA2-128s signatures against the Solidity verifier on a local Anvil node. Requires Rust and Foundry. Starts Anvil, and deploys SlhDsaVerifier. It generates random messages and contexts, alternating hedged and deterministic signing. Each signature is verified through call; modified messages, corrupted signatures, and incorrect contexts must be rejected.

Run 10 signatures:

```bash
bash eval/eval_anvil.sh -n 10
```
## slhsol — native quantum account

`QuantumAccount` uses SLH-DSA-SHA2-128s signatures and the onchain verifier for
EIP-8141 native validation. It supports key rotation, native SENDER operations and
optional constructor staking for the ERC-8421 alternative mempool. It targets the
Mumbai ethrex devnet profile, chain ID 1337.

See [the contract guide](slhsol/QUANTUM_ACCOUNT.md) for signing, deployment, tests and the
distinction between native execution and mempool admission.

## ensv2 — Devnet ENSv2 names

`qsw.eth` subnames on the shared devnet, built on the pinned official ENSv2 contracts and paid in dUSDC.
Each QuantumAccount's names are held by its own `ENSVault`, which only the account controls, and resolve to
the account. These are devnet names, not public `.eth` names. See [ensv2/README.md](ensv2/README.md).

## Shared devnet

The reproducible demo stack uses chain **81411338** and the pinned ethrex
`9aa3645d` frame-transaction profile.

- [Devnet and persistent node setup](infra/devnet/README.md)
- [Public RPC gateway and explorer routing](infra/gateway/README.md)
- [Uniswap v4 deployment](slhsol/deployments/README.md)
- [WASM-signed sponsored swap example](demo/README.md)
- [Web wallet app and Vercel deployment](apps/web/README.md)

`QuantumAccountFactory` registers only the accounts it deploys. `QuantumGuardHook`
accepts swaps from those accounts through the pinned Universal Router. It has no
volume or daily limit. The demo uses the official pinned Uniswap contracts, two
test tokens, and a funded pool.

The shared deployment exposes:

| Service | URL |
| --- | --- |
| Execution RPC | https://altmempool.bailo.london/rpc |
| Alternative mempool | https://altmempool.bailo.london/mempool |
| Explorer | https://altmempool.bailo.london/explorer/ |
| Contract addresses and ABIs | https://altmempool.bailo.london/explorer/contracts |
| Mined transaction history | https://altmempool.bailo.london/explorer/chain |
| Frontend deployment manifest | https://altmempool.bailo.london/deployment.json |

See the [verified sponsored swap](demo/evidence/shared-devnet/report.json) and
[deployed contract addresses](slhsol/deployments/shared-devnet.json). Address pages
show live balances, bytecode and mined transactions involving each address;
contract ABIs are published from the deployment artifacts. The Pool and Activity
tabs show alternative-mempool admission separately from chain history.

## EIP-8141

[EIP-8141: Frame Transaction](https://eips.ethereum.org/EIPS/eip-8141)

EIP-8141 proposes native account abstraction through transactions composed of separate validation, gas payment, and execution frames. It allows smart accounts to define custom authorization logic, including post-quantum signature verification, while supporting key rotation, batched operations, and sponsored transaction fees.

## ERC-8421

[ERC-8421: Frame Transaction Alternative Mempools](https://ethereum-magicians.org/t/erc-8421-frame-transaction-alternative-mempools/29800)

ERC-8421 proposes alternative mempool rules for EIP-8141 frame transactions. It defines a framework for transaction admission and propagation outside the default public mempool, with validation restrictions designed to resist denial-of-service attacks while accommodating more flexible smart-account validation policies.
