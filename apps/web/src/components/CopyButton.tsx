import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

export type CopyState = "idle" | "copied" | "failed";

/**
 * Resolves true only once the browser confirms the write. False when it refuses (permissions, document not
 * focused) or has no Clipboard API (plain http origins, some in-app webviews). `null` means no API (tests).
 */
export async function writeClipboard(text: string, clipboard?: Pick<Clipboard, "writeText"> | null): Promise<boolean> {
  try {
    const target = clipboard === undefined ? globalThis.navigator?.clipboard : clipboard;
    if (!target?.writeText) return false;
    await target.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export const copyLabel = (state: CopyState, label: string) =>
  state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label;

/** "Failed" stays up long enough to select and copy the value by hand. */
const SHOW_MS: Record<Exclude<CopyState, "idle">, number> = { copied: 1500, failed: 10_000 };

/** Clipboard copy with the design's 1.5 s "Copied" acknowledgement, shown only after the write succeeded. */
export function useCopy(): [state: CopyState, copy: (text: string) => void] {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempt = useRef(0);
  useEffect(
    () => () => {
      attempt.current++;
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback((text: string) => {
    const id = ++attempt.current;
    void writeClipboard(text).then((ok) => {
      if (id !== attempt.current) return;
      const next = ok ? "copied" : "failed";
      setState(next);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setState("idle"), SHOW_MS[next]);
    });
  }, []);
  return [state, copy];
}

const MANUAL_STYLE: CSSProperties = { userSelect: "all", overflowWrap: "anywhere", fontSize: 12 };

/** The full value, selected with one click, for when the browser would not copy it. */
export function ManualCopy({ text }: { text: string }) {
  return (
    <span className="mono" role="status" style={MANUAL_STYLE}>
      <span className="vh">Copy failed. Select and copy by hand: </span>
      {text}
    </span>
  );
}

/** .tbtn copy button, e.g. "Copy address" / "Copy hash". */
export function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [state, copy] = useCopy();
  return (
    <>
      <button type="button" className={className ? `tbtn ${className}` : "tbtn"} onClick={() => copy(text)}>
        {copyLabel(state, label)}
      </button>
      {state === "failed" && <ManualCopy text={text} />}
    </>
  );
}
