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
