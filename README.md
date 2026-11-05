# Quantum Smart Wallet

An Ethereum smart wallet using post-quantum signatures, onchain verification, and native account abstraction via EIP-8141.

## rslh — SLH-DSA (FIPS 205) command-line tool

`rslh/` is a Rust implementation of SLH-DSA-SHA2-128s (default) and SLH-DSA-SHAKE-128s with a small CLI.

> ⚠️ Research/educational code — not audited. Do not use it to protect real funds.

### Build and test

```bash
cd rslh
cargo build --release          # binary: target/release/rslh
cargo test                     # run the test suite
cargo install --path .         # optional: put `rslh` on your PATH
```

Without installing, run it via `cargo run --release -- <command> ...`.

### Generate keys

```bash
rslh keygen --sk me.key --pk me.pub                # SLH-DSA-SHA2-128s (default)
rslh keygen --alg shake --sk s.key --pk s.pub      # SLH-DSA-SHAKE-128s
```

Key files are one line of text, `<ALGORITHM>:<hex>` (64-byte private key, 32-byte public key).
The private key is written with mode `0600`. Existing files are never overwritten unless you pass `--force`.

### Sign and verify

```bash
# Sign a file (hedged with OS randomness), optionally with a context string
rslh sign   --sk me.key --in msg.txt --sig msg.sig --context app
rslh verify --pk me.pub --in msg.txt --sig msg.sig --context app

# Message from stdin, deterministic signature
echo hello | rslh sign   --sk me.key --sig hello.sig --deterministic
echo hello | rslh verify --pk me.pub --sig hello.sig
```

- Signatures are raw 7,856-byte binary files.
- The algorithm is read from the key file, so `sign`/`verify` need no `--alg`.
- The context must match between signing and verifying (`--context TEXT` or `--context-hex HEX`, max 255 bytes).
- `verify` exit status: `0` = valid, `1` = invalid, `2` = error — handy in scripts:

```bash
if rslh verify --pk me.pub --in msg.txt --sig msg.sig; then echo ok; fi
```

### Key management

```bash
rslh pubkey --sk me.key --pk me.pub --force   # re-derive the public key from a private key
rslh info   --key me.pub                      # show algorithm, key type and public key
rslh check  --sk me.key                       # verify the private key's hypertree root (slow)
```

### Interoperability with OpenSSL

Keys can be exported to / imported from the raw FIPS 205 byte layout used by OpenSSL:

```bash
rslh export --key me.key --out me.raw
rslh import --raw me.raw --out me2.key --alg sha2

# Signatures are OpenSSL-compatible (me_pub.pem = OpenSSL's PEM of the same key)
openssl pkeyutl -verify -pubin -inkey me_pub.pem -in msg.txt -sigfile msg.sig
```

Run `rslh help` for the full list of commands and options.
