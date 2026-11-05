import {readFile} from 'node:fs/promises';

const expectedChain = 81411338;
const deadline = Date.now() + Number(process.env.QSW_READY_TIMEOUT_SECONDS || 900) * 1000;
const rpc = process.env.QSW_INTERNAL_RPC || 'http://ethrex:8545';
const beacon = process.env.QSW_INTERNAL_BEACON || 'http://beacon:5052';
const registry = '0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f';
async function json(url, options = {}) {
  const response = await fetch(url, {...options, signal: AbortSignal.timeout(10000)});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
async function request(method, params = []) {
  const result = await json(rpc, {method: 'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  if (result.error) throw new Error(result.error.message);
  return result.result;
}
let previous = null;
let lastLog = 0;
while (Date.now() < deadline) {
  try {
    if (Number(await request('eth_chainId')) !== expectedChain) throw new Error('Wrong chain ID');
    const version = await request('web3_clientVersion');
    if (!version.includes('9aa3645d')) throw new Error('Wrong execution profile');
    const [{data:spec},{data:genesis},{data:head},block] = await Promise.all([
      json(beacon + '/eth/v1/config/spec'), json(beacon + '/eth/v1/beacon/genesis'),
      json(beacon + '/eth/v1/beacon/headers/head'), request('eth_getBlockByNumber',['latest',false]),
    ]);
    const epoch = Number(spec.HEZE_FORK_EPOCH);
    const slots = Number(spec.SLOTS_PER_EPOCH);
    const seconds = Number(spec.SECONDS_PER_SLOT);
    if (epoch !== 2 || slots !== 32 || seconds !== 6) throw new Error('Unexpected staged fork configuration');
    const activated = Number(head.header.message.slot) >= epoch * slots &&
      Number(block.timestamp) >= Number(genesis.genesis_time) + epoch * slots * seconds;
    const number = Number(block.number);
    if (activated && previous !== null && number > previous) {
      const expectedCode = (await readFile('/opt/qsw/registry.runtime.hex','utf8')).trim().toLowerCase();
      if ((await request('eth_getCode',[registry,'latest'])).toLowerCase() !== expectedCode) throw new Error('Wrong registry runtime');
      console.log(JSON.stringify({ready:true,chainId:expectedChain,blockNumber:number,slot:Number(head.header.message.slot),executionProfile:version}));
      process.exit(0);
    }
    previous = number;
    if (Date.now() - lastLog > 30000) {
      console.log(`Waiting for epoch 2 and advancing blocks: slot ${head.header.message.slot}, EL ${number}`); lastLog = Date.now();
    }
  } catch (error) {
    if (Date.now() - lastLog > 30000) {console.log(`Waiting for private services: ${error.message}`);lastLog=Date.now();}
  }
  await new Promise(resolve => setTimeout(resolve, 6000));
}
console.error('Devnet did not become ready; inspect only this Compose project logs.');
process.exit(1);
