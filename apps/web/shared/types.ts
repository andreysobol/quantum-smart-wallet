/**
 * Contracts shared by the browser app and the server API. Isomorphic: no DOM or
 * Node-only imports. Quantities that can exceed 2^53 travel as decimal strings.
 */
export type Hex = `0x${string}`;
export type Address = `0x${string}`;

export type SwapDirection = "USDC_TO_WETH" | "WETH_TO_USDC";

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/** Contract addresses from the published deployment manifest. */
export interface DeploymentContracts {
  accountFactory: Address;
  demoUSDC: Address;
  weth9: Address;
  permit2: Address;
  universalRouter: Address;
  poolManager: Address;
  stateView: Address;
  quantumGuardHook: Address;
  verifier: Address;
  stakingRegistry: Address;
}

/**
 * Devnet ENSv2 namespace (manifest `ens` section, verified on-chain by the server). Names are ERC-1155
 * tokens held by each account's ENSVault (the token owner); the QuantumAccount controls the vault.
 * Devnet only: these names do not reserve public .eth names.
 */
export interface EnsDeployment {
  /** Always shown with the feature: "Devnet ENSv2". */
  label: string;
  /** Parent name, e.g. "qsw.eth". */
  namespace: string;
  rootRegistry: Address;
  ethRegistry: Address;
  /** The namespace's PermissionedRegistry (subname tokens). */
  qswRegistry: Address;
  universalResolver: Address;
  registrar: Address;
  vaultFactory: Address;
  resolverImplementation: Address;
  verifiableFactory: Address;
  /** dUSDC. */
  paymentToken: Address;
  /** Raw payment-token units per 365 days, decimal string. */
  pricePerYear: string;
  minDuration: number;
  /** Longest registration the sponsor accepts, in whole years. */
  maxYears: number;
  /** First block of the namespace deployment (log queries start here). */
  deploymentBlock: number;
}

/** GET /api/config: everything the browser needs; no secrets. */
export interface PublicConfig {
  chainId: number;
  genesisHash: Hex;
  nativeProfile: string;
  rpcUrl: string;
  mempoolUrl: string;
  explorerUrl: string;
  contracts: DeploymentContracts;
  poolKey: PoolKey;
  poolId: Hex;
  /** Wei, decimal string; locked by the factory when an account is created. */
  accountInitialStake: string;
  signature: { algorithm: string; context: string; bytes: number };
  /** Null when the server has no operator credentials configured. */
  sponsor: Address | null;
  operatorReady: boolean;
  faucet: { enabled: boolean; amount: string; symbol: string; decimals: number };
  /** Inclusive maximum swap inputs accepted for sponsorship, raw units as decimal strings. */
  limits: { maxAmountInUsdc: string; maxAmountInWeth: string; maxDeadlineSeconds: number };
  /** Fee caps the sponsor signs, wei per gas as decimal strings. */
  fees: { maxPriorityFeePerGas: string; maxFeePerGas: string };
  /** Devnet ENSv2; null when the manifest has no ENS section or it did not verify on-chain. */
  ens: EnsDeployment | null;
}

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string };
}

export type ApiErrorCode =
  | "bad_request"
  | "not_configured"
  | "rate_limited"
  | "not_quantum_account"
  | "policy_rejected"
  | "invalid_signature"
  | "operator_unavailable"
  | "upstream_error"
  | "timeout"
  | "internal";

/** POST /api/account */
export interface CreateAccountRequest {
  publicKey: Hex;
}
export interface CreateAccountResponse {
  account: Address;
  salt: Hex;
  publicKey: Hex;
  /** False when the account already existed (idempotent repeat). */
  created: boolean;
  txHash: Hex | null;
  blockNumber: number | null;
  stakeWei: string;
}

/** POST /api/faucet */
export interface FaucetRequest {
  account: Address;
}
export interface FaucetResponse {
  account: Address;
  token: Address;
  amount: string;
  txHash: Hex;
  blockNumber: number;
}

/** JSON shape accepted by eth_sendFrameTransaction (see demo/evidence/shared-devnet/transaction.json). */
export interface WireFrame {
  mode: number | Hex;
  flags: number | Hex;
  target: Address;
  limits: { execution: Hex; state: Hex };
  value: Hex;
  data: Hex;
}
export interface WireSignature {
  scheme: number | Hex;
  signer: Hex;
  msg: Hex;
  signature: Hex;
}
export interface WireFrameTx {
  chainId: Hex;
  nonceKeys: Hex[];
  nonceSeq: Hex;
  sender: Address;
  frames: WireFrame[];
  signatures: WireSignature[];
  fees: { maxPriorityFeePerGas: Hex; maxFeePerGas: Hex; maxFeePerBlobGas: Hex };
  blobVersionedHashes: Hex[];
  recentRootReferences: Hex[];
}

/** Which sponsored template a transaction claims to be. */
export type SponsorKind = "swap" | "ens-register";

/** POST /api/sponsor: the PQ-signed transaction; the server validates and co-signs. */
export interface SponsorRequest {
  tx: WireFrameTx;
  /** Defaults to "swap". */
  kind?: SponsorKind;
}
export interface SponsorResponse {
  sponsor: Address;
  signingHash: Hex;
  txHash: Hex;
  /** Complete transaction including the sponsor signature, ready for eth_sendFrameTransaction. */
  tx: WireFrameTx;
}
