import { formatUnits } from "viem";
import { USDC_DECIMALS, WETH_DECIMALS } from "../../shared/constants.js";
import type { SwapDirection } from "../../shared/types.js";

export type TokenKey = "usdc" | "weth";

export const TOKEN_DECIMALS: Record<TokenKey, number> = { usdc: USDC_DECIMALS, weth: WETH_DECIMALS };
/** Display decimals, as in the design (USDC 2, ETH/WETH 4). */
export const TOKEN_DP: Record<TokenKey, number> = { usdc: 2, weth: 4 };

export const tokenIn = (direction: SwapDirection): TokenKey => (direction === "USDC_TO_WETH" ? "usdc" : "weth");
export const tokenOut = (direction: SwapDirection): TokenKey => (direction === "USDC_TO_WETH" ? "weth" : "usdc");

/** Decimal number for display math only (never for amounts that get signed). */
export const toNumber = (raw: bigint, decimals: number): number => Number(formatUnits(raw, decimals));

/**
 * en-US grouped amount with `dp` fraction digits. Values below 1 keep 4 significant
 * digits when that is more precise, so small swap amounts never read as rounded or zero.
 */
export function formatAmount(raw: bigint, decimals: number, dp: number): string {
  const value = toNumber(raw < 0n ? -raw : raw, decimals);
  const sign = raw < 0n ? "−" : "";
  const fixed = value.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  if (value !== 0 && value < 1) {
    const precise = value.toLocaleString("en-US", { maximumSignificantDigits: 4 });
    if ((precise.split(".")[1]?.length ?? 0) > dp) return sign + precise;
  }
  return sign + fixed;
}

export const formatToken = (raw: bigint, token: TokenKey): string => formatAmount(raw, TOKEN_DECIMALS[token], TOKEN_DP[token]);

/** Keep digits and one dot, drop grouping commas (the design's onAmt sanitiser). */
export function sanitizeAmountInput(value: string): string {
  let v = value.replace(/,/g, "").replace(/[^0-9.]/g, "");
  const parts = v.split(".");
  if (parts.length > 2) v = parts[0] + "." + parts.slice(1).join("");
  return v;
}

/** Parse a sanitised decimal string into raw units; null when empty/invalid or too precise. */
export function parseAmountInput(value: string, decimals: number): bigint | null {
  if (!/^\d*\.?\d*$/.test(value) || value === "" || value === ".") return null;
  const [whole = "", fraction = ""] = value.split(".");
  if (fraction.length > decimals) return null;
  if (whole.length > 30) return null;
  return BigInt((whole || "0") + fraction.padEnd(decimals, "0"));
}

/** Raw amount as a plain decimal string without grouping (for the input field). */
export function rawToInput(raw: bigint, decimals: number, maxDp: number): string {
  const [whole, fraction = ""] = formatUnits(raw, decimals).split(".");
  const cut = fraction.slice(0, maxDp).replace(/0+$/, "");
  return cut ? `${whole}.${cut}` : (whole ?? "0");
}

/**
 * Spot price in dUSDC per WETH from a v4 sqrtPriceX96 (display only).
 * raw = (sqrtP / 2^96)^2 is currency1 raw units per currency0 raw unit.
 */
export function spotUsdcPerWeth(sqrtPriceX96: bigint, usdcIsCurrency0: boolean): number {
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  const raw = ratio * ratio;
  if (!(raw > 0)) return Number.NaN;
  const scale = 10 ** (WETH_DECIMALS - USDC_DECIMALS);
  return usdcIsCurrency0 ? scale / raw : raw * scale;
}
