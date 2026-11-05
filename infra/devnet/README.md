# Shared Quantum Smart Wallet devnet

Dedicated **chain 81411338**. The VPS runtime is a small Compose stack: pinned
ethrex, one Lighthouse beacon, one 32-validator VC, the genuine custom validating
sidecar, and a static explorer. It does not run Kurtosis, ClickHouse, a prover,
or a database service. The native envelope/opcodes are the tested ethrex
`9aa3645d` profile, not whichever EIP draft is newest.

## Server-only bootstrap: secrets stay on the VPS

This path creates a new identity directly on the server. It does **not** upload
or reuse any workstation validator keys, JWT, mnemonic, or private archive.
Requires Docker, Python 3.10+, Git, Kurtosis CLI 1.22.2, and the already-built
sidecar image. Foundry `cast` is not required when `--mnemonic-image` is supplied.

Before running Kurtosis on a public VPS, keep its temporary published EL/engine
and bootstrap API ports private at the Docker firewall. The deployment owner
manages that temporary rule; the script does not change host firewall rules.

```sh
python3 infra/devnet/bootstrap.py \
  --prefund-address 0xYOUR_FRESH_PUBLIC_DEPLOYER_ADDRESS \
  --prefund-eth 1000 \
  --kurtosis /absolute/path/to/kurtosis \
  --mnemonic-image qsw-sidecar:2e22ff0a-pq-v1
```

The image runs Node with its existing `ethers` dependency in an isolated,
network-disabled temporary container. It generates 256 bits of fresh entropy;
the script captures the resulting 24-word mnemonic privately in memory and
never prints it. The public prefunded address can belong to a key kept off the
server: that key is neither needed nor accepted by bootstrap.

The resulting `.generated/bundle`, JWT, validator keystores, recovery material,
logs, and private archive remain on the VPS. Do not download or publish them.
Continue with `configure.py` and Compose below using that same local bundle;
skip the workstation archive-transfer/extraction steps. After the script has
removed its new bootstrap enclave, the deployment owner stops only the newly
introduced bootstrap coordinator/logging services. Kurtosis is not part of the
steady-state 4GB runtime. No existing enclave or unrelated service is stopped.

The sidecar runtime itself uses pinned **Bun 1.4.4**, not Node's strict ESM
loader: the upstream packages contain extensionless directory imports that
Node 24 rejects. Node remains available for the small standalone health/readiness
scripts. The public builder image runs the TypeScript/unit checks before Bun
starts the compiled CLI.

## Bootstrap once on a workstation or CI

Requires Docker, Kurtosis CLI 1.22.2, Python 3.10+, `git`, and Foundry `cast`.
The pinned ethereum-package creates the same staged forks as the working local
mining example: Osaka at genesis, Amsterdam at epoch 1, Hegota at epoch 2,
32 slots/epoch, 6 seconds/slot, and a 120-second genesis delay. Both EIP-8282 builder predeploys and the deposit
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
`qsw-vps-bootstrap-*` enclave, and waits for real mining through Heze plus two
observed execution-head advances. Only then it stops that enclave's VC, beacon,
and EL in order, exports their consistent offline state, and removes the enclave.
A genesis-only or stalled chain is never published as a usable bundle. It never resets or removes the existing local demo enclave.
On ARM it tags the immutable amd64 ethrex image with a unique local alias, as
the official mining helper does, to avoid Kurtosis requesting a nonexistent ARM
manifest. The project-local Kurtosis config uses Vector, not optional Otel.

Outputs are **private and Git-ignored**:

- `.generated/bundle/`: immutable genesis/config/JWT, offline EL and CL database
  snapshots after mined Heze, validator keys plus retained slashing DB, recovery
  mnemonic, and a version 2 SHA-256 manifest with the mining checkpoint.
- `.generated/devnet-bundle.private.tar.gz`: transfer this privately to the VPS.
- `.generated/bootstrap/`: private rendered input and diagnostic log. Do not
  publish these logs: the upstream generator can echo validator configuration.

Bundle creation is reproducible from pinned tools and the retained private input;
each fresh invocation intentionally creates a new genesis/identity. A sealed
bundle is never overwritten. Never run its bootstrap VC and VPS VC together.

## Prepare and launch the VPS

Use an x86_64 Linux host with Docker Compose v2, Python 3.10+, and Git. The runtime
node memory caps total about 3.6 GiB; 2 vCPU/4 GiB is intended for the small demo,
not a load-tested public service. The validator cap includes startup key-decryption
peaks; normal usage is lower. Build images before starting the nodes to avoid
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

`configure.py` requires the sealed, mined version 2 bundle and sets
`COMPOSE_PROJECT_NAME=qsw-devnet-<genesis-file-SHA256-first-12>` in `runtime.env`.
The same genesis reuses its project and named volumes; a different genesis gets
new volume names, preserving every earlier failed candidate. Keep passing the
`--env-file` argument on all Compose commands.

Two offline one-shot initializers verify each database snapshot and seed only
empty volumes into `/data/runtime`, with a chain/genesis/checkpoint fingerprint.
An existing matching runtime is retained; an unmarked or mismatched volume is
refused and never overwritten. Neither initializer exposes ports or uses a
network. They finish before the EL/CL start.

`configure.py` copies validator material **once** to
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
retains the proven `--target-peers=0` setting and bypasses the HTTP worker queue
on this small private network. Bootstrap mines across the staged fork boundaries
before export; the persistent runtime resumes that saved fork choice and EL
state rather than rebuilding a never-mined old genesis across later forks.

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

Use the same generated Compose project name for updates; never replace it with
the old fixed `qsw-devnet` project name. Preserve `runtime.env` with backups.
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

### Repairing the missing public deposit-start file in an older bundle

Lighthouse requires `consensus/deposit_contract_block.txt`. Its value is `0`
because this dedicated chain preloads the deposit contract in genesis. Future
bootstrap exports require that exact file; similarly named `deploy_block.txt`
is not a substitute.

For an already sealed bundle created by the earlier exporter, run **on the same
server that holds its keys**:

```sh
python3 infra/devnet/repair_public_metadata.py
python3 infra/devnet/configure.py --public-url https://altmempool.bailo.london
python3 infra/devnet/prepare_source.py
docker compose --env-file infra/devnet/.generated/runtime.env -f infra/devnet/compose.yaml build sidecar
docker compose --env-file infra/devnet/.generated/runtime.env -f infra/devnet/compose.yaml up -d sidecar
docker compose --env-file infra/devnet/.generated/runtime.env -f infra/devnet/compose.yaml restart beacon validator
```

The repair verifies the old checksum manifest and chain ID, confirms the deposit
contract exists in genesis, adds only the public block-number file, updates its
manifest hash, and repacks the private archive locally. Genesis, JWT, validator
keys, runtime/slashing DB, and the runtime genesis fingerprint remain unchanged.
No regeneration, reset, or private-key upload is performed.

### Preserving an earlier failed genesis-only candidate

Version 2 deliberately rejects older genesis-only bundles. Do not repair them
into snapshots, delete their volumes, reuse their validator identity, or reset
their slashing database. Stop that candidate's producers, archive its private
`.generated/bundle` and `.generated/runtime-validator` together with its existing
volumes, then run the server-only bootstrap with a fresh identity. The generated
project namespace selects fresh volumes without deleting the archived ones.
The old public-metadata repair above is useful only for inspecting the old
candidate; it does not make it eligible for the new snapshot runtime.
