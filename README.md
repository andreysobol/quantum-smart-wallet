# Quantum Smart Wallet

An Ethereum smart wallet using post-quantum signatures, onchain verification, and native account abstraction via EIP-8141.

> ⚠️ Research/educational code — not audited. Do not use it to protect real funds.

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
