// The wallet app in Chromium against the Vite dev server with the /api dev plugin and NO operator key
// (QSW_E2E_PREVIEW=1: the production build, served with vercel.json's CSP): boot and design, onboarding with a
// real worker key, backup export + verification + restore through the UI, and the read-only Portfolio, Exchange
// and Proof screens for the shared devnet's demo account.
// Nothing here changes chain state: account creation is mocked, and no transaction is signed or sent.
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { encodeFunctionData, erc20Abi, formatEther, toFunctionSelector } from "viem";
import { accountSalt } from "../shared/account.js";
import { loadPoolState, quoteExactIn } from "../shared/quote.js";
import { rpcBatch } from "../shared/rpc.js";
import type { Address, Hex, PublicConfig } from "../shared/types.js";
import { formatAmount, formatToken } from "../src/chain/amounts.js";
import { seal } from "../src/design/helpers.js";
import type { WalletRecord } from "../src/state/types.js";

// Shared devnet facts: explorer URL formats, and the demo account's transactions (demo/evidence/shared-devnet).
const EXPLORER = "https://altmempool.bailo.london/explorer/";
const RPC = "https://altmempool.bailo.london/rpc";
const DEMO: Address = "0x19b17f47284db0b254c62eb9ad6ce95538e3bc30";
const SPONSOR: Address = "0xb7Ca4C821205f6721bacbd48052bEbF6A1f252c1";
const DEMO_SWAP: Hex = "0x5372c2b13aa087361c62475f8b28f843012a9fb2ae4e4692878d80efcb28fa1e";
const DEMO_MINT: Hex = "0xcf0babdd7a0a9d0b42d72675dd1a93028b34c5784cb54bf6f2f599e83556d614";
const DEMO_CREATE: Hex = "0x23c1e58f0409aefda2a7af5660b8987b7cd7fe86049d260ca6d4f09aec1c7328";
const DEMO_SWAP_OUT = 498_475_151_013_721n;
/** Placeholder hash for the mocked account creation (no such transaction exists). */
const MOCK_CREATE_TX: Hex = `0x${"e2e0".repeat(16)}`;
const PASS = "e2e correct horse battery";

const IS_ACCOUNT = toFunctionSelector("isAccount(address)");
const GET_ADDRESS = toFunctionSelector("getAddress(bytes32,bytes32)");
const TRUE_WORD: Hex = `0x${"0".repeat(63)}1`;

type RpcCall = { id: number; method: string; params?: [{ to?: string; data?: string }, ...unknown[]] };
type RpcReply = { id: number; result?: unknown };

/** Uncaught page errors, plus Content-Security-Policy violations (QSW_E2E_PREVIEW=1 serves vercel.json's CSP). */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /Content Security Policy/i.test(message.text())) errors.push(message.text());
  });
  return errors;
}

/** Open the app and return the /api/config it booted with. */
async function openApp(page: Page): Promise<PublicConfig> {
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/config");
  await page.goto("/");
  const config = (await (await response).json()) as PublicConfig;
  expect(config).toMatchObject({ explorerUrl: EXPLORER, rpcUrl: RPC });
  return config;
}

/** Genesis -> Create wallet until the operator-less server stops it; returns the worker-generated public key. */
async function generateKeyOnly(page: Page): Promise<Hex> {
  const posted = page.waitForRequest((r) => r.url().endsWith("/api/account") && r.method() === "POST");
  await page.getByRole("button", { name: "Create wallet" }).click();
  const { publicKey } = (await posted).postDataJSON() as { publicKey: Hex };
  await expect(page.getByRole("alert").filter({ hasText: "Operator not configured" })).toBeVisible({ timeout: 60_000 });
  return publicKey;
}

/**
 * Pretend the operator exists: /api/account answers with the factory's own CREATE2 address for the key
 * (read live through getAddress, which stays a real eth_call) and isAccount reads true for it afterwards.
 */
async function mockRegistration(page: Page, config: PublicConfig) {
  const state = { predicted: null as Address | null, registered: false, requests: [] as Hex[] };
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
      if (call.method !== "eth_call" || to?.toLowerCase() !== factory || !data || typeof reply?.result !== "string") continue;
      if (data.startsWith(GET_ADDRESS)) state.predicted = `0x${reply.result.slice(-40)}`;
      const asksPredicted = !!state.predicted && data.toLowerCase().endsWith(state.predicted.slice(2).toLowerCase());
      if (data.startsWith(IS_ACCOUNT) && state.registered && asksPredicted) reply.result = TRUE_WORD;
    }
    await route.fulfill({ response, json });
  });
  await page.route("**/api/account", async (route) => {
    const { publicKey } = route.request().postDataJSON() as { publicKey: Hex };
    state.requests.push(publicKey);
    if (!state.predicted) {
      return route.fulfill({ status: 500, json: { error: { code: "internal", message: "test: getAddress was not read first" } } });
    }
    state.registered = true;
    await route.fulfill({
      json: {
        account: state.predicted,
        salt: accountSalt(publicKey),
        publicKey,
        created: true,
        txHash: MOCK_CREATE_TX,
        blockNumber: 1,
        stakeWei: config.accountInitialStake,
      },
    });
  });
  return state;
}

/** Independent read-only balances of an account: [ETH, dUSDC, WETH]. */
async function readBalances(config: PublicConfig, account: Address): Promise<[bigint, bigint, bigint]> {
  const balanceOf = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [account] });
  const results = await rpcBatch(config.rpcUrl, [
    { method: "eth_getBalance", params: [account, "latest"] },
    { method: "eth_call", params: [{ to: config.contracts.demoUSDC, data: balanceOf }, "latest"] },
    { method: "eth_call", params: [{ to: config.contracts.weth9, data: balanceOf }, "latest"] },
  ]);
  return results.map((r) => {
    if (!r.ok) throw r.error;
    return BigInt(r.result as string);
  }) as [bigint, bigint, bigint];
}

// Screens keep polling the RPC: drop routes before teardown so an in-flight handler cannot fail the test.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

const termRow = (page: Page, term: string) => page.locator(".tbl > div").filter({ has: page.locator("dt", { hasText: term }) }).locator("dd");

test("boots on Genesis with the design styles and bundled fonts; /api/config reports no operator", async ({ page }) => {
  const errors = watchErrors(page);
  const external: string[] = [];
  page.on("request", (r) => {
    if (!r.url().startsWith("http://127.0.0.1:4173/") && r.url() !== RPC) external.push(r.url());
  });
  const config = await openApp(page);
  expect(config).toMatchObject({ chainId: 81411338, operatorReady: false, sponsor: null, faucet: { enabled: false } });

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Nothing but hashes.");
  await expect(page.getByRole("button", { name: "Create wallet" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Restore" })).toBeVisible();
  await expect(page.locator(".foot")).toContainText("Devnet 81411338 · test tokens only");
  await expect(page.locator("a.net")).toHaveAttribute("href", EXPLORER);
  await expect(page.locator(".gen .seal.live .l-pk textPath")).toContainText("PK 0x");

  const look = await page.evaluate(async () => {
    await document.fonts.ready;
    const css = (selector: string) => getComputedStyle(document.querySelector(selector) as Element);
    return {
      background: getComputedStyle(document.body).backgroundColor,
      ink: css(".qs").getPropertyValue("--ink").trim(),
      heading: css(".gen-h").fontFamily,
      button: css(".btn").fontFamily,
      loaded: [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/["']/g, "")),
      fibers: document.querySelectorAll(".paperfx .fiber").length,
    };
  });
  expect(look.background).toBe("rgb(12, 9, 25)");
  expect(look.ink.toLowerCase()).toBe("#ece8ff");
  expect(look.heading).toMatch(/^"?Bodoni Moda"?/);
  expect(look.button).toMatch(/^"?Martian Mono"?/);
  expect(new Set(look.loaded)).toEqual(new Set(["Bodoni Moda", "Martian Mono"]));
  expect(look.fibers).toBeGreaterThan(0);
  // Fonts are bundled: the only off-origin traffic is the devnet RPC (chain id + genesis check).
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});

test("create wallet: worker key and seal, operator-less error with retry, mocked registration, verified backup, restore", async ({
  page,
  browser,
}, testInfo) => {
  const errors = watchErrors(page);
  const workers: string[] = [];
  page.on("worker", (worker) => workers.push(worker.url()));
  const posts: Hex[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/account") && r.method() === "POST") posts.push((r.postDataJSON() as { publicKey: Hex }).publicKey);
  });
  const config = await openApp(page);

  // 1. No operator key on this server: the key is still generated in the worker and engraved, then the
  //    account creation step explains the problem and offers a retry.
  const publicKey = await generateKeyOnly(page);
  expect(publicKey).toMatch(/^0x[0-9a-f]{64}$/);
  expect(workers.some((url) => /\/signer\.worker[.-]/.test(url))).toBe(true);
  await expect(page.getByRole("heading", { name: "Engraving unavailable", exact: true })).toBeVisible();
  const engraved = page.locator(".seal.live.engr");
  await expect(engraved.locator(".l-pk textPath")).toContainText(`PK ${publicKey}`);
  await expect(engraved.locator(".l-ba path")).toHaveAttribute("d", seal(`acct|${publicKey.slice(2)}`, false).braidA);

  await page.getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => posts.length).toBe(2);
  await expect(page.getByRole("alert").filter({ hasText: "Operator not configured" })).toBeVisible();
  expect(posts[1]).toBe(publicKey);

  // 2. The operator "appears" (mocked): retrying registers the same key's own CREATE2 account.
  const registration = await mockRegistration(page, config);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Your seal", exact: true })).toBeVisible({ timeout: 60_000 });
  expect(registration.requests).toEqual([publicKey]);
  const account = registration.predicted as Address;
  await expect(page.getByLabel(`Account ${account}`)).toBeVisible();
  await expect(page.getByRole("link", { name: `View transaction ${MOCK_CREATE_TX} on the explorer` })).toHaveAttribute(
    "href",
    `${EXPLORER}chain/tx/${MOCK_CREATE_TX}`,
  );
  await expect(engraved.locator(".l-pk textPath")).toContainText(`PK ${publicKey}`);

  // 3. Backup: passphrase, encrypted download, then the check re-reads that file through the file chooser.
  await page.getByRole("button", { name: "Back up" }).click();
  await expect(page.getByRole("heading", { name: "Back up", exact: true })).toBeVisible();
  await page.getByLabel("Passphrase", { exact: true }).fill(PASS);
  await page.getByLabel("Repeat passphrase").fill(PASS);
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download backup" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(`qsw-backup-${account.slice(0, 10).toLowerCase()}.json`);
  const file = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(file);
  const text = await readFile(file, "utf8");
  const backup = JSON.parse(text) as { publicKey: string; meta: { chainId: number; account: string } };
  expect(backup.publicKey).toBe(publicKey);
  expect(backup.meta.chainId).toBe(config.chainId);
  expect(backup.meta.account.toLowerCase()).toBe(account.toLowerCase());
  expect(text).not.toContain(PASS);

  await expect(page.getByRole("heading", { name: "Check", exact: true })).toBeVisible();
  const choosing = page.waitForEvent("filechooser");
  await page.getByText("Choose file").click();
  await (await choosing).setFiles(file);
  await expect(page.getByText(download.suggestedFilename())).toBeVisible();
  await page.getByLabel("Backup passphrase").fill(`${PASS}!`);
  await page.getByRole("button", { name: "Seal backup" }).click();
  await expect(page.getByRole("alert")).toHaveText("Wrong passphrase for this backup file.");
  await page.getByLabel("Backup passphrase").fill(PASS);
  await page.getByRole("button", { name: "Seal backup" }).click();
  await expect(page.locator(".stamp .st1")).toHaveText("Sealed");
  await expect(page.getByRole("status")).toHaveText("Backup verified and sealed.");

  await expect(page.getByRole("heading", { name: "Portfolio", exact: true })).toBeVisible();
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("qsw.wallet.v1") ?? "null") as unknown);
  expect(stored).toMatchObject({ publicKey, backedUp: true, createTxHash: MOCK_CREATE_TX, salt: accountSalt(publicKey) });
  expect((stored as WalletRecord).account.toLowerCase()).toBe(account.toLowerCase());
  expect(errors).toEqual([]);

  // 4. Restore on a fresh device (new context: empty IndexedDB and localStorage) from that file.
  const device = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  try {
    const fresh = await device.newPage();
    const freshErrors = watchErrors(fresh);
    const known = await mockRegistration(fresh, await openApp(fresh));
    known.registered = true;
    await fresh.getByRole("button", { name: "Restore" }).click();
    await expect(fresh.getByRole("heading", { name: "Restore", exact: true })).toBeVisible();
    const picking = fresh.waitForEvent("filechooser");
    await fresh.getByText("Choose or drop your").click();
    await (await picking).setFiles(file);
    await fresh.getByLabel("Passphrase", { exact: true }).fill(`${PASS}!`);
    await fresh.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(fresh.getByRole("alert")).toHaveText("Wrong passphrase for this backup file.");
    await fresh.getByLabel("Passphrase", { exact: true }).fill(PASS);
    await fresh.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(fresh.getByRole("heading", { name: "Your seal", exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(fresh.locator(".seal.live.engr .l-pk textPath")).toContainText(`PK ${publicKey}`);
    expect(known.requests).toEqual([]);
    await fresh.getByRole("button", { name: "Continue" }).click();
    await expect(fresh.getByRole("heading", { name: "Portfolio", exact: true })).toBeVisible();
    await expect(fresh.getByRole("button", { name: `Copy address ${account}` })).toBeVisible();
    const restored = await fresh.evaluate(() => JSON.parse(localStorage.getItem("qsw.wallet.v1") ?? "null") as unknown);
    expect(restored).toMatchObject({ publicKey, backedUp: true, createTxHash: null });
    expect((restored as WalletRecord).account.toLowerCase()).toBe(account.toLowerCase());
    expect(freshErrors).toEqual([]);
    await fresh.unrouteAll({ behavior: "ignoreErrors" });
  } finally {
    await device.close();
  }
});

test("portfolio, exchange and proof replay show the demo account's real devnet data", async ({ page }) => {
  const errors = watchErrors(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const config = await openApp(page);

  // The boot opens the Portfolio only when this device holds the record's key, so pair the demo account's
  // public record with a key generated here. Nothing is signed in this test.
  const publicKey = await generateKeyOnly(page);
  const record: WalletRecord = {
    version: 1,
    chainId: config.chainId,
    account: DEMO,
    publicKey,
    salt: accountSalt(publicKey),
    factory: config.contracts.accountFactory,
    createdAt: Date.now(),
    createTxHash: DEMO_CREATE,
    backedUp: true,
  };
  await page.evaluate((value) => localStorage.setItem("qsw.wallet.v1", value), JSON.stringify(record));
  await page.reload();

  // Portfolio: balances equal an independent read of the chain.
  await expect(page.getByRole("heading", { name: "Portfolio", exact: true })).toBeVisible();
  const [eth, usdc, weth] = await readBalances(config, DEMO);
  const rows = page.locator(".holdings .hrow");
  await expect(rows).toHaveCount(3);
  await expect(rows.locator(".hamt")).toHaveText([formatAmount(eth, 18, 4), formatAmount(weth, 18, 4), formatAmount(usdc, 6, 2)]);
  await expect(rows.locator(".hname .lab")).toHaveText(["ETH", "WETH", "dUSDC"]);
  await expect(page.locator(".v-main")).toContainText("0.012 ETH is locked as your account's mempool stake.");
  await expect(page.getByRole("button", { name: "Faucet unavailable" })).toBeDisabled();

  // Activity ledger and explorer links (mempool admission view for frame txs, chain view otherwise).
  await expect(page.locator(".lg-row .tt", { hasText: `Swapped 1.00 dUSDC → ${formatToken(DEMO_SWAP_OUT, "weth")} WETH` })).toBeVisible();
  await expect(page.locator(".lg-row .tt", { hasText: "Received 1.00 dUSDC" })).toBeVisible();
  await expect(page.locator(".lg-row .tt", { hasText: "Account created" })).toBeVisible();
  const link = (hash: Hex) => page.getByRole("link", { name: `View transaction ${hash} on the explorer` });
  const nodeParam = encodeURIComponent(config.mempoolUrl);
  expect(nodeParam).toBe("https%3A%2F%2Faltmempool.bailo.london%2Fmempool");
  await expect(link(DEMO_SWAP)).toHaveAttribute("href", `${EXPLORER}tx/${DEMO_SWAP}?node=${nodeParam}`);
  await expect(link(DEMO_MINT)).toHaveAttribute("href", `${EXPLORER}chain/tx/${DEMO_MINT}`);
  await expect(link(DEMO_CREATE)).toHaveAttribute("href", `${EXPLORER}chain/tx/${DEMO_CREATE}`);
  await expect(link(DEMO_SWAP)).toHaveAttribute("rel", "noopener noreferrer");
  await expect(page.locator("a.net")).toHaveAttribute("href", `${EXPLORER}address/${DEMO}`);
  await expect(page.getByRole("button", { name: `Copy address ${DEMO}` })).toBeVisible();

  // Exchange: a live quote from the pool, the five frames and the network fee (sponsor) row.
  const nav = page.getByRole("navigation", { name: "Sections" });
  await nav.getByRole("button", { name: "Exchange" }).click();
  await expect(page.getByRole("heading", { name: "Exchange", exact: true })).toBeVisible();
  await page.getByLabel("You pay").fill("1");
  const quote = quoteExactIn(await loadPoolState(config.rpcUrl, config), "USDC_TO_WETH", 1_000_000n);
  await expect(page.locator(".recv .amt")).toHaveText(formatToken(quote.amountOut, "weth"));
  await expect(termRow(page, "Rate")).toHaveText(/^1 WETH = [\d,]+\.\d{2} dUSDC$/);
  await expect(termRow(page, "Min. received")).toHaveText(`${formatToken((quote.amountOut * 9_950n) / 10_000n, "weth")} WETH (0.5%)`);
  const frames = page.locator(".frl .fr");
  await expect(frames).toHaveCount(5);
  await expect(frames.locator(".fm")).toHaveText(["VERIFY", "VERIFY", "SENDER", "SENDER", "SENDER"]);
  await expect(frames.locator(".fd")).toHaveText([
    "Check your SLH-DSA signature",
    "Sponsor approves paying gas",
    "Approve 1.00 dUSDC for Permit2",
    "Permit2 allowance for the router",
    "Swap to WETH on the guarded pool",
  ]);
  await expect(page.locator(".x-grid")).toContainText("1 transaction · 5 frames");
  await expect(termRow(page, "Network fee")).toHaveText("No sponsor");
  await expect(page.getByRole("button", { name: "Sponsor unavailable" })).toBeDisabled();

  // Proof replay of the demo swap, rebuilt from the chain: frames, PQ validation in frame 0, the block.
  await nav.getByRole("button", { name: "Portfolio" }).click();
  await page.getByRole("button", { name: "Replay proof" }).first().click();
  await expect(page.getByRole("heading", { name: "Proof", exact: true })).toBeVisible();
  await expect(page.locator(".pfl .pf")).toHaveCount(5, { timeout: 30_000 });
  await expect(page.locator(".pfl .pf .pf-t")).toHaveText([
    "Check your SLH-DSA signature",
    "Sponsor approves paying gas",
    "Approve 1.00 dUSDC for Permit2",
    "Permit2 allowance for the router",
    "Swap to WETH on the guarded pool",
  ]);
  await expect(page.locator(".p-title")).toHaveText("Verified", { timeout: 30_000 });
  await expect(page.locator(".pfl .pf .pf-s")).toHaveText(["Approved", "Approved", "Done", "Done", "Done"]);
  await expect(page.locator(".p-stage .stamp .st1")).toHaveText("Verified");
  await expect(page.locator(".p-stage .stamp .st2")).toHaveText("Block 408");
  const receipt = (term: string) => page.locator(".rc > div").filter({ has: page.locator("dt", { hasText: term }) }).locator("dd");
  await expect(receipt("Result")).toHaveText(`−1.00 dUSDC · +${formatToken(DEMO_SWAP_OUT, "weth")} WETH`);
  await expect(receipt("Min. received")).toHaveText(`${formatToken(450_000_000_000_000n, "weth")} WETH`);
  await expect(receipt("Block")).toHaveText("408");
  await expect(receipt("Paid by")).toHaveText("0xb7ca…52c1 (sponsor)");
  await expect(receipt("Fee")).toHaveText(`${formatEther(1_727_304_012_091_128n).slice(0, 8)} ETH · 1,727,304 gas`);
  await expect(receipt("PQ validation")).toHaveText("1,120,597 gas (frame 0)");
  await expect(receipt("Admission")).toHaveText(/^(24\/24 checks · \w+|No longer held by the mempool)$/);
  await expect(receipt("Nonce")).toHaveText("6");
  await expect(link(DEMO_SWAP)).toHaveAttribute("href", `${EXPLORER}tx/${DEMO_SWAP}?node=${nodeParam}`);
  expect(errors).toEqual([]);
});

test("exchange names the sponsor and its fee when the server has one", async ({ page }) => {
  const errors = watchErrors(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  // Same operator-less dev server; only the browser's view of /api/config gains a sponsor. Nothing is signed.
  await page.route("**/api/config", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...((await response.json()) as PublicConfig), sponsor: SPONSOR, operatorReady: true } });
  });
  const config = await openApp(page);
  expect(config.sponsor).toBe(SPONSOR);
  const engraved = page.waitForRequest((r) => r.url().endsWith("/api/account") && r.method() === "POST");
  await page.getByRole("button", { name: "Create wallet" }).click();
  const { publicKey } = (await engraved).postDataJSON() as { publicKey: Hex };
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
    backedUp: true,
  };
  await page.evaluate((value) => localStorage.setItem("qsw.wallet.v1", value), JSON.stringify(record));
  await page.reload();
  await page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: "Exchange" }).click();

  const fee = formatEther(1_730_000n * BigInt(config.fees.maxPriorityFeePerGas)).slice(0, 7);
  await expect(termRow(page, "Network fee")).toHaveText(`Sponsored · ≈${fee} ETH paid by 0xb7Ca…52c1`);
  await page.getByLabel("You pay").fill("1");
  await expect(page.getByRole("button", { name: "Not enough dUSDC" })).toBeDisabled();
  // WETH -> dUSDC within the demo account's WETH balance unlocks signing (not clicked).
  await page.getByLabel("You pay").fill("");
  await page.getByRole("button", { name: "Swap direction" }).click();
  await page.getByLabel("You pay").fill("0.0001");
  await expect(page.locator(".recv .amt")).not.toHaveText("0");
  await expect(page.locator(".frl .fr .fd").nth(2)).toHaveText("Approve 0.0001 WETH for Permit2");
  await expect(page.getByRole("button", { name: "Sign", exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});
