/**
 * Swap template: the evidence transaction's frames rebuilt from evidence parameters,
 * round trips in both directions, and the strict decoders.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getAddress, keccak256, toBytes, type Hex } from "viem";
import { encodeRaw, fromWire, signingHash, toWire, txHash, type FrameTx } from "../shared/frameTx.js";
import {
  buildSwapTx,
  decodeErc20Approve,
  decodeGuardedSwap,
  decodePermit2Approve,
  encodeGuardedSwap,
  frameLabels,
  parseSwapTx,
  type SwapConfig,
} from "../shared/swap.js";
import type { Address } from "../shared/types.js";

const REPO = new URL("../../../", import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (path: string): any => JSON.parse(readFileSync(new URL(path, REPO), "utf8"));
const evidence = (name: string) => json(`demo/evidence/shared-devnet/${name}`);

const wire = evidence("transaction.json");
const report = evidence("report.json");
const frameReceipt = evidence("frame-receipt.json");
const admission = evidence("admission-and-inclusion.json");
const manifest = json("slhsol/deployments/shared-devnet.json");
const lower = (value: string) => value.toLowerCase() as Hex;
const mined: FrameTx = fromWire(wire);

const config: SwapConfig = {
  chainId: manifest.chainId,
  contracts: {
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
  },
  poolKey: manifest.poolKey,
  sponsor: getAddress(report.sponsor),
};

// Parameters taken from evidence other than the frame calldata itself.
const amountIn = BigInt(report.inputUSDC);
const minOut = BigInt(report.minimumOutputWETH);
const permit2Approval = frameReceipt.frameReceipts[3].logs[0];
const deadline = BigInt("0x" + permit2Approval.data.slice(2 + 64, 2 + 128));
const nonce = BigInt(admission.entry.nonce);
const account = report.account as Address;

describe("guarded swap rebuilt from evidence parameters", () => {
  const built = buildSwapTx({ config, account, nonce, direction: "USDC_TO_WETH", amountIn, minOut, deadline });

  it("takes the deadline from the Permit2 Approval event of frame 3", () => {
    expect(permit2Approval.topics[0]).toBe(keccak256(toBytes("Approval(address,address,address,uint160,uint48)")));
    expect(BigInt("0x" + permit2Approval.data.slice(2, 66))).toBe(amountIn);
    expect(deadline).toBe(0x6aed522fn);
  });

  it("reproduces every frame (mode, flags, target, limits, value, data) exactly", () => {
    expect(built.frames).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(built.frames[i], `frame ${i}`).toEqual(mined.frames[i]);
      expect(built.frames[i]!.data, `frame ${i} data`).toBe(lower(wire.frames[i].data));
    }
  });

  it("has the reported signing hash unsigned, and with the evidence signatures is the mined raw tx", () => {
    expect(signingHash(built)).toBe(lower(report.signingHash));
    expect(built.signatures.map((s) => [s.scheme, s.signer, s.msg, (s.signature.length - 2) / 2])).toEqual([
      [0, "0x", "0x", 7856],
      [1, lower(report.sponsor), "0x", 65],
    ]);
    const signed: FrameTx = { ...built, signatures: mined.signatures };
    expect(encodeRaw(signed)).toBe(lower(readFileSync(new URL("demo/evidence/shared-devnet/raw-transaction.hex", REPO), "utf8").trim()));
    expect(txHash(signed)).toBe(lower(report.transactionHash));
  });

  it("decoders recover every parameter from the mined calldata", () => {
    expect(decodeErc20Approve(mined.frames[2]!.data)).toEqual({ spender: lower(manifest.permit2), amount: amountIn });
    expect(decodePermit2Approve(mined.frames[3]!.data)).toEqual({
      token: lower(manifest.demoUSDC),
      spender: lower(manifest.universalRouter),
      amount: amountIn,
      expiration: deadline,
    });
    expect(decodeGuardedSwap(mined.frames[4]!.data)).toMatchObject({ zeroForOne: true, amountIn, amountOutMinimum: minOut, deadline, tokenIn: lower(manifest.demoUSDC) });
  });

  it("parseSwapTx extracts the signed intent from the mined transaction", () => {
    expect(parseSwapTx(mined, config)).toEqual({
      direction: "USDC_TO_WETH",
      amountIn,
      minOut,
      deadline,
      account: lower(report.account),
      nonce,
      sponsor: lower(report.sponsor),
      tokenIn: lower(manifest.demoUSDC),
      tokenOut: lower(manifest.weth9),
    });
  });
});

describe("both directions round trip", () => {
  for (const direction of ["USDC_TO_WETH", "WETH_TO_USDC"] as const) {
    it(`${direction}: build -> wire -> parse returns the same intent`, () => {
      const params = { config, account, nonce: 42n, direction, amountIn: 123_456n, minOut: 7n, deadline: 1_900_000_000n };
      const tx = buildSwapTx(params);
      const back = fromWire(JSON.parse(JSON.stringify(toWire(tx))));
      expect(back).toEqual(tx);
      const parsed = parseSwapTx(back, config);
      expect(parsed).toMatchObject({ direction, amountIn: 123_456n, minOut: 7n, deadline: 1_900_000_000n, nonce: 42n, account: lower(account) });
      const usdc = lower(manifest.demoUSDC);
      expect(parsed.tokenIn === usdc).toBe(direction === "USDC_TO_WETH");
      expect(tx.frames[2]!.target).toBe(parsed.tokenIn);
      expect(decodeGuardedSwap(tx.frames[4]!.data).zeroForOne).toBe(direction === "USDC_TO_WETH");
    });
  }

  it("labels the five frames for each direction", () => {
    expect(frameLabels("USDC_TO_WETH")).toHaveLength(5);
    expect(frameLabels("WETH_TO_USDC")[2]).toMatch(/WETH/);
  });
});

describe("strictness", () => {
  const base = buildSwapTx({ config, account, nonce: 1n, direction: "WETH_TO_USDC", amountIn: 10n ** 15n, minOut: 1n, deadline: 1_900_000_000n });
  const withFrame = (i: number, patch: Partial<FrameTx["frames"][number]>): FrameTx => ({
    ...base,
    frames: base.frames.map((f, j) => (j === i ? { ...f, ...patch } : f)),
  });

  it("refuses to build without a sponsor or with the sponsor as account", () => {
    expect(() => buildSwapTx({ config: { ...config, sponsor: null }, account, nonce: 1n, direction: "USDC_TO_WETH", amountIn: 1n, minOut: 1n, deadline: 1n })).toThrow(/sponsor/);
    expect(() => buildSwapTx({ config, account: config.sponsor!, nonce: 1n, direction: "USDC_TO_WETH", amountIn: 1n, minOut: 1n, deadline: 1n })).toThrow(/differ/);
  });

  it("rejects mismatched approvals, foreign pools, recipients and trailing bytes", () => {
    const other = "0x000000000000000000000000000000000000dead";
    expect(() => parseSwapTx(withFrame(2, { target: lower(manifest.demoUSDC) }), config)).toThrow(/frame 2/);
    expect(() => parseSwapTx(withFrame(4, { target: other }), config)).toThrow(/frame 4/);
    const foreignPool = encodeGuardedSwap({ poolKey: { ...config.poolKey, fee: 500 }, zeroForOne: false, amountIn: 10n ** 15n, amountOutMinimum: 1n, deadline: 1_900_000_000n });
    expect(() => parseSwapTx(withFrame(4, { data: foreignPool }), config)).toThrow(/poolKey/);
    expect(() => parseSwapTx(withFrame(4, { data: `${base.frames[4]!.data}00` }), config)).toThrow();
    expect(() => decodeErc20Approve(`${base.frames[2]!.data}00`)).toThrow(/non-canonical/);
    expect(() => parseSwapTx({ ...base, frames: base.frames.slice(0, 4) }, config)).toThrow(/5 frames/);
  });
});
