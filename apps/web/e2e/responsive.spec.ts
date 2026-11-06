// Layout across viewports for every screen state, on the operator-less dev server (nothing is sent on chain):
// no horizontal overflow, the screen's primary action inside the first viewport, 44 px touch targets on phones.
// QSW_SHOTS_DIR=<dir> also writes a screenshot per state and viewport plus <state>.json measurements.
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { toFunctionSelector } from "viem";
import { accountSalt } from "../shared/account.js";
import type { Address, Hex, PublicConfig } from "../shared/types.js";
import type { WalletRecord } from "../src/state/types.js";

const SHOTS = process.env.QSW_SHOTS_DIR;
const DEMO: Address = "0x19b17f47284db0b254c62eb9ad6ce95538e3bc30";
const PASS = "responsive correct horse";
const BALANCE_OF = "0x70a08231";
const IS_ACCOUNT = toFunctionSelector("isAccount(address)");
const GET_ADDRESS = toFunctionSelector("getAddress(bytes32,bytes32)");

interface Viewport {
  name: string;
  width: number;
  height: number;
  phone?: boolean;
}
const VIEWPORTS: Viewport[] = [
  { name: "desktop-1440x900", width: 1440, height: 900 },
  { name: "laptop-short-1280x640", width: 1280, height: 640 },
  { name: "tablet-landscape-1024x768", width: 1024, height: 768 },
  { name: "between-880x720", width: 880, height: 720 },
  { name: "tablet-portrait-768x1024", width: 768, height: 1024 },
  { name: "zoom200-640x450", width: 640, height: 450 },
  { name: "phone-390x844", width: 390, height: 844, phone: true },
  { name: "phone-landscape-844x390", width: 844, height: 390, phone: true },
  { name: "phone-small-320x568", width: 320, height: 568, phone: true },
];

interface Measure {
  overflowX: number;
  docHeight: number;
  offenders: string[];
  smallTargets: string[];
  clipped: string[];
  primary: { found: boolean; inView: boolean; bottom: number } | null;
}

/** Layout facts for the current viewport; `primary` is a CSS selector for the screen's main action. */
async function measure(page: Page, primary: string | null): Promise<Measure> {
  return page.evaluate((primarySel) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const describe = (el: Element) => {
      const cls = typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
      const label = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
      const r = el.getBoundingClientRect();
      return `${el.tagName.toLowerCase()}${cls} "${label}" [${Math.round(r.left)},${Math.round(r.right)}]x[${Math.round(r.width)}x${Math.round(r.height)}]`;
    };
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    // Decorative layers and visually hidden text (1x1 clipped labels kept for assistive tech).
    const decorative = (el: Element) => {
      const r = el.getBoundingClientRect();
      return !!el.closest(".paperfx, [aria-hidden='true'], .vh") || (r.width <= 1 && r.height <= 1);
    };
    const offenders: Element[] = [];
    for (const el of document.querySelectorAll("body *")) {
      if (decorative(el) || !visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1 || r.left < -1) offenders.push(el);
    }
    // Report only the outermost offending elements.
    const outer = offenders.filter((el) => !offenders.some((other) => other !== el && other.contains(el)));
    const targets = document.querySelectorAll("button, a[href], input, select, textarea, [role='button'], label.pick, label.drop");
    const smallTargets = [...targets]
      .filter((el) => visible(el) && !decorative(el))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width < 44 || r.height < 44;
      })
      .map(describe);
    const clipped = [...document.querySelectorAll("body *")]
      .filter((el) => visible(el) && !decorative(el) && el.children.length === 0)
      .filter((el) => {
        const s = getComputedStyle(el);
        const hides = s.overflowX === "hidden" || s.overflowX === "clip" || s.textOverflow === "ellipsis";
        return hides && el.scrollWidth > el.clientWidth + 1;
      })
      .map(describe);
    let primaryInfo = null;
    if (primarySel) {
      const el = [...document.querySelectorAll(primarySel)].find(visible);
      if (!el) primaryInfo = { found: false, inView: false, bottom: -1 };
      else {
        const r = el.getBoundingClientRect();
        primaryInfo = { found: true, inView: r.top >= 0 && r.bottom <= vh + 1, bottom: Math.round(r.bottom) };
      }
    }
    const doc = document.scrollingElement ?? document.documentElement;
    return {
      overflowX: doc.scrollWidth - vw,
      docHeight: doc.scrollHeight,
      offenders: outer.slice(0, 8).map(describe),
      smallTargets: smallTargets.slice(0, 12),
      clipped: clipped.slice(0, 8),
      primary: primaryInfo,
    };
  }, primary);
}

/** Measure (and optionally screenshot) one state at every viewport, from the top of the page. */
/**
 * Landing states must show their primary action in every window; longer forms scroll naturally, so their
 * action must be in view only in windows at least `minHeight` tall (default: always).
 */
async function sweep(page: Page, state: string, primary: string | null, opts: { minHeight?: number } = {}) {
  const report: Record<string, Measure> = {};
  for (const v of VIEWPORTS) {
    await page.setViewportSize({ width: v.width, height: v.height });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(250);
    const m = await measure(page, primary);
    report[v.name] = m;
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: `${SHOTS}/${state}--${v.name}.png` });
    }
    expect.soft(m.overflowX, `${state} @ ${v.name}: horizontal overflow (${m.offenders.join(" | ")})`).toBeLessThanOrEqual(0);
    const checkPrimary = primary && v.height >= (opts.minHeight ?? 0);
    if (checkPrimary) {
      expect.soft(m.primary?.inView, `${state} @ ${v.name}: primary action ${primary} not in the first viewport (bottom ${m.primary?.bottom})`).toBe(true);
    }
    if (v.phone) expect.soft(m.smallTargets, `${state} @ ${v.name}: touch targets under 44 px`).toEqual([]);
  }
  if (SHOTS) writeFileSync(`${SHOTS}/${state}.json`, JSON.stringify(report, null, 1));
  await page.setViewportSize({ width: 1440, height: 900 });
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});
test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

async function openApp(page: Page): Promise<PublicConfig> {
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/config");
  await page.goto("/");
  return (await (await response).json()) as PublicConfig;
}

type RpcCall = { id: number; method: string; params?: [{ to?: string; data?: string }, ...unknown[]] };
type RpcReply = { id: number; result?: unknown };

/** Rewrite selected RPC answers in the browser: registration of the generated key, and optional big balances. */
async function routeRpc(page: Page, config: PublicConfig, opts: { register?: boolean; bigBalances?: boolean }) {
  const state = { predicted: null as Address | null, registered: false };
  const factory = config.contracts.accountFactory.toLowerCase();
  await page.route(config.rpcUrl, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as RpcCall | RpcCall[];
    const response = await route.fetch();
    const json = (await response.json()) as RpcReply | RpcReply[];
    const replies = Array.isArray(json) ? json : [json];
    for (const call of Array.isArray(body) ? body : [body]) {
      const { to, data } = call.params?.[0] ?? {};
      const reply = replies.find((r) => r.id === call.id);
      if (call.method !== "eth_call" || !data || typeof reply?.result !== "string") continue;
      if (opts.register && to?.toLowerCase() === factory) {
        if (data.startsWith(GET_ADDRESS)) state.predicted = `0x${reply.result.slice(-40)}`;
        const asks = !!state.predicted && data.toLowerCase().endsWith(state.predicted.slice(2).toLowerCase());
        if (data.startsWith(IS_ACCOUNT) && state.registered && asks) reply.result = `0x${"0".repeat(63)}1`;
      }
      if (opts.bigBalances && data.startsWith(BALANCE_OF) && data.toLowerCase().endsWith(DEMO.slice(2))) {
        const usdc = to?.toLowerCase() === config.contracts.demoUSDC.toLowerCase();
        // 123,456,789.123456 dUSDC and 98,765.432109876543210987 WETH
        const raw = usdc ? 123_456_789_123_456n : 98_765_432_109_876_543_210_987n;
        reply.result = `0x${raw.toString(16).padStart(64, "0")}`;
      }
    }
    await route.fulfill({ response, json });
  });
  if (opts.register) {
    await page.route("**/api/account", async (route) => {
      const { publicKey } = route.request().postDataJSON() as { publicKey: Hex };
      state.registered = true;
      await route.fulfill({
        json: {
          account: state.predicted,
          salt: accountSalt(publicKey),
          publicKey,
          created: true,
          txHash: `0x${"e2e0".repeat(16)}`,
          blockNumber: 1,
          stakeWei: config.accountInitialStake,
        },
      });
    });
  }
}

/** A device key plus the demo account's public record, so Portfolio/Exchange/Proof show real devnet data. */
async function openDemoWallet(page: Page, config: PublicConfig) {
  const posted = page.waitForRequest((r) => r.url().endsWith("/api/account") && r.method() === "POST");
  await page.getByRole("button", { name: "Create wallet" }).click();
  const { publicKey } = (await posted).postDataJSON() as { publicKey: Hex };
  await expect(page.getByRole("alert").filter({ hasText: "Operator not configured" })).toBeVisible({ timeout: 60_000 });
  const record: WalletRecord = {
    version: 1,
    chainId: config.chainId,
    account: DEMO,
    publicKey,
    salt: accountSalt(publicKey),
    factory: config.contracts.accountFactory,
    createdAt: Date.now(),
    createTxHash: null,
    backedUp: false,
  };
  await page.evaluate((value) => localStorage.setItem("qsw.wallet.v1", value), JSON.stringify(record));
  await page.goto("/");
  await expect(page.locator(".v-grid")).toBeVisible();
  await expect(page.locator(".holdings .hrow")).toHaveCount(3, { timeout: 30_000 });
}

test("genesis and its config-error state", async ({ page }) => {
  await openApp(page);
  await expect(page.getByRole("button", { name: "Create wallet" })).toBeVisible();
  await sweep(page, "genesis", ".gen .btn:not(.ghost)");
  await page.route("**/api/config", (route) => route.fulfill({ status: 503, json: { error: { code: "upstream_error", message: "The devnet RPC is unreachable." } } }));
  await page.goto("/");
  await page.waitForTimeout(1500);
  await sweep(page, "genesis-config-error", null);
});

test("engrave: unavailable operator and a registered seal", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Operator not configured" })).toBeVisible({ timeout: 60_000 });
  await sweep(page, "engrave-unavailable", "main .btn:not(.ghost)");
});

test("engrave done, backup plate and check", async ({ page }) => {
  const config = await openApp(page);
  await routeRpc(page, config, { register: true });
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page.getByRole("heading", { name: "Your seal", exact: true })).toBeVisible({ timeout: 60_000 });
  await sweep(page, "engrave-done", "main .btn:not(.ghost)");
  await page.getByRole("button", { name: "Back up" }).click();
  await expect(page.getByRole("heading", { name: "Back up", exact: true })).toBeVisible();
  await sweep(page, "backup-plate", "main .btn:not(.ghost)", { minHeight: 600 });
  await page.getByLabel("Passphrase", { exact: true }).fill(PASS);
  await page.getByLabel("Repeat passphrase").fill(PASS);
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download backup" }).click();
  await downloading;
  await expect(page.getByRole("heading", { name: "Check", exact: true })).toBeVisible();
  await sweep(page, "backup-check", "main .btn:not(.ghost)", { minHeight: 600 });
});

test("restore", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByRole("heading", { name: "Restore", exact: true })).toBeVisible();
  await sweep(page, "restore", "main .btn:not(.ghost)", { minHeight: 600 });
});

test("portfolio, exchange and proof with real devnet data", async ({ page }) => {
  const config = await openApp(page);
  await openDemoWallet(page, config);
  await expect(page.locator(".lg-row").first()).toBeVisible({ timeout: 30_000 });
  await sweep(page, "portfolio", ".v-main > .row .tbtn, .v-main .empty .btn");
  await page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: "Exchange" }).click();
  await page.getByLabel("You pay").fill("1");
  await expect(page.locator(".frl .fr")).toHaveCount(5);
  await page.waitForTimeout(800);
  await sweep(page, "exchange", ".btn.wide", { minHeight: 600 });
  await page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: "Portfolio" }).click();
  await page.getByRole("button", { name: "Replay proof" }).first().click();
  await expect(page.locator(".p-title")).toHaveText("Verified", { timeout: 30_000 });
  await sweep(page, "proof", ".p-title", { minHeight: 600 });
});

test("long balances and amounts", async ({ page }) => {
  const config = await openApp(page);
  await routeRpc(page, config, { bigBalances: true });
  await openDemoWallet(page, config);
  await sweep(page, "portfolio-long", ".v-main > .row .tbtn, .v-main .empty .btn");
  await page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: "Exchange" }).click();
  await page.getByLabel("You pay").fill("123456789.123456");
  await page.waitForTimeout(800);
  await sweep(page, "exchange-long", ".btn.wide", { minHeight: 600 });
});
