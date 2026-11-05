"""Deployment boundary regressions; no RPC requests or transactions are sent."""
import copy
import hashlib
import json
import os
from pathlib import Path
from types import SimpleNamespace
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import deploy

SENDER = '0x' + '11' * 20
TARGET = '0x' + '22' * 20
TX_HASH = '0x' + '33' * 32
BLOCK_HASH = '0x' + '44' * 32


class DeployTests(unittest.TestCase):
    def transaction(self):
        return {'kind': 'CALL', 'nonce': 17, 'from': SENDER, 'to': TARGET,
                'data': '0x1234', 'value': 0, 'createdAddress': None}

    def test_live_approval_estimate_replaces_stale_forge_gas_and_hash_is_durable_before_send(self):
        args = SimpleNamespace(rpc='https://example.invalid')
        ledger = {'transactions': [self.transaction()]}
        snapshots = []
        calls = []
        sent = False
        receipt = {'status': '0x1', 'transactionHash': TX_HASH, 'blockNumber': '0x20',
                   'blockHash': BLOCK_HASH}

        def persist():
            snapshots.append(copy.deepcopy(ledger))

        def rpc(_url, method, params):
            nonlocal sent
            calls.append(method)
            if method == 'eth_getTransactionCount':
                return '0x11'
            if method == 'eth_estimateGas':
                self.assertNotIn('gas', ledger['transactions'][0])
                return '0x1ff78'  # Actual failing Permit2 approval needs 130,936.
            if method == 'eth_getTransactionByHash':
                return {**self.transaction(), 'input': '0x1234', 'nonce': '0x11', 'value': '0x0'} if sent else None
            if method == 'eth_sendRawTransaction':
                self.assertEqual(snapshots[-1]['transactions'][0]['hash'], TX_HASH)
                self.assertEqual(snapshots[-1]['transactions'][0]['rawTransaction'], '0xc0')
                sent = True
                return TX_HASH
            if method == 'eth_getBlockByNumber':
                return {'hash': BLOCK_HASH}
            self.fail(f'unexpected method: {method}')

        with patch.object(deploy, 'rpc', side_effect=rpc), \
             patch.object(deploy, 'sign_transaction', return_value='0xc0') as sign, \
             patch.object(deploy.shared.codec, 'keccak', return_value=bytes.fromhex('33' * 32)), \
             patch.object(deploy, 'wait_receipt', return_value=receipt):
            deploy.send_one(args, ledger, 0, 'PRIVATE', persist)
        self.assertEqual(sign.call_args.args[3], 207_124)
        self.assertTrue(ledger['transactions'][0]['confirmed'])
        self.assertLess(calls.index('eth_estimateGas'), calls.index('eth_sendRawTransaction'))

    def test_signing_is_offline_with_explicit_decimal_value_and_nonce(self):
        tx = self.transaction()
        tx['value'] = 0
        with patch.object(deploy, 'command', return_value='0xc0') as command:
            deploy.sign_transaction(SimpleNamespace(rpc='unused'), tx, 'PRIVATE', 207_124)
        argv = command.call_args.args[0]
        self.assertNotIn('--rpc-url', argv)
        self.assertEqual(argv[argv.index('--value') + 1], '0')
        self.assertEqual(argv[argv.index('--nonce') + 1], '17')
        self.assertEqual(argv[argv.index('--chain') + 1], str(deploy.CHAIN_ID))
        self.assertTrue(command.call_args.kwargs['private'])

    def test_nonce_collision_stops_before_estimation_or_signing(self):
        args = SimpleNamespace(rpc='https://example.invalid')
        with patch.object(deploy, 'rpc', return_value='0x12') as rpc, \
             patch.object(deploy, 'sign_transaction') as sign:
            with self.assertRaisesRegex(deploy.DeploymentError, 'nonce mismatch'):
                deploy.send_one(args, {'transactions': [self.transaction()]}, 0, 'PRIVATE', lambda: None)
        sign.assert_not_called()
        self.assertTrue(all(call.args[1] == 'eth_getTransactionCount' for call in rpc.call_args_list))

    def test_failed_create_receipt_is_saved_and_never_recreated(self):
        tx = {**self.transaction(), 'kind': 'CREATE', 'to': None, 'createdAddress': TARGET,
              'hash': TX_HASH, 'rawTransaction': '0xc0'}
        ledger = {'transactions': [tx]}
        receipt = {'status': '0x0', 'transactionHash': TX_HASH}
        saved = []
        with patch.object(deploy, 'rpc', return_value=receipt) as rpc, \
             patch.object(deploy, 'sign_transaction') as sign:
            with self.assertRaisesRegex(deploy.DeploymentError, 'reverted'):
                deploy.send_one(SimpleNamespace(rpc='unused'), ledger, 0, 'PRIVATE',
                                lambda: saved.append(copy.deepcopy(ledger)))
        self.assertEqual(saved[-1]['transactions'][0]['receipt'], receipt)
        sign.assert_not_called()
        self.assertEqual(rpc.call_count, 1)

    def test_safety_margin_never_silently_clamps_at_cap(self):
        with self.assertRaisesRegex(deploy.DeploymentError, 'cap'):
            deploy.gas_limit(16_000_000)
        with self.assertRaises(deploy.DeploymentError):
            deploy.gas_limit(0)

    def test_private_command_timeout_and_stderr_do_not_reveal_key(self):
        secret = 'DO_NOT_PRINT_THIS_KEY'
        timeout = subprocess.TimeoutExpired(['cast', '--private-key', secret], 1, stderr=secret)
        with patch.object(deploy.subprocess, 'run', side_effect=timeout):
            with self.assertRaises(deploy.DeploymentError) as caught:
                deploy.command(['cast', '--private-key', secret], private=True)
        self.assertNotIn(secret, str(caught.exception))
        with patch.object(deploy.subprocess, 'run', return_value=SimpleNamespace(returncode=1, stderr=secret)):
            with self.assertRaises(deploy.DeploymentError) as caught:
                deploy.command(['cast', '--private-key', secret], private=True)
        self.assertNotIn(secret, str(caught.exception))

    def test_manifest_is_not_overwritten_if_someone_changes_it(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'manifest.json'
            original = b'{"preserve":true}\n'
            path.write_bytes(original)
            with self.assertRaisesRegex(deploy.DeploymentError, 'refusing to overwrite'):
                deploy.publish(path, {'replace': True}, 'different-original-hash')
            self.assertEqual(path.read_bytes(), original)
            deploy.publish(path, {'replace': True}, hashlib.sha256(original).hexdigest())
            self.assertEqual(path.read_bytes(), original)

    def test_operator_secret_json_is_rejected_before_it_can_be_a_forge_manifest(self):
        with self.assertRaisesRegex(deploy.DeploymentError, 'private fields'):
            deploy.check_manifest_input({'address': SENDER, 'private_key': 'PRIVATE'},
                                        SimpleNamespace(genesis_hash='unused'))

    def test_forge_uses_manifest_copy_and_never_receives_a_signer_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory) / 'repo'
            (repo / 'slhsol/deployments').mkdir(parents=True)
            state = Path(directory) / 'state'
            state.mkdir()
            candidate = {'chainId': deploy.CHAIN_ID, 'preserve': True}
            args = SimpleNamespace(rpc='https://example.invalid', staking_registry=TARGET,
                                   genesis_hash='0x' + 'aa' * 32)
            def command(argv, **kwargs):
                self.assertNotIn('--private-key', argv)
                self.assertNotIn('--broadcast', argv)
                self.assertNotIn('--account', argv)
                self.assertNotIn('ETH_PRIVATE_KEY', kwargs['env'])
                output = Path(kwargs['env']['DEMO_OUTPUT'])
                self.assertEqual(json.loads(output.read_text()), candidate)
                output.write_text(json.dumps(candidate))
                return 'Script ran successfully.'
            with patch.object(deploy, 'REPO', repo), \
                 patch.dict(os.environ, {'ETH_PRIVATE_KEY': 'PRIVATE'}), \
                 patch.object(deploy, 'command', side_effect=command):
                manifest, transactions = deploy.forge_plan(args, SENDER, state, candidate)
            self.assertEqual(manifest, candidate)
            self.assertEqual(transactions, [])
            self.assertEqual(candidate['preserve'], True)

    def test_planned_create_address_and_nonce_are_checked_before_any_send(self):
        journal = {'chain': deploy.CHAIN_ID, 'transactions': [{
            'transactionType': 'CREATE', 'contractAddress': TARGET,
            'transaction': {'from': SENDER, 'nonce': '0x0', 'chainId': hex(deploy.CHAIN_ID),
                            'input': '0x6000', 'value': '0x0', 'gas': '0x13b34'}}]}
        with patch.object(deploy, 'create_address', return_value='0x' + '55' * 20):
            with self.assertRaisesRegex(deploy.DeploymentError, 'CREATE prediction'):
                deploy.normalize_plan(journal, SENDER)
        with patch.object(deploy, 'create_address', return_value=TARGET):
            tx = deploy.normalize_plan(journal, SENDER)[0]
        self.assertNotIn('gas', tx)
        self.assertEqual(tx['nonce'], 0)


if __name__ == '__main__':
    unittest.main()
