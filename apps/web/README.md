# Quantum Smart Wallet web app

A browser wallet for the [shared devnet](../../README.md#shared-devnet) (chain 81411338). Each
wallet is a `QuantumAccount` that validates SLH-DSA-SHA2-128s signatures natively under EIP-8141.

- **Keys in the browser.** `slhts` (rslh compiled to WebAssembly) generates keys and signs in a
  module Web Worker. Instead of a seed phrase, you export a passphrase-encrypted backup file and
  prove you can restore it.
- **Operator-created accounts.** The server's operator key creates the account through
  `QuantumAccountFactory`, pays its 0.012 ETH alternative-mempool stake, and mints test dUSDC
  from the faucet.
- **Sponsored swaps.** A dUSDC/WETH swap on the guarded Uniswap v4 pool is one EIP-8141 frame
  transaction with five frames. The browser signs it. The server checks it against a strict
  policy and co-signs it as gas sponsor. The browser then submits it to the alternative mempool
  and follows it through admission, inclusion and the account's on-chain signature check.

> Test tokens on a devnet only. Research code, not audited.

| Path | Contents |
| --- | --- |
| `src/` | React app: screens, design system, signer worker, chain logic |
| `shared/` | Isomorphic code: constants, types, ABIs, frame-transaction codec, swap builder, quotes |
| `api/`, `server/` | Vercel Functions: `GET /api/config`, `POST /api/account`, `POST /api/faucet`, `POST /api/sponsor` |
| `scripts/vercel-build.sh` | Builds from a clean checkout: Rust and wasm-bindgen if missing, then `slhts`, then the app |
| `test/`, `e2e/` | Vitest unit tests, Playwright browser tests |

## Local development

You need Node.js 22 or newer (24 recommended). The WebAssembly signer also needs Rust with the
`wasm32-unknown-unknown` target and `wasm-bindgen-cli` at the version in `rslh/Cargo.lock`
(0.2.130).

```bash
cd apps/web
npm install
npm run build:wasm             # builds ../../slhts: rslh -> WebAssembly -> TypeScript
cp .env.example .env.local     # set QSW_OPERATOR_PRIVATE_KEY to enable writes
npm run dev                    # http://localhost:5173, with /api served by the dev plugin
```

For the shared devnet, the operator key is the `private_key` field of
`../../.secrets/devnet-operator.json` (see [the demo guide](../../demo/README.md)).

If Rust or wasm-bindgen is missing, run `bash scripts/vercel-build.sh --check` to see what is
missing and what would be installed. `bash scripts/vercel-build.sh` then does the whole build:

- If Rust is missing, it installs it with rustup (minimal profile) into `~/.cargo` and
  `~/.rustup`, without editing your shell profiles.
- It downloads the pinned wasm-bindgen release, checks its SHA-256, and keeps it in
  `node_modules/.cache/qsw-tools`.
- It builds `slhts`, then builds the app.

Without an operator key the app still loads and reads the chain, but `/api/config` reports
`operatorReady: false` and the server refuses account creation, the faucet and sponsorship.
`npm run build` type-checks and writes `dist/`. `npm run preview` serves `dist/` with the same
`/api` handlers.

## Tests

```bash
npm run typecheck
npm test                       # vitest: codec golden vectors, swaps, quotes, sponsor policy, backups, onboarding
QSW_LIVE_READ=1 npm test       # adds read-only checks against the public devnet
npm run e2e                    # Playwright, Chromium: WASM signer in a worker, backup round trip, and the app
```

The app e2e (`e2e/app.spec.ts`) starts `vite` on port 4173 with the operator keys forced empty, then checks
onboarding (account creation is mocked in the browser), the backup check, restore, and the read-only Portfolio,
Exchange and Proof screens for the demo account. It reads the public devnet but never sends a transaction.

The live run is opt-in because it spends operator ETH (0.012 ETH stake per account plus sponsored gas). Through
the real UI it creates a factory account, verifies a backup, mints test dUSDC and swaps dUSDC→WETH and
WETH→dUSDC with sponsored gas, then checks receipts, payer, frame statuses, mempool admission and balances on chain:

```bash
QSW_LIVE=1 npx playwright test -c playwright.live.config.ts                      # local dev server + .env.local
QSW_LIVE=1 QSW_LIVE_URL=https://quantum-smart-wallet.vercel.app npx playwright test -c playwright.live.config.ts
```

## Deploying to Vercel

1. Import the repository as a new project. On the **Build and Deployment** settings page, set:

   | Setting | Value |
   | --- | --- |
   | Root Directory | `apps/web` |
   | Include files outside the root directory in the Build Step | Enabled (the build needs `../../slhts` and `../../rslh`) |
   | Framework Preset, Build Command, Output Directory | Leave as detected. `vercel.json` sets `vite`, `bash scripts/vercel-build.sh` and `dist` |
   | Install Command | Default (`npm install`; links `slhts` through its `file:` dependency) |
   | Node.js Version | 24.x (also pinned by `"engines": {"node": "24.x"}` in `package.json`, which takes precedence) |
   | Function Region | London (`lhr1`), next to the devnet. On the Hobby plan `regions` in `vercel.json` is ignored, so set it here |
   | Ignored Build Step | `[ -n "$VERCEL_GIT_PREVIOUS_SHA" ] && git diff --quiet "$VERCEL_GIT_PREVIOUS_SHA" HEAD -- . ../../slhts ../../rslh`. This skips the build unless `apps/web`, `slhts` or `rslh` changed since the branch's last successful deployment. It still builds a branch's first deployment, and builds when that commit is outside Vercel's shallow clone |

2. Under **Environment Variables**, add the variables from [`.env.example`](.env.example):

   | Name | Type | Purpose |
   | --- | --- | --- |
   | `QSW_OPERATOR_PRIVATE_KEY` | Secret | Creates accounts and funds their stake. For the faucet it must be the DemoUSDC minter (`0xb7Ca4C821205f6721bacbd48052bEbF6A1f252c1` on the shared devnet) |
   | `QSW_SPONSOR_PRIVATE_KEY` | Secret | Optional. A separate key that pays swap gas; defaults to the operator key |
   | `QSW_DEPLOYMENT_URL`, `QSW_RPC_URL`, `QSW_MEMPOOL_URL` | Config | Optional overrides of the deployment manifest |
   | `QSW_FAUCET_AMOUNT`, `QSW_FAUCET_MAX_BALANCE`, `QSW_MAX_SWAP_USDC`, `QSW_MAX_SWAP_WETH`, `QSW_MIN_OPERATOR_BALANCE` | Config | Optional limits in raw units |

   - Mark both keys **Secret** (sensitive), so they are write-only once saved.
   - Scope the keys to Production. Add them to Preview only if you trust every branch that can
     deploy: preview builds and functions can read them.
   - Never give a secret a `VITE_` prefix. Vite inlines `VITE_*` values into the public bundle.
   - Variable changes apply only to new deployments, so redeploy after editing them. In the
     Redeploy dialog, uncheck **Use project's Ignore Build Step**: an unchanged commit would
     otherwise be skipped.

3. Deploy. The build command runs `scripts/vercel-build.sh` and stops with a clear error if a
   step fails. It:
   - uses the build image's Rust (rustc 1.92.0 at the time of writing) and adds the
     `wasm32-unknown-unknown` target, or installs Rust with rustup (minimal profile) if it is missing;
   - downloads wasm-bindgen 0.2.130 for x86_64 Linux and checks it against the SHA-256 pinned in
     the script (it reads the required version from `rslh/Cargo.lock` and stops if the pins do
     not cover that version);
   - builds `slhts` (`npm ci && npm run build`);
   - runs `npm run build`.

What `vercel.json` configures:

- **Functions.** The functions in `api/` run on Node.js with `maxDuration: 60` s. Account
  creation waits up to 45 s for its receipt.
- **Rewrites.** Every path except `/api`, `/api/*` and `/assets/*` is rewritten to
  `/index.html`, so unknown API routes and stale asset URLs return 404, not the app shell.
- **Security headers.** Every response gets:
  - a strict Content Security Policy: scripts only from this origin, plus `'wasm-unsafe-eval'` for
    the signer; network requests only to this origin and `https://altmempool.bailo.london`; no
    framing, plugins, `<base>` or form posts;
  - `X-Content-Type-Options: nosniff`;
  - `Referrer-Policy: no-referrer`;
  - a `Permissions-Policy` that disables unused device APIs;
  - `Cross-Origin-Opener-Policy: same-origin`.
- **Caching.** Hashed files under `/assets/` are cached as immutable for a year.

The browser calls the RPC and mempool URLs directly. If `QSW_RPC_URL` or `QSW_MEMPOOL_URL`
points at another origin, add that origin to `connect-src` in `vercel.json`.

### Deploying with the CLI (how the shared devnet app is deployed)

CLI deployments upload the repository root, and Vercel does not read `.gitignore`. The root
[`.vercelignore`](../../.vercelignore) is therefore an allowlist: only `apps/web`, `slhts` and `rslh`
sources are uploaded, never `.secrets/`, `.state/`, `.generated/`, `.env*` files or build outputs.
Keep it that way before running `vercel deploy`.

```bash
vercel project add quantum-smart-wallet
printf '%s' '{"rootDirectory":"apps/web","framework":"vite","nodeVersion":"24.x",
  "sourceFilesOutsideRootDirectory":true,"serverlessFunctionRegion":"lhr1"}' |
  vercel api /v9/projects/quantum-smart-wallet -X PATCH --input -
vercel link --yes --project quantum-smart-wallet            # from the repository root
node -e 'process.stdout.write(require("./.secrets/devnet-operator.json").private_key)' |
  vercel env add QSW_OPERATOR_PRIVATE_KEY production,preview --sensitive
printf '%s' https://altmempool.bailo.london/rpc | vercel env add QSW_RPC_URL production,preview --no-sensitive
# likewise QSW_MEMPOOL_URL and QSW_DEPLOYMENT_URL (values from /deployment.json)
vercel deploy --prod                                         # from the repository root
```

Production: https://quantum-smart-wallet.vercel.app. `/api/config` must report `operatorReady: true`
and the sponsor address derived from the key (`0xb7Ca…52c1` on the shared devnet).

## Security model

- **Signing key.** The SLH-DSA secret key is generated inside the signer worker and is decrypted
  only there, only while signing. At rest it is AES-GCM encrypted under a non-extractable device
  key in IndexedDB. Backup files are encrypted with your passphrase (PBKDF2-SHA256 with 600,000
  iterations, then AES-GCM-256). The key never reaches the main thread or the server.
- **Server keys.** The operator and sponsor keys come only from the server environment. They are
  never logged, returned by the API or included in the client bundle. The repository's
  `.vercelignore` keeps `.secrets/`, `.state/` and `.env*` files (except `.env.example`) out of
  Vercel CLI uploads.
- **Sponsorship policy.** The server never submits user transactions. It co-signs a swap as
  sponsor only after it checks:
  - the exact five-frame shape;
  - the pinned router and guarded pool;
  - the amount, deadline and fee limits;
  - the account's current nonce;
  - a valid SLH-DSA signature, verified on chain with the verifier contract.
- **Chain check.** Before using the RPC endpoint, the browser checks that it serves the expected
  chain ID and genesis hash.

## Operator responsibilities

- Keep the operator and sponsor accounts funded with devnet ETH. Each new account locks a
  0.012 ETH stake, and every sponsored swap pays gas. The API refuses to create an account or
  sponsor a swap when that would leave less than `QSW_MIN_OPERATOR_BALANCE`.
- Protect the keys. Anyone holding the operator key controls its ETH and the dUSDC mint.
- If a key leaks, rotate it and redeploy. For abuse, check the function logs for rejected
  requests and rate limiting.

## Limitations

- Devnet only (chain 81411338). The tokens have no value.
- Rate limits are kept in memory per function instance. They are best effort, not a security
  boundary.
- Quotes assume the swap does not cross an initialized tick (single-range math). The minimum
  output, set by your slippage tolerance, still protects the swap on chain.
- Keys live in one browser profile, so clearing site data deletes them. Keep the backup file and
  its passphrase.
- Not audited.
