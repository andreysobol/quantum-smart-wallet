# Public devnet gateway

A keyless Bun 1.4.4 gateway in front of private ethrex and sidecar containers.
Caddy listens only on host loopback port 18080. An existing HTTPS tunnel points
to that origin; this stack does not change tunnel settings or expose host ports
80/443. The explorer must be built with base path `/explorer/`.

## Run

Start the devnet services with aliases `ethrex`, `sidecar`, and `explorer` on the
external Docker network `qsw-devnet`. Copy `.env.example` to `.env`, set the public
hostname and an existing absolute path to a public deployment JSON file, then:

```sh
docker compose --env-file infra/gateway/.env -f infra/gateway/compose.yaml config --quiet
docker compose --env-file infra/gateway/.env -f infra/gateway/compose.yaml up -d --build
curl -H 'Host: wallet.example.org' http://127.0.0.1:18080/healthz
```

The deployment JSON is mounted read-only. It must contain public network and
contract information only. The gateway does not need any private key or API token.

| Public path | Destination |
| --- | --- |
| `/rpc` | Explicitly allowed ethrex reads, calls, estimates, and raw transaction submission |
| `/mempool` | Explicit frame-transaction and explorer RPC methods |
| WebSocket `/mempool` | Explorer-event subscribe/unsubscribe only |
| `/explorer/` | Explorer frontend, preserving its base path |
| `/deployment.json` | Read-only public manifest |
| `/healthz` | Gateway process health |

JSON-RPC requires `jsonrpc: "2.0"`, an ID, and array parameters. HTTP batches
contain 1–20 requests; the whole batch is checked before any member is forwarded.
Requests are parsed and serialized again. Unknown methods, admin/debug/testing,
privileged submission, trace options, key-based signing, public configuration and
faucet administration are blocked. Native simulation remains internal.

HTTP requests are limited to 1 MiB, upstream responses to 4 MiB, and upstream
requests to 20 seconds. WebSocket input is limited to 64 KiB, 120 messages per
minute per connection, 100 connections, and a bounded pre-connect queue (16
messages / 256 KiB). Explorer reconnect cursors are accepted only as nonnegative
safe integers. Each connection has at most one pending or active subscription; its
slot is released only after a matching successful unsubscribe. Closing either socket closes its peer; upstream details and error
data are not exposed.

CORS allows browser clients without credentials. The tunnel should preserve the
public Host header. Backends have no public host-port bindings; do not expose
their raw ports through another proxy.

## Verify

No package installation is needed:

```sh
bun --version # 1.4.4
bun test infra/gateway
```

The implementation uses the native APIs documented at
[HTTP server](https://bun.com/docs/runtime/http/server) and
[WebSockets](https://bun.com/docs/runtime/http/websockets).

## Cloudflare API compatibility

For this shared deployment, the Tunnel hostname `altmempool.bailo.london` routes
to `http://127.0.0.1:18080`. Existing hostnames and Access applications are retained.
The new public RPC paths must work for programmatic clients.

Cloudflare Browser Integrity Check can reject normal Python clients with error
1010. This deployment has an explicitly approved Configuration Rule with action
`set_config`, parameter `bic: false`, scoped to exactly:

```text
http.host eq "altmempool.bailo.london" and
http.request.uri.path in {"/rpc" "/rpc/" "/mempool" "/mempool/"}
```

The zone-wide browser check, other WAF controls and unrelated Access applications
stay enabled. Apply this narrow rule only with the zone owner's authorization;
verify an ordinary JSON-RPC client and a browser WebSocket after deployment.
The gateway's method, size, rate and subscription limits still apply.


## Chain address history

The gateway also indexes the internal execution RPC into persistent Bun SQLite at
`/data/explorer.sqlite`, stored in the `gateway_data` volume. It reads chain data
only; indexing makes no submissions or administrative calls. Restarting the
gateway resumes the index. A changed chain ID or genesis hash clears old history.
A detected reorg removes orphaned transactions and address associations; a reorg
deeper than 64 blocks rebuilds the index from genesis.

These methods are local to POST `/rpc`, with the existing batch and CORS policy:

| Method | Parameters | Result |
| --- | --- | --- |
| `qsw_explorerStatus` | `[]` | `{chainId,genesisHash,indexedBlock,latestBlock,transactionCount,indexing,error,lastUpdated}` |
| `qsw_explorerTransactions` | `[{address?,before?,limit?}]` | `{transactions,nextCursor}` |
| `qsw_explorerTransaction` | `[transactionHash]` | `{transaction,receipt,block:{number,hash,timestamp}}` or `null` |

`chainId` is a hex quantity; unavailable identity/block fields are null.
`indexedBlock` and `latestBlock` are numbers. `lastUpdated` is the last successful
poll time in seconds. Display `error` before an indexing indicator, and show
partial history while the indexed height is below the latest observed height.
An upstream failure keeps `indexing` true and exposes a sanitized retry message.

List rows contain `hash,blockNumber,transactionIndex,timestamp,from,to,
contractAddress,payer,type,status,gasUsed,value`. Heights, indexes, and timestamps
are numbers. Other quantities are hex strings; missing addresses, status and gas
are null. Native transactions use `sender` as their sender fallback and sum frame
values when the envelope has no outer value. Details preserve the original EL
transaction and receipt, including native `nonceKeys`, `nonceSeq`, and frames.

History is labelled **transactions involving an address**. Participants include
sender, destination, created contract, payer, frame targets, log emitters,
Transfer event sender/recipient topics, and the account in the factory's known
AccountCreated event. Calls visible only in internal execution traces are absent.

`limit` defaults to 25 and must be an integer from 1 to 100. `before` is an opaque
positive `nextCursor`; omit it for the newest page. Address pages range the
participants index, without walking unrelated history. Public detail responses
are rejected before parsing if stored JSON would exceed the 4 MiB response cap.

Backfill handles at most 32 blocks per poll and 500 receipt transactions, allowing
one larger block bounded at 5,000 transactions. There are at most four concurrent
internal reads, 16 MiB per internal RPC response, and no overlapping polls.
Receipt/block consistency is checked before each atomic block commit. Public API
queries use only SQLite and never initiate chain backfill.
