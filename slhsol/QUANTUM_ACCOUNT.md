# Native SLH-DSA account

`QuantumAccount` authorizes EIP-8141 transactions with the existing
`SlhDsaVerifier`. It targets ETHGlobal Mumbai's ethrex `9aa3645d` profile,
chain **1337**, and its ERC-8421 alternative mempool.

## Build and test

```sh
# From the repository root:
git submodule update --init --recursive
cd slhsol
forge fmt --check
forge build --sizes
forge test -vv
```

The project pins solc 0.8.30, Cancun and the optimizer. The existing verifier uses
`MCOPY` and requires Cancun or later. No new package dependency is required.

## Account policy

- `QuantumAccount.sol` stores a raw 32-byte public key and immutable verifier.
- `validateFrame()` checks the native caller `0x…00aa`, transaction type/sender,
  current VERIFY target/mode, approval flags and signature metadata before
  checking the complete canonical transaction digest and calling APPROVE.
- Native SENDER frames execute transfers and DeFi calls. There is no ECDSA owner,
  proxy admin, account-level nonce counter or public arbitrary-execution function.
- `rotateKey(bytes32)` accepts only a self-call, authorized by the current key in
  the native VERIFY frame. Generate and back up the replacement key first.
- `receive()` accepts ETH without a frame context.
- `FrameTxSupport.sol` provides five fixed opcode helpers because stock solc cannot
  emit 8141 instructions. It follows the workshop's STATICCALL-for-reads and
  DELEGATECALL-for-APPROVE pattern. Helper addresses cannot be changed by callers.

## Signing

1. Build the entire native envelope: chain, sender, keyed nonce, fees and frames.
2. Signature entry **0** must be `ARBITRARY`: scheme `0`, empty signer/message and
   a 7,856-byte witness placeholder.
3. Compute the canonical signing hash with the **pinned workshop codec**.
4. Sign the raw **32-byte digest** using pure SLH-DSA-SHA2-128s and UTF-8 context
   **`QuantumSmartWallet/SLH-DSA-SHA2-128s/v1`**.
5. Replace the witness. Any change to signed envelope fields requires re-signing.

The public key is raw `PK.seed || PK.root`, not the algorithm-prefixed CLI file.
The existing verifier adds pure-FIPS-205 framing itself. Do not frame twice, sign
an ASCII hex hash, use `personal_sign` or substitute HashSLH-DSA. Keep the witness
in `signatures`, not frame calldata, to avoid a circular signing hash.

The devnet hash elides empty-message witness bytes to empty bytes. The newer EIP
instead commits to their lengths. Do not silently switch encoding profiles.

### Browser signing with the WASM bindings

Use the existing `slhts` API after constructing all frames, the sponsor and the
signature placeholders. `sigHash` below comes from the codec for the selected
devnet profile. The wrapper's `fromHex` and `toHex` use hex without an `0x` prefix;
the Ethereum RPC signature field requires the prefix.

```ts
import { init, fromHex, sign, toHex } from "slhts";

await init();
const digest = fromHex(sigHash.replace(/^0x/, ""));
if (digest.length !== 32) throw new Error("expected a 32-byte frame digest");
const signature = sign("sha2", secretKey, digest, {
  context: new TextEncoder().encode("QuantumSmartWallet/SLH-DSA-SHA2-128s/v1"),
});
tx.signatures[0] = {
  scheme: 0,
  signer: "0x",
  msg: "0x",
  signature: `0x${toHex(signature)}`,
};
```

The general-purpose bindings also support SHAKE and an empty context, but this
account requires SHA2 and the exact context above. Key material stays in the
browser. Run key generation and signing in a Web Worker to keep the UI responsive;
the current WASM API is synchronous. The sponsor can add its signature afterward
without changing the already-signed envelope fields.

The account-specific Playwright test signs a raw digest with WASM and compares
the resulting public key and complete signature with the fixture accepted by the
real Solidity verifier.

## Frames

| Frame | Mode | Flags | Target | Data |
|---|---|---|---|---|
| 0 | VERIFY (1) | 2 | account | `validateFrame()` (`0x634b01e8`) |
| 1 | VERIFY (1) | 1 | sponsor | sponsor validation |
| 2+ | SENDER (2) | as required | recipient/token/router | signed operation |

Sponsorship is the application's primary flow: the user signs with the PQ key
and the sponsor pays ETH fees. A default-code EOA sponsor uses signature index 1;
a contract paymaster defines its own payment policy. Construct the sponsor frame
before requesting the user's signature. For optional self-payment, use account
VERIFY flags `3` and omit the sponsor frame.

For approval plus swap, set `ATOMIC_BATCH_FLAG = 4` on the approval SENDER frame
and end the group with flags `0` on the swap. Otherwise frames can revert
independently. Sign the minimum output, deadline and account recipient too.

## Deploy and stake

Constructor: `(initialPublicKey, verifierAddress, stakingRegistry, initialStake,
unstakeDelaySec)`, payable.

Without staking, pass zeros for all three staking arguments. With staking, provide
a deployed registry, a delay of at least 86,400 seconds and ETH value at least
equal to the stake. The constructor calls `addStake` **from the account address**;
the remaining ETH stays spendable. This avoids requiring expensive PQ validation
before the account has stake. Stake itself cannot pay transaction gas.

The immutable verifier is trusted configuration: use this repository's
`SlhDsaVerifier`, not an arbitrary contract with the same ABI.

`script/DeployQuantumAccount.s.sol` deploys both contracts and checks chain ID
1337 before broadcasting. Also verify `web3_clientVersion` against the pinned
profile; chain ID alone does not prove native support.

```sh
export QSW_PUBLIC_KEY=0xYOUR_RAW_32_BYTE_PUBLIC_KEY
export QSW_SPENDABLE_ETH=0
# Optional, after checking the current registry address:
# export QSW_STAKING_REGISTRY=0x...
# export QSW_INITIAL_STAKE=12000000000000000
# export QSW_UNSTAKE_DELAY=86400
forge script script/DeployQuantumAccount.s.sol:DeployQuantumAccount \
  --rpc-url https://altmempool.forshtat.com --account YOUR_DEVNET_KEYSTORE
```

This is a dry run. Add `--broadcast` only when intentionally deploying.

## Verification and budget limits

Foundry tests use the real SLH verifier and a Rust-generated raw-digest/context
fixture, while mocking native opcode results because Forge/Anvil do not implement
8141. They cover authorization, tampering, key rotation, malformed/reverting
helpers and verifier, ETH reception and constructor staking.

Reproduce the deterministic public **test** fixture:

```sh
cd ../rslh
cargo build --release --locked
cd ../slhsol
python3 script/gen_account_vector.py
```

`script/simulate_native.py` separately exercises native execution on ethrex with
transient CREATE2 deployments. It requires Python 3, `cast`, built artifacts, the
Rust CLI and a funded **devnet-only** payer key in `QSW_SIMULATION_PAYER_KEY`.
It calls only reads and `ethrex_simulateFrameTransaction`: no broadcast or faucet.

```sh
forge build
python3 script/simulate_native.py --rslh ../rslh/target/release/rslh
```

Reports are written under `cache/native-simulation`. Simulated deployments and
rotations disappear after the call. Native execution is distinct from admission,
P2P propagation and mining.

Verification costs more than 100,000 gas and varies with WOTS chain lengths.
Measure the actual signature and account path and leave headroom. The published
sidecar at `2e22ff0a` unconditionally caps validation prefixes at 100,000 before
resolving stakes. Do not assume staking overrides the deployed node's cap; the
draft, landing page and implementation have documented differences.

## References

- [ETHGlobal Mumbai EF track](https://ethglobal.com/events/mumbai/prizes/ethereum-foundation)
- [Workshop and pinned devnet profile](https://github.com/forshtat/mempool-workshop)
- [Opcode helper pattern](https://github.com/forshtat/hegota-support)
- [Spec/implementation differences](https://docs.altmempool.wtf/project/differences/)
