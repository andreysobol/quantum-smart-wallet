#!/usr/bin/env python3
"""Run an actual WASM-signed, sponsored Uniswap v4 swap through the public mempool.

Requires built slhts/slhsol artifacts, Foundry cast, and the dedicated devnet
manifest. The optional simulation endpoint is private (normally an SSH forward).
Private keys remain under demo/.state and are never written to public reports.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import secrets
import ssl
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
spec = importlib.util.spec_from_file_location('native_codec', REPO / 'slhsol/script/simulate_native.py')
codec = importlib.util.module_from_spec(spec)
spec.loader.exec_module(codec)
CHAIN_ID = 81411338
CONTEXT = codec.CONTEXT
TLS = ssl.create_default_context(cafile='/etc/ssl/cert.pem' if Path('/etc/ssl/cert.pem').exists() else None)


def command(args, sensitive=False):
    try:
        process = subprocess.run(args, capture_output=True, text=True, timeout=180)
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError(f'{Path(args[0]).name} could not finish') from None
    if process.returncode:
        detail = '' if sensitive else ': ' + process.stderr.strip()[:800]
        raise RuntimeError(f'{Path(args[0]).name} failed{detail}')
    return process.stdout.strip()


def rpc(url, method, params):
    request = urllib.request.Request(url, json.dumps({
        'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params,
    }).encode(), {'Content-Type': 'application/json'})
    response = json.load(urllib.request.urlopen(request, timeout=90, context=TLS))
    if 'error' in response:
        raise RuntimeError(f'{method}: {json.dumps(response["error"])[:1800]}')
    return response['result']


def abi(signature, *values):
    return command(['cast', 'abi-encode', signature, *map(str, values)])


def calldata(signature, *values):
    return command(['cast', 'calldata', signature, *map(str, values)])


def call(url, address, signature, *values, block='latest'):
    return rpc(url, 'eth_call', [{'to': address, 'data': calldata(signature, *values)}, block])


def wait_receipt(url, tx_hash):
    deadline = time.monotonic() + 240
    while time.monotonic() < deadline:
        receipt = rpc(url, 'eth_getTransactionReceipt', [tx_hash])
        if receipt:
            if receipt.get('status') != '0x1':
                raise RuntimeError(f'transaction reverted: {tx_hash}')
            return receipt
        time.sleep(2)
    raise RuntimeError(f'transaction not included before timeout: {tx_hash}')


def send(url, key, sender, target, data, value=0):
    request = {'from': sender, 'to': target, 'data': data, 'value': hex(value)}
    estimate = int(rpc(url, 'eth_estimateGas', [request]), 16)
    gas_limit = max(estimate * 12 // 10, estimate + 50_000)
    if gas_limit > 16_777_216:
        raise RuntimeError('setup transaction exceeds the pinned per-transaction gas limit')
    nonce = int(rpc(url, 'eth_getTransactionCount', [sender, 'pending']), 16)
    raw = command(['cast', 'mktx', '--chain', str(CHAIN_ID), '--private-key', key,
                   '--nonce', str(nonce), '--gas-limit', str(gas_limit),
                   '--gas-price', '1000000000', '--legacy', '--value', str(value),
                   target, data], sensitive=True)
    tx_hash = rpc(url, 'eth_sendRawTransaction', [raw])
    return wait_receipt(url, tx_hash)


def wire(tx):
    return {'chainId': hex(tx[0]), 'nonceKeys': [hex(k) for k in tx[1]], 'nonceSeq': hex(tx[2]),
            'sender': '0x' + tx[3].hex(),
            'frames': [{'mode': f[0], 'flags': f[1], 'target': '0x' + f[2].hex(),
                        'limits': {'execution': hex(f[3][0]), 'state': hex(f[3][1])},
                        'value': hex(f[4]), 'data': '0x' + f[5].hex()} for f in tx[4]],
            'signatures': [{'scheme': s[0], 'signer': '0x' + s[1].hex(), 'msg': '0x' + s[2].hex(),
                            'signature': '0x' + s[3].hex()} for s in tx[5]],
            'fees': {'maxPriorityFeePerGas': hex(tx[6][0]), 'maxFeePerGas': hex(tx[6][1]),
                     'maxFeePerBlobGas': hex(tx[6][2])},
            'blobVersionedHashes': [], 'recentRootReferences': []}


def swap_calldata(manifest, amount_in, min_out, deadline):
    pool = manifest['poolKey']
    usdc = manifest['demoUSDC']
    weth = manifest['weth9']
    zero_for_one = pool['currency0'].lower() == usdc.lower()
    pool_tuple = f"({pool['currency0']},{pool['currency1']},{pool['fee']},{pool['tickSpacing']},{pool['hooks']})"
    # This deployment's pinned v4-periphery includes minHopPriceX36.
    swap = abi('f(((address,address,uint24,int24,address),bool,uint128,uint128,uint256,bytes))',
               f"({pool_tuple},{str(zero_for_one).lower()},{amount_in},{min_out},0,0x)")
    settle = abi('f(address,uint256)', usdc, amount_in)
    take = abi('f(address,uint256)', weth, min_out)
    inputs = abi('f(bytes,bytes[])', '0x060c0f', f'[{swap},{settle},{take}]')
    return calldata('execute(bytes,bytes[],uint256)', '0x10', f'[{inputs}]', deadline)


def save(path, data):
    path.write_text(json.dumps(data, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--rpc', required=True)
    parser.add_argument('--mempool', required=True)
    parser.add_argument('--simulation-rpc')
    parser.add_argument('--deployer-key-file', type=Path, required=True)
    parser.add_argument('--amount-in', type=int, default=1_000_000, help='raw 6-decimal test USDC')
    parser.add_argument('--min-out', type=int, required=True, help='raw WETH; chosen by caller and signed')
    args = parser.parse_args()
    if args.amount_in <= 0 or args.min_out <= 0:
        raise RuntimeError('amount and minimum output must be positive')
    manifest = json.loads(args.manifest.read_text())
    if manifest['chainId'] != CHAIN_ID or int(rpc(args.rpc, 'eth_chainId', []), 16) != CHAIN_ID:
        raise RuntimeError('refusing non-demo chain')
    genesis = rpc(args.rpc, 'eth_getBlockByNumber', ['0x0', False])
    if genesis['hash'].lower() != manifest['genesisHash'].lower():
        raise RuntimeError('manifest genesis mismatch')
    version = rpc(args.rpc, 'web3_clientVersion', [])
    if '9aa3645d' not in version:
        raise RuntimeError('unsupported native frame codec profile')
    if int(rpc(args.mempool, 'eth_chainId', []), 16) != CHAIN_ID:
        raise RuntimeError('mempool chain mismatch')
    if args.simulation_rpc:
        if int(rpc(args.simulation_rpc, 'eth_chainId', []), 16) != CHAIN_ID:
            raise RuntimeError('simulation chain mismatch')
        if rpc(args.simulation_rpc, 'eth_getBlockByNumber', ['0x0', False])['hash'] != genesis['hash']:
            raise RuntimeError('simulation genesis mismatch')
    if args.deployer_key_file.stat().st_mode & 0o077:
        raise RuntimeError('deployer key file must be private (0600)')
    deployer = json.loads(args.deployer_key_file.read_text())
    private_key = deployer['private_key']
    sponsor = deployer['address']
    if command(['cast', 'wallet', 'address', '--private-key', private_key], sensitive=True).lower() != sponsor.lower():
        raise RuntimeError('deployer address/key mismatch')
    state_dir = ROOT / '.state' / str(time.time_ns())
    state_dir.mkdir(parents=True, mode=0o700)
    keyfile = state_dir / 'owner.private.json'
    command(['node', str(ROOT / 'wasm_signer.mjs'), 'keygen', str(keyfile)], sensitive=True)
    owner = json.loads(keyfile.read_text())
    salt = '0x' + secrets.token_hex(32)
    account = '0x' + call(args.rpc, manifest['accountFactory'], 'getAddress(bytes32,bytes32)',
                          owner['publicKey'], salt)[-40:]
    stake = int(call(args.rpc, manifest['accountFactory'], 'INITIAL_STAKE()'), 16)
    send(args.rpc, private_key, sponsor, manifest['accountFactory'],
         calldata('createAccount(bytes32,bytes32)', owner['publicKey'], salt), stake)
    if int(call(args.rpc, manifest['accountFactory'], 'isAccount(address)', account), 16) != 1:
        raise RuntimeError('account not registered by factory')
    send(args.rpc, private_key, sponsor, manifest['demoUSDC'], calldata('mint(address,uint256)', account, args.amount_in))
    if int(rpc(args.rpc, 'eth_getBalance', [account, 'latest']), 16) != 0:
        raise RuntimeError('demo requires a user wallet with zero ETH')
    deadline = int(rpc(args.rpc, 'eth_getBlockByNumber', ['latest', False])['timestamp'], 16) + 1800
    # The guard must reject an ordinary EOA even though its token balance is funded.
    negative_data = swap_calldata(manifest, args.amount_in, args.min_out, deadline)
    expected_error = command(['cast', 'sig', 'NotQuantumAccount(address)'])[2:].lower()
    try:
        rpc(args.rpc, 'eth_call', [{'from': sponsor, 'to': manifest['universalRouter'],
                                  'data': negative_data}, 'latest'])
    except RuntimeError as error:
        proof = 'public eth_call revert bytes'
        if expected_error not in str(error).lower():
            # This pinned ethrex eth_call tries decoding custom errors as Error(string)
            # and drops the original bytes. The operator's private callTracer retains them.
            if not args.simulation_rpc:
                raise RuntimeError('this client hides revert bytes; pass --simulation-rpc via SSH for the guard proof') from None
            trace = rpc(args.simulation_rpc, 'debug_traceCall', [
                {'from': sponsor, 'to': manifest['universalRouter'], 'data': negative_data, 'gas': '0x989680'},
                'latest', {'tracer': 'callTracer'},
            ])
            save(state_dir / 'guard-rejection-trace.json', trace)
            if expected_error not in json.dumps(trace).lower():
                raise RuntimeError('EOA swap failed for an unexpected reason; guard proof is inconclusive') from None
            proof = 'private callTracer revert bytes'
        save(state_dir / 'guard-rejection.json', {'initiator': sponsor, 'errorSelector': '0x' + expected_error,
                                                 'expectedGuardRejection': True, 'proof': proof})
    else:
        raise RuntimeError('guard accepted an EOA swap')
    nonce = int(rpc(args.rpc, 'eth_getTransactionCount', [account, 'latest']), 16)
    usdc = manifest['demoUSDC']
    weth = manifest['weth9']
    balances_before = {'usdc': int(call(args.rpc, usdc, 'balanceOf(address)', account), 16),
                       'weth': int(call(args.rpc, weth, 'balanceOf(address)', account), 16)}
    target_data = [
        (usdc, 4, 80_000, 100_000, calldata('approve(address,uint256)', manifest['permit2'], args.amount_in)),
        (manifest['permit2'], 4, 80_000, 100_000,
         calldata('approve(address,address,uint160,uint48)', usdc, manifest['universalRouter'], args.amount_in, deadline)),
        (manifest['universalRouter'], 0, 1_000_000, 200_000,
         swap_calldata(manifest, args.amount_in, args.min_out, deadline)),
    ]
    frames = [[1, 2, codec.hex_bytes(account), [2_400_000, 0], 0, codec.hex_bytes(calldata('validateFrame()'))],
              [1, 1, codec.hex_bytes(sponsor), [30_000, 0], 0, b'']]
    for target, flags, execution, state, data in target_data:
        frames.append([2, flags, codec.hex_bytes(target), [execution, state], 0, codec.hex_bytes(data)])
    tx = [CHAIN_ID, [0], nonce, codec.hex_bytes(account), frames,
          [[0, b'', b'', bytes(7856)], [1, codec.hex_bytes(sponsor), b'', bytes(65)]],
          [1_000_000_000, 2_000_000_000, 0], [], []]
    digest = codec.signature_hash(tx)
    signature_file = state_dir / 'wasm-signature.bin'
    command(['node', str(ROOT / 'wasm_signer.mjs'), 'sign', str(keyfile), '0x' + digest.hex(), str(signature_file)], sensitive=True)
    tx[5][0][3] = signature_file.read_bytes()
    assert codec.sign_payer(tx, private_key) == digest
    raw = b'\x06' + codec.rlp(tx)
    tx_hash = '0x' + codec.keccak(raw).hex()
    save(state_dir / 'transaction.json', wire(tx))
    (state_dir / 'raw-transaction.hex').write_text('0x' + raw.hex() + '\n')
    if args.simulation_rpc:
        if int(rpc(args.simulation_rpc, 'eth_chainId', []), 16) != CHAIN_ID:
            raise RuntimeError('simulation chain mismatch')
        sim_genesis = rpc(args.simulation_rpc, 'eth_getBlockByNumber', ['0x0', False])
        if sim_genesis['hash'] != genesis['hash']:
            raise RuntimeError('simulation genesis mismatch')
        simulation = rpc(args.simulation_rpc, 'ethrex_simulateFrameTransaction', ['0x' + raw.hex(), 'latest', {'trace': True}])
        save(state_dir / 'native-preflight.json', simulation)
        if simulation['executionStatus'] != 'success' or not all(f['succeeded'] for f in simulation['frames']):
            raise RuntimeError('signed native swap failed private preflight')
    print(json.dumps({'phase': 'submitting', 'hash': tx_hash, 'account': account,
                      'signature': 'actual slhts WASM', 'frames': len(frames)}), flush=True)
    submitted = rpc(args.mempool, 'eth_sendFrameTransaction', [wire(tx)])
    if submitted.lower() != tx_hash.lower():
        raise RuntimeError('mempool hash mismatch')
    receipt = wait_receipt(args.rpc, tx_hash)
    frame_receipt = rpc(args.mempool, 'eth_getFrameTransactionReceipt', [tx_hash])
    save(state_dir / 'receipt.json', receipt)
    save(state_dir / 'frame-receipt.json', frame_receipt)
    # EL inclusion can precede the sidecar reconciler's next pass.
    inclusion_deadline = time.monotonic() + 45
    while True:
        detail = rpc(args.mempool, 'skandha_explorer_getTransaction', [tx_hash])
        if (detail.get('admission') or {}).get('outcome') == 'included':
            break
        if time.monotonic() >= inclusion_deadline:
            raise RuntimeError('receipt exists but sidecar inclusion history is not ready')
        time.sleep(1)
    save(state_dir / 'admission-and-inclusion.json', detail)
    block = receipt['blockNumber']
    previous = hex(int(block, 16) - 1)
    before = int(rpc(args.rpc, 'eth_getBalance', [sponsor, previous]), 16)
    after = int(rpc(args.rpc, 'eth_getBalance', [sponsor, block]), 16)
    fee = int(receipt['gasUsed'], 16) * int(receipt['effectiveGasPrice'], 16)
    assert receipt['type'] == '0x6' and receipt['payer'].lower() == sponsor.lower()
    mined_block = rpc(args.rpc, 'eth_getBlockByNumber', [block, False])
    if mined_block['miner'].lower() == sponsor.lower():
        raise RuntimeError('use a separate validator fee recipient to measure sponsor gross gas debit')
    assert before - after == fee
    assert all(f['status'] == '0x1' for f in receipt['frameReceipts'])
    assert int(rpc(args.rpc, 'eth_getBalance', [account, block]), 16) == 0
    assert int(rpc(args.rpc, 'eth_getTransactionCount', [account, block]), 16) == nonce + 1
    usdc_after = int(call(args.rpc, usdc, 'balanceOf(address)', account, block=block), 16)
    weth_after = int(call(args.rpc, weth, 'balanceOf(address)', account, block=block), 16)
    assert balances_before['usdc'] - usdc_after == args.amount_in
    assert weth_after - balances_before['weth'] >= args.min_out
    assert detail['admission']['outcome'] == 'included'
    assert all(c['verdict'] == 'pass' for c in detail['admission']['checks'])
    report = {'chainId': CHAIN_ID, 'genesisHash': genesis['hash'], 'transactionHash': tx_hash,
              'blockNumber': int(block, 16), 'blockHash': receipt['blockHash'], 'status': 'success',
              'signingHash': '0x' + digest.hex(),
              'account': account, 'factory': manifest['accountFactory'], 'sponsor': sponsor,
              'publicKey': owner['publicKey'], 'signatureBackend': 'actual slhts WASM', 'signatureBytes': 7856,
              'accountEthBalanceWei': '0', 'gasUsed': int(receipt['gasUsed'], 16), 'sponsorFeeWei': str(fee),
              'inputUSDC': str(args.amount_in), 'outputWETH': str(weth_after - balances_before['weth']),
              'minimumOutputWETH': str(args.min_out), 'allFramesSucceeded': True,
              'passedAdmissionChecks': len(detail['admission']['checks']), 'ordinaryEoaRejectedByGuard': True,
              'mempool': args.mempool, 'stateDirectory': str(state_dir)}
    save(state_dir / 'report.json', report)
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Errors never include signer command arguments or private key file data.
        raise SystemExit(str(error)) from None
