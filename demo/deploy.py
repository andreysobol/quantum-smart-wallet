#!/usr/bin/env python3
"""Plan with Forge, then deploy sequentially using live ethrex gas estimates.

Private keys are used only by local cast signing. The ignored public ledger
persists the exact signed transaction before any submission, enabling --resume
without changing its nonce, gas or transaction hash.
"""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time

import sponsored_swap as shared

REPO = Path(__file__).resolve().parent.parent
CHAIN_ID = 81411338
GAS_PRICE = 1_000_000_000
MAX_GAS = 16_700_000
REGISTRY = '0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f'
ADDRESS_KEYS = ('verifier', 'stakingRegistry', 'poolManager', 'permit2', 'weth9',
                'positionManager', 'universalRouter', 'quoter', 'stateView',
                'demoUSDC', 'accountFactory', 'hookDeployer', 'quantumGuardHook')


class DeploymentError(Exception):
    pass


def command(argv, *, private=False, cwd=None, env=None, timeout=240):
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, cwd=cwd, env=env)
    except subprocess.TimeoutExpired:
        raise DeploymentError(f'{Path(argv[0]).name} timed out; command details suppressed') from None
    except OSError:
        raise DeploymentError(f'{Path(argv[0]).name} could not start') from None
    if result.returncode:
        detail = '' if private else ': ' + result.stderr.strip()[:600]
        raise DeploymentError(f'{Path(argv[0]).name} failed{detail}')
    return result.stdout.strip()


def rpc(url, method, params):
    try:
        return shared.rpc(url, method, params)
    except RuntimeError as error:
        # The RPC payload contains only public transaction data, never a key.
        raise DeploymentError(str(error)) from None
    except Exception as error:
        raise DeploymentError(f'RPC {method} could not complete ({type(error).__name__})') from None


def number(value):
    return int(value, 16) if isinstance(value, str) and value.startswith('0x') else int(value)


def address(value):
    if not isinstance(value, str) or not re.fullmatch(r'0x[0-9a-fA-F]{40}', value):
        raise DeploymentError('invalid public address')
    return value.lower()


def save(path, value):
    temporary = path.with_suffix('.tmp')
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as out:
        json.dump(value, out, indent=2)
        out.write('\n')
        out.flush()
        os.fsync(out.fileno())
    os.replace(temporary, path)


@contextmanager
def locked(directory):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with os.fdopen(os.open(directory / 'operator.lock', os.O_CREAT | os.O_RDWR, 0o600), 'a+') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise DeploymentError('another deployment process holds this network/operator ledger') from None
        yield


def gas_limit(estimate):
    if estimate <= 0:
        raise DeploymentError('live gas estimate must be positive')
    limit = (estimate * 6 + 4) // 5 + 50_000
    if limit > MAX_GAS:
        raise DeploymentError('live estimate plus safety margin exceeds the 16.7m gas cap')
    return limit


def check_nonce(url, sender, expected):
    latest = number(rpc(url, 'eth_getTransactionCount', [sender, 'latest']))
    pending = number(rpc(url, 'eth_getTransactionCount', [sender, 'pending']))
    if latest != expected or pending != expected:
        raise DeploymentError(f'nonce mismatch: planned {expected}, latest {latest}, pending {pending}; no replacement sent')


def check_network(args):
    if number(rpc(args.rpc, 'eth_chainId', [])) != CHAIN_ID:
        raise DeploymentError('refusing a non-demo chain')
    actual = rpc(args.rpc, 'eth_getBlockByNumber', ['0x0', False])['hash']
    if actual.lower() != args.genesis_hash.lower():
        raise DeploymentError('network genesis mismatch')
    if '9aa3645d' not in rpc(args.rpc, 'web3_clientVersion', []):
        raise DeploymentError('unsupported native profile; expected ethrex 9aa3645d')


def create_address(sender, nonce):
    return '0x' + shared.codec.keccak(shared.codec.rlp([bytes.fromhex(sender[2:]), nonce]))[-20:].hex()


def normalize_plan(journal, sender):
    if not isinstance(journal, dict) or not isinstance(journal.get('transactions'), list):
        raise DeploymentError('invalid Forge transaction journal')
    if number(journal.get('chain', CHAIN_ID)) != CHAIN_ID:
        raise DeploymentError('Forge journal chain mismatch')
    planned = []
    for entry in journal.get('transactions', []):
        tx = entry['transaction']
        kind = entry['transactionType']
        if kind not in ('CREATE', 'CALL') or address(tx['from']) != sender:
            raise DeploymentError('unexpected Forge transaction type or sender')
        if number(tx.get('chainId', CHAIN_ID)) != CHAIN_ID:
            raise DeploymentError('planned transaction chain mismatch')
        nonce = number(tx['nonce'])
        if nonce < 0 or number(tx.get('value', 0)) < 0:
            raise DeploymentError('negative planned nonce or value')
        if planned and nonce != planned[-1]['nonce'] + 1:
            raise DeploymentError('Forge plan nonces are not consecutive')
        data = tx.get('input', tx.get('data', '0x'))
        if not isinstance(data, str) or not re.fullmatch(r'0x(?:[0-9a-fA-F]{2})*', data):
            raise DeploymentError('invalid planned transaction data')
        target = address(tx['to']) if tx.get('to') else None
        predicted = None
        if kind == 'CREATE':
            if target is not None:
                raise DeploymentError('CREATE plan unexpectedly has a destination')
            predicted = create_address(sender, nonce)
            if address(entry['contractAddress']) != predicted:
                raise DeploymentError('CREATE prediction does not match the exact planned nonce')
        elif target is None:
            raise DeploymentError('CALL plan has no destination')
        planned.append({'kind': kind, 'nonce': nonce, 'from': sender, 'to': target,
                        'data': data.lower(), 'value': number(tx.get('value', 0)),
                        'createdAddress': predicted})
    return planned


def check_manifest_input(manifest, args):
    def reject_secrets(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if key.lower().replace('_', '') in ('privatekey', 'secretkey', 'mnemonic', 'jwt', 'jwtsecret'):
                    raise DeploymentError('private fields are forbidden in a public deployment manifest')
                reject_secrets(item)
        elif isinstance(value, list):
            for item in value:
                reject_secrets(item)
    reject_secrets(manifest)
    required = (*ADDRESS_KEYS, 'chainId', 'genesisHash', 'hookSalt', 'positionTokenId')
    if not isinstance(manifest, dict) or any(key not in manifest for key in required):
        raise DeploymentError('existing file is not a complete public deployment manifest')
    if manifest['chainId'] != CHAIN_ID or manifest['genesisHash'].lower() != args.genesis_hash.lower():
        raise DeploymentError('existing manifest network mismatch')
    for key in ADDRESS_KEYS:
        address(manifest[key])


def forge_plan(args, sender, directory, candidate=None):
    # The real manifest is never a Forge output: a dry run writes only a copy.
    deployment_dir = REPO / 'slhsol/deployments'
    deployment_dir.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='local-deploy-plan-', dir=deployment_dir) as temporary:
        output = Path(temporary) / 'manifest.json'
        if candidate is not None:
            output.write_text(json.dumps(candidate))
        stage = directory / f'forge-{time.time_ns()}'
        stage.mkdir()
        env = {key: value for key, value in os.environ.items()
               if not key.startswith('DEMO_') and not any(token in key.upper()
               for token in ('PRIVATE_KEY', 'MNEMONIC', 'KEYSTORE', 'PASSWORD'))}
        env.update({'FOUNDRY_PROFILE': 'default', 'FOUNDRY_BROADCAST': str(stage / 'broadcast'),
                    'DEMO_DEPLOYER': sender, 'DEMO_STAKING_REGISTRY': args.staking_registry,
                    'DEMO_GENESIS_HASH': args.genesis_hash, 'DEMO_OUTPUT': str(output),
                    'DEMO_NATIVE_PROFILE': 'ethrex/eip8141-tracer@9aa3645d'})
        log = command(['forge', 'script', 'script/DeployDemo.s.sol:DeployDemo',
                       '--rpc-url', args.rpc, '--sender', sender, '--disable-labels'],
                      cwd=REPO / 'slhsol', env=env, timeout=600)
        (stage / 'dry-run.log').write_text(log + '\n')
        if not output.is_file():
            raise DeploymentError('Forge dry run did not produce a manifest')
        manifest = json.loads(output.read_text())
        journal = stage / f'broadcast/DeployDemo.s.sol/{CHAIN_ID}/dry-run/run-latest.json'
        transactions = normalize_plan(json.loads(journal.read_text()), sender) if journal.is_file() else []
        return manifest, transactions


def verify_manifest(args, manifest, sender):
    if manifest['chainId'] != CHAIN_ID or manifest['genesisHash'].lower() != args.genesis_hash.lower():
        raise DeploymentError('manifest network mismatch')
    for key in ADDRESS_KEYS:
        if rpc(args.rpc, 'eth_getCode', [address(manifest[key]), 'latest']) in ('0x', '0x0'):
            raise DeploymentError(f'manifest component has no code: {key}')
    if number(manifest['quantumGuardHook']) & 0x3fff != 0x80:
        raise DeploymentError('incorrect hook permission address')
    owner = shared.call(args.rpc, manifest['positionManager'], 'ownerOf(uint256)', manifest['positionTokenId'])
    if address('0x' + owner[-40:]) != sender:
        raise DeploymentError('LP position owner mismatch')
    liquidity = shared.call(args.rpc, manifest['stateView'], 'getLiquidity(bytes32)', manifest['poolId'])
    if number(liquidity) <= 0:
        raise DeploymentError('guarded pool has no active liquidity')


def sign_transaction(args, tx, key, limit):
    argv = ['cast', 'mktx', '--chain', str(CHAIN_ID),
            '--nonce', str(tx['nonce']), '--legacy', '--gas-price', str(GAS_PRICE),
            '--gas-limit', str(limit), '--value', str(tx['value']), '--private-key', key]
    argv.extend(['--create', tx['data']] if tx['to'] is None else [tx['to'], tx['data']])
    raw = command(argv, private=True)
    if not re.fullmatch(r'0x[0-9a-fA-F]+', raw):
        raise DeploymentError('local signer returned invalid raw transaction encoding')
    return raw


def confirm(args, tx, receipt):
    if receipt['transactionHash'].lower() != tx['hash'].lower():
        raise DeploymentError('receipt transaction hash mismatch')
    if number(receipt['status']) != 1:
        raise DeploymentError(f'transaction reverted at nonce {tx["nonce"]}: {tx["hash"]}; manual recovery required')
    block = rpc(args.rpc, 'eth_getBlockByNumber', [receipt['blockNumber'], False])
    if not block or block['hash'].lower() != receipt['blockHash'].lower():
        raise DeploymentError('receipt is no longer in the canonical chain; stopped')
    actual = rpc(args.rpc, 'eth_getTransactionByHash', [tx['hash']])
    if not actual or address(actual['from']) != tx['from'] or number(actual['nonce']) != tx['nonce']:
        raise DeploymentError('confirmed transaction sender/nonce mismatch')
    actual_to = address(actual['to']) if actual.get('to') else None
    if actual_to != tx['to'] or actual.get('input', actual.get('data', '')).lower() != tx['data']:
        raise DeploymentError('confirmed transaction does not match the saved deployment intent')
    if number(actual['value']) != tx['value']:
        raise DeploymentError('confirmed transaction value mismatch')
    if tx['kind'] == 'CREATE':
        if address(receipt['contractAddress']) != tx['createdAddress']:
            raise DeploymentError('confirmed CREATE address mismatch')
        if rpc(args.rpc, 'eth_getCode', [tx['createdAddress'], 'latest']) in ('0x', '0x0'):
            raise DeploymentError('confirmed creation has no runtime code')


def wait_receipt(args, tx_hash):
    deadline = time.monotonic() + 240
    while time.monotonic() < deadline:
        receipt = rpc(args.rpc, 'eth_getTransactionReceipt', [tx_hash])
        if receipt is not None:
            return receipt  # Persist failed receipts too, before rejecting them.
        time.sleep(2)
    raise DeploymentError(f'confirmation incomplete: {tx_hash}; use --resume')


def send_one(args, ledger, index, key, persist):
    tx = ledger['transactions'][index]
    if 'hash' in tx:
        receipt = rpc(args.rpc, 'eth_getTransactionReceipt', [tx['hash']])
        if receipt:
            tx['receipt'] = receipt
            persist()
            confirm(args, tx, receipt)
            tx['confirmed'] = True
            persist()
            return
    if 'rawTransaction' not in tx:
        check_nonce(args.rpc, tx['from'], tx['nonce'])
        request = {'from': tx['from'], 'data': tx['data'], 'value': hex(tx['value']),
                   'nonce': hex(tx['nonce']), 'gasPrice': hex(GAS_PRICE), 'gas': hex(MAX_GAS)}
        if tx['to'] is not None:
            request['to'] = tx['to']
        # Estimate only after every prior transaction has a successful receipt.
        estimate = number(rpc(args.rpc, 'eth_estimateGas', [request, 'latest']))
        limit = gas_limit(estimate)
        check_nonce(args.rpc, tx['from'], tx['nonce'])
        raw = sign_transaction(args, tx, key, limit)
        tx.update({'estimate': estimate, 'gasLimit': limit, 'rawTransaction': raw,
                   'hash': '0x' + shared.codec.keccak(bytes.fromhex(raw[2:])).hex()})
        persist()  # hash/raw bytes durable BEFORE the first submission
    pending = rpc(args.rpc, 'eth_getTransactionByHash', [tx['hash']])
    if pending is None:
        check_nonce(args.rpc, tx['from'], tx['nonce'])
        try:
            returned = rpc(args.rpc, 'eth_sendRawTransaction', [tx['rawTransaction']])
            if returned.lower() != tx['hash'].lower():
                raise DeploymentError('RPC returned an unexpected transaction hash')
        except DeploymentError:
            # A lost response is ambiguous. Keep exact signed bytes; --resume can
            # query/rebroadcast this hash, never create a replacement transaction.
            persist()
            raise
    try:
        receipt = wait_receipt(args, tx['hash'])
    except Exception:
        raise DeploymentError(f'confirmation incomplete at nonce {tx["nonce"]}: {tx["hash"]}; use --resume') from None
    tx['receipt'] = receipt
    persist()
    confirm(args, tx, receipt)
    tx['confirmed'] = True
    persist()
    print(json.dumps({'phase': 'confirmed', 'index': index, 'nonce': tx['nonce'], 'hash': tx['hash']}), flush=True)


def publish(path, manifest, original_hash):
    payload = (json.dumps(manifest, indent=2) + '\n').encode()
    if path.exists():
        current = path.read_bytes()
        if hashlib.sha256(current).hexdigest() != original_hash and json.loads(current) != manifest:
            raise DeploymentError('existing public manifest changed; refusing to overwrite it')
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    # A hard link publishes a complete file atomically and refuses overwrite.
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(prefix='local-verified-manifest-', dir=path.parent, delete=False) as out:
            temporary = Path(out.name)
            os.fchmod(out.fileno(), 0o644)
            out.write(payload)
            out.flush()
            os.fsync(out.fileno())
        try:
            os.link(temporary, path)
        except FileExistsError:
            raise DeploymentError('manifest appeared concurrently; refusing to overwrite it') from None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rpc', required=True)
    parser.add_argument('--key-file', type=Path, required=True)
    parser.add_argument('--genesis-hash', required=True)
    parser.add_argument('--staking-registry', default=REGISTRY)
    parser.add_argument('--manifest', type=Path, default=REPO / 'slhsol/deployments/shared-devnet.json')
    parser.add_argument('--resume', action='store_true', help='continue only the saved exact transaction plan')
    args = parser.parse_args()
    if not re.fullmatch(r'0x[0-9a-fA-F]{64}', args.genesis_hash):
        raise DeploymentError('invalid genesis hash')
    args.staking_registry = address(args.staking_registry)
    args.manifest = args.manifest.resolve()
    if args.manifest == args.key_file.resolve():
        raise DeploymentError('manifest and private key paths must differ')
    if args.key_file.stat().st_mode & 0o077:
        raise DeploymentError('key file must be private (0600)')
    credentials = json.loads(args.key_file.read_text())
    sender = address(credentials['address'])
    key = credentials['private_key']
    if not isinstance(key, str) or not re.fullmatch(r'0x[0-9a-fA-F]{64}', key):
        raise DeploymentError('invalid private key file')
    actual = command(['cast', 'wallet', 'address', '--private-key', key], private=True)
    if address(actual) != sender:
        raise DeploymentError('operator address/key mismatch')
    check_network(args)
    directory = REPO / 'demo/.state/deploy' / args.genesis_hash[2:].lower() / sender[2:]
    with locked(directory):
        ledger_path = directory / 'ledger.json'
        if ledger_path.exists():
            ledger = json.loads(ledger_path.read_text())
            if ledger['genesisHash'].lower() != args.genesis_hash.lower() or ledger['deployer'] != sender:
                raise DeploymentError('saved ledger network/operator mismatch')
            if ledger['manifestPath'] != str(args.manifest):
                raise DeploymentError('saved ledger uses a different manifest path')
            if ledger['status'] != 'complete' and not args.resume:
                raise DeploymentError('an unfinished deployment ledger exists; inspect it and use --resume')
        else:
            if args.resume:
                raise DeploymentError('no saved deployment ledger to resume')
            original = args.manifest.read_bytes() if args.manifest.exists() else None
            candidate = json.loads(original) if original is not None else None
            if candidate is not None:
                check_manifest_input(candidate, args)
            manifest, planned = forge_plan(args, sender, directory, candidate)
            ledger = {'version': 1, 'chainId': CHAIN_ID, 'genesisHash': args.genesis_hash,
                      'deployer': sender, 'manifestPath': str(args.manifest), 'status': 'planned',
                      'originalManifestHash': hashlib.sha256(original).hexdigest() if original else None,
                      'manifest': manifest, 'transactions': planned}
            save(ledger_path, ledger)
        persist = lambda: save(ledger_path, ledger)
        if ledger['status'] != 'complete':
            for index in range(len(ledger['transactions'])):
                send_one(args, ledger, index, key, persist)
        # Re-run the source checks against the mined addresses, using another copy.
        checked, additional = forge_plan(args, sender, directory, ledger['manifest'])
        if additional:
            raise DeploymentError('post-deployment check planned additional transactions; stopped without sending them')
        verify_manifest(args, checked, sender)
        check_network(args)
        publish(args.manifest, checked, ledger['originalManifestHash'])
        ledger['status'] = 'complete'
        persist()
        print(json.dumps({'phase': 'complete', 'manifest': str(args.manifest), 'ledger': str(ledger_path),
                          'transactions': len(ledger['transactions']), 'chainId': CHAIN_ID}))


if __name__ == '__main__':
    try:
        main()
    except DeploymentError as error:
        raise SystemExit(str(error)) from None
    except KeyboardInterrupt:
        raise SystemExit('interrupted; inspect the durable ledger and use --resume') from None
    except Exception:
        raise SystemExit('deployment could not complete; private command details suppressed') from None
