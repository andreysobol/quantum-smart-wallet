// Copy feedback: "Copied" only once the browser confirmed the clipboard write.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CopyButton, copyLabel, writeClipboard } from "../src/components/CopyButton.js";

describe("copy feedback", () => {
  it("reports success only once the browser confirms the write", async () => {
    const written: string[] = [];
    expect(await writeClipboard("0xabc", { writeText: async (text) => void written.push(text) })).toBe(true);
    expect(written).toEqual(["0xabc"]);
  });

  it("reports failure when the write is refused, throws, or the Clipboard API is missing (plain http)", async () => {
    const refused = () => Promise.reject(new DOMException("Document is not focused.", "NotAllowedError"));
    expect(await writeClipboard("0xabc", { writeText: refused })).toBe(false);
    expect(
      await writeClipboard("0xabc", {
        writeText: () => {
          throw new TypeError("Illegal invocation");
        },
      }),
    ).toBe(false);
    expect(await writeClipboard("0xabc", null)).toBe(false);
  });

  it("never says Copied unless it was", () => {
    expect(copyLabel("idle", "Copy address")).toBe("Copy address");
    expect(copyLabel("copied", "Copy address")).toBe("Copied");
    expect(copyLabel("failed", "Copy address")).toBe("Copy failed");
  });

  it("the button starts with its label and no manual-copy fallback", () => {
    const html = renderToStaticMarkup(createElement(CopyButton, { text: "0x19b17f47284db0b254c62eb9ad6ce95538e3bc30", label: "Copy address" }));
    expect(html).toBe('<button type="button" class="tbtn">Copy address</button>');
  });
});
