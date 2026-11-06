/** Display helpers for raw token amounts and hex strings (isomorphic, no locale surprises). */

/** Exact decimal string of a raw amount, truncated (never rounded up) to maxFractionDigits, trailing zeros trimmed. */
export function formatUnits(value: bigint, decimals: number, maxFractionDigits = decimals): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = (abs % base).toString().padStart(decimals, "0").slice(0, Math.max(0, maxFractionDigits)).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** formatUnits with thousands separators on the whole part: 12345.5 -> "12,345.5". */
export function formatAmount(value: bigint, decimals: number, maxFractionDigits = 4): string {
  const [whole = "0", fraction] = formatUnits(value, decimals, maxFractionDigits).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction ? `${grouped}.${fraction}` : grouped;
}

/**
 * Strict decimal parser for user input: "1", "1.5", ".5", "1." -> raw units.
 * Returns null for anything else, including more fraction digits than the token has.
 */
export function parseUnits(text: string, decimals: number): bigint | null {
  const trimmed = text.trim();
  const match = /^(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (!match || trimmed === "" || trimmed === ".") return null;
  const [, whole = "", fraction = ""] = match;
  if (fraction.length > decimals) return null;
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** "0x1234…abcd" (lead counts the 0x prefix). */
export function shortHex(hex: string, lead = 6, tail = 4): string {
  return hex.length <= lead + tail + 1 ? hex : `${hex.slice(0, lead)}…${hex.slice(-tail)}`;
}

/** Plain-number USD display: "$1,234.56". */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const fixed = Math.abs(value).toFixed(2);
  const [whole = "0", cents = "00"] = fixed.split(".");
  return `${value < 0 ? "-" : ""}$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
}
