# Quantum Smart Wallet

An Ethereum smart wallet using post-quantum signatures, onchain verification, and native account abstraction via EIP-8141.

> ⚠️ Research/educational code — not audited. Do not use it to protect real funds.

## SLH-DSA-SHA2-128s

[FIPS 205: Stateless Hash-Based Digital Signature Standard](https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.205.pdf)

NIST’s FIPS 205 defines SLH-DSA, a stateless, hash-based digital signature algorithm derived from SPHINCS+. Its SLH-DSA-SHA2-128s variant uses SHA-256 and prioritizes smaller signatures. The standard specifies key generation, signing, and verification for authenticating data with resistance to quantum computing attacks.

## slhsol — native quantum account

`QuantumAccount` uses SLH-DSA-SHA2-128s signatures and the onchain verifier for
EIP-8141 native validation. It supports key rotation, native SENDER operations and
optional constructor staking for the ERC-8421 alternative mempool. It targets the
Mumbai ethrex devnet profile, chain ID 1337.

See [the contract guide](slhsol/QUANTUM_ACCOUNT.md) for signing, deployment, tests and the
distinction between native execution and mempool admission.

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
