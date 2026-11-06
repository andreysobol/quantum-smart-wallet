import { getAddress } from "viem";

/**
 * The account address engraved under its seal: the full checksummed address in four-character groups,
 * with the first and last groups (the ones people compare) lit.
 */
export function Serial({ address }: { address: string }) {
  let hex = address.slice(2);
  try {
    hex = getAddress(address).slice(2);
  } catch {
    // Show what we were given rather than nothing.
  }
  const groups = hex.match(/.{1,4}/g) ?? [];
  return (
    <div className="serial-wrap addr" aria-label={`Account ${address}`}>
      <span className="ax">0x</span>
      {groups.map((group, index) => (
        <span key={index} className={index === 0 || index === groups.length - 1 ? "ag hi" : "ag"}>
          {group}
        </span>
      ))}
    </div>
  );
}
