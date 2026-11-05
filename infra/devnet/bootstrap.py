#!/usr/bin/env python3
"""Create a fresh private genesis bundle locally, then remove only its bootstrap enclave.

Runs the proven pinned ethereum-package once on a workstation/CI or privately
on the VPS. The steady-state VPS only runs Compose afterwards. Validator
mnemonic, JWT and keystores never print.
The existing local demonstration enclave is not read, stopped or reused.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import time
import uuid
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent
PACKAGE = "github.com/ethpandaops/ethereum-package@b5b3af65248f11702216e377d0377bcd8ccf4caf"
CHAIN_ID = 81411338
CURRENT_LOG = None
PINNED_EL = "ghcr.io/forshtat/ethrex@sha256:920295ae5496669a6f90a44431d4cbcb4703feec0e89207599fe19a251739873"
LOCAL_EL = "qsw-ethrex-bootstrap-local:9aa3645d"
SERVICES = {
    "execution": "el-1-ethrex-lighthouse",
    "consensus": "cl-1-lighthouse-ethrex",
    "validator": "vc-1-ethrex-lighthouse",
}


class BootstrapError(Exception):
    pass


def private_write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_text(content)
    path.chmod(0o600)


def run(argv, *, log=None, allow_failure=False):
    # Do not include argv/stderr in exceptions: generated configuration holds
    # fresh validator secrets, and genesis tools can echo them on failure.
    if log:
        with log.open("a") as output:
            result = subprocess.run(argv, stdout=output, stderr=subprocess.STDOUT, text=True, check=False)
    else:
        result = subprocess.run(argv, capture_output=True, text=True, check=False)
    if result.returncode and not allow_failure:
        if CURRENT_LOG is not None and result.stderr:
            private_write(CURRENT_LOG.parent / "failure.private.json",
                          json.dumps({"tool": Path(argv[0]).name, "operation": argv[1] if len(argv) > 1 else "", "stderr": result.stderr}, indent=2))
        raise BootstrapError(f"{Path(argv[0]).name} failed; inspect the private bootstrap log")
    return result


def required_tools(kurtosis, mnemonic_image):
    return ("docker", kurtosis) if mnemonic_image is not None else ("docker", "cast", kurtosis)


def generate_mnemonic(mnemonic_image=None):
    if mnemonic_image is not None:
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._/@:-]*", mnemonic_image):
            raise BootstrapError("Mnemonic image must be a valid nonempty Docker image reference")
        # The built sidecar already contains ethers v5. No network, host mount,
        # shell interpolation, or private-key transfer is involved. run()
        # captures the sensitive JSON in memory; it is never forwarded to stdout.
        program = (
            "const {utils}=require('ethers');"
            "console.log(JSON.stringify({mnemonic:utils.entropyToMnemonic("
            "require('node:crypto').randomBytes(32))}));"
        )
        result = run(["docker", "run", "--rm", "--network", "none", "--entrypoint", "node",
                      mnemonic_image, "-e", program])
    else:
        result = run(["cast", "wallet", "new-mnemonic", "--words", "24", "--json"])
    try:
        mnemonic = json.loads(result.stdout)["mnemonic"]
    except (ValueError, KeyError, TypeError):
        raise BootstrapError("Mnemonic generator returned invalid JSON") from None
    if not isinstance(mnemonic, str):
        raise BootstrapError("Mnemonic generator did not produce 24 words")
    words = mnemonic.split()
    if len(words) != 24 or any(not re.fullmatch(r"[a-z]+", word) for word in words):
        raise BootstrapError("Mnemonic generator did not produce 24 words")
    return " ".join(words)


def flag(info, name):
    tokens = [*(info["Config"].get("Entrypoint") or []), *(info["Config"].get("Cmd") or [])]
    if "-c" in tokens:
        position = tokens.index("-c")
        tokens = shlex.split(tokens[position + 1])
    for index, token in enumerate(tokens):
        if token.startswith(name + "="):
            return token[len(name) + 1:]
        if token == name and index + 1 < len(tokens):
            return tokens[index + 1]
    raise BootstrapError(f"Expected source service flag {name} was not found")


def services(enclave):
    ids = run(["docker", "ps", "-a", "--filter", f"label=com.kurtosistech.enclave-name={enclave}", "--format", "{{.ID}}"])
    if not ids.stdout.split():
        raise BootstrapError("Bootstrap enclave has no containers")
    inspected = json.loads(run(["docker", "inspect", *ids.stdout.split()]).stdout)
    found = {}
    for item in inspected:
        labels = item["Config"].get("Labels") or {}
        for role, expected in SERVICES.items():
            if labels.get("com.kurtosistech.id") == expected:
                if role in found:
                    raise BootstrapError("More than one bootstrap container matches a role")
                found[role] = item
    if set(found) != set(SERVICES):
        raise BootstrapError("Bootstrap EL/CL/VC services are incomplete")
    return found


def copy_file(container, source, destination, *, required=True):
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    copied = run(["docker", "cp", "-L", f"{container}:{source}", str(destination)], allow_failure=not required)
    if copied.returncode:
        return False
    if destination.is_symlink() or not destination.is_file():
        raise BootstrapError("Exported configuration is not a regular file")
    destination.chmod(0o600)
    return True


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def http_endpoint(info, port_flag):
    port = flag(info, port_flag)
    bindings = info.get("NetworkSettings", {}).get("Ports", {}).get(port + "/tcp") or []
    for binding in bindings:
        if binding.get("HostIp") in ("127.0.0.1", "0.0.0.0", "::", "::1", ""):
            host_port = binding.get("HostPort", "")
            if host_port.isdigit():
                return "http://127.0.0.1:" + host_port
    raise BootstrapError("Bootstrap API has no host-local port binding")


def http_json(url, body=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


def rpc(url, method, params=None):
    reply = http_json(url, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []})
    if "error" in reply:
        raise BootstrapError("Bootstrap execution RPC rejected a readiness check")
    return reply["result"]


def read_checkpoint(execution_url, consensus_url):
    if int(rpc(execution_url, "eth_chainId"), 16) != CHAIN_ID:
        raise BootstrapError("Bootstrap execution API has the wrong chain ID")
    if "9aa3645d" not in rpc(execution_url, "web3_clientVersion"):
        raise BootstrapError("Bootstrap execution API has the wrong pinned profile")
    spec = http_json(consensus_url + "/eth/v1/config/spec")["data"]
    if (int(spec["HEZE_FORK_EPOCH"]), int(spec["SLOTS_PER_EPOCH"]), int(spec["SECONDS_PER_SLOT"])) != (2, 32, 6):
        raise BootstrapError("Bootstrap consensus fork schedule differs from the pinned profile")
    genesis = http_json(consensus_url + "/eth/v1/beacon/genesis")["data"]
    head = http_json(consensus_url + "/eth/v1/beacon/headers/head")["data"]
    syncing = http_json(consensus_url + "/eth/v1/node/syncing")["data"]
    block = rpc(execution_url, "eth_getBlockByNumber", ["latest", False])
    slot = int(head["header"]["message"]["slot"])
    number = int(block["number"], 16)
    activated = (slot >= 64 and number > 0 and
                 int(block["timestamp"], 16) >= int(genesis["genesis_time"]) + 384 and
                 not syncing["is_syncing"] and not syncing.get("el_offline", True) and
                 not syncing.get("is_optimistic", True))
    return {"executionBlockNumber": number, "executionBlockHash": block["hash"],
            "consensusSlot": slot, "consensusRoot": head["root"],
            "hezeActive": activated, "hezeForkEpoch": 2}


def wait_for_mining(found, timeout):
    execution_url = http_endpoint(found["execution"], "--http.port")
    consensus_url = http_endpoint(found["consensus"], "--http-port")
    deadline = time.monotonic() + timeout
    previous = None
    advances = 0
    next_log = 0
    while time.monotonic() < deadline:
        try:
            checkpoint = read_checkpoint(execution_url, consensus_url)
            if checkpoint["hezeActive"]:
                if previous is not None and checkpoint["executionBlockNumber"] > previous:
                    advances += 1
                previous = checkpoint["executionBlockNumber"]
                if advances >= 2:
                    checkpoint["observedPostHezeAdvances"] = advances
                    print(json.dumps({"bootstrapMiningReady": True, **checkpoint}), flush=True)
                    return checkpoint
            else:
                previous, advances = None, 0
            status = f"slot {checkpoint['consensusSlot']}, EL {checkpoint['executionBlockNumber']}"
        except (BootstrapError, OSError, ValueError, KeyError, TypeError):
            status = "private bootstrap services starting"
        if time.monotonic() >= next_log:
            print("Waiting for mined Heze and two EL advances: " + status, flush=True)
            next_log = time.monotonic() + 30
        time.sleep(3)
    raise BootstrapError("Fresh bootstrap did not mine through Heze; no genesis-only bundle was published")


def stop_for_snapshot(info):
    run(["docker", "stop", "--time", "60", info["Id"]])
    stopped = json.loads(run(["docker", "inspect", info["Id"]]).stdout)[0]["State"]
    if stopped.get("Running") or stopped.get("OOMKilled") or stopped.get("ExitCode") != 0:
        raise BootstrapError("Bootstrap service did not stop cleanly; refusing an unsafe database snapshot")


def freeze_services(found):
    for role in ("validator", "consensus", "execution"):
        stop_for_snapshot(found[role])


def copy_datadir(info, destination):
    source = flag(info, "--datadir").rstrip("/")
    if not source.startswith("/") or source in ("", "/"):
        raise BootstrapError("Unsafe bootstrap data directory")
    destination.mkdir(parents=True, mode=0o700)
    run(["docker", "cp", "-L", info["Id"] + ":" + source + "/.", str(destination)])
    count = 0
    for path in destination.rglob("*"):
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise BootstrapError("Refusing an unsafe database snapshot entry")
        path.chmod(0o700 if path.is_dir() else 0o600)
        count += int(path.is_file())
    if not count:
        raise BootstrapError("Bootstrap database snapshot is empty")


def export_bundle(found, bundle, enclave, prefund, mnemonic, checkpoint):
    execution, consensus, validator = [found[key] for key in ("execution", "consensus", "validator")]
    keys = flag(validator, "--validators-dir").rstrip("/")
    secrets = flag(validator, "--secrets-dir").rstrip("/")
    # Service creation is not proof that VC key import/DB initialization has
    # finished. Wait for its actual DB before stopping this fresh bootstrap VC.
    deadline = time.monotonic() + 90
    while True:
        ready = run(["docker", "exec", validator["Id"], "sh", "-c", 'test -s "$1"', "check", keys + "/slashing_protection.sqlite"], allow_failure=True)
        if ready.returncode == 0:
            break
        if time.monotonic() >= deadline:
            raise BootstrapError("Bootstrap VC did not initialize its slashing DB; no bundle was published")
        time.sleep(2)
    # Stop ONLY this newly-created VC before copying its keystores and slashing
    # database. No validator runs locally after the exported identity is moved.
    # Stop all database writers before copying either side of Engine API state.
    # The retained VC SQLite covers every signature made by this fresh identity.
    freeze_services(found)
    copy_datadir(execution, bundle / "snapshot/execution")
    copy_datadir(consensus, bundle / "snapshot/consensus")
    copy_file(execution["Id"], flag(execution, "--network"), bundle / "genesis.json")
    copy_file(execution["Id"], flag(execution, "--authrpc.jwtsecret"), bundle / "jwt.hex")
    testnet = flag(consensus, "--testnet-dir").rstrip("/")
    for name in ("config.yaml", "genesis.ssz", "deposit_contract_block.txt", "deposit_contract.txt"):
        copy_file(consensus["Id"], f"{testnet}/{name}", bundle / "consensus" / name,
                  required=name in ("config.yaml", "genesis.ssz", "deposit_contract_block.txt"))
    if (bundle / "consensus/deposit_contract_block.txt").read_text().strip() != "0":
        raise BootstrapError("Expected the genesis-preloaded deposit contract to start at block 0")
    if Path(keys).parent != Path(secrets).parent:
        raise BootstrapError("Unexpected separate validator export roots")
    destination = bundle / "validator-keys"
    destination.mkdir(parents=True, mode=0o700)
    # The shared key-generator volume also contains other clients' key layouts
    # and symlinks. Export only the two paths this Lighthouse VC actually uses.
    for source, name in [(keys, "keys"), (secrets, "secrets")]:
        target = destination / name
        target.mkdir(mode=0o700)
        run(["docker", "cp", "-L", f"{validator['Id']}:{source}/.", str(target)])
    for path in destination.rglob("*"):
        if path.is_symlink():
            raise BootstrapError("Refusing an exported validator symlink")
        path.chmod(0o700 if path.is_dir() else 0o600)
    if not (destination / "keys/slashing_protection.sqlite").is_file():
        raise BootstrapError("Stopped bootstrap VC has no retained slashing-protection DB")
    private_write(bundle / "recovery/validator-mnemonic.txt", mnemonic + "\n")
    genesis = json.loads((bundle / "genesis.json").read_text())
    if int(genesis["config"]["chainId"]) != CHAIN_ID:
        raise BootstrapError("Generated execution genesis has the wrong chain ID")
    metadata = {
        "formatVersion": 2,
        "chainId": CHAIN_ID,
        "snapshot": checkpoint,
        "bootstrapEnclave": enclave,
        "ethereumPackage": PACKAGE,
        "prefundedAccounts": prefund,
        "createdAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "images": {key: value["Config"]["Image"] for key, value in found.items()},
        "executionImageDigest": PINNED_EL,
        "files": {},
    }
    for path in sorted(bundle.rglob("*")):
        if path.is_file():
            metadata["files"][str(path.relative_to(bundle))] = sha256_file(path)
    private_write(bundle / "manifest.json", json.dumps(metadata, indent=2) + "\n")
    return metadata


def main():
    global CURRENT_LOG
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prefund-address", required=True)
    parser.add_argument("--prefund-eth", type=int, default=1000)
    parser.add_argument("--kurtosis", default="kurtosis")
    parser.add_argument("--ready-timeout", type=int, default=1800, help="Maximum seconds to mine through Heze before any export")
    parser.add_argument("--mnemonic-image", help="Generate secrets locally with an existing Node+ethers image instead of requiring cast")
    parser.add_argument("--enclave", default="qsw-vps-bootstrap-" + uuid.uuid4().hex[:12])
    args = parser.parse_args()
    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", args.prefund_address):
        raise BootstrapError("Prefunded address must be a public 20-byte Ethereum address")
    if not 1 <= args.prefund_eth <= 1_000_000:
        raise BootstrapError("Prefund must be between 1 and 1,000,000 test ETH")
    if not 600 <= args.ready_timeout <= 3600:
        raise BootstrapError("Mining readiness timeout must be between 600 and 3600 seconds")
    if not re.fullmatch(r"qsw-vps-bootstrap-[a-zA-Z0-9-]+", args.enclave):
        raise BootstrapError("Bootstrap enclave must have a fresh qsw-vps-bootstrap- name")
    for executable in required_tools(args.kurtosis, args.mnemonic_image):
        if not shutil.which(executable):
            raise BootstrapError(f"Required local tool is missing: {Path(executable).name}")
    generated = ROOT / ".generated"
    generated.mkdir(exist_ok=True, mode=0o700)
    bundle = generated / "bundle"
    if bundle.exists():
        raise BootstrapError("A private bundle already exists; refusing to overwrite or reset it")
    # Project-local config avoids mutating the user's Kurtosis settings and
    # disables the optional ClickHouse/Otel stack on small bootstrap hosts.
    config_root = generated / "kurtosis-config"
    private_write(config_root / "kurtosis/kurtosis-config.yml",
                  "config-version: 9\nshould-send-metrics: false\nkurtosis-clusters:\n"
                  "  docker:\n    type: docker\n    backend-log-collector: vector\n")
    os.environ["XDG_CONFIG_HOME"] = str(config_root)
    work = generated / "bootstrap" / args.enclave
    work.mkdir(mode=0o700, parents=True, exist_ok=False)
    log = work / "launch.private.log"
    private_write(log, "")
    CURRENT_LOG = log
    mnemonic = generate_mnemonic(args.mnemonic_image)
    prefund = {args.prefund_address: {"balance": f"{args.prefund_eth}ETH"}}
    template = (ROOT / "network.template.yaml").read_text()
    rendered = template.replace("__VALIDATOR_MNEMONIC__", json.dumps(mnemonic))
    rendered = rendered.replace("__PREFUND_JSON__", json.dumps(json.dumps(prefund)))
    rendered = rendered.replace("__LOCAL_EL_IMAGE__", LOCAL_EL)
    input_file = work / "network.private.yaml"
    private_write(input_file, rendered)
    # Do not reuse any enclave: even an explicitly supplied bootstrap name may
    # refer to another run. Only our newly-created enclave is removed below.
    exists = run([args.kurtosis, "enclave", "inspect", args.enclave], allow_failure=True)
    if exists.returncode == 0:
        raise BootstrapError("Bootstrap enclave already exists; choose a fresh name")
    print(f"Generating fresh chain {CHAIN_ID} in {args.enclave}; private output is captured", flush=True)
    created = False
    try:
        # ethrex's pinned image is amd64-only. Kurtosis on an ARM workstation
        # otherwise tries an impossible ARM pull even when amd64 is cached.
        # This unique local alias is verified/tagged from the immutable digest,
        # exactly the official mining helper's local-image approach.
        run(["docker", "pull", "--platform", "linux/amd64", PINNED_EL], log=log)
        run(["docker", "tag", PINNED_EL, LOCAL_EL], log=log)
        run([args.kurtosis, "engine", "start"], log=log)
        created = True
        run([args.kurtosis, "run", "--enclave", args.enclave, PACKAGE, "--args-file", str(input_file)], log=log)
        pending_bundle = generated / ("exporting-" + args.enclave)
        pending_bundle.mkdir(mode=0o700)
        found = services(args.enclave)
        checkpoint = wait_for_mining(found, args.ready_timeout)
        metadata = export_bundle(found, pending_bundle, args.enclave, prefund, mnemonic, checkpoint)
        pending_bundle.rename(bundle)
        archive = generated / "devnet-bundle.private.tar.gz"
        with tarfile.open(archive, "w:gz") as output:
            output.add(bundle, arcname="bundle")
        archive.chmod(0o600)
        print(json.dumps({"chainId": CHAIN_ID, "prefundedAddresses": list(prefund),
                          "bundle": str(bundle), "privateArchive": str(archive),
                          "exportedFileCount": len(metadata["files"])}), flush=True)
    finally:
        if created:
            cleanup = run([args.kurtosis, "enclave", "rm", args.enclave, "--force"], log=log, allow_failure=True)
            if cleanup.returncode:
                print(f"Bootstrap cleanup needs attention: {args.enclave}; do not start its VC beside the VPS VC", file=sys.stderr)


if __name__ == "__main__":
    try:
        main()
    except BootstrapError as error:
        print(f"Bootstrap stopped: {error}", file=sys.stderr)
        sys.exit(1)
