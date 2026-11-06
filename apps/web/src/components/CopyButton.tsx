import { useCallback, useEffect, useRef, useState } from "react";

/** Clipboard copy with the design's 1.5 s "Copied" acknowledgement. */
export function useCopy(): [copied: boolean, copy: (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = useCallback((text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {
      // Clipboard unavailable (permissions, insecure context): the value stays visible in the UI.
    });
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }, []);
  return [copied, copy];
}

/** .tbtn copy button, e.g. "Copy address" / "Copy hash". */
export function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [copied, copy] = useCopy();
  return (
    <button type="button" className={className ? `tbtn ${className}` : "tbtn"} onClick={() => copy(text)}>
      {copied ? "Copied" : label}
    </button>
  );
}
