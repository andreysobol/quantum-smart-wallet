#!/usr/bin/env python3
"""Fetch the pinned public sidecar and apply only the tracked QSW patches."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent
REPOSITORY = "https://github.com/forshtat/mempool-workshop-sidecar.git"
REVISION = "2e22ff0a2898e69ea4bf5275bce1be8581a8582a"


def run(argv, cwd=None):
    result = subprocess.run(argv, cwd=cwd, text=True, capture_output=True, check=False)
    if result.returncode:
        raise SystemExit(f"Source preparation failed: {Path(argv[0]).name}: {result.stderr.strip()[:700]}")
    return result.stdout.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Verify an already prepared tree without modifying it")
    args = parser.parse_args()
    generated = ROOT / ".generated"
    generated.mkdir(mode=0o700, exist_ok=True)
    source = generated / "sidecar-source"
    patches = sorted((ROOT / "patches").glob("*.patch"))
    source_metadata = {"repository": REPOSITORY, "revision": REVISION,
                       "patches": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in patches}}
    assets = {"Dockerfile.sidecar": "Dockerfile.qsw", "static-server.mjs": ".qsw/static-server.mjs",
              "health.mjs": ".qsw/health.mjs", "readiness.mjs": ".qsw/readiness.mjs",
              "genesis/registry.runtime.hex": ".qsw/registry.runtime.hex"}
    metadata = {**source_metadata, "assets": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in assets}}
    marker = source / ".qsw/source.json"
    if source.exists():
        recorded = json.loads(marker.read_text()) if marker.is_file() else {}
        if any(recorded.get(key) != value for key, value in source_metadata.items()):
            raise SystemExit("Prepared source differs from the tracked inputs; preserve it and choose a fresh .generated directory")
        if run(["git", "rev-parse", "HEAD"], source) != REVISION:
            raise SystemExit("Prepared source revision changed")
        if args.check:
            if recorded != metadata or any(not (source / target).is_file() or hashlib.sha256((source / target).read_bytes()).hexdigest() != metadata["assets"][name] for name, target in assets.items()):
                raise SystemExit("Copied public build inputs changed; rerun prepare_source.py to refresh only those files")
            print("Pinned source, patches and all copied public inputs verified")
            return
    else:
        if args.check:
            raise SystemExit("Prepared source is missing")
        run(["git", "clone", "--no-checkout", REPOSITORY, str(source)])
        run(["git", "checkout", "--detach", REVISION], source)
        for patch in patches:
            run(["git", "apply", "--check", "--recount", str(patch)], source)
            run(["git", "apply", "--recount", str(patch)], source)
        (source / ".qsw").mkdir()
    # Refresh only these public inputs; never reset source, bundle or runtime.
    for name, target in assets.items():
        shutil.copyfile(ROOT / name, source / target)
    (source / ".dockerignore").write_text(".git\nnode_modules\n**/node_modules\n**/lib\n.env\n.env.*\nconfig.json\ncoverage\n**/coverage\n")
    marker.write_text(json.dumps(metadata, indent=2) + "\n")
    print(f"Prepared public sidecar {REVISION} with {len(patches)} tracked patches")


if __name__ == "__main__":
    main()
