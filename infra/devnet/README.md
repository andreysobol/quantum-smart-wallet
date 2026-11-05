# Shared Quantum Smart Wallet devnet

Dedicated **chain 81411338**. The VPS runtime is a small Compose stack: pinned
ethrex, one Lighthouse beacon, one 32-validator VC, the genuine custom validating
sidecar, and a static explorer. It does not run Kurtosis, ClickHouse, a prover,
or a database service. The native envelope/opcodes are the tested ethrex
`9aa3645d` profile, not whichever EIP draft is newest.

## Bootstrap once on a workstation or CI

Requires Docker, Kurtosis CLI 1.22.2, Python 3.10+, `git`, and Foundry `cast`.
The pinned ethereum-package creates the same staged forks as the working local
mining example: Osaka at genesis, Amsterdam at epoch 1, Hegota at epoch 2,
32 slots/epoch, 6 seconds/slot. Both EIP-8282 builder predeploys and the deposit
inhibitor are retained. The staking registry is preloaded at
`0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f` from the tracked source/runtime.

```sh
python3 infra/devnet/bootstrap.py \
  --prefund-address 0xYOUR_FRESH_PUBLIC_DEPLOYER_ADDRESS \
  --prefund-eth 1000 \
  --kurtosis /absolute/path/to/kurtosis
```

The address must be a real 20-byte address. Its private key stays outside this
repository and outside every Docker build context. Bootstrap generates a fresh
24-word validator mnemonic without printing it, creates only a uniquely named
`qsw-vps-bootstrap-*` enclave, stops its VC before exporting, and removes that
bootstrap enclave. It never resets or removes the existing local demo enclave.
On ARM it tags the immutable amd64 ethrex image with a unique local alias, as
the official mining helper does, to avoid Kurtosis requesting a nonexistent ARM
manifest. The project-local Kurtosis config uses Vector, not optional Otel.

Outputs are **private and Git-ignored**:

- `.generated/bundle/`: immutable genesis/config/JWT, validator keys plus retained
  slashing DB, recovery mnemonic, and SHA-256 manifest.
- `.generated/devnet-bundle.private.tar.gz`: transfer this privately to the VPS.
- `.generated/bootstrap/`: private rendered input and diagnostic log. Do not
  publish these logs: the upstream generator can echo validator configuration.

Bundle creation is reproducible from pinned tools and the retained private input;
each fresh invocation intentionally creates a new genesis/identity. A sealed
bundle is never overwritten. Never run its bootstrap VC and VPS VC together.

## Prepare and launch the VPS

Use an x86_64 Linux host with Docker Compose v2, Python 3.10+, and Git. The runtime
memory limits total about 3 GiB; 2 vCPU/4 GiB is intended for the small demo,
not a load-tested public service. Build images before starting the nodes to avoid
competing for that memory. Pull/build needs internet access.

Transfer the private archive over SSH, preserving confidentiality, and extract
into the checkout's `infra/devnet/.generated/` so it contains `bundle/`.

```sh
mkdir -p infra/devnet/.generated
chmod 700 infra/devnet/.generated
tar -xzf /private/path/devnet-bundle.private.tar.gz -C infra/devnet/.generated
python3 infra/devnet/configure.py --public-url https://altmempool.bailo.london
python3 infra/devnet/prepare_source.py
python3 infra/devnet/prepare_source.py --check

docker compose --env-file infra/devnet/.generated/runtime.env -f infra/devnet/compose.yaml config --quiet
docker compose --env-file infra/devnet/.generated/runtime.env -f infra/devnet/compose.yaml build sidecar
docker compose --env-file infra/devnet/.generated/runtime.env -f infra/devnet/compose.yaml build explorer
docker network inspect qsw-devnet >/dev/null 2>&1 || docker network create qsw-devnet
docker compose --env-file infra/devnet/.generated/runtime.env -f infra/devnet/compose.yaml up -d
docker compose --env-file infra/devnet/.generated/runtime.env -f infra/devnet/compose.yaml exec -T sidecar node /opt/qsw/readiness.mjs
```

`configure.py` verifies the sealed bundle, copies validator material **once** to
the separate writable `.generated/runtime-validator`, and binds that runtime to
the genesis fingerprint. Reruns retain its slashing database. A missing DB or
different genesis causes an error; it is never silently recreated. Keep this
private runtime directory in backups along with the sealed bundle.

The default block fee recipient is `0x000000000000000000000000000000000000dEaD`.
This keeps block-tip credits out of the sponsor's balance, so the sponsor's
balance decrease equals the gross transaction fee in the demo. Override it with
`configure.py --fee-recipient ADDRESS` when that measurement is not needed.

Readiness requires the expected chain/profile, CL epoch 2, the exact registry
runtime, and advancing EL blocks. Hegota begins at genesis +384 seconds; an HTTP
response or chain ID alone does not prove mining readiness. The single beacon
retains the proven `--target-peers=0` setting. A testnet may initially skip slots
while catching up from an older genesis.

## Gateway interface

The shared Docker network is `qsw-devnet`. The separate gateway joins it and uses:

| Service | Internal destination | Public route owned by the gateway |
|---|---|---|
| EL | `http://ethrex:8545` | `/rpc`, explicit method allowlist |
| Sidecar HTTP/WS | `http://sidecar:14337/rpc` | `/mempool`, explicit method allowlist |
| Static explorer | `http://explorer:8080` | `/explorer/` |

No service here publishes a host port. Engine/JWT, CL/VC, raw debug/admin and
privileged submission remain private. The gateway must validate method names in
HTTP batches and WebSocket frames and deny `engine_*`, `admin_*`, `debug_*`,
`debug_bundler_*`, `testing_*`, and direct privileged submission. A plain
path-based reverse proxy is insufficient because it reaches localhost-gated APIs
from a trusted address. Gateway TLS/tunnel/DNS are deliberately separate.

The explorer build fixes both Vite assets and router paths under `/explorer/`.
Its static backend accepts stripped or unstripped prefixes. Change the public
origin with `configure.py` and rebuild the explorer image.

## Sidecar provenance and policy

`prepare_source.py` fetches public source commit
`2e22ff0a2898e69ea4bf5275bce1be8581a8582a`, applies only tracked patches, and
fingerprints all copied build inputs. It preserves an existing tree whose source
inputs differ instead of resetting it. The Docker build runs the focused policy
and WebSocket regression tests before producing the runtime.

This is an explicitly identified **custom PQ mempool**. Each distinct third-party
entity stays at 100k verification gas. Only the actual on-chain-staked sender
gets 2.5m: positive stake at least 0.01 ETH, delay at least one day, and no pending
withdrawal. Repeated roles/addresses share one budget. Signature costs and expiry
accounting remain bounded; this custom validator rejects leading expiry frames.
All original crypto, execution, opcode, storage and balance checks remain. Empty
whitelists are used; only the real SHA-256 precompile is configured as such.
`policy.yaml` determines the advertised content-addressed mempool ID.

Transactions enter via `eth_sendFrameTransaction`, undergo full native traced
simulation and admission, then the standard auto-relayer submits them to the
private co-located ethrex ingress. There is no harness/public privileged bypass.

## Operations and durability

EL/CL databases and sidecar DB use named volumes; validator runtime/slashing data
use the separate private host directory. All runtime services restart unless
stopped. Store the image digests, genesis, private bundle, runtime-validator,
named volumes, public deployment manifest and policy together in backups.

Use this same Compose project for updates. Never use `down -v` or regenerate the
bundle to restart the service. Restore a consistent snapshot; never initialize a
fresh slashing DB for the same validator keys. Keep exactly one active VC during
host migration. Raw bootstrap CI `down` removes an enclave and is not the VPS
restart procedure.

The explorer's admission/lifecycle history is an in-memory 10,000-record buffer
and clears on sidecar restart. Persisted mempool/reputation DB does not turn that
history into a durable index. Save important admission reports and chain receipts
separately; pruned entries may no longer resolve through sidecar lookup APIs.

Local checks without deploying anything: `python3 infra/devnet/test_sanity.py`.
