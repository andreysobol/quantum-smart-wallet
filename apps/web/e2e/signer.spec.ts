// Real-browser proof of the signer: WASM in a module worker, SLH-DSA sign/verify with the
// account context, passphrase backups, and no secret key ever posted to the main thread.
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { Hex } from "../shared/types.js";
import type { BackupFile, KeyMeta } from "../src/crypto/types.js";

const PASS = "correct horse battery staple";
const WRONG = "correct horse battery stapler";
const META: KeyMeta = {
  chainId: 81411338,
  account: "0x8F3a1c2B4d5E6f708192a3B4c5D6e7F809a1B2c3",
  factory: "0x00000000000000000000000000000000000000f1",
  salt: `0x${"11".repeat(32)}`,
};

async function openHarness(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/signer.html");
  await expect(page.locator("#status")).toHaveText("ready");
  return errors;
}

const randomDigest = (): Hex => `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`;

function flipCiphertextBit(backup: BackupFile): BackupFile {
  const bytes = Buffer.from(backup.cipher.ciphertext, "base64");
  bytes[10] = (bytes[10] ?? 0) ^ 1;
  return { ...backup, cipher: { ...backup.cipher, ciphertext: bytes.toString("base64") } };
}

test("loads the SLH-DSA WebAssembly inside a module worker", async ({ page }) => {
  const errors = await openHarness(page);
  const wasm: string[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.endsWith(".wasm")) wasm.push(`${response.status()} ${response.headers()["content-type"]}`);
  });
  const created = page.waitForEvent("worker");
  await page.evaluate(() => window.harness.signer.ready());
  const worker = await created;

  expect(worker.url()).toMatch(/signer\.worker[^/]*\.js$/);
  expect(await page.evaluate(() => window.harness.log.spawned)).toEqual([
    { url: expect.stringMatching(/signer\.worker/), type: "module" },
  ]);
  // importScripts() is a no-op in classic workers but throws a TypeError in module workers.
  const kind = await worker.evaluate(() => {
    try {
      (self as unknown as { importScripts(): void }).importScripts();
      return "classic";
    } catch (error) {
      return (error as Error).name;
    }
  });
  expect(kind).toBe("TypeError");
  expect(wasm).toEqual(["200 application/wasm"]);
  expect(errors).toEqual([]);
});

test("generates a key and signs a 32-byte digest that verifies under the account context", async ({ page }) => {
  const errors = await openHarness(page);
  const digest = randomDigest();
  const flipped = `${digest.slice(0, -1)}${digest.endsWith("0") ? "1" : "0"}` as Hex;

  const result = await page.evaluate(
    async ({ digest, flipped }) => {
      const { signer, verifyOnMainThread, outcome } = window.harness;
      const { publicKey, ms: keygenMs } = await signer.generate();
      const { signature, ms } = await signer.sign(publicKey, digest);
      return {
        publicKey,
        keygenMs,
        ms,
        hasKey: await signer.hasKey(publicKey),
        signatureBytes: (signature.length - 2) / 2,
        valid: await verifyOnMainThread(publicKey, digest, signature),
        emptyContext: await verifyOnMainThread(publicKey, digest, signature, ""),
        otherDigest: await verifyOnMainThread(publicKey, flipped, signature),
        shortDigest: await outcome(signer.sign(publicKey, "0x1234")),
        unknownKey: await outcome(signer.sign(`0x${"ab".repeat(32)}`, digest)),
      };
    },
    { digest, flipped },
  );

  expect(result.publicKey).toMatch(/^0x[0-9a-f]{64}$/);
  expect(result.hasKey).toBe(true);
  expect(result.signatureBytes).toBe(7856);
  expect(result.valid).toBe(true);
  expect(result.emptyContext).toBe(false);
  expect(result.otherDigest).toBe(false);
  expect(result.ms).toBeGreaterThan(0);
  expect(result.keygenMs).toBeGreaterThan(0);
  expect(result.shortDigest).toMatchObject({ ok: false, name: "SignerError", code: "internal" });
  expect(result.unknownKey).toMatchObject({ ok: false, name: "SignerError", code: "no_key" });
  expect(errors).toEqual([]);
});

test("backup export -> file -> verify -> import round trip; wrong passphrase rejected; secret never leaves the worker", async ({
  page,
}) => {
  const errors = await openHarness(page);

  const { publicKey, backup } = await page.evaluate(
    async ({ meta, pass }) => {
      const { signer } = window.harness;
      const { publicKey } = await signer.generate();
      await signer.setMeta(publicKey, meta);
      return { publicKey, backup: await signer.exportBackup(publicKey, pass) };
    },
    { meta: META, pass: PASS },
  );
  expect(backup).toMatchObject({
    format: "quantum-smart-wallet-backup",
    version: 1,
    algorithm: "SLH-DSA-SHA2-128s",
    context: "QuantumSmartWallet/SLH-DSA-SHA2-128s/v1",
    publicKey,
    meta: META,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: 600_000 },
    cipher: { name: "AES-GCM" },
  });

  // Save through the real download flow, then choose the file again like a user would.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.evaluate((file) => window.harness.downloadBackup(file), backup),
  ]);
  expect(download.suggestedFilename()).toBe("qsw-backup-0x8f3a1c2b.json");
  const savedPath = await download.path();
  expect(JSON.parse(readFileSync(savedPath, "utf8"))).toEqual(backup);
  await page.setInputFiles("#backup-file", savedPath);
  const reread = await page.evaluate(() => window.harness.readSelectedFile());
  expect(reread).toEqual(backup);

  const digest = randomDigest();
  const checks = await page.evaluate(
    async ({ file, tampered, publicKey, pass, wrong, digest }) => {
      const { signer, outcome, verifyOnMainThread } = window.harness;
      const other = `0x${"cd".repeat(32)}` as const;
      const result = {
        verified: await signer.verifyBackup(file, pass, publicKey),
        otherKey: await signer.verifyBackup(file, pass, other),
        wrongPassphrase: await outcome(signer.verifyBackup(file, wrong, publicKey)),
        tampered: await outcome(signer.verifyBackup(tampered, pass, publicKey)),
        shortExportPassphrase: await outcome(signer.exportBackup(publicKey, "short12")),
        forgotten: await signer.forget(publicKey).then(() => signer.hasKey(publicKey)),
        signWithoutKey: await outcome(signer.sign(publicKey, digest)),
        importWrong: await outcome(signer.importBackup(file, wrong)),
        hasKeyAfterWrongImport: await signer.hasKey(publicKey),
        imported: await signer.importBackup(file, pass),
        hasKeyAfterImport: await signer.hasKey(publicKey),
        signatureValid: false,
      };
      const { signature } = await signer.sign(publicKey, digest);
      result.signatureValid = await verifyOnMainThread(publicKey, digest, signature);
      return result;
    },
    { file: reread, tampered: flipCiphertextBit(reread), publicKey, pass: PASS, wrong: WRONG, digest },
  );

  expect(checks.verified).toBe(true);
  expect(checks.otherKey).toBe(false);
  expect(checks.wrongPassphrase).toMatchObject({ ok: false, name: "SignerError", code: "bad_passphrase" });
  expect(checks.tampered).toMatchObject({ ok: false, code: "bad_passphrase" });
  expect(checks.shortExportPassphrase).toMatchObject({ ok: false, code: "bad_passphrase" });
  expect(checks.forgotten).toBe(false);
  expect(checks.signWithoutKey).toMatchObject({ ok: false, code: "no_key" });
  expect(checks.importWrong).toMatchObject({ ok: false, code: "bad_passphrase" });
  expect(checks.hasKeyAfterWrongImport).toBe(false);
  expect(checks.imported).toEqual({ publicKey, meta: META });
  expect(checks.hasKeyAfterImport).toBe(true);
  expect(checks.signatureValid).toBe(true);

  // A malformed file is refused before anything reaches the worker.
  await page.setInputFiles("#backup-file", {
    name: "notes.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ format: "something-else" })),
  });
  const malformed = await page.evaluate(() => window.harness.outcome(window.harness.readSelectedFile()));
  expect(malformed).toMatchObject({ ok: false, name: "SignerError", code: "bad_backup" });

  // Learn the real secret (test-only main-thread decryption), then search every worker message for it.
  const leak = await page.evaluate(
    async ({ file, pass }) => {
      const { revealBackupSecret, scanForSecret, log } = window.harness;
      const { secretSeedHex, derivedPublicKey } = await revealBackupSecret(file, pass);
      return {
        derivedPublicKey,
        scan: scanForSecret(secretSeedHex),
        ops: log.sent.map((message) => (message as { op: string }).op),
        responseKeys: log.received.map((message) => Object.keys(message as object).sort().join(",")),
      };
    },
    { file: backup, pass: PASS },
  );
  expect(leak.derivedPublicKey).toBe(publicKey);
  expect(new Set(leak.ops)).toEqual(
    new Set(["generate", "setMeta", "exportBackup", "verifyBackup", "forget", "hasKey", "sign", "importBackup"]),
  );
  expect(leak.scan.received.messages).toBe(leak.ops.length);
  expect(leak.scan.received.strings).toBeGreaterThan(0);
  expect(leak.scan.received).toMatchObject({ binaries: 0, hits: [] });
  expect(leak.scan.sent).toMatchObject({ binaries: 0, hits: [] });
  for (const keys of leak.responseKeys) expect(["id,ok,result", "error,id,ok"]).toContain(keys);
  expect(errors).toEqual([]);
});
