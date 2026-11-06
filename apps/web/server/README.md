# Account creation, faucet and gas sponsorship

Server-side handlers for [Quantum Smart Wallet](https://quantum-smart-wallet.vercel.app/).
They run as Vercel Functions alongside the frontend. The devnet, alternative mempool and
explorer run separately on a VPS.

## API

| Endpoint | Request | Result |
| --- | --- | --- |
| `GET /api/config` | — | Verified network configuration, contract addresses, sponsor address, faucet settings and limits. |
| `POST /api/account` | `{ publicKey }` | Creates a QuantumAccount and funds its mempool stake, or returns the existing account. |
| `POST /api/faucet` | `{ account }` | Mints test dUSDC to an account registered with QuantumAccountFactory. |
| `POST /api/sponsor` | `{ tx, kind }` | Validates and co-signs a frame transaction. `kind` is `swap` (default) or `ens-register`. |

POST requests use `Content-Type: application/json`. Cross-origin browser requests are rejected.
Request and response types are defined in [shared/types.ts](../shared/types.ts);
handlers are in [routes.ts](routes.ts).

### Account creation

The browser generates an SLH-DSA key pair through WASM and sends only the 32-byte public key.
The server derives the account address and calls QuantumAccountFactory with the operator key.
Repeated requests for the same key return the same account.

The operator pays deployment gas and the account's **0.012 ETH** alternative-mempool stake.
The user's signing key stays in the browser.

### Faucet

The operator must be the deployed DemoUSDC minter. By default, the faucet mints **1,000 dUSDC**
per request and rejects accounts already holding **5,000 dUSDC** or more. It checks factory
membership before minting and returns the mined transaction hash.

### Gas sponsorship

The browser builds and signs an EIP-8141 frame transaction. The server checks its template,
account, nonce, targets, fees, gas limits and SLH-DSA signature before adding the sponsor signature.

- **Swaps:** five frames targeting the configured Uniswap v4 router and guarded pool, with
  amount and deadline limits.
- **ENS registration:** six frames to create the account's vault, approve the quoted dUSDC fee,
  register the name and set its address record. The server also checks availability, duration,
  payment and vault ownership.

The browser submits the co-signed transaction to `eth_sendFrameTransaction` on the alternative
mempool. The sponsor pays ETH gas; the account supplies swap tokens or the name registration fee.

Policies are implemented in [policy.ts](policy.ts) and [ensPolicy.ts](ensPolicy.ts).

## Backend deployment

Deploy the repository to Vercel with **Root Directory `apps/web`**, **Node.js 24** and access to
files outside that directory enabled. The build command is `bash scripts/vercel-build.sh`;
the output directory is `dist`. API entry points are in [api/](../api/).

Set these variables in Vercel. For local development, use the same names in
`apps/web/.env.local`.

| Variable | Value or purpose |
| --- | --- |
| `QSW_OPERATOR_PRIVATE_KEY` | Server secret for account creation, stake funding and dUSDC minting. |
| `QSW_SPONSOR_PRIVATE_KEY` | Optional separate gas payer; defaults to the operator key. |
| `QSW_DEPLOYMENT_URL` | `https://altmempool.bailo.london/deployment.json` |
| `QSW_RPC_URL` | `https://altmempool.bailo.london/rpc` |
| `QSW_MEMPOOL_URL` | `https://altmempool.bailo.london/mempool` |

For the shared devnet, the operator key is the `private_key` field of the local, ignored
`.secrets/devnet-operator.json` at the repository root. Keep keys in server-only variables,
without a `VITE_` prefix. Mark them Sensitive in Vercel and redeploy after changing them.

Keep operator and sponsor accounts funded with devnet ETH. The default reserve is **0.05 ETH**.
Additional limits and defaults are documented in [`.env.example`](../.env.example).

For local startup and full Vercel settings, see the [web app README](../README.md).

## Devnet, alternative mempool, RPC and explorer

The shared network uses chain **81411338**. The VPS runs ethrex, a Lighthouse beacon and
validator client, the alternative-mempool sidecar, a static explorer and a public gateway.

| Public service | URL |
| --- | --- |
| Execution RPC | https://altmempool.bailo.london/rpc |
| Alternative mempool | https://altmempool.bailo.london/mempool |
| Explorer | https://altmempool.bailo.london/explorer/ |
| Deployment manifest | https://altmempool.bailo.london/deployment.json |

The custom PQ mempool policy allows **2.5 million verification gas** for an on-chain-staked
sender with at least 0.01 ETH stake, at least a one-day withdrawal delay and no pending
withdrawal. Distinct third-party entities retain the 100,000-gas budget. This accommodates
SLH-DSA verification while preserving the sidecar's other validation checks.

The sidecar simulates and admits frame transactions, then relays accepted transactions to
the private execution node. The gateway exposes allowed RPC methods and explorer routes;
engine, admin and debug interfaces remain private. It holds no signing keys.

Use the existing deployment guides:

- [Devnet deployment](../../../infra/devnet/README.md): bootstrap, Compose services, mempool
  policy, readiness and backups.
- [Gateway deployment](../../../infra/gateway/README.md): public RPC routes, HTTPS tunnel,
  explorer index and Cloudflare configuration.
- [Contract deployment](../../../slhsol/deployments/README.md): wallet contracts, tokens,
  Uniswap v4 and liquidity.

Preserve the existing genesis, validator state and volumes when restarting the network.
Do not bootstrap a new chain to update the backend or explorer.

## Verify

After deployment, check [the public configuration](https://quantum-smart-wallet.vercel.app/api/config)
for the expected chain, contracts and sponsor. `operatorReady: true` means an operator key is
configured; it does not prove that the operator is funded or has minting permission.

From `apps/web`, run:

```sh
npm test
QSW_LIVE_READ=1 npm test
```

For an end-to-end run through the deployed wallet:

```sh
QSW_LIVE=1 QSW_LIVE_URL=https://quantum-smart-wallet.vercel.app npx playwright test -c playwright.live.config.ts
```

The live tests spend devnet funds. They cover account creation, faucet minting, sponsored
swaps and name registration, checking receipts and resulting on-chain state.

Rate limits are in memory per function instance. They provide no shared quota across Vercel
instances. This is an unaudited devnet deployment; its tokens have no value.
