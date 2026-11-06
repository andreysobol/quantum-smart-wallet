import { TOKENS, tokenMark, type TokenSym } from "../design/helpers.js";
import { cx } from "./Seal.js";

/** Engraved token medallion: braided ring (WETH gets the extra "wrapped" rims) plus the glyph. */
export function TokenMark({ sym, small, className }: { sym: TokenSym; small?: boolean; className?: string }) {
  const token = TOKENS[sym];
  return (
    <span className={cx("tk", small && "sm", token.cls, className)}>
      <svg viewBox="-20 -20 40 40" aria-hidden="true">
        <path d={tokenMark(sym)} />
      </svg>
      <span className="tk-g" aria-hidden="true">
        {token.glyph}
      </span>
    </span>
  );
}
