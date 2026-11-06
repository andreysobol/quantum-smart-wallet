## Cross-checking with OpenSSL

Checks rslh against OpenSSL’s independent SLH-DSA implementation. Requires OpenSSL 3.5 or later with SLH-DSA support.

The script generates keys and signs random messages with random contexts using rslh, then checks that OpenSSL loads the exported keys and derives the same public key, accepts valid signatures and rejects modified messages, corrupted signatures, and incorrect contexts, and produces identical signatures in deterministic mode.

Run 100 checks, stopping at the first failure:

```bash
bash eval/eval_openssl.sh -n 100
```

## Anvil evaluation

Anvil evaluation checks Rust-generated SLH-DSA-SHA2-128s signatures against the Solidity verifier on a local Anvil node. Requires Rust and Foundry. Starts Anvil, and deploys SlhDsaVerifier. It generates random messages and contexts, alternating hedged and deterministic signing. Each signature is verified through call; modified messages, corrupted signatures, and incorrect contexts must be rejected.

Run 10 signatures:

```bash
bash eval/eval_anvil.sh -n 10
```
