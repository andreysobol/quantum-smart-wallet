/**
 * Read-only Devnet ENSv2 smoke against the shared devnet; run with QSW_LIVE_READ=1.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkNames, loadNames, loadVault, quoteName, type EnsConfig } from "../src/chain/ens.js";
import { parseEnsSection } from "../server/ens.js";
import { CONFIG, DEMO } from "./chain.fixtures.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const manifest: any = JSON.parse(readFileSync(new URL("../../../slhsol/deployments/shared-devnet.json", import.meta.url), "utf8"));
const config: EnsConfig = { ...CONFIG, ens: parseEnsSection(manifest.ens) };
const unused = `nobody-${"x".repeat(12)}`;

describe.skipIf(!process.env.QSW_LIVE_READ)("live devnet names", () => {
  it("quotes an unregistered name at 5 dUSDC per year", async () => {
    const quote = await quoteName(config, DEMO, unused, 2);
    expect(quote).toMatchObject({ name: `${unused}.qsw.eth`, available: true, price: 10_000_000n });
  }, 60_000);

  it("predicts the demo account's vault and its resolver", async () => {
    const vault = await loadVault(config, DEMO);
    expect(vault.vault).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(vault.resolver).not.toBe(vault.vault);
    const names = await loadNames(config, DEMO);
    if (!vault.deployed) expect(names.names).toEqual([]);
  }, 60_000);

  it("does not verify an unregistered name", async () => {
    const vault = await loadVault(config, DEMO);
    const [status] = await checkNames(config, DEMO, vault.vault, [unused]);
    expect(status).toMatchObject({ registered: false, owner: null, resolvesTo: null, verified: false });
  }, 60_000);
});
