# Quantum Smart Wallet

An Ethereum Smart Wallet using hash based post-quantum signatures, onchain verification, and native account abstraction via EIP-8141 and ERC-8421.

> ⚠️ Research/educational code — not audited. Do not use it to protect real funds.
>

Imagine waking up tomorrow and discovering that the cryptography protecting your Ethereum wallet is broken. Your private key can be recovered. Your funds can be stolen. And your wallet cannot defend itself. We don't know when quantum computers will become powerful enough to make this possible. But we know the mathematics already.

A native Ethereum wallet that replaces classical transaction authorization with SLH-DSA-SHA2-128s, a post-quantum signature algorithm standardized by NIST. Using EIP-8141 and ERC-8421, we demonstrate post-quantum transactions with native validation and alternative mempool support. You can send assets, trade tokens, and register ENS names, all authorized by post-quantum signatures.

# What Was Built

- [x] [Rust post-quantum (SLH-DSA-SHA2-128s) cryptography library and CLI](rslh/)
- [x] [TypeScript bindings: Rust WASM library](slhts/)
- [x] [On-chain SLH-DSA signature verifier](slhsol/src/SlhDsaSha2_128s.sol)
- [x] [Native quantum smart account](slhsol/src/QuantumAccount.sol)
- [x] [Quantum account factory](slhsol/src/QuantumAccountFactory.sol)
- [x] [Quantum-gated Uniswap v4 hook](slhsol/src/QuantumGuardHook.sol)
- [x] [Web wallet](apps/web/)
- [x] [Account creation, faucet and gas sponsorship backend deployment](apps/web/server/)
- [x] [Devnet and alternative mempool infrastructure deployment](infra/devnet/)
- [x] [RPC gateway and explorer deployment](infra/gateway/)
- [x] [Deployment and sponsored swap demo](demo/)
- [x] [Cross-implementation validation: OpenSSL, rslh and slhts](eval/)

# Try our wallet

[Quantum Smart Wallet](https://quantum-smart-wallet.vercel.app/)

```
DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT
DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT
DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT
DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT
DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT
DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT
DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT
DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT
DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT
DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT
DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT
DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT DEMO SCREENSHOT
```

[Quantum Smart Wallet](https://quantum-smart-wallet.vercel.app/)

## SLH-DSA-SHA2-128s

[FIPS 205: Stateless Hash-Based Digital Signature Standard](https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.205.pdf)

NIST’s FIPS 205 defines SLH-DSA, a stateless, hash-based digital signature algorithm derived from SPHINCS+. Its SLH-DSA-SHA2-128s variant uses SHA-256 and prioritizes smaller signatures. The standard specifies key generation, signing, and verification for authenticating data with resistance to quantum computing attacks.

## EIP-8141

[EIP-8141: Frame Transaction](https://eips.ethereum.org/EIPS/eip-8141)

EIP-8141 proposes native account abstraction through transactions composed of separate validation, gas payment, and execution frames. It allows smart accounts to define custom authorization logic, including post-quantum signature verification, while supporting key rotation, batched operations, and sponsored transaction fees.

## ERC-8421

[ERC-8421: Frame Transaction Alternative Mempools](https://ethereum-magicians.org/t/erc-8421-frame-transaction-alternative-mempools/29800)

ERC-8421 proposes alternative mempool rules for EIP-8141 frame transactions. It defines a framework for transaction admission and propagation outside the default public mempool, with validation restrictions designed to resist denial-of-service attacks while accommodating more flexible smart-account validation policies.

---

## slhsol — native quantum account

`QuantumAccount` uses SLH-DSA-SHA2-128s signatures and the onchain verifier for
EIP-8141 native validation. It supports key rotation, native SENDER operations and
optional constructor staking for the ERC-8421 alternative mempool. It targets the
Mumbai ethrex devnet profile, chain ID 1337.

See [the contract guide](slhsol/QUANTUM_ACCOUNT.md) for signing, deployment, tests and the
distinction between native execution and mempool admission.

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

## rslh — SLH-DSA

Rust implementation of SLH-DSA-SHA2-128s and SLH-DSA-SHAKE-128s with a small CLI.

### Build and test

```bash
cd rslh
cargo build --release
cargo test
cargo install --path .         # optional: put `rslh` on your PATH
```

### Generate keys

```bash
rslh keygen --sk me.key --pk me.pub
```

### Sign and verify

```bash
rslh sign   --sk me.key --in msg.txt --sig msg.sig --context app --deterministic
rslh verify --pk me.pub --in msg.txt --sig msg.sig --context app --deterministic
```

### Key management

```bash
rslh pubkey --sk me.key --pk me.pub --force # re-derive the public key from a private key
```

## Cross-checking with OpenSSL

Checks rslh against OpenSSL’s independent SLH-DSA implementation. Requires OpenSSL 3.5 or later with SLH-DSA support.

The script generates keys and signs random messages with random contexts using rslh, then checks that OpenSSL loads the exported keys and derives the same public key, accepts valid signatures and rejects modified messages, corrupted signatures, and incorrect contexts, and produces identical signatures in deterministic mode.

Run 100 checks, stopping at the first failure:

```bash
bash eval/eval_openssl.sh -n 100
```

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

## slhts

Rust code compiled to WebAssembly, with a TypeScript API.

### Build

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130 --locked 

npm ci
npm run build
```

### Use from TypeScript

```ts
import { init, generateKeyPair, sign, verify } from "slhts";

await init();                                   // load rslh_bg.wasm once
const kp = generateKeyPair("sha2");             // or "shake"
const msg = new TextEncoder().encode("hello");
const ctx = new TextEncoder().encode("app");

const sig = sign("sha2", kp.secretKey, msg, { context: ctx });   // 7,856 bytes, takes ~1–3 s
verify("sha2", kp.publicKey, msg, sig, ctx);                     // true
```

### Test in a headless browser

```bash
cargo build --release --manifest-path ../rslh/Cargo.toml 
npx playwright install --with-deps chromium
npm test
```

The Playwright tests load `test/index.html` in headless Chromium, call the TypeScript API, and check:
round trips for both parameter sets, rejection of a modified message / context / signature,
byte-identical deterministic signatures and keys versus the native CLI, and that the CLI verifies
a hedged signature made in the browser.
