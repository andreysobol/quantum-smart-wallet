// Headless-browser tests: the TypeScript API (dist/) runs rslh compiled to WebAssembly
// in Chromium; results are cross-checked against the native rslh CLI.
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, ".."); // slhts
const CLI = resolve(ROOT, "../rslh/target/release/rslh");
const ORIGIN = "http://rslh.test";
const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
};

declare global {
  interface Window {
    rslh: typeof import("../src/index");
  }
}

/** Serve slhts from disk at ORIGIN (no web server needed) and load the test page. */
async function openPage(page: Page) {
  page.on("pageerror", (e) => console.error("page error:", e));
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const file = join(ROOT, path === "/" ? "test/index.html" : path);
    try {
      await route.fulfill({ body: readFileSync(file), contentType: TYPES[extname(file)] });
    } catch {
      await route.fulfill({ status: 404 });
    }
  });
  await page.goto(`${ORIGIN}/`);
  await expect(page.locator("#status")).toHaveText("ready");
}

const cli = (...args: string[]) => execFileSync(CLI, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

test.beforeEach(async ({ page }) => openPage(page));

test("exposes sizes and algorithm names", async ({ page }) => {
  const r = await page.evaluate(() => ({
    sizes: window.rslh.sizes(),
    sha2: window.rslh.algorithmName("sha2"),
    shake: window.rslh.algorithmName("shake"),
  }));
  expect(r.sizes).toEqual({ secretKey: 64, publicKey: 32, signature: 7856 });
  expect(r.sha2).toBe("SLH-DSA-SHA2-128s");
  expect(r.shake).toBe("SLH-DSA-SHAKE-128s");
});

for (const alg of ["sha2", "shake"] as const) {
  test(`${alg}: sign and verify in the browser, reject tampering`, async ({ page }) => {
    const r = await page.evaluate((alg) => {
      const { generateKeyPair, sign, verify } = window.rslh;
      const enc = new TextEncoder();
      const kp = generateKeyPair(alg);
      const msg = enc.encode("hello from the browser");
      const ctx = enc.encode("app");
      const sig = sign(alg, kp.secretKey, msg, { context: ctx });
      const flipped = sig.slice();
      flipped[1234] ^= 1;
      return {
        sigLen: sig.length,
        valid: verify(alg, kp.publicKey, msg, sig, ctx),
        badMessage: verify(alg, kp.publicKey, enc.encode("hello from the browseR"), sig, ctx),
        badContext: verify(alg, kp.publicKey, msg, sig, enc.encode("ap")),
        badSignature: verify(alg, kp.publicKey, msg, flipped, ctx),
      };
    }, alg);
    expect(r).toEqual({
      sigLen: 7856,
      valid: true,
      badMessage: false,
      badContext: false,
      badSignature: false,
    });
  });

  test(`${alg}: browser and native CLI agree`, async ({ page }) => {
    const dir = mkdtempSync(join(tmpdir(), "rslh-wasm-"));
    const seed = Array.from({ length: 48 }, (_, i) => i.toString(16).padStart(2, "0")).join("");
    const msgHex = Buffer.from("cross-check message").toString("hex");
    const ctxHex = "c0ffee";
    writeFileSync(join(dir, "msg"), Buffer.from(msgHex, "hex"));

    // Same seed => same keys; deterministic signature must be byte-identical.
    const out = await page.evaluate(
      ({ alg, seed, msgHex, ctxHex }) => {
        const { keyPairFromSeed, generateKeyPair, sign, toHex, fromHex } = window.rslh;
        const kp = keyPairFromSeed(alg, fromHex(seed));
        const det = sign(alg, kp.secretKey, fromHex(msgHex), {
          context: fromHex(ctxHex),
          deterministic: true,
        });
        const fresh = generateKeyPair(alg);
        const hedged = sign(alg, fresh.secretKey, fromHex(msgHex), { context: fromHex(ctxHex) });
        return {
          pk: toHex(kp.publicKey),
          det: toHex(det),
          freshPk: toHex(fresh.publicKey),
          hedged: toHex(hedged),
        };
      },
      { alg, seed, msgHex, ctxHex },
    );

    cli("keygen", "--alg", alg, "--seed", seed, "--sk", join(dir, "sk.key"), "--pk", join(dir, "pk.pub"));
    expect(readFileSync(join(dir, "pk.pub"), "utf8").trim().split(":")[1]).toBe(out.pk);
    cli("sign", "--sk", join(dir, "sk.key"), "--in", join(dir, "msg"), "--sig", join(dir, "det.sig"),
      "--context-hex", ctxHex, "--deterministic");
    expect(readFileSync(join(dir, "det.sig")).toString("hex")).toBe(out.det);

    // Native CLI verifies the browser's hedged signature under a fresh browser key.
    writeFileSync(join(dir, "hedged.sig"), Buffer.from(out.hedged, "hex"));
    writeFileSync(join(dir, "fresh.raw"), Buffer.from(out.freshPk, "hex"));
    cli("import", "--raw", join(dir, "fresh.raw"), "--out", join(dir, "fresh.pub"), "--alg", alg);
    const verified = cli("verify", "--pk", join(dir, "fresh.pub"), "--in", join(dir, "msg"),
      "--sig", join(dir, "hedged.sig"), "--context-hex", ctxHex);
    expect(verified).toContain("signature VALID");
  });
}

test("sha2: native account digest matches the Solidity-tested signature", async ({ page }) => {
  const fixture = readFileSync(resolve(ROOT, "../slhsol/test/AccountVector.sol"), "utf8");
  const publicKey = fixture.match(/PUBLIC_KEY\s*=\s*hex"([0-9a-f]{64})"/i)?.[1];
  const digest = fixture.match(/DIGEST\s*=\s*hex"([0-9a-f]{64})"/i)?.[1];
  const context = fixture.match(/CONTEXT\s*=\s*"([^"]+)"/)?.[1];
  const signature = fixture.match(/return\s+hex"([0-9a-f]+)"/i)?.[1];
  if (!publicKey || !digest || !context || !signature) throw new Error("invalid AccountVector.sol fixture");
  expect(context).toBe("QuantumSmartWallet/SLH-DSA-SHA2-128s/v1");

  const out = await page.evaluate(
    ({ codecDigest, context }) => {
      const { keyPairFromSeed, fromHex, toHex, sign, verify } = window.rslh;
      const kp = keyPairFromSeed("sha2", Uint8Array.from({ length: 48 }, (_, i) => i));
      // The codec returns prefixed hex; sign the decoded digest, not its text.
      const message = fromHex(codecDigest.slice(2));
      const ctx = new TextEncoder().encode(context);
      const sig = sign("sha2", kp.secretKey, message, { context: ctx, deterministic: true });
      const sigHex = toHex(sig);
      return {
        digestBytes: message.length,
        publicKey: toHex(kp.publicKey),
        signatureBytes: sig.length,
        signature: sigHex,
        valid: verify("sha2", kp.publicKey, message, sig, ctx),
        wrongContext: verify("sha2", kp.publicKey, message, sig, new Uint8Array()),
        entry: { scheme: 0, signer: "0x", msg: "0x", signature: `0x${sigHex}` },
      };
    },
    { codecDigest: `0x${digest}`, context },
  );

  expect(out.digestBytes).toBe(32);
  expect(out.publicKey).toBe(publicKey);
  expect(out.signatureBytes).toBe(7856);
  expect(out.signature).toBe(signature);
  expect(out.valid).toBe(true);
  expect(out.wrongContext).toBe(false);
  expect(out.entry).toEqual({ scheme: 0, signer: "0x", msg: "0x", signature: `0x${signature}` });
});
