// Markup of the "replace this device's wallet?" question, rendered on the server with a stubbed wallet context
// (no DOM in this test environment; the decisions themselves are covered by custody.test.ts).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PendingReplace, WalletContextValue } from "../src/state/wallet.js";
import type { WalletRecord } from "../src/state/types.js";

const ctx = vi.hoisted(() => ({ value: {} as Partial<WalletContextValue> }));
vi.mock("../src/state/wallet.js", () => ({ useWallet: () => ctx.value }));

const { Genesis, ReplaceWallet } = await import("../src/screens/Genesis.js");

const current: WalletRecord = {
  version: 1,
  chainId: 81411338,
  account: "0x19b17f47284db0b254c62eb9ad6ce95538e3bc30",
  publicKey: `0x${"ab".repeat(32)}`,
  salt: `0x${"cd".repeat(32)}`,
  factory: "0x573b8fC3b0d72b3B859eACBA67fA3224Ecb55181",
  createdAt: 1,
  createTxHash: null,
  backedUp: false,
};

const render = (replacing: PendingReplace | null, action: PendingReplace["action"]) => {
  ctx.value = { replacing, confirmReplace: () => {}, keepWallet: () => {} };
  return renderToStaticMarkup(createElement(ReplaceWallet, { action }));
};

describe("replace confirmation", () => {
  it("names the current account and warns when it is not backed up; replacing is a separate, explicit button", () => {
    const html = render({ action: "create", current }, "create");
    expect(html).toContain("This device already holds a wallet");
    expect(html).toContain("0x19b1…bc30");
    expect(html).toContain("not backed up");
    expect(html).toContain("without a backup file you lose access to its funds");
    expect(html).toMatch(/<button type="button" class="btn"[^>]*>Keep it<\/button>/);
    expect(html).toMatch(/<button type="button" class="link warn"[^>]*>Replace it<\/button>/);
  });

  it("says so when the current wallet is backed up", () => {
    const html = render({ action: "restore", current: { ...current, backedUp: true }, publicKey: `0x${"0b".repeat(32)}`, meta: null }, "restore");
    expect(html).toContain("is backed up.");
    expect(html).toContain("restore its backup file to use it again");
  });

  it("explains a save refused because another tab saved a wallet meanwhile", () => {
    const html = render({ action: "save", current, record: { ...current, publicKey: `0x${"0b".repeat(32)}` } }, "save");
    expect(html).toContain("Another tab saved a wallet on this device");
  });

  it("renders only on the screen that asked", () => {
    expect(render(null, "create")).toBe("");
    expect(render({ action: "create", current }, "restore")).toBe("");
    expect(render({ action: "create", current }, "save")).toBe("");
  });

  it("Genesis keeps its buttons and shows the question under them", () => {
    ctx.value = { replacing: { action: "create", current }, createWallet: () => {}, go: () => {}, confirmReplace: () => {}, keepWallet: () => {} };
    const html = renderToStaticMarkup(createElement(Genesis));
    expect(html).toContain(">Create wallet</button>");
    expect(html).toContain(">Restore</button>");
    expect(html.indexOf(">Restore</button>")).toBeLessThan(html.indexOf("Keep it"));
  });
});
