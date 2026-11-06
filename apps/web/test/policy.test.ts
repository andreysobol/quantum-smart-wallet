/**
 * Sponsor policy: one acceptance and a rejection per rule, against a fake chain
 * (no network) and a random sponsor key.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionResult, getAddress, hexToString, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { accountAbi, factoryAbi, verifierAbi } from "../shared/abis.js";
import { SIGNATURE_CONTEXT } from "../shared/constants.js";
import { signingHash, type FrameTx } from "../shared/frameTx.js";
import { buildSwapTx } from "../shared/swap.js";
import type { DeploymentContracts, PoolKey } from "../shared/types.js";
import type { Rpc } from "../server/manifest.js";
import { checkSponsorPolicy, type PolicyContext } from "../server/policy.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const manifest: any = JSON.parse(readFileSync(new URL("../../../slhsol/deployments/shared-devnet.json", import.meta.url), "utf8"));
const contracts: DeploymentContracts = {
  accountFactory: manifest.accountFactory,
  demoUSDC: manifest.demoUSDC,
  weth9: manifest.weth9,
  permit2: manifest.permit2,
  universalRouter: manifest.universalRouter,
  poolManager: manifest.poolManager,
  stateView: manifest.stateView,
  quantumGuardHook: manifest.quantumGuardHook,
  verifier: manifest.verifier,
  stakingRegistry: manifest.stakingRegistry,
};
const deployment = { chainId: 81411338, contracts, poolKey: manifest.poolKey as PoolKey };
const sponsor = privateKeyToAccount(generatePrivateKey());
const ACCOUNT = getAddress("0x19b17f47284db0b254c62eb9ad6ce95538e3bc30");
const PUBLIC_KEY = `0x${"ab".repeat(32)}` as Hex;
const PQ_SIGNATURE = `0x${"5a".repeat(7856)}` as Hex;
const NOW = 1_800_000_000n;

interface FakeChain {
  nonce: bigint;
  timestamp: bigint;
  registered: boolean;
  sponsorBalance: bigint;
  verified: { publicKey: Hex; message: Hex; context: string; signature: Hex }[];
}

function fakeRpc(chain: FakeChain): Rpc {
  const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
  const call = async (method: string, params: unknown[] = []): Promise<unknown> => {
    switch (method) {
      case "eth_getTransactionCount":
        return `0x${chain.nonce.toString(16)}`;
      case "eth_getBlockByNumber":
        return { number: "0x10", timestamp: `0x${chain.timestamp.toString(16)}` };
      case "eth_getBalance":
        return `0x${chain.sponsorBalance.toString(16)}`;
      case "eth_call": {
        const { to, data } = params[0] as { to: string; data: Hex };
        if (same(to, contracts.accountFactory)) {
          decodeFunctionData({ abi: factoryAbi, data });
          return encodeFunctionResult({ abi: factoryAbi, functionName: "isAccount", result: chain.registered });
        }
        if (same(to, ACCOUNT)) return encodeFunctionResult({ abi: accountAbi, functionName: "publicKey", result: PUBLIC_KEY });
        if (same(to, contracts.verifier)) {
          const { args } = decodeFunctionData({ abi: verifierAbi, data });
          const [publicKey, message, context, signature] = args;
          chain.verified.push({ publicKey, message, context: hexToString(context), signature });
          const ok = publicKey === PUBLIC_KEY && signature === PQ_SIGNATURE && hexToString(context) === SIGNATURE_CONTEXT;
          return encodeFunctionResult({ abi: verifierAbi, functionName: "verify", result: ok });
        }
        throw new Error(`unexpected eth_call to ${to}`);
      }
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
  return {
    call: call as Rpc["call"],
    batch: async (calls) => Promise.all(calls.map(async (c) => ({ ok: true as const, result: await call(c.method, c.params) }))),
  };
}

const freshChain = (): FakeChain => ({ nonce: 7n, timestamp: NOW, registered: true, sponsorBalance: 10n ** 18n, verified: [] });

function validTx(overrides: Partial<Parameters<typeof buildSwapTx>[0]> = {}): FrameTx {
  const tx = buildSwapTx({
    config: { ...deployment, sponsor: sponsor.address },
    account: ACCOUNT,
    nonce: 7n,
    direction: "USDC_TO_WETH",
    amountIn: 1_000_000n,
    minOut: 1n,
    deadline: NOW + 1800n,
    ...overrides,
  });
  return { ...tx, signatures: [{ ...tx.signatures[0]!, signature: PQ_SIGNATURE }, tx.signatures[1]!] };
}

function context(chain: FakeChain): PolicyContext {
  return { deployment, sponsor: sponsor.address, maxSwapUsdc: 1_000_000_000n, maxSwapWeth: 5n * 10n ** 17n, reserve: 5n * 10n ** 16n, rpc: fakeRpc(chain) };
}

const frame = (tx: FrameTx, i: number, patch: Partial<FrameTx["frames"][number]>): FrameTx => ({
  ...tx,
  frames: tx.frames.map((f, j) => (j === i ? { ...f, ...patch } : f)),
});

async function rejects(tx: FrameTx, code: string, message: RegExp, chain: FakeChain = freshChain()) {
  await expect(checkSponsorPolicy(tx, context(chain))).rejects.toMatchObject({ code, message: expect.stringMatching(message) });
}

describe("sponsor policy", () => {
  it("accepts the canonical swap in both directions and verifies the PQ signature on-chain", async () => {
    const chain = freshChain();
    const tx = validTx();
    await expect(checkSponsorPolicy(tx, context(chain))).resolves.toMatchObject({ direction: "USDC_TO_WETH", amountIn: 1_000_000n, minOut: 1n });
    expect(chain.verified).toEqual([{ publicKey: PUBLIC_KEY, message: signingHash(tx), context: SIGNATURE_CONTEXT, signature: PQ_SIGNATURE }]);
    await expect(checkSponsorPolicy(validTx({ direction: "WETH_TO_USDC", amountIn: 10n ** 17n }), context(freshChain()))).resolves.toMatchObject({
      direction: "WETH_TO_USDC",
    });
  });

  it("rejects a wrong chain id", () => rejects({ ...validTx(), chainId: 1n }, "policy_rejected", /chainId must be 81411338/));
  it("rejects nonce keys other than [0]", () => rejects({ ...validTx(), nonceKeys: [1n] }, "policy_rejected", /nonceKeys/));
  it("rejects blob hashes", () => rejects({ ...validTx(), blobVersionedHashes: [`0x${"01".repeat(32)}`] }, "policy_rejected", /Blob hashes/));
  it("rejects different fees", () => {
    const tx = validTx();
    return rejects({ ...tx, fees: { ...tx.fees, maxFeePerGas: tx.fees.maxFeePerGas + 1n } }, "policy_rejected", /Fees must be exactly/);
  });
  it("rejects a frame count other than 5", () => rejects({ ...validTx(), frames: validTx().frames.slice(0, 4) }, "policy_rejected", /exactly 5 frames/));

  it("rejects a frame 0 that is not the account VERIFY with its limits, no value and validateFrame()", async () => {
    const tx = validTx();
    await rejects(frame(tx, 0, { flags: 3 }), "policy_rejected", /Frame 0 must be the account VERIFY/);
    await rejects(frame(tx, 0, { target: sponsor.address }), "policy_rejected", /Frame 0 must target/);
    await rejects(frame(tx, 0, { limits: { execution: 5_000_000n, state: 0n } }), "policy_rejected", /Frame 0 gas limits/);
    await rejects(frame(tx, 0, { value: 1n }), "policy_rejected", /Frame 0 must not carry value/);
    await rejects(frame(tx, 0, { data: "0x12345678" }), "policy_rejected", /Frame 0 calldata/);
  });

  it("rejects a frame 1 that does not make this server's sponsor pay", async () => {
    const tx = validTx();
    await rejects(frame(tx, 1, { target: "0x000000000000000000000000000000000000dEaD" }), "policy_rejected", /Frame 1 must target/);
    await rejects(frame(tx, 1, { data: "0x00" }), "policy_rejected", /Frame 1 calldata must be empty/);
  });

  it("rejects malformed signature entries", async () => {
    const tx = validTx();
    const [pq, sp] = tx.signatures as [FrameTx["signatures"][number], FrameTx["signatures"][number]];
    await rejects({ ...tx, signatures: [pq] }, "policy_rejected", /exactly 2 signature entries/);
    await rejects({ ...tx, signatures: [{ ...pq, signature: "0x1234" }, sp] }, "policy_rejected", /Signature 0/);
    await rejects({ ...tx, signatures: [pq, { ...sp, signer: ACCOUNT as Hex }] }, "policy_rejected", /Signature 1/);
  });

  it("rejects swap frames that deviate from the template", async () => {
    const tx = validTx();
    const other = validTx({ amountIn: 2_000_000n });
    await rejects(frame(tx, 2, { data: other.frames[2]!.data }), "policy_rejected", /Swap frames rejected: frame 2 must approve exactly amountIn/);
    await rejects(frame(tx, 4, { limits: { execution: 3_000_000n, state: 200_000n } }), "policy_rejected", /canonical swap template/);
  });

  it("rejects a zero minimum output", () => rejects(validTx({ minOut: 0n }), "policy_rejected", /minimum output/));
  it("rejects input above the per-direction limit", async () => {
    await rejects(validTx({ amountIn: 1_000_000_001n }), "policy_rejected", /between 1 and 1000000000/);
    await rejects(validTx({ direction: "WETH_TO_USDC", amountIn: 5n * 10n ** 17n + 1n }), "policy_rejected", /input amount/);
  });

  it("rejects senders that are not factory accounts", () => rejects(validTx(), "not_quantum_account", /not a QuantumAccount/, { ...freshChain(), registered: false }));
  it("rejects a stale or future nonce", () => rejects(validTx(), "policy_rejected", /nonceSeq 7 does not match the account nonce 8/, { ...freshChain(), nonce: 8n }));
  it("rejects deadlines outside (now, now + 3600]", async () => {
    await rejects(validTx({ deadline: NOW }), "policy_rejected", /deadline/);
    await rejects(validTx({ deadline: NOW + 3601n }), "policy_rejected", /deadline/);
  });
  it("refuses when the sponsor cannot cover the worst-case fee plus reserve", () =>
    rejects(validTx(), "operator_unavailable", /low on gas funds/, { ...freshChain(), sponsorBalance: 5n * 10n ** 16n }));
  it("rejects a PQ signature the on-chain verifier refuses", async () => {
    const tx = validTx();
    await rejects({ ...tx, signatures: [{ ...tx.signatures[0]!, signature: `0x${"5b".repeat(7856)}` }, tx.signatures[1]!] }, "invalid_signature", /does not verify/);
  });
});

