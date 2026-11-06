import { readFileSync } from "node:fs";
import type { Address, PublicConfig } from "../shared/types.js";

/** JSON captured read-only from https://altmempool.bailo.london/{rpc,mempool} (demo account and demo swap). */
export const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/chain/${name}`, import.meta.url), "utf8")) as T;

export const DEMO: Address = "0x19b17f47284db0b254c62eb9ad6ce95538e3bc30";
export const SPONSOR: Address = "0xb7Ca4C821205f6721bacbd48052bEbF6A1f252c1";

/** The shared devnet's public config (deployment.json addresses). */
export const CONFIG: PublicConfig = {
  chainId: 81411338,
  genesisHash: "0xd3f5fc1f656bd0d05f18cca9cad3a2cc7ef373042c1890862c379a61e3e89f50",
  nativeProfile: "9aa3645d",
  rpcUrl: "https://altmempool.bailo.london/rpc",
  mempoolUrl: "https://altmempool.bailo.london/mempool",
  explorerUrl: "https://altmempool.bailo.london/explorer/",
  contracts: {
    accountFactory: "0x573b8fC3b0d72b3B859eACBA67fA3224Ecb55181",
    demoUSDC: "0x3636a1d9A30C46264822F1A47975707793770F42",
    weth9: "0xeDae4f23AdD2AabBFcAd8972801e6fa90aD4bBF2",
    permit2: "0x389e7536AB422DF13370e7D713Cabd22BDe9d6C9",
    universalRouter: "0xBf8badae6056b59beC3d993936Ab8627aA2A4D34",
    poolManager: "0x80E825e141C8f1d58C4d8DB19FB11f05D098a549",
    stateView: "0x25FC0eCfB3aA85bf1562c945B9d34235038d3cF7",
    quantumGuardHook: "0xc83EE6088f08ca9307c10a54A32F7CfB748F4080",
    verifier: "0xC5e49792793820a75e4979b442058c95456FdB01",
    stakingRegistry: "0xD51c04d7A0B01124E84DE152F4e56d9eeCB22D2F",
  },
  poolKey: {
    currency0: "0x3636a1d9A30C46264822F1A47975707793770F42",
    currency1: "0xeDae4f23AdD2AabBFcAd8972801e6fa90aD4bBF2",
    fee: 3000,
    tickSpacing: 60,
    hooks: "0xc83EE6088f08ca9307c10a54A32F7CfB748F4080",
  },
  poolId: "0x91ea57c02be0f80cc7409964629262064ba5258cd9db38dc1a7bb6ab7c292e8b",
  accountInitialStake: "12000000000000000",
  signature: { algorithm: "SLH-DSA-SHA2-128s", context: "QuantumSmartWallet/SLH-DSA-SHA2-128s/v1", bytes: 7856 },
  sponsor: SPONSOR,
  operatorReady: true,
  faucet: { enabled: true, amount: "1000000000", symbol: "dUSDC", decimals: 6 },
  limits: { maxAmountInUsdc: "1000000000", maxAmountInWeth: "500000000000000000", maxDeadlineSeconds: 3600 },
  fees: { maxPriorityFeePerGas: "1000000000", maxFeePerGas: "2000000000" },
  ens: null,
};
