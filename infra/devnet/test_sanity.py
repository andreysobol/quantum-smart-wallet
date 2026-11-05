#!/usr/bin/env python3
"""Focused regressions for sealed bundles, mutable validator state and source cache."""
import hashlib
import contextlib
import io
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
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
bootstrap = module("bootstrap")
repair_metadata = module("repair_public_metadata")


class DepositMetadataTests(unittest.TestCase):
    def test_missing_or_wrong_deposit_start_metadata_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            bundle = Path(temporary)
            (bundle / "consensus").mkdir()
            with self.assertRaisesRegex(ValueError, "deposit_contract_block"):
                configure.validate_deposit_start(bundle)
            file = bundle / "consensus/deposit_contract_block.txt"
            file.write_text("1\n")
            with self.assertRaisesRegex(ValueError, "start block 0"):
                configure.validate_deposit_start(bundle)
            file.write_text("0\n")
            configure.validate_deposit_start(bundle)

    def test_repair_changes_only_public_metadata_and_preserves_runtime_and_keys(self):
        with tempfile.TemporaryDirectory() as temporary:
            generated = Path(temporary)
            bundle = generated / "bundle"
            (bundle / "consensus").mkdir(parents=True)
            address = "0x" + "42" * 20
            (bundle / "consensus/config.yaml").write_text('DEPOSIT_CONTRACT_ADDRESS: "' + address + '"\n')
            (bundle / "genesis.json").write_text(json.dumps({"config":{"chainId":81411338},"alloc":{address:{"code":"0x00"}}}))
            (bundle / "validator-keystore.fixture").write_bytes(b"public test fixture only")
            runtime = generated / "runtime-validator"
            runtime.mkdir(); (runtime / "keep").write_bytes(b"retain slashing state")
            before = {str(p.relative_to(bundle)):p.read_bytes() for p in bundle.rglob("*") if p.is_file()}
            metadata = {"chainId":81411338,"files":{name:hashlib.sha256(data).hexdigest() for name,data in before.items()}}
            (bundle / "manifest.json").write_text(json.dumps(metadata))
            self.assertTrue(repair_metadata.repair(generated)["changed"])
            configure.validate_deposit_start(bundle)
            for name, data in before.items(): self.assertEqual((bundle / name).read_bytes(), data)
            self.assertEqual((runtime / "keep").read_bytes(), b"retain slashing state")
            updated = json.loads((bundle / "manifest.json").read_text())
            self.assertEqual(updated["files"][repair_metadata.RELATIVE], hashlib.sha256(b"0\n").hexdigest())
            self.assertFalse(repair_metadata.repair(generated)["changed"])


class MiningSnapshotTests(unittest.TestCase):
    checkpoint = {"executionBlockNumber": 65, "executionBlockHash": "0x" + "ab" * 32,
                  "consensusSlot": 65, "consensusRoot": "0x" + "cd" * 32,
                  "hezeActive": True, "hezeForkEpoch": 2, "observedPostHezeAdvances": 2}

    def test_export_wait_requires_two_observed_advances_after_heze(self):
        reads = [dict(self.checkpoint, hezeActive=False, executionBlockNumber=0),
                 dict(self.checkpoint, executionBlockNumber=65),
                 dict(self.checkpoint, executionBlockNumber=65),
                 dict(self.checkpoint, executionBlockNumber=66),
                 dict(self.checkpoint, executionBlockNumber=67)]
        found = {role:{"Id":role} for role in ("execution", "consensus", "validator")}
        with patch.object(bootstrap, "http_endpoint", return_value="http://127.0.0.1:1"), \
             patch.object(bootstrap, "read_checkpoint", side_effect=reads) as read, \
             patch.object(bootstrap.time, "sleep"), contextlib.redirect_stdout(io.StringIO()):
            result = bootstrap.wait_for_mining(found, 600)
        self.assertEqual(read.call_count, 5)
        self.assertEqual(result["executionBlockNumber"], 67)
        self.assertEqual(result["observedPostHezeAdvances"], 2)

    def test_snapshot_writer_stop_order_is_validator_consensus_execution(self):
        found = {role:{"Id":role} for role in ("execution", "consensus", "validator")}
        with patch.object(bootstrap, "stop_for_snapshot") as stop:
            bootstrap.freeze_services(found)
        self.assertEqual([call.args[0]["Id"] for call in stop.call_args_list], ["validator", "consensus", "execution"])

    def fixture(self, root):
        bundle = root / "bundle"
        (bundle / "snapshot/execution/chain-81411338").mkdir(parents=True)
        (bundle / "snapshot/consensus/beacon/chain_db").mkdir(parents=True)
        (bundle / "genesis.json").write_text('{"config":{"chainId":81411338}}')
        (bundle / "snapshot/execution/chain-81411338/CURRENT").write_bytes(b"execution database fixture")
        (bundle / "snapshot/consensus/beacon/chain_db/CURRENT").write_bytes(b"consensus database fixture")
        files = {str(p.relative_to(bundle)):hashlib.sha256(p.read_bytes()).hexdigest() for p in bundle.rglob("*") if p.is_file()}
        metadata = {"chainId":81411338,"formatVersion":2,"snapshot":self.checkpoint.copy(),"files":files}
        (bundle / "manifest.json").write_text(json.dumps(metadata))
        return bundle, metadata

    def initialize(self, bundle, target, role="execution"):
        return subprocess.run(["node", str(ROOT / "init-state.mjs"), str(bundle), str(target), role], capture_output=True, text=True)

    def test_snapshot_validation_rejects_unmined_and_missing_database(self):
        with tempfile.TemporaryDirectory() as temporary:
            bundle, metadata = self.fixture(Path(temporary))
            configure.validate_snapshot(bundle, metadata)
            metadata["snapshot"]["observedPostHezeAdvances"] = 1
            with self.assertRaisesRegex(ValueError, "mined post-Heze"):
                configure.validate_snapshot(bundle, metadata)
            metadata["snapshot"]["observedPostHezeAdvances"] = 2
            (bundle / "snapshot/consensus/beacon/chain_db/CURRENT").unlink()
            with self.assertRaisesRegex(ValueError, "consensus database"):
                configure.validate_snapshot(bundle, metadata)

    def test_offline_volume_initializer_preserves_live_state_on_same_genesis_rerun(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bundle, metadata = self.fixture(root)
            target = root / "volume"
            first = self.initialize(bundle, target)
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertTrue(json.loads(first.stdout)["initialized"])
            database = target / "runtime/chain-81411338/CURRENT"
            database.write_bytes(b"new live chain state")
            second = self.initialize(bundle, target)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertFalse(json.loads(second.stdout)["initialized"])
            self.assertEqual(database.read_bytes(), b"new live chain state")
            consensus = self.initialize(bundle, root / "consensus-volume", "consensus")
            self.assertEqual(consensus.returncode, 0, consensus.stderr)
            metadata["snapshot"]["executionBlockHash"] = "0x" + "ff" * 32
            (bundle / "manifest.json").write_text(json.dumps(metadata))
            mismatch = self.initialize(bundle, target)
            self.assertNotEqual(mismatch.returncode, 0)
            self.assertIn("another snapshot", mismatch.stderr)
            self.assertEqual(database.read_bytes(), b"new live chain state")
            metadata["snapshot"]["executionBlockHash"] = self.checkpoint["executionBlockHash"]
            (bundle / "manifest.json").write_text(json.dumps(metadata))
            database.unlink()
            missing = self.initialize(bundle, target)
            self.assertNotEqual(missing.returncode, 0)
            self.assertFalse(database.exists())

    def test_initializer_rejects_unmarked_nonempty_volume_and_tampered_snapshot(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bundle, _ = self.fixture(root)
            target = root / "old-volume"; target.mkdir()
            (target / "retain").write_bytes(b"old database")
            result = self.initialize(bundle, target)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Unmarked/nonempty", result.stderr)
            self.assertEqual((target / "retain").read_bytes(), b"old database")
            (bundle / "snapshot/execution/chain-81411338/CURRENT").write_bytes(b"tampered")
            fresh = root / "fresh-volume"
            result = self.initialize(bundle, fresh)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("checksum differs", result.stderr)
            self.assertEqual(list(fresh.iterdir()), [])


class MnemonicGeneratorTests(unittest.TestCase):
    # Public BIP39 zero-entropy fixture, never used to initialize a devnet.
    fixture = " ".join(["abandon"] * 23 + ["art"])

    def test_image_generation_is_isolated_captured_and_does_not_require_cast(self):
        output = io.StringIO()
        image = "qsw-sidecar:2e22ff0a-pq-v1"
        response = SimpleNamespace(stdout=json.dumps({"mnemonic": self.fixture}))
        with patch.object(bootstrap, "run", return_value=response) as run, contextlib.redirect_stdout(output):
            mnemonic = bootstrap.generate_mnemonic(image)
        self.assertEqual(len(mnemonic.split()), 24)
        self.assertEqual(output.getvalue(), "")
        command = run.call_args.args[0]
        self.assertEqual(command[:7], ["docker", "run", "--rm", "--network", "none", "--entrypoint", "node"])
        self.assertEqual(command[7], image)
        self.assertNotIn("cast", bootstrap.required_tools("kurtosis", image))

    def test_workstation_default_retains_cast(self):
        response = SimpleNamespace(stdout=json.dumps({"mnemonic": self.fixture}))
        with patch.object(bootstrap, "run", return_value=response) as run:
            self.assertEqual(len(bootstrap.generate_mnemonic().split()), 24)
        self.assertEqual(run.call_args.args[0], ["cast", "wallet", "new-mnemonic", "--words", "24", "--json"])
        self.assertIn("cast", bootstrap.required_tools("kurtosis", None))

    def test_invalid_response_or_image_fails_without_echoing_sensitive_output(self):
        for body in ["invalid JSON", json.dumps({"mnemonic": "too few words"}), json.dumps({"mnemonic": None})]:
            with patch.object(bootstrap, "run", return_value=SimpleNamespace(stdout=body)):
                with self.assertRaises(bootstrap.BootstrapError):
                    bootstrap.generate_mnemonic("qsw-sidecar:test")
        with patch.object(bootstrap, "run") as run:
            with self.assertRaises(bootstrap.BootstrapError):
                bootstrap.generate_mnemonic("--privileged")
            run.assert_not_called()


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
