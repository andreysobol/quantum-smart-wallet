/**
 * Protocol constants pinned to the shared devnet and the working demo
 * (demo/sponsored_swap.py, demo/evidence/shared-devnet/transaction.json).
 */
export const CHAIN_ID = 81411338;
export const NATIVE_PROFILE = "9aa3645d";
export const DEFAULT_DEPLOYMENT_URL = "https://altmempool.bailo.london/deployment.json";

export const SIGNATURE_ALGORITHM = "SLH-DSA-SHA2-128s";
export const SIGNATURE_CONTEXT = "QuantumSmartWallet/SLH-DSA-SHA2-128s/v1";
export const SIGNATURE_BYTES = 7856;
export const SECRET_KEY_BYTES = 64;
export const PUBLIC_KEY_BYTES = 32;
export const SPONSOR_SIGNATURE_BYTES = 65;

/** EIP-8141 frame modes and the scopes/flags used by the account and sponsor. */
export const FRAME_MODE = { DEFAULT: 0, VERIFY: 1, SENDER: 2 } as const;
export const FRAME_FLAGS = {
  /** Account VERIFY: execution approval; a later frame pays. */
  accountExecution: 2,
  /** Sponsor VERIFY: payment approval. */
  sponsorPayment: 1,
  /** SENDER frame that opens/continues an atomic batch. */
  atomicBatch: 4,
  /** SENDER frame that ends an atomic batch (or stands alone). */
  none: 0,
} as const;
/** Signature schemes in the envelope's signatures list. */
export const SIGNATURE_SCHEME = { ARBITRARY: 0, SECP256K1: 1 } as const;

/** QuantumAccount.validateFrame() */
export const VALIDATE_FRAME_SELECTOR = "0x634b01e8";

/** Per-frame gas limits, identical to the verified demo transaction. */
export const FRAME_LIMITS = {
  accountVerify: { execution: 2_400_000n, state: 0n },
  sponsorVerify: { execution: 30_000n, state: 0n },
  tokenApprove: { execution: 80_000n, state: 100_000n },
  permit2Approve: { execution: 80_000n, state: 100_000n },
  swap: { execution: 1_000_000n, state: 200_000n },
} as const;

/** Fee caps signed by both the account and the sponsor (wei per gas). */
export const FEES = {
  maxPriorityFeePerGas: 1_000_000_000n,
  maxFeePerGas: 2_000_000_000n,
  maxFeePerBlobGas: 0n,
} as const;

/** Universal Router / v4 periphery identifiers used by the guarded swap. */
export const UNIVERSAL_ROUTER_V4_SWAP = "0x10";
export const V4_ACTIONS_EXACT_IN_SINGLE = "0x060c0f"; // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL

/** Domain separator for the deterministic CREATE2 salt derived from a public key. */
export const ACCOUNT_SALT_DOMAIN = "QuantumSmartWallet/web/account-salt/v1";

export const USDC_DECIMALS = 6;
export const WETH_DECIMALS = 18;
