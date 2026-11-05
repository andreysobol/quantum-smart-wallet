#!/usr/bin/env python3
"""Validate a sealed private bundle and render public runtime configuration."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import urllib.parse

ROOT = Path(__file__).resolve().parent
CHAIN_ID = 81411338
DEFAULT_FEE_RECIPIENT = "0x000000000000000000000000000000000000dEaD"


def policy_cid(data):
    return "b" + base64.b32encode(b"\x01\x55\x12\x20" + hashlib.sha256(data).digest()).decode().lower().rstrip("=")


def validate_deposit_start(bundle):
    file = bundle / "consensus/deposit_contract_block.txt"
    if not file.is_file() or file.is_symlink():
        raise ValueError("required Lighthouse file missing: consensus/deposit_contract_block.txt")
    if file.read_text().strip() != "0":
        raise ValueError("expected genesis-preloaded deposit contract start block 0")


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_snapshot(bundle, metadata):
    snapshot = metadata.get("snapshot", {})
    if (metadata.get("formatVersion") != 2 or not snapshot.get("hezeActive") or
        snapshot.get("observedPostHezeAdvances", 0) < 2 or
        snapshot.get("hezeForkEpoch") != 2 or
        snapshot.get("consensusSlot", 0) < 64 or snapshot.get("executionBlockNumber", 0) < 1 or
        not re.fullmatch(r"0x[0-9a-fA-F]{64}", snapshot.get("executionBlockHash", ""))):
        raise ValueError("a mined post-Heze version 2 snapshot is required; preserve older bundles")
    for role in ("execution", "consensus"):
        directory = bundle / "snapshot" / role
        files = [p for p in directory.rglob("*") if p.is_file()] if directory.is_dir() else []
        if directory.is_symlink() or not files:
            raise ValueError(f"required {role} database snapshot is missing")
        pointer = directory / (f"chain-{CHAIN_ID}/CURRENT" if role == "execution" else "beacon/chain_db/CURRENT")
        if not pointer.is_file() or pointer.is_symlink() or pointer.stat().st_size == 0:
            raise ValueError(f"required {role} database pointer is missing")
        for file in files:
            if file.is_symlink() or str(file.relative_to(bundle)) not in metadata["files"]:
                raise ValueError("database snapshot file is unsafe or not sealed")


def validate_bundle(bundle):
    metadata = json.loads((bundle / "manifest.json").read_text())
    if metadata.get("chainId") != CHAIN_ID:
        raise ValueError("wrong bundle chain ID")
    for relative, expected in metadata["files"].items():
        file = bundle / relative
        if file.is_symlink() or not file.is_file() or not file.resolve().is_relative_to(bundle.resolve()):
            raise ValueError("unsafe/missing bundle file")
        if sha256_file(file) != expected:
            raise ValueError(f"bundle file checksum failed: {relative}")
    genesis = json.loads((bundle / "genesis.json").read_text())
    if int(genesis["config"]["chainId"]) != CHAIN_ID:
        raise ValueError("wrong execution chain ID")
    registry = genesis["alloc"].get("d51c04d7a0b01124e84de152f4e56d9eecb22d2f") or genesis["alloc"].get("0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f")
    if not registry or registry.get("code", "").lower() != (ROOT / "genesis/registry.runtime.hex").read_text().strip().lower():
        raise ValueError("staking registry runtime does not match the pinned source")
    for required in ("consensus/config.yaml", "consensus/genesis.ssz", "consensus/deposit_contract_block.txt", "jwt.hex"):
        if not (bundle / required).is_file():
            raise ValueError(f"required bundle file missing: {required}")
    validate_deposit_start(bundle)
    validate_snapshot(bundle, metadata)
    if not (bundle / "validator-keys/keys").is_dir() or not (bundle / "validator-keys/secrets").is_dir():
        raise ValueError("validator keys/secrets are missing")
    database = bundle / "validator-keys/keys/slashing_protection.sqlite"
    if not database.is_file() or database.stat().st_size == 0:
        raise ValueError("exported slashing-protection DB is missing; never recreate it for these keys")
    jwt = (bundle / "jwt.hex").read_text().strip()
    if not re.fullmatch(r"(?:0x)?[0-9a-fA-F]{64}", jwt):
        raise ValueError("invalid testnet JWT format")
    return metadata


def initialize_validator_runtime(generated):
    bundle = generated / "bundle"
    runtime = generated / "runtime-validator"
    fingerprint = {"chainId": CHAIN_ID, "genesisSha256": hashlib.sha256((bundle / "genesis.json").read_bytes()).hexdigest()}
    marker = runtime / ".qsw-genesis.json"
    if runtime.exists():
        if not marker.is_file() or json.loads(marker.read_text()) != fingerprint:
            raise ValueError("existing validator runtime belongs to another/unknown genesis; preserve it")
    else:
        shutil.copytree(bundle / "validator-keys", runtime)
        runtime.chmod(0o700)
        marker.write_text(json.dumps(fingerprint, indent=2) + "\n")
        marker.chmod(0o600)
    database = runtime / "keys/slashing_protection.sqlite"
    if database.is_symlink() or not database.is_file() or database.stat().st_size == 0:
        raise ValueError("runtime slashing DB is missing; restore its backup rather than reinitializing")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--public-url", required=True)
    parser.add_argument("--fee-recipient")
    args = parser.parse_args()
    url = urllib.parse.urlsplit(args.public_url.rstrip("/"))
    if url.scheme not in ("https", "http") or not url.hostname or url.username or url.password or url.query or url.fragment or url.path:
        raise ValueError("public URL must be a plain HTTP(S) origin")
    generated = ROOT / ".generated"
    metadata = validate_bundle(generated / "bundle")
    initialize_validator_runtime(generated)
    # Keep block-tip credits out of the sponsor's balance so a demo's sponsor
    # balance delta equals the gross transaction fee. This address has no key.
    recipient = args.fee_recipient or DEFAULT_FEE_RECIPIENT
    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", recipient):
        raise ValueError("invalid fee recipient")
    cid = policy_cid((ROOT / "policy.yaml").read_bytes())
    sentinel = "0x00000000000000000000000000000000000000aa"
    config = {
        "entryPoints": [sentinel], "canonicalEntryPoint": sentinel,
        "standardMempoolId": cid,
        "supportedMempools": [{"mempoolId": cid, "entryPoint": sentinel}],
        "relayers": [], "rpcEndpoint": "http://ethrex:8545", "rpcEndpointSubmit": "http://ethrex:8545",
        "stakingRegistryAddress": "0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f",
        "minStake": "10000000000000000", "minUnstakeDelay": 86400,
        "precompiles": ["0x0000000000000000000000000000000000000002"],
        "whitelistedEntities": {"account": [], "paymaster": [], "factory": [], "external": []},
        "relayOpsWithWhitelistedEntities": False,
        "bundleInterval": 1000, "maxSubmitAttempts": 30, "maxConcurrentSubmissions": 2,
        "bundleSize": 2, "userOpGasLimit": 16_777_216,
        "enforceGasPrice": False, "useropsTTL": 600,
    }
    # No signing keys live here: protocol transactions arrive already signed.
    (generated / "sidecar-config.json").write_text(json.dumps(config, indent=2) + "\n")
    (generated / "sidecar-config.json").chmod(0o644)
    project = "qsw-devnet-" + sha256_file(generated / "bundle/genesis.json")[:12]
    (generated / "runtime.env").write_text(f"COMPOSE_PROJECT_NAME={project}\nQSW_PUBLIC_URL={args.public_url.rstrip('/')}\nQSW_FEE_RECIPIENT={recipient}\n")
    (generated / "runtime.env").chmod(0o600)
    print(json.dumps({"chainId": CHAIN_ID, "policyCid": cid, "publicUrl": args.public_url,
                      "feeRecipient": recipient, "bundleChecksums": "verified"}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, StopIteration) as error:
        raise SystemExit(f"Configuration not written: {error}") from None
