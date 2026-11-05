#!/usr/bin/env python3
"""Focused regressions for sealed bundles, mutable validator state and source cache."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / (name + ".py"))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


configure = module("configure")
prepare = module("prepare_source")


class ValidatorStateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.generated = Path(self.temp.name)
        bundle = self.generated / "bundle"
        (bundle / "validator-keys/keys").mkdir(parents=True)
        (bundle / "validator-keys/secrets").mkdir()
        (bundle / "genesis.json").write_text('{"config":{"chainId":81411338}}')
        self.database = bundle / "validator-keys/keys/slashing_protection.sqlite"
        with sqlite3.connect(self.database) as connection:
            connection.execute("CREATE TABLE history(slot INTEGER)")

    def tearDown(self):
        self.temp.cleanup()

    def test_runtime_updates_do_not_modify_sealed_bundle_or_get_overwritten(self):
        sealed_hash = hashlib.sha256(self.database.read_bytes()).hexdigest()
        configure.initialize_validator_runtime(self.generated)
        runtime_db = self.generated / "runtime-validator/keys/slashing_protection.sqlite"
        with sqlite3.connect(runtime_db) as connection:
            connection.execute("INSERT INTO history VALUES (42)")
        configure.initialize_validator_runtime(self.generated)
        with sqlite3.connect(runtime_db) as connection:
            self.assertEqual(connection.execute("SELECT slot FROM history").fetchall(), [(42,)])
        self.assertEqual(hashlib.sha256(self.database.read_bytes()).hexdigest(), sealed_hash)

    def test_missing_runtime_slashing_database_is_not_recreated(self):
        configure.initialize_validator_runtime(self.generated)
        runtime = self.generated / "runtime-validator/keys/slashing_protection.sqlite"
        runtime.unlink()
        with self.assertRaisesRegex(ValueError, "slashing DB is missing"):
            configure.initialize_validator_runtime(self.generated)
        self.assertFalse(runtime.exists())

    def test_new_genesis_cannot_reuse_existing_validator_runtime(self):
        configure.initialize_validator_runtime(self.generated)
        (self.generated / "bundle/genesis.json").write_text('{"differentGenesis":true}')
        with self.assertRaisesRegex(ValueError, "another/unknown genesis"):
            configure.initialize_validator_runtime(self.generated)


class PublicAssetCacheTests(unittest.TestCase):
    def test_public_input_updates_refresh_without_touching_private_state(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "patches").mkdir()
            (root / "genesis").mkdir()
            source = root / ".generated/sidecar-source"
            (source / ".qsw").mkdir(parents=True)
            private = root / ".generated/runtime-validator"
            private.mkdir(); (private / "retain").write_text("private runtime sentinel")
            assets = {"Dockerfile.sidecar":"Dockerfile.qsw", "static-server.mjs":".qsw/static-server.mjs",
                      "health.mjs":".qsw/health.mjs", "readiness.mjs":".qsw/readiness.mjs",
                      "genesis/registry.runtime.hex":".qsw/registry.runtime.hex"}
            for name in assets:
                (root / name).write_text("initial " + name)
            metadata = {"repository":prepare.REPOSITORY,"revision":prepare.REVISION,"patches":{}}
            (source / ".qsw/source.json").write_text(json.dumps(metadata))
            with patch.object(prepare, "ROOT", root), patch.object(prepare, "run", return_value=prepare.REVISION):
                with patch.object(sys, "argv", ["prepare_source.py"]): prepare.main()
                with patch.object(sys, "argv", ["prepare_source.py", "--check"]): prepare.main()
                (root / "Dockerfile.sidecar").write_text("updated public Dockerfile")
                with patch.object(sys, "argv", ["prepare_source.py", "--check"]):
                    with self.assertRaises(SystemExit): prepare.main()
                with patch.object(sys, "argv", ["prepare_source.py"]): prepare.main()
                self.assertEqual((source / "Dockerfile.qsw").read_text(), "updated public Dockerfile")
                self.assertEqual((private / "retain").read_text(), "private runtime sentinel")


if __name__ == "__main__":
    unittest.main()
