# Product

<!-- impeccable:product-schema 1 -->

Captured from repository evidence (README.md, demo/README.md, slhsol/QUANTUM_ACCOUNT.md, apps/web) in a
lightweight init, without an interview. Facts marked _(inferred)_ are hypotheses to confirm.

## Platform

web

## Users

- People trying a post-quantum Ethereum wallet on the shared devnet: they create a wallet in the browser,
  back up its key, get test funds and make a swap, then inspect the proof. _(inferred: developers and
  evaluators of the ETHGlobal Mumbai EF-track work referenced in slhsol/QUANTUM_ACCOUNT.md)_
- The operator who runs the devnet server API (account creation, stake, test-token faucet, sponsorship).

## Product Purpose

Quantum Smart Wallet is an Ethereum smart wallet secured by post-quantum, hash-based signatures
(SLH-DSA-SHA2-128s, FIPS 205), verified on chain by the user's own account through EIP-8141 native
account abstraction. The web app (apps/web) makes the whole path usable: key generation and signing in the
browser, a factory-created QuantumAccount, encrypted backups, test-token funding, sponsored dUSDC/WETH swaps
through the alternative mempool, and a proof of what was verified. Success is a real swap whose post-quantum
validation, sponsor, amounts and admission are visible and checkable on the explorer.

## Positioning

The account has no ECDSA owner key: every transaction is authorised by an SLH-DSA signature that the account
verifies itself on chain, and gas is paid by a sponsor, so the account holds zero ETH. Tagline in the shipped
copy: "Nothing but hashes."

## Operating Context

- Shared devnet, chain 81411338 (ethrex 9aa3645d frame-transaction profile); test tokens only (dUSDC, WETH).
- Public RPC, alternative mempool and explorer at https://altmempool.bailo.london; deployment manifest at
  /deployment.json. Blocks every ~6 s; a sponsored swap confirms in roughly 10-15 s.
- Signing takes about 1-3 s of WebAssembly work in a Web Worker; backups use a passphrase-encrypted file.
- Used in desktop and mobile browsers. _(inferred: demos happen on laptops and phones)_

## Capabilities and Constraints

- One wallet per browser profile; the secret key stays on the device, encrypted at rest; there is no seed
  phrase, only a backup file plus passphrase.
- Swaps are one EIP-8141 transaction with five frames (account VERIFY, sponsor VERIFY, two approvals, the
  guarded Uniswap v4 swap); only factory-created accounts may trade on the guarded pool.
- The server API needs operator credentials; without them the app is read-only and must say so.
- Research and educational code, not audited; never for real funds.

## Brand Commitments

- Name "Quantum Smart Wallet"; tagline "Nothing but hashes."
- The visual identity of the shipped design is binding: refinements preserve it rather than replace it.

## Evidence on Hand

- A verified sponsored swap with receipts, wire bytes and admission checks: demo/evidence/shared-devnet/.
- Live end-to-end runs: apps/web/e2e/live.spec.ts against the deployed app.
- No users, testimonials, metrics or partners exist; do not invent them.

## Product Principles

1. Show chain truth, never simulated values: actual amounts, sponsor, PQ validation gas, admission, explorer links.
2. Keys stay with the user: generated, stored and used on the device; backups are explicit and verified.
3. No ETH needed: gas is sponsored and the account's ETH balance is zero by design.
4. Be honest about the devnet: test tokens only, unaudited research code, clear operator-unavailable states.

## Accessibility & Inclusion

The interface must stay readable and operable on touch devices and with enlarged text, with primary actions
reachable without hunting.
