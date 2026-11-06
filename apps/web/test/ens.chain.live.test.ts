/**
 * Read-only Devnet ENSv2 smoke against the shared devnet; run with QSW_LIVE_READ=1.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodeFunctionData, keccak256, stringToBytes, toFunctionSelector, type Address, type Hex } from "viem";
import { dnsEncode } from "../shared/ens.js";
import { ensVaultAbi, permissionedResolverAbi } from "../shared/ensAbis.js";
import { rpcCall } from "../shared/rpc.js";
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

  // Registered by the live run (e2e/names.live.spec.ts, tx 0xfcf79147…a7ab).
  const LIVE = {
    account: "0xc19245E98CAa3680179F81b8a0C8795810Cd5775" as Address,
    vault: "0xB6a82373C7531d4064e3A7DFE398aa4c02d7Ae36" as Address,
    resolver: "0x0515e5f0302569115102747af12641C0EE3086ED" as Address,
    label: "qswmw56wsx5",
    registerTx: "0xfcf79147e658857dca200fb97c7f6af3b440298340fa3ebf798745fa7012a7ab" as Hex,
  };
  const STRANGER = "0x000000000000000000000000000000000000dEaD" as Address;
  const OPERATOR = "0xb7Ca4C821205f6721bacbd48052bEbF6A1f252c1" as Address;
  const setText = encodeFunctionData({
    abi: permissionedResolverAbi,
    functionName: "setText",
    args: [dnsEncode(`${LIVE.label}.qsw.eth`), "description", "managed through the vault"],
  });
  const asCaller = (from: Address, to: Address, data: Hex) => rpcCall<Hex>(config.rpcUrl, "eth_call", [{ from, to, data }, "latest"]);

  it("verifies the live name: held by the vault, resolving to its account", async () => {
    const [status] = await checkNames(config, LIVE.account, LIVE.vault, [LIVE.label]);
    expect(status).toMatchObject({ registered: true, verified: true, resolvesTo: LIVE.account });
    expect(status?.owner?.toLowerCase()).toBe(LIVE.vault.toLowerCase());
  }, 60_000);

  it("lets only the controlling account manage the name through its vault", async () => {
    // Authorized: frame 5 of the live registration was the account calling vault.execute(resolver, setAddress(...)).
    const receipt = await rpcCall<{ from: string; frameReceipts: { status: string; logs: { address: string; topics: string[] }[] }[] }>(
      config.rpcUrl,
      "eth_getTransactionReceipt",
      [LIVE.registerTx],
    );
    expect(receipt.from.toLowerCase()).toBe(LIVE.account.toLowerCase());
    expect(receipt.frameReceipts[5]?.status).toBe("0x1");
    const executed = receipt.frameReceipts[5]?.logs.find((log) => log.address.toLowerCase() === LIVE.vault.toLowerCase());
    expect(executed?.topics).toEqual([
      keccak256(stringToBytes("Executed(address,bytes4)")),
      `0x${LIVE.resolver.slice(2).toLowerCase().padStart(64, "0")}`,
      `${toFunctionSelector("setAddress(bytes,uint256,bytes)")}${"0".repeat(56)}`,
    ]);
    // Unauthorized: the operator and any other caller are refused by the vault (UnauthorizedCaller).
    const execute = encodeFunctionData({ abi: ensVaultAbi, functionName: "execute", args: [LIVE.resolver, setText] });
    for (const stranger of [OPERATOR, STRANGER]) {
      await expect(asCaller(stranger, LIVE.vault, execute)).rejects.toMatchObject({ code: 3, message: expect.stringMatching(/reverted/) });
      // Nor can they write the vault's resolver directly: only the vault holds its roles.
      await expect(asCaller(stranger, LIVE.resolver, setText)).rejects.toMatchObject({ code: 3, message: expect.stringMatching(/reverted/) });
    }
  }, 60_000);
});
