#!/usr/bin/env python3
"""Exercise QuantumAccount on native ethrex in a throwaway RPC simulation.

Never sends a transaction, funds an address, or calls a state-mutating debug API.
Requires a funded devnet payer key in QSW_SIMULATION_PAYER_KEY. Use only a
deliberately public test key: this script is restricted to chain 1337 and the
Mumbai ethrex 9aa3645d profile. No payer private key is written to the report.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import ssl
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
PROXY = bytes.fromhex("4e59b44847b379578588920ca78fbf26c0b4956c")
CONTEXT = "QuantumSmartWallet/SLH-DSA-SHA2-128s/v1"
PROFILE_COMMIT = "9aa3645d"
SIGNATURE_LENGTH = 7856
ALLOWED_METHODS = {
    "eth_chainId", "web3_clientVersion", "eth_blockNumber", "eth_getCode",
    "eth_getBalance", "ethrex_simulateFrameTransaction",
}


class SimulationError(Exception):
    pass


def command(arguments, *, sensitive=False):
    """Keep signer arguments and stderr out of exceptions and normal output."""
    try:
        process = subprocess.run(arguments, capture_output=True, text=True, timeout=90, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise SimulationError(f"{Path(arguments[0]).name} could not finish ({type(error).__name__})") from None
    if process.returncode:
        detail = "" if sensitive else ": " + process.stderr.strip()[:1000]
        raise SimulationError(f"{Path(arguments[0]).name} failed with exit {process.returncode}{detail}")
    return process.stdout.strip()


def hex_bytes(value):
    return bytes.fromhex(value.removeprefix("0x"))


def keccak(value):
    return hex_bytes(command(["cast", "keccak", "0x" + value.hex()]))


def rlp(value):
    """Canonical RLP of nested lists, byte strings and nonnegative integers."""
    if isinstance(value, int):
        if value < 0:
            raise SimulationError("negative integer in RLP")
        value = value.to_bytes((value.bit_length() + 7) // 8, "big")
    if isinstance(value, list):
        content = b"".join(rlp(item) for item in value)
        return length_prefix(len(content), 0xc0) + content
    if not isinstance(value, bytes):
        raise SimulationError("unsupported RLP value")
    if len(value) == 1 and value[0] < 0x80:
        return value
    return length_prefix(len(value), 0x80) + value


def length_prefix(length, offset):
    if length < 56:
        return bytes([offset + length])
    encoded = length.to_bytes((length.bit_length() + 7) // 8, "big")
    return bytes([offset + 55 + len(encoded)]) + encoded


def signature_hash(transaction):
    elided = copy.deepcopy(transaction)
    for signature in elided[5]:
        if not signature[2]:
            signature[3] = b""
    return keccak(b"\x06" + rlp(elided))


def sign_payer(transaction, payer_key):
    digest = signature_hash(transaction)
    signature = hex_bytes(command([
        "cast", "wallet", "sign", "--no-hash", "--private-key", payer_key, "0x" + digest.hex(),
    ], sensitive=True))
    if len(signature) != 65:
        raise SimulationError("cast returned a non-65-byte sponsor signature")
    parity = signature[64]
    if parity in (27, 28):
        parity -= 27
    if parity not in (0, 1):
        raise SimulationError("cast returned an unsupported sponsor signature parity")
    # Frame SECP256K1 uses parity || r || s, whereas cast returns r || s || v.
    transaction[5][1][3] = bytes([parity]) + signature[:64]
    return digest


class Rpc:
    def __init__(self, endpoint, directory):
        self.endpoint = endpoint
        self.directory = directory
        self.sequence = 0
        # On macOS Python's bundled CA path can differ from the system bundle.
        system_ca = Path("/etc/ssl/cert.pem")
        self.tls = ssl.create_default_context(cafile=str(system_ca) if system_ca.is_file() else None)

    def call(self, method, params, label=None):
        if method not in ALLOWED_METHODS:
            raise SimulationError(f"RPC method is not on the read-only whitelist: {method}")
        self.sequence += 1
        name = label or f"{self.sequence:02d}-{method}"
        request = {"jsonrpc": "2.0", "id": self.sequence, "method": method, "params": params}
        (self.directory / f"{name}-request.json").write_text(json.dumps(request, indent=2) + "\n")
        http_request = urllib.request.Request(
            self.endpoint,
            data=json.dumps(request).encode(),
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(http_request, timeout=45, context=self.tls) as response:
                result = json.load(response)
        except (OSError, ValueError, urllib.error.URLError) as error:
            raise SimulationError(f"RPC {method} failed ({type(error).__name__})") from None
        (self.directory / f"{name}-response.json").write_text(json.dumps(result, indent=2) + "\n")
        if "error" in result:
            raise SimulationError(f"RPC {method}: {json.dumps(result['error'])[:1200]}")
        if "result" not in result:
            raise SimulationError(f"RPC {method} returned no result")
        return result["result"]


def artifact(relative_path):
    path = ROOT / "out" / relative_path
    try:
        data = json.loads(path.read_text())
        code = hex_bytes(data["bytecode"]["object"])
    except (OSError, ValueError, KeyError):
        raise SimulationError(f"Missing or invalid build artifact {relative_path}; run forge build first") from None
    if not code:
        raise SimulationError(f"Empty creation code in {relative_path}")
    return data, code


def create2_address(salt, initcode):
    return keccak(b"\xff" + PROXY + salt + keccak(initcode))[-20:]


def frame(mode, flags, target, execution, state=0, data=b""):
    return [mode, flags, target, [execution, state], 0, data]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rpc", default="https://altmempool.forshtat.com")
    parser.add_argument("--rslh", type=Path, default=ROOT.parent / "rslh/target/release/rslh")
    args = parser.parse_args()
    if not args.rpc.startswith("https://") and not args.rpc.startswith("http://localhost"):
        raise SimulationError("Use HTTPS for public RPC connections")
    payer_key = os.environ.pop("QSW_SIMULATION_PAYER_KEY", "")
    if not re.fullmatch(r"(?:0x)?[0-9a-fA-F]{64}", payer_key):
        raise SimulationError("Set QSW_SIMULATION_PAYER_KEY to a funded devnet-only payer key")
    try:
        signer = args.rslh.resolve(strict=True)
    except OSError:
        raise SimulationError("Rust signer binary not found; pass --rslh /absolute/path/to/rslh") from None

    directory = ROOT / "cache/native-simulation"
    directory.mkdir(parents=True, exist_ok=True)
    rpc = Rpc(args.rpc, directory)
    if int(rpc.call("eth_chainId", []), 16) != 1337:
        raise SimulationError("Refusing to simulate on a chain other than devnet 1337")
    version = rpc.call("web3_clientVersion", [])
    if PROFILE_COMMIT not in version:
        raise SimulationError("RPC does not run the pinned Mumbai ethrex 9aa3645d profile")
    block = rpc.call("eth_blockNumber", [])
    if rpc.call("eth_getCode", ["0x" + PROXY.hex(), block]) in ("0x", "0x0"):
        raise SimulationError("CREATE2 proxy is not deployed at the pinned block")
    payer = hex_bytes(command(["cast", "wallet", "address", "--private-key", payer_key], sensitive=True))
    if len(payer) != 20:
        raise SimulationError("cast returned an invalid payer address")
    payer_balance = int(rpc.call("eth_getBalance", ["0x" + payer.hex(), block]), 16)
    if payer_balance == 0:
        raise SimulationError("Simulation payer has no devnet ETH at the pinned block")

    account_artifact, account_initcode = artifact("QuantumAccount.sol/QuantumAccount.json")
    _, verifier_initcode = artifact("SlhDsaSha2_128s.sol/SlhDsaVerifier.json")
    verifier_salt = keccak(b"QSW native simulation verifier v1" + block.encode())
    verifier_address = create2_address(verifier_salt, verifier_initcode)

    with tempfile.TemporaryDirectory(prefix="test-key-", dir=directory) as temporary:
        temp = Path(temporary)
        secret, public, message, witness = [temp / name for name in ("key", "pub", "digest", "signature")]
        command([str(signer), "keygen", "--seed", bytes(range(48)).hex(), "--sk", str(secret), "--pk", str(public)])
        public_key = bytes.fromhex(public.read_text().strip().split(":", 1)[1])
        if len(public_key) != 32:
            raise SimulationError("Rust signer returned a non-32-byte public key")
        # All constructor fields are static ABI words: pk, verifier, registry,
        # initialStake, unstakeDelaySec. No stake or spendable ETH is needed:
        # a pre-existing EOA sponsors this throwaway transaction.
        constructor = public_key + verifier_address.rjust(32, b"\x00") + b"\x00" * 96
        account_initcode += constructor
        account_salt = keccak(b"QSW native simulation account v1" + block.encode())
        account_address = create2_address(account_salt, account_initcode)
        for name, address in [("verifier", verifier_address), ("account", account_address)]:
            if rpc.call("eth_getCode", ["0x" + address.hex(), block]) not in ("0x", "0x0"):
                raise SimulationError(f"Predicted transient {name} address is occupied")

        selector = bytes.fromhex(account_artifact["methodIdentifiers"]["rotateKey(bytes32)"])
        validate_selector = bytes.fromhex(account_artifact["methodIdentifiers"]["validateFrame()"])
        new_public_key = hashlib.sha256(b"QSW simulation rotated test key v1").digest()
        transaction = [
            1337, [0], 0, account_address,
            [
                frame(0, 0, PROXY, 500_000, 4_000_000, verifier_salt + verifier_initcode),
                frame(0, 0, PROXY, 800_000, 6_000_000, account_salt + account_initcode),
                frame(1, 2, account_address, 3_000_000, data=validate_selector),
                frame(1, 1, payer, 30_000),
                frame(2, 0, account_address, 50_000, 200_000, selector + new_public_key),
            ],
            [[0, b"", b"", b"\x00" * SIGNATURE_LENGTH], [1, payer, b"", b"\x00" * 65]],
            [1_000_000_000, 2_000_000_000, 0], [], [],
        ]
        digest = signature_hash(transaction)
        message.write_bytes(digest)
        command([str(signer), "sign", "--sk", str(secret), "--in", str(message),
                 "--sig", str(witness), "--context", CONTEXT, "--deterministic"])
        command([str(signer), "verify", "--pk", str(public), "--in", str(message),
                 "--sig", str(witness), "--context", CONTEXT])
        signature = witness.read_bytes()
        if len(signature) != SIGNATURE_LENGTH:
            raise SimulationError("Rust signer returned an unexpected signature length")
        transaction[5][0][3] = signature
        if sign_payer(transaction, payer_key) != digest:
            raise SimulationError("Signing changed the canonical digest")

        happy_raw = "0x" + (b"\x06" + rlp(transaction)).hex()
        happy = rpc.call("ethrex_simulateFrameTransaction", [happy_raw, block, {"trace": True}], "happy")
        tampered = copy.deepcopy(transaction)
        # Preserve the PQ signature but alter only the requested key rotation.
        # Re-sign the sponsor so any failure is not its protocol ECDSA check.
        tampered[4][-1][5] = selector + bytes([new_public_key[0] ^ 1]) + new_public_key[1:]
        tampered_digest = sign_payer(tampered, payer_key)
        tampered_raw = "0x" + (b"\x06" + rlp(tampered)).hex()
        rejected = rpc.call("ethrex_simulateFrameTransaction", [tampered_raw, block, {"trace": True}], "tampered")

    happy_frames = happy.get("frames") or []
    happy_passed = (
        happy.get("executionStatus") == "success" and len(happy_frames) == 5
        and all(item.get("succeeded") is True for item in happy_frames)
    )
    # Reject only the expected PQ validation failure, not an unrelated failure
    # to deploy, fund the payer, authenticate its ECDSA signature or execute.
    tampered_error = rejected.get("executionError") or ""
    tampered_failed = (
        rejected.get("executionStatus") is None
        and "VERIFY frame 2" in tampered_error
        and "RevertOpcode" in tampered_error
    )
    # Confirm neither transient deployment was persisted at the current head.
    # The simulation itself used the same pinned block for both variants.
    transient_code_absent = all(
        rpc.call("eth_getCode", ["0x" + address.hex(), "latest"]) in ("0x", "0x0")
        for address in (verifier_address, account_address)
    )
    report = {
        "readOnly": True, "chainId": 1337, "clientVersion": version, "block": block,
        "account": "0x" + account_address.hex(), "verifier": "0x" + verifier_address.hex(),
        "payer": "0x" + payer.hex(), "digest": "0x" + digest.hex(),
        "tamperedDigest": "0x" + tampered_digest.hex(),
        "happyPassed": happy_passed, "tamperedRejected": tampered_failed,
        "transientCodeAbsent": transient_code_absent,
        "canonicalMempoolValid": happy.get("canonicalMempoolValid"),
        "canonicalMempoolViolation": happy.get("canonicalMempoolViolation"),
        "happy": happy, "tampered": rejected,
    }
    (directory / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key: value for key, value in report.items() if key not in ("happy", "tampered")}, indent=2))
    if not happy_passed:
        raise SimulationError("Native happy-path simulation failed; inspect cache/native-simulation/report.json")
    if not tampered_failed:
        raise SimulationError("Tampered-body simulation was not rejected; inspect the saved report")
    if not transient_code_absent:
        raise SimulationError("A transient deployment address has code at the current head")


if __name__ == "__main__":
    try:
        main()
    except SimulationError as error:
        print(f"Simulation failed: {error}", file=sys.stderr)
        sys.exit(1)
