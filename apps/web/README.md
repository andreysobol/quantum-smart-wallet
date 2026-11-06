# Quantum Smart Wallet web app

[Open the wallet](https://quantum-smart-wallet.vercel.app/)

A browser wallet for the shared devnet (chain **81411338**). QuantumAccount validates
SLH-DSA-SHA2-128s signatures through EIP-8141. The browser signs through the WASM library;
the server sponsors gas, and the browser submits transactions to the ERC-8421 alternative mempool.

## Try it

1. Create an account and export a passphrase-encrypted backup. There is no seed phrase.
2. Get test dUSDC from the faucet in **Portfolio**.
3. Swap dUSDC and WETH in **Exchange**, or register a `qsw.eth` name in **Names**.
4. Follow the transaction through mempool admission and block inclusion in **Proof**.

The operator creates accounts and funds their 0.012 ETH mempool stake. Users need no ETH
for sponsored transactions. Names cost 5 dUSDC per year, with registration for 1–5 years.

Names are held by a per-account ENSVault and resolve to the QuantumAccount. See the
[ENSv2 contracts](../../slhsol/ensv2/README.md) for ownership, registration and deployment addresses.

## Project structure

| Path | Contents |
| --- | --- |
| `src/` | Screens, styles, signer worker and browser chain operations |
| `shared/` | ABIs, frame-transaction codec, swap and ENS builders, quotes and types |
| `api/`, `server/` | Vercel Functions for configuration, account creation, faucet and sponsorship |
| `scripts/vercel-build.sh` | Rust/WASM and frontend build |
| `test/`, `e2e/` | Vitest and Playwright tests |

## Local development

Use Node.js 24. The signer build requires Rust, the `wasm32-unknown-unknown` target and
`wasm-bindgen-cli` matching `rslh/Cargo.lock`.

From the repository root:

```sh
cd apps/web
npm install
npm run build:wasm
cp .env.example .env.local
npm run dev
```

Set `QSW_OPERATOR_PRIVATE_KEY` in `.env.local` to enable account creation, the faucet and
sponsorship. For the shared devnet, use the `private_key` field from the local, ignored
`../../.secrets/devnet-operator.json`. Without it, the app runs read-only and `/api/config`
reports `operatorReady: false`.

The dev server runs at `http://localhost:5173` and serves the API locally. `npm run build`
type-checks and builds to `dist/`; `npm run preview` serves the build with the same API handlers.

If build tools are missing, run `bash scripts/vercel-build.sh --check` to inspect the requirements.
Running the script without `--check` installs missing Rust/WASM tools and builds the signer and app.

## Environment variables

Use the same variable names in `.env.local` and Vercel. See [`.env.example`](.env.example)
for all limits and their defaults.

| Variable | Purpose |
| --- | --- |
| `QSW_OPERATOR_PRIVATE_KEY` | Server secret for account creation, stake funding and the faucet. Must be the deployed DemoUSDC minter. Also sponsors gas unless a separate sponsor key is set. |
| `QSW_SPONSOR_PRIVATE_KEY` | Optional server secret for a separate gas payer. |
| `QSW_DEPLOYMENT_URL` | Deployment manifest: `https://altmempool.bailo.london/deployment.json` |
| `QSW_RPC_URL` | Chain RPC: `https://altmempool.bailo.london/rpc` |
| `QSW_MEMPOOL_URL` | Alternative mempool: `https://altmempool.bailo.london/mempool` |

Keep private keys server-side, without a `VITE_` prefix. In Vercel, mark them Sensitive and
scope them to Production; enable them for Preview only for trusted branches. Redeploy after
changing variables.

The browser calls the RPC and mempool directly. If either uses another origin, add it to
`connect-src` in [vercel.json](vercel.json).

## Deploy to Vercel

Import the repository with these settings:

| Setting | Value |
| --- | --- |
| Root Directory | `apps/web` |
| Include files outside the root directory in the Build Step | Enabled; the build uses `slhts` and `rslh` |
| Framework | Vite |
| Build Command | `bash scripts/vercel-build.sh` |
| Output Directory | `dist` |
| Node.js | 24.x |
| Function Region | London (`lhr1`) |

Add the environment variables above and deploy. The build script prepares Rust and wasm-bindgen,
verifies the downloaded wasm-bindgen checksum, builds `slhts`, then builds the frontend.

For CLI deployments, run `vercel deploy --prod` from the repository root after linking the project.
The root [`.vercelignore`](../../.vercelignore) limits uploads to app and signer sources, excluding
secrets, local state and environment files. Preserve that allowlist.

After deployment, check `/api/config` for `operatorReady: true` and the expected sponsor address.
If an Ignored Build Step skips a configuration-only redeployment, disable that option in the
Redeploy dialog.

## Tests

Run from `apps/web`:

```sh
npm run typecheck
npm test
npm run e2e
```

Unit tests cover transaction encoding, swaps, quotes, sponsor policies, backups and onboarding.
Browser tests cover the WASM signer, backup restoration and responsive layouts. The default
app tests mock account creation and read the public devnet without sending transactions.

Read-only devnet checks:

```sh
QSW_LIVE_READ=1 npm test
```

Live browser tests create accounts, mint dUSDC, swap in both directions and register names.
They spend operator devnet ETH and check receipts, frame statuses, sponsorship, balances,
name ownership and resolution.

```sh
QSW_LIVE=1 npx playwright test -c playwright.live.config.ts
QSW_LIVE=1 QSW_LIVE_URL=https://quantum-smart-wallet.vercel.app npx playwright test -c playwright.live.config.ts
```

## Keys and sponsorship

- The SLH-DSA key is generated and used inside a Web Worker. Backups use PBKDF2-SHA256
  with 600,000 iterations and AES-256-GCM encryption.
- IndexedDB stores the key encrypted with a non-extractable device key in the same record.
  This does not protect against malicious code running on the app's origin or access to the
  browser profile. Clearing site data deletes local keys; keep the backup and its passphrase.
- Operator and sponsor keys stay in the server environment. Keep both accounts funded:
  account creation locks a 0.012 ETH stake, and sponsored transactions consume gas.
  `QSW_MIN_OPERATOR_BALANCE` sets the required reserve.
- The sponsor validates the transaction template, targets, amounts, fees, nonce and on-chain
  SLH-DSA signature. Swap and ENS registration have separate policies. The browser submits
  the co-signed transaction.
- The app checks the chain ID and genesis hash. ENS is disabled when its namespace is missing
  or fails the server's on-chain configuration check.

## Limitations

- Devnet tokens have no value. The contracts and app are not audited.
- Rate limits are in memory per function instance and do not provide global abuse protection.
- Swap quotes use single-range math and assume no initialized tick is crossed. The transaction's
  minimum output enforces the selected slippage limit on chain.
- One wallet is active per browser profile. Switching wallets requires confirmation; reopening
  a replaced wallet requires its backup.
