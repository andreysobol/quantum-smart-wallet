#!/usr/bin/env python3
"""Repair one public Lighthouse metadata file locally; never transfer secrets.

For an existing sealed chain81411338 bundle whose deposit contract is already
preloaded at genesis. Genesis, JWT, validator keys and runtime/slashing state
are not changed. The local private archive is repacked on the same server.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import tarfile

ROOT = Path(__file__).resolve().parent
RELATIVE = "consensus/deposit_contract_block.txt"


def atomic_text(file, text):
    temporary = file.with_name(file.name + ".qsw-tmp")
    with temporary.open("w") as output:
        output.write(text)
    temporary.chmod(0o600)
    os.replace(temporary, file)


def repair(generated):
    bundle = generated / "bundle"
    metadata_file = bundle / "manifest.json"
    metadata = json.loads(metadata_file.read_text())
    genesis = json.loads((bundle / "genesis.json").read_text())
    if metadata.get("chainId") != 81411338 or int(genesis["config"]["chainId"]) != 81411338:
        raise ValueError("refusing a bundle for another chain")
    for relative, expected in metadata["files"].items():
        file = bundle / relative
        if file.is_symlink() or not file.is_file() or not file.resolve().is_relative_to(bundle.resolve()):
            raise ValueError("unsafe/missing existing bundle file")
        if hashlib.sha256(file.read_bytes()).hexdigest() != expected:
            raise ValueError(f"existing bundle checksum differs: {relative}")
    config = (bundle / "consensus/config.yaml").read_text()
    address = re.search(r"(?m)^DEPOSIT_CONTRACT_ADDRESS:\s*['\"]?(0x[0-9a-fA-F]{40})", config)
    if not address:
        raise ValueError("cannot identify the configured deposit contract")
    alloc = {key.lower().removeprefix("0x"): value for key, value in genesis["alloc"].items()}
    if not alloc.get(address.group(1).lower().removeprefix("0x"), {}).get("code"):
        raise ValueError("configured deposit contract is not preloaded at genesis")
    target = bundle / RELATIVE
    if target.is_symlink() or (target.exists() and target.read_text().strip() != "0"):
        raise ValueError("existing deposit start metadata is different; refusing to overwrite it")
    changed = not target.exists() or RELATIVE not in metadata["files"]
    if not target.exists():
        atomic_text(target, "0\n")
    metadata["files"][RELATIVE] = hashlib.sha256(target.read_bytes()).hexdigest()
    atomic_text(metadata_file, json.dumps(metadata, indent=2) + "\n")
    archive = generated / "devnet-bundle.private.tar.gz"
    temporary = generated / ".devnet-bundle.private.tar.gz.tmp"
    with tarfile.open(temporary, "w:gz") as output:
        output.add(bundle, arcname="bundle")
    temporary.chmod(0o600)
    os.replace(temporary, archive)
    return {"chainId": 81411338, "repairedFile": RELATIVE, "startBlock": 0,
            "changed": changed, "archiveRepackedOnSameHost": True,
            "genesisAndKeysUnchanged": True}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--generated-dir", type=Path, default=ROOT / ".generated")
    args = parser.parse_args()
    print(json.dumps(repair(args.generated_dir)))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError) as error:
        raise SystemExit(f"Metadata repair stopped: {error}") from None
