// The Names section on the operator-less dev server: the namespace is verified on the real devnet, names are
// normalized and quoted from the registrar, and the 6-frame plan names the vault as token owner and the
// account as controller. Nothing is signed or sent (this server has no sponsor).
// QSW_SHOTS_DIR=<dir> also writes desktop and phone screenshots.
import { expect, test, type Page } from "@playwright/test";
import { accountSalt } from "../shared/account.js";
import type { Address, Hex, PublicConfig } from "../shared/types.js";
import type { WalletRecord } from "../src/state/types.js";

const DEMO: Address = "0x19b17f47284db0b254c62eb9ad6ce95538e3bc30";
const SHOTS = process.env.QSW_SHOTS_DIR;

async function openDemoWallet(page: Page): Promise<PublicConfig> {
  await page.goto("/");
  const config = (await (await page.request.get("/api/config")).json()) as PublicConfig;
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
  return config;
}

test("names: devnet label, normalization, availability, price and the vault plan", async ({ page }) => {
  const config = await openDemoWallet(page);
  expect(config.ens).toMatchObject({ label: "Devnet ENSv2", namespace: "qsw.eth", pricePerYear: "5000000", maxYears: 5 });

  await page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: "Names" }).click();
  await expect(page.getByText("Devnet ENSv2 · chain 81411338 · these names do not reserve public .eth names")).toBeVisible();
  await expect(page.getByText("No names yet.", { exact: false })).toBeVisible({ timeout: 30_000 });

  const field = page.getByLabel("Name", { exact: true });
  const status = page.locator("#ens-status");
  await field.fill("a.b");
  await expect(status).toHaveText(/One label only/);
  await field.fill("ab_cd");
  await expect(status).toHaveText(/Not a valid ENS name/);

  const label = `Quantum${Date.now().toString(36)}`;
  await field.fill(label);
  await expect(status).toHaveText(`${label.toLowerCase()}.qsw.eth is available (normalized)`, { timeout: 30_000 });
  await expect(page.locator(".recv .amt")).toHaveText("5");
  await page.getByRole("group", { name: "Registration length" }).getByRole("button", { name: "3 yr" }).click();
  await expect(page.locator(".recv .amt")).toHaveText("15");

  const terms = page.locator(".terms .tbl");
  await expect(terms).toContainText("Token owner");
  await expect(terms).toContainText("Your name vault 0x");
  await expect(terms).toContainText("opened by this transaction");
  await expect(terms).toContainText(`Controller`);
  await expect(terms).toContainText(`Your account ${DEMO.slice(0, 6)}`);
  const frames = page.locator(".terms .frl .fd");
  await expect(frames).toHaveCount(6);
  await expect(frames.nth(3)).toHaveText("Approve 15 dUSDC to the registrar");
  await expect(frames.nth(4)).toHaveText(`Register ${label.toLowerCase()}.qsw.eth to your vault`);
  await expect(frames.nth(5)).toHaveText(`Point ${label.toLowerCase()}.qsw.eth at your account`);
  // No sponsor on this server: nothing can be signed.
  await expect(page.getByRole("button", { name: "Sponsor unavailable" })).toBeDisabled();

  if (SHOTS) {
    await page.screenshot({ path: `${SHOTS}/names-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${SHOTS}/names-phone.png`, fullPage: true });
  }
});
