// Live run on the shared devnet through the real UI (opt-in: QSW_LIVE=1, see playwright.live.config.ts):
// WASM key in the worker -> factory account with operator-funded stake -> verified backup -> faucet mint ->
// sponsored dUSDC->WETH swap -> sponsored WETH->dUSDC swap. Every UI claim is cross-checked on chain.
import { expect, test, type Page } from "@playwright/test";
import { encodeFunctionData, erc20Abi } from "viem";
import { factoryAbi } from "../shared/abis.js";
import { rpcBatch, rpcCall } from "../shared/rpc.js";
import type { Address, Hex, PublicConfig } from "../shared/types.js";

const OPERATOR: Address = "0xb7ca4c821205f6721bacbd48052bebf6a1f252c1";
const PASS = "live correct horse battery";

test.skip(!process.env.QSW_LIVE, "set QSW_LIVE=1 to spend devnet operator funds on a live run");
test.describe.configure({ mode: "serial" });

interface Receipt {
  status: string;
  type: string;
  payer?: string;
  blockNumber: string;
  frameReceipts?: { status: string; gasUsed?: string }[];
}

async function read(config: PublicConfig, account: Address) {
  const balanceOf = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [account] });
  const isAccount = encodeFunctionData({ abi: factoryAbi, functionName: "isAccount", args: [account] });
  const [eth, usdc, weth, registered] = await rpcBatch(config.rpcUrl, [
    { method: "eth_getBalance", params: [account, "latest"] },
    { method: "eth_call", params: [{ to: config.contracts.demoUSDC, data: balanceOf }, "latest"] },
    { method: "eth_call", params: [{ to: config.contracts.weth9, data: balanceOf }, "latest"] },
    { method: "eth_call", params: [{ to: config.contracts.accountFactory, data: isAccount }, "latest"] },
  ]);
  const big = (r: (typeof eth)) => {
    if (!r?.ok) throw r?.error ?? new Error("missing RPC result");
    return BigInt(r.result as string);
  };
  return { eth: big(eth), usdc: big(usdc), weth: big(weth), registered: big(registered) === 1n };
}

async function receiptOf(config: PublicConfig, hash: Hex): Promise<Receipt> {
  for (let i = 0; i < 60; i++) {
    const receipt = await rpcCall<Receipt | null>(config.rpcUrl, "eth_getTransactionReceipt", [hash]);
    if (receipt) return receipt;
    await new Promise((done) => setTimeout(done, 2_000));
  }
  throw new Error(`no receipt for ${hash}`);
}

/** Alternative-mempool admission for a frame transaction: outcome and check verdicts. */
async function admissionOf(config: PublicConfig, hash: Hex) {
  for (let i = 0; i < 45; i++) {
    const detail = await rpcCall<{ admission?: { outcome?: string; checks?: { rule: string; verdict: string }[] } } | null>(
      config.mempoolUrl,
      "skandha_explorer_getTransaction",
      [hash],
    ).catch(() => null);
    if (detail?.admission?.outcome === "included") return detail.admission;
    await new Promise((done) => setTimeout(done, 1_000));
  }
  throw new Error(`mempool never reported inclusion for ${hash}`);
}

/** Sign on the Exchange and wait for the Proof screen to finish; returns the transaction hash. */
async function swap(page: Page): Promise<Hex> {
  const sign = page.getByRole("button", { name: "Sign", exact: true });
  await expect(sign).toBeEnabled({ timeout: 90_000 });
  const sponsored = page.waitForResponse((r) => r.url().endsWith("/api/sponsor"), { timeout: 120_000 });
  await sign.click();
  const response = await sponsored;
  const body = (await response.json()) as { txHash?: Hex; error?: { message: string } };
  expect(response.status(), body.error?.message).toBe(200);
  await expect(page.getByRole("heading", { name: "Proof", exact: true })).toBeVisible();
  await expect(page.locator(".p-title")).toHaveText("Verified", { timeout: 240_000 });
  await expect(page.locator(".pfl .pf .pf-s")).toHaveText(["Approved", "Approved", "Done", "Done", "Done"]);
  return body.txHash as Hex;
}

async function expectSponsoredSuccess(config: PublicConfig, account: Address, hash: Hex) {
  const receipt = await receiptOf(config, hash);
  expect(receipt.status).toBe("0x1");
  expect(receipt.type).toBe("0x6");
  expect(receipt.payer?.toLowerCase()).toBe(OPERATOR);
  expect(receipt.frameReceipts?.map((f) => f.status)).toEqual(["0x1", "0x1", "0x1", "0x1", "0x1"]);
  // Frame 0 is the account's VERIFY frame: the on-chain SLH-DSA verification.
  expect(BigInt(receipt.frameReceipts?.[0]?.gasUsed ?? "0x0")).toBeGreaterThan(500_000n);
  const admission = await admissionOf(config, hash);
  expect(admission.checks?.length).toBeGreaterThan(0);
  expect(admission.checks?.every((check) => check.verdict === "pass")).toBe(true);
  expect((await read(config, account)).eth).toBe(0n);
  return receipt;
}

test("create a factory account, verify its backup, mint test dUSDC and swap both ways with sponsored gas", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const configResponse = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/config");
  await page.goto("/");
  const config = (await (await configResponse).json()) as PublicConfig;
  expect(config.operatorReady).toBe(true);
  expect(config.sponsor?.toLowerCase()).toBe(OPERATOR);

  // 1. Key in the worker, account through the factory (operator funds the stake), on-chain confirmation.
  const created = page.waitForResponse((r) => r.url().endsWith("/api/account"), { timeout: 120_000 });
  await page.getByRole("button", { name: "Create wallet" }).click();
  const createResponse = await created;
  const account = (await createResponse.json()) as { account: Address; txHash: Hex | null; created: boolean; error?: unknown };
  expect(createResponse.status(), JSON.stringify(account.error ?? null)).toBe(200);
  expect(account.created).toBe(true);
  await expect(page.getByRole("heading", { name: "Your seal", exact: true })).toBeVisible({ timeout: 120_000 });
  const fresh = await read(config, account.account);
  expect(fresh).toMatchObject({ registered: true, eth: 0n, usdc: 0n, weth: 0n });
  const createReceipt = await receiptOf(config, account.txHash as Hex);
  expect(createReceipt.status).toBe("0x1");
  test.info().annotations.push({ type: "account", description: account.account }, { type: "create tx", description: String(account.txHash) });

  // 2. Straight to the portfolio, then a verified backup from its link.
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator(".v-grid")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Back up your key" }).click();
  await page.getByLabel("Passphrase", { exact: true }).fill(PASS);
  await page.getByLabel("Repeat passphrase").fill(PASS);
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download backup" }).click();
  const download = await downloading;
  const backupPath = test.info().outputPath("backup.json");
  await download.saveAs(backupPath);
  await expect(page.getByRole("heading", { name: "Check", exact: true })).toBeVisible();
  const choosing = page.waitForEvent("filechooser");
  await page.getByText("Choose file").click();
  await (await choosing).setFiles(backupPath);
  await page.getByLabel("Backup passphrase").fill(PASS);
  await page.getByRole("button", { name: "Seal backup" }).click();
  await expect(page.locator(".stamp .st1")).toHaveText("Sealed");
  await expect(page.locator(".v-grid")).toBeVisible({ timeout: 30_000 });

  // 3. Faucet: operator mints test dUSDC to the registered account.
  const faucet = page.waitForResponse((r) => r.url().endsWith("/api/faucet"), { timeout: 120_000 });
  await page.getByRole("button", { name: /^Get .* test dUSDC$/ }).click();
  const faucetResponse = await faucet;
  const minted = (await faucetResponse.json()) as { amount: string; txHash: Hex; error?: unknown };
  expect(faucetResponse.status(), JSON.stringify(minted.error ?? null)).toBe(200);
  await expect(page.getByRole("status").filter({ hasText: /^Received [\d,.]+ dUSDC\.$/ })).toBeVisible({ timeout: 60_000 });
  const funded = await read(config, account.account);
  expect(funded.usdc).toBe(BigInt(minted.amount));
  test.info().annotations.push({ type: "faucet tx", description: minted.txHash });

  // 4. Sponsored dUSDC -> WETH swap.
  const nav = page.getByRole("navigation", { name: "Sections" });
  await nav.getByRole("button", { name: "Exchange" }).click();
  await expect(page.locator(".x-grid")).toBeVisible();
  await page.getByLabel("You pay").fill("10");
  const buy = await swap(page);
  await expectSponsoredSuccess(config, account.account, buy);
  const afterBuy = await read(config, account.account);
  expect(afterBuy.usdc).toBe(funded.usdc - 10_000_000n);
  expect(afterBuy.weth).toBeGreaterThan(0n);
  await expect(page.locator(".rc > div").filter({ has: page.locator("dt", { hasText: "Result" }) }).locator("dd")).toContainText(
    "−10.00 dUSDC",
  );
  test.info().annotations.push({ type: "swap dUSDC->WETH", description: buy });

  // 5. Sponsored WETH -> dUSDC swap of everything received (first mined swap in this direction).
  await nav.getByRole("button", { name: "Exchange" }).click();
  await expect(page.locator(".x-grid")).toBeVisible();
  await page.getByRole("button", { name: "Swap direction" }).click();
  await page.getByRole("button", { name: "Max" }).click();
  const sell = await swap(page);
  await expectSponsoredSuccess(config, account.account, sell);
  const afterSell = await read(config, account.account);
  expect(afterSell.weth).toBe(0n);
  expect(afterSell.usdc).toBeGreaterThan(afterBuy.usdc);
  test.info().annotations.push({ type: "swap WETH->dUSDC", description: sell });

  // 6. Activity lists the swaps once the gateway index catches up.
  await nav.getByRole("button", { name: "Portfolio" }).click();
  await expect(page.locator(".lg-row .tt", { hasText: /^Swapped 10\.00 dUSDC → / })).toBeVisible({ timeout: 90_000 });

  expect(errors).toEqual([]);
  console.log(JSON.stringify({ account: account.account, create: account.txHash, faucet: minted.txHash, buy, sell }));
});
