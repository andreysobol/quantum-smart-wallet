// Live Devnet ENSv2 registration through the real UI (opt-in: QSW_LIVE=1, see playwright.live.config.ts):
// new account -> faucet -> Names -> PQ-signed 6-frame registration, sponsored and sent through the
// alternative mempool. Every claim is cross-checked on chain: the dUSDC payment, the vault as token owner,
// the account as the vault's controller, forward resolution through UniversalResolverV2, the receipt, the
// payer, PQ validation in frame 0 and the mempool's admission checks. Then the sponsor must refuse the taken
// name, a payment other than the registrar's quote and a forged signature.
import { expect, test } from "@playwright/test";
import { decodeFunctionResult, encodeFunctionData, erc20Abi, keccak256, stringToBytes, type Hex } from "viem";
import { buildRegisterTx, dnsEncode, nameNode, type EnsTxConfig } from "../shared/ens.js";
import { ensRegistryAbi, ensVaultAbi, ensVaultFactoryAbi, universalResolverAbi } from "../shared/ensAbis.js";
import { fromWire, toWire } from "../shared/frameTx.js";
import { rpcCall } from "../shared/rpc.js";
import type { Address, PublicConfig, WireFrameTx } from "../shared/types.js";

const OPERATOR: Address = "0xb7ca4c821205f6721bacbd48052bebf6a1f252c1";
const ADDR_ABI = [{ type: "function", name: "addr", stateMutability: "view", inputs: [{ name: "node", type: "bytes32" }], outputs: [{ name: "", type: "address" }] }] as const;

test.skip(!process.env.QSW_LIVE, "set QSW_LIVE=1 to spend devnet operator funds on a live run");

interface FrameReceipt {
  status: string;
  gasUsed?: unknown;
}
interface Receipt {
  status: string;
  type: string;
  payer?: string;
  blockNumber: string;
  frameReceipts?: FrameReceipt[];
}

const call = async (config: PublicConfig, to: Address, data: Hex) => rpcCall<Hex>(config.rpcUrl, "eth_call", [{ to, data }, "latest"]);

async function usdcOf(config: PublicConfig, owner: Address): Promise<bigint> {
  return BigInt(await call(config, config.contracts.demoUSDC, encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [owner] })));
}

async function receiptOf(config: PublicConfig, hash: Hex): Promise<Receipt> {
  for (let i = 0; i < 60; i++) {
    const receipt = await rpcCall<Receipt | null>(config.rpcUrl, "eth_getTransactionReceipt", [hash]);
    if (receipt) return receipt;
    await new Promise((done) => setTimeout(done, 2_000));
  }
  throw new Error(`no receipt for ${hash}`);
}

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

test("register a devnet name to the account's vault and resolve it to the account", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const configResponse = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/config");
  await page.goto("/");
  const config = (await (await configResponse).json()) as PublicConfig;
  expect(config.operatorReady).toBe(true);
  const ens = config.ens!;
  expect(ens).toMatchObject({ label: "Devnet ENSv2", namespace: "qsw.eth" });

  // 1. A fresh factory account (operator-funded stake), straight to the portfolio, then test dUSDC.
  const created = page.waitForResponse((r) => r.url().endsWith("/api/account"), { timeout: 120_000 });
  await page.getByRole("button", { name: "Create wallet" }).click();
  const account = (await (await created).json()) as { account: Address; txHash: Hex };
  await expect(page.getByRole("heading", { name: "Your seal", exact: true })).toBeVisible({ timeout: 120_000 });
  await page.getByRole("button", { name: "Continue" }).click();
  const faucet = page.waitForResponse((r) => r.url().endsWith("/api/faucet"), { timeout: 120_000 });
  await page.getByRole("button", { name: /^Get .* test dUSDC$/ }).click();
  expect((await faucet).status()).toBe(200);
  await expect(page.getByRole("status").filter({ hasText: /^Received [\d,.]+ dUSDC\.$/ })).toBeVisible({ timeout: 60_000 });

  // 2. Register a fresh name for one year from the Names section.
  const label = `qsw${Date.now().toString(36)}`;
  const name = `${label}.${ens.namespace}`;
  await page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: "Names" }).click();
  await expect(page.getByLabel("Name", { exact: true })).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill(label.toUpperCase());
  await expect(page.locator("#ens-status")).toHaveText(`${name} is available (normalized)`, { timeout: 30_000 });
  const before = { account: await usdcOf(config, account.account), beneficiary: await usdcOf(config, OPERATOR) };
  const requested = page.waitForRequest((r) => r.url().endsWith("/api/sponsor"), { timeout: 120_000 });
  const sponsored = page.waitForResponse((r) => r.url().endsWith("/api/sponsor"), { timeout: 180_000 });
  await page.getByRole("button", { name: `Register ${name}` }).click();
  const request = (await requested).postDataJSON() as { tx: WireFrameTx; kind: string };
  expect(request.kind).toBe("ens-register");
  const response = await sponsored;
  const body = (await response.json()) as { txHash?: Hex; error?: { message: string } };
  expect(response.status(), body.error?.message).toBe(200);
  const hash = body.txHash as Hex;
  await expect(page.getByText(`${name} is held by your vault and resolves to your account`)).toBeVisible({ timeout: 240_000 });

  // 3. On chain: receipt, payer, PQ validation, admission.
  const receipt = await receiptOf(config, hash);
  console.log(JSON.stringify({ frameGas: receipt.frameReceipts?.map((f) => f.gasUsed) }));
  expect(receipt.status).toBe("0x1");
  expect(receipt.type).toBe("0x6");
  expect(receipt.payer?.toLowerCase()).toBe(OPERATOR);
  expect(receipt.frameReceipts?.map((f) => f.status)).toEqual(["0x1", "0x1", "0x1", "0x1", "0x1", "0x1"]);
  const frame0 = receipt.frameReceipts?.[0]?.gasUsed as { execution?: string } | string | undefined;
  expect(BigInt(typeof frame0 === "string" ? frame0 : (frame0?.execution ?? "0x0"))).toBeGreaterThan(500_000n);
  const admission = await admissionOf(config, hash);
  expect(admission.checks?.every((check) => check.verdict === "pass")).toBe(true);

  // 4. Payment: exactly one year's price from the account to the registrar's beneficiary.
  const price = BigInt(ens.pricePerYear);
  expect(await usdcOf(config, account.account)).toBe(before.account - price);
  expect(await usdcOf(config, OPERATOR)).toBe(before.beneficiary + price);

  // 5. Ownership: the account's vault holds the token; the account controls the vault; the vault's resolver.
  const vault = decodeFunctionResult({
    abi: ensVaultFactoryAbi,
    functionName: "vaultAddress",
    data: await call(config, ens.vaultFactory, encodeFunctionData({ abi: ensVaultFactoryAbi, functionName: "vaultAddress", args: [account.account] })),
  });
  const state = decodeFunctionResult({
    abi: ensRegistryAbi,
    functionName: "getState",
    data: await call(config, ens.qswRegistry, encodeFunctionData({ abi: ensRegistryAbi, functionName: "getState", args: [BigInt(keccak256(stringToBytes(label)))] })),
  });
  expect(state.status).toBe(2);
  expect(state.latestOwner.toLowerCase()).toBe(vault.toLowerCase());
  expect(state.latestOwner.toLowerCase()).not.toBe(account.account.toLowerCase());
  expect(state.latestOwner.toLowerCase()).not.toBe(OPERATOR);
  const controller = decodeFunctionResult({ abi: ensVaultAbi, functionName: "CONTROLLER", data: await call(config, vault, encodeFunctionData({ abi: ensVaultAbi, functionName: "CONTROLLER" })) });
  expect(controller.toLowerCase()).toBe(account.account.toLowerCase());
  const resolver = decodeFunctionResult({ abi: ensVaultAbi, functionName: "RESOLVER", data: await call(config, vault, encodeFunctionData({ abi: ensVaultAbi, functionName: "RESOLVER" })) });
  const registeredResolver = decodeFunctionResult({
    abi: ensRegistryAbi,
    functionName: "getResolver",
    data: await call(config, ens.qswRegistry, encodeFunctionData({ abi: ensRegistryAbi, functionName: "getResolver", args: [label] })),
  });
  expect(registeredResolver.toLowerCase()).toBe(resolver.toLowerCase());

  // 6. Resolution through the official UniversalResolverV2.
  const [result, usedResolver] = decodeFunctionResult({
    abi: universalResolverAbi,
    functionName: "resolve",
    data: await call(
      config,
      ens.universalResolver,
      encodeFunctionData({ abi: universalResolverAbi, functionName: "resolve", args: [dnsEncode(name), encodeFunctionData({ abi: ADDR_ABI, functionName: "addr", args: [nameNode(name)] })] }),
    ),
  });
  expect(usedResolver.toLowerCase()).toBe(resolver.toLowerCase());
  expect(decodeFunctionResult({ abi: ADDR_ABI, functionName: "addr", data: result }).toLowerCase()).toBe(account.account.toLowerCase());

  // 7. The wallet shows the verified name: receipt, list, header and portfolio.
  await expect(page.locator(".rc > div").filter({ has: page.locator("dt", { hasText: "Token owner" }) }).locator("dd")).toContainText(`Vault ${vault.slice(0, 6)}`);
  await expect(page.locator(".lg-row").filter({ hasText: name })).toContainText("Verified · held by your vault");
  await expect(page.locator(".acct .mono")).toHaveText(name, { timeout: 90_000 });
  await page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: "Portfolio" }).click();
  await expect(page.locator(".v-acct .ensn")).toHaveText(name);

  // 8. Taken names are refused by the UI and by the sponsor.
  await page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: "Names" }).click();
  await page.getByRole("button", { name: "Register another name" }).click();
  await page.getByLabel("Name", { exact: true }).fill(label);
  await expect(page.locator("#ens-status")).toHaveText(`${name} is taken`, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Name taken" })).toBeDisabled();

  const signed = fromWire(request.tx);
  const nonce = BigInt(await rpcCall<Hex>(config.rpcUrl, "eth_getTransactionCount", [account.account, "latest"]));
  const sponsor = (await (await page.request.get("/api/config")).json()) as PublicConfig;
  const sponsorPost = async (tx: WireFrameTx) => {
    const res = await page.request.post("/api/sponsor", { data: { tx, kind: "ens-register" } });
    return { status: res.status(), error: ((await res.json()) as { error?: { code: string; message: string } }).error };
  };
  const txConfig: EnsTxConfig = { chainId: config.chainId, sponsor: sponsor.sponsor, ens };
  const base = { config: txConfig, account: account.account, nonce, years: 1, vault, resolver };
  const withPq = (tx: ReturnType<typeof buildRegisterTx>) => toWire({ ...tx, signatures: tx.signatures.map((s, i) => (i === 0 ? signed.signatures[0]! : s)) });

  const taken = await sponsorPost(withPq(buildRegisterTx({ ...base, label, price })));
  expect(taken).toMatchObject({ status: 422, error: { code: "policy_rejected", message: `${name} is already registered.` } });
  const fresh = `${label}x`;
  const underpaid = await sponsorPost(withPq(buildRegisterTx({ ...base, label: fresh, price: price - 1n })));
  expect(underpaid).toMatchObject({ status: 422, error: { message: expect.stringContaining("quoted price of 5000000") } });
  const forged = await sponsorPost(withPq(buildRegisterTx({ ...base, label: fresh, price })));
  expect(forged).toMatchObject({ status: 422, error: { code: "invalid_signature" } });
  const replay = await sponsorPost(request.tx);
  expect(replay).toMatchObject({ status: 422, error: { message: expect.stringContaining("does not match the account nonce") } });

  expect(errors).toEqual([]);
  console.log(JSON.stringify({ account: account.account, create: account.txHash, name, vault, resolver, register: hash }));
});
