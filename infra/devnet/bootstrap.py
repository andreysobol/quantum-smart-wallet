#!/usr/bin/env python3
"""Create a fresh private genesis bundle locally, then remove only its bootstrap enclave.

Runs the proven pinned ethereum-package once on a workstation/CI. The 4GB VPS
only runs Compose afterwards. Validator mnemonic, JWT and keystores never print.
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


def export_bundle(found, bundle, enclave, prefund, mnemonic):
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
    run(["docker", "stop", validator["Id"]])
    copy_file(execution["Id"], flag(execution, "--network"), bundle / "genesis.json")
    copy_file(execution["Id"], flag(execution, "--authrpc.jwtsecret"), bundle / "jwt.hex")
    testnet = flag(consensus, "--testnet-dir").rstrip("/")
    for name in ("config.yaml", "genesis.ssz", "deploy_block.txt", "deposit_contract.txt"):
        copy_file(consensus["Id"], f"{testnet}/{name}", bundle / "consensus" / name,
                  required=name in ("config.yaml", "genesis.ssz"))
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
        "chainId": CHAIN_ID,
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
            metadata["files"][str(path.relative_to(bundle))] = hashlib.sha256(path.read_bytes()).hexdigest()
    private_write(bundle / "manifest.json", json.dumps(metadata, indent=2) + "\n")
    return metadata


def main():
    global CURRENT_LOG
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prefund-address", required=True)
    parser.add_argument("--prefund-eth", type=int, default=1000)
    parser.add_argument("--kurtosis", default="kurtosis")
    parser.add_argument("--enclave", default="qsw-vps-bootstrap-" + uuid.uuid4().hex[:12])
    args = parser.parse_args()
    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", args.prefund_address):
        raise BootstrapError("Prefunded address must be a public 20-byte Ethereum address")
    if not 1 <= args.prefund_eth <= 1_000_000:
        raise BootstrapError("Prefund must be between 1 and 1,000,000 test ETH")
    if not re.fullmatch(r"qsw-vps-bootstrap-[a-zA-Z0-9-]+", args.enclave):
        raise BootstrapError("Bootstrap enclave must have a fresh qsw-vps-bootstrap- name")
    for executable in ("docker", "cast", args.kurtosis):
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
    mnemonic_result = run(["cast", "wallet", "new-mnemonic", "--words", "24", "--json"])
    mnemonic = json.loads(mnemonic_result.stdout)["mnemonic"]
    if len(mnemonic.split()) != 24:
        raise BootstrapError("Mnemonic generator did not produce 24 words")
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
        metadata = export_bundle(services(args.enclave), pending_bundle, args.enclave, prefund, mnemonic)
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
