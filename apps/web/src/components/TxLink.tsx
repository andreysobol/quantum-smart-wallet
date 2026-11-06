import type { ReactNode } from "react";

/** Explorer link in the design's .txa style (opens in a new tab, with the arrow glyph). */
export function TxLink({ href, label, children }: { href: string; label: string; children: ReactNode }) {
  return (
    <a className="txa mono" href={href} target="_blank" rel="noopener noreferrer" aria-label={label}>
      {children}
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M6 3h7v7M13 3 4 12" />
      </svg>
    </a>
  );
}
