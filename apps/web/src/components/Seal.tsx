import { useId, type ReactNode } from "react";
import { ringFontSize, ringText, seal } from "../design/helpers.js";

/** The design keys account art on the public key as 64 lowercase hex chars (no 0x). */
export function pkDigits(publicKey: string): string {
  return publicKey.replace(/^0x/i, "").toLowerCase();
}

/** Seal seed of an account, identical to the prototype's 'acct|' + pk. */
export function accountSeed(publicKey: string): string {
  return "acct|" + pkDigits(publicKey);
}

const VIEW = "-100 -100 200 200";

export interface SealProps {
  /** Engraving seed, e.g. accountSeed(publicKey) or a ledger entry's seed. */
  seed: string;
  /** Low-detail medallion (.mseal) used at 30-40px. */
  lite?: boolean;
  /** Lite: width/height in px. Full: max-width in px (the container sets the size otherwise). */
  size?: number;
  /** Extra classes on the root, e.g. "engr", "signing", "locked", "proof". */
  className?: string;
  /** Full seal only: slow rotation of the layers (.live). Default true. */
  animate?: boolean;
  /** Full seal only: public key (hex, 0x optional) set as the micro-text ring. Omitted: no ring. */
  pk?: string;
  /** Full seal only: draw the rosette and inner rings. Default true (the proof view omits them). */
  rosette?: boolean;
  /** Full seal only: extra layers inside the seal (tree, stamp). */
  children?: ReactNode;
}

export function Seal({ seed, lite, size, className, animate = true, pk, rosette = true, children }: SealProps) {
  const ringId = "pkr-" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  if (lite) {
    const p = seal(seed, true);
    return (
      <span className={cx("mseal", className)} style={size ? { width: size, height: size } : undefined}>
        <svg viewBox={VIEW} aria-hidden="true">
          <path className="p-rule" d={p.rules} />
          <path className="p-ba" d={p.braidA} />
          <path className="p-bb" d={p.braidB} />
          <path className="p-ros" d={p.ros} />
          <path className="p-in" d={p.inner} />
        </svg>
      </span>
    );
  }
  const p = seal(seed, false);
  const ring = pk ? ringText(pkDigits(pk)) : null;
  return (
    <div className={cx("seal", animate && "live", className)} style={size ? { maxWidth: size } : undefined}>
      <div className="ly l-out">
        <svg viewBox={VIEW} aria-hidden="true">
          <path className="p-rule" d={p.rules} />
        </svg>
      </div>
      {ring && (
        <div className="ly l-pk">
          <svg viewBox={VIEW} aria-hidden="true">
            <defs>
              <path id={ringId} d={p.ringPath} />
            </defs>
            <text className="micro" style={{ fontSize: `${ringFontSize(p.ringLen, ring)}px` }}>
              <textPath href={`#${ringId}`}>{ring}</textPath>
            </text>
          </svg>
        </div>
      )}
      <div className="ly l-ba">
        <svg viewBox={VIEW} aria-hidden="true">
          <path className="p-ba" d={p.braidA} />
        </svg>
      </div>
      <div className="ly l-bb">
        <svg viewBox={VIEW} aria-hidden="true">
          <path className="p-bb" d={p.braidB} />
        </svg>
      </div>
      {rosette && (
        <>
          <div className="ly l-ros">
            <svg viewBox={VIEW} aria-hidden="true">
              <path className="p-ros" d={p.ros} />
            </svg>
          </div>
          <div className="ly l-in">
            <svg viewBox={VIEW} aria-hidden="true">
              <path className="p-in" d={p.inner} />
            </svg>
          </div>
        </>
      )}
      {children}
    </div>
  );
}

/** The SLH-DSA hypertree layer of the proof seal (path data from the proof view). */
export function TreeLayer({ dim, lit, hot, climb }: { dim: string; lit: string; hot: string; climb: string }) {
  return (
    <div className="ly l-tree">
      <svg viewBox={VIEW} aria-hidden="true">
        <path className="t-dim" d={dim} />
        <path className="t-lit" d={lit} />
        <path className="t-hot" d={hot} />
        <path className="t-climb" d={climb} />
      </svg>
    </div>
  );
}

export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}
