// Deploy the Devnet ENSv2 namespace qsw.eth to the shared devnet (chain 81411338).
//
// Mirrors the official contracts-v2 V2Fixture (ContractNamer, VerifiableFactory, LabelStore, root and
// .eth PermissionedRegistry, GatewayProvider, UniversalResolverV2), then adds qsw.eth: its own
// PermissionedRegistry, the dUSDC SimpleSubnameRegistrar and the ENSVaultFactory. Every transaction uses
// the devnet's own eth_estimateGas (its state gas is not modelled by Forge). Re-running resumes: each step
// is skipped when the chain already shows its effect. Writes ensv2/deployments/shared-devnet.json and the
// `ens` section of slhsol/deployments/shared-devnet.json (the published manifest's source).
//
//   forge build && QSW_DEPLOYER_KEY_FILE=../.secrets/devnet-operator.json npm run deploy
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  http,
  isAddressEqual,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ENSV2 = new URL("../", import.meta.url);
const REPO = new URL("../", ENSV2);
const RECORD = new URL("deployments/shared-devnet.json", ENSV2);
const MANIFEST = new URL("slhsol/deployments/shared-devnet.json", REPO);
const KEY_FILE = process.env.QSW_DEPLOYER_KEY_FILE ?? new URL(".secrets/devnet-operator.json", REPO).pathname;

const CONTRACTS_V2 = {
  repository: "https://github.com/ensdomains/contracts-v2",
  tag: "v2-mainnet-deployment-1",
  commit: "62778d80038e50cb23514eab1b7d66ceb8a41e1c",
};
const NAMESPACE = { parent: "eth", label: "qsw", name: "qsw.eth" } as const;
const PRICE_PER_YEAR = 5_000_000n; // 5 dUSDC (6 decimals)
const MIN_DURATION = 365n * 24n * 60n * 60n;
const MAX_EXPIRY = (1n << 64n) - 1n;

// RegistryRolesLib
const R = {
  REGISTRAR: 1n << 0n,
  REGISTER_RESERVED: 1n << 4n,
  SET_PARENT: 1n << 8n,
  RENEW: 1n << 16n,
  SET_SUBREGISTRY: 1n << 20n,
  SET_RESOLVER: 1n << 24n,
  CAN_NAME: 1n << 120n,
};
const admin = (role: bigint) => role << 128n;
// V2Fixture._rootRegistryRootRoles / _ethRegistryRootRoles / _ethTokenRoles
const ROOT_REGISTRY_ROOT_ROLES =
  R.REGISTRAR | admin(R.REGISTRAR) | R.REGISTER_RESERVED | admin(R.REGISTER_RESERVED) | R.SET_PARENT |
  admin(R.SET_PARENT) | R.RENEW | admin(R.RENEW) | R.CAN_NAME | admin(R.CAN_NAME);
const ETH_REGISTRY_ROOT_ROLES =
  admin(R.REGISTRAR) | admin(R.REGISTER_RESERVED) | R.SET_PARENT | admin(R.SET_PARENT) | admin(R.RENEW) |
  R.CAN_NAME | admin(R.CAN_NAME);
const ETH_TOKEN_ROLES = R.SET_SUBREGISTRY | admin(R.SET_SUBREGISTRY) | R.SET_RESOLVER | admin(R.SET_RESOLVER);
// qsw.eth: the operator may only add registrars/renewers; it holds no role that can take or unregister a name.
const QSW_REGISTRY_ROOT_ROLES = admin(R.REGISTRAR) | admin(R.RENEW) | R.SET_PARENT;
// The qsw token in .eth gets no roles, so qsw.eth's subregistry and resolver stay as deployed.
const QSW_TOKEN_ROLES = 0n;
const REGISTRAR_ROLES = R.REGISTRAR | R.RENEW;

type Manifest = Record<string, unknown> & { accountFactory: string; demoUSDC: string; chainId: number; genesisHash: string; rpcUrl: string };
type Step = { hash: Hex; block: number };
type DeploymentRecord = {
  status: "deploying" | "ready";
  label: string;
  chainId: number;
  genesisHash: Hex;
  operator: Address;
  contractsV2: typeof CONTRACTS_V2;
  contracts: Record<string, Address>;
  transactions: Record<string, Step>;
};

const manifestText = readFileSync(MANIFEST, "utf8");
const manifest = JSON.parse(manifestText) as Manifest;
const rpcUrl = process.env.QSW_RPC_URL ?? manifest.rpcUrl;
const key = (JSON.parse(readFileSync(KEY_FILE, "utf8")) as { private_key: string }).private_key;
const operator = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex);
const chain = defineChain({
  id: manifest.chainId,
  name: "QSW shared devnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 60_000 }) });
const wallet = createWalletClient({ chain, account: operator, transport: http(rpcUrl, { timeout: 60_000 }) });

function artifact(name: string, file = name): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(readFileSync(new URL(`out/${file}.sol/${name}.json`, ENSV2), "utf8")) as {
    abi: Abi;
    bytecode: { object: Hex };
  };
  return { abi: json.abi, bytecode: json.bytecode.object };
}

const record: DeploymentRecord = existsSync(RECORD)
  ? (JSON.parse(readFileSync(RECORD, "utf8")) as DeploymentRecord)
  : {
      status: "deploying",
      label: "Devnet ENSv2 (not public .eth names)",
      chainId: manifest.chainId,
      genesisHash: manifest.genesisHash as Hex,
      operator: operator.address,
      contractsV2: CONTRACTS_V2,
      contracts: {},
      transactions: {},
    };

function save(): void {
  const tmp = new URL("shared-devnet.json.tmp", RECORD);
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, RECORD);
}

async function send(step: string, request: { to?: Address; data: Hex }): Promise<{ contractAddress: Address | null }> {
  const estimate = await client.estimateGas({ account: operator.address, to: request.to, data: request.data });
  const gas = (estimate * 6n) / 5n + 50_000n;
  const hash = await wallet.sendTransaction({ to: request.to ?? null, data: request.data, gas, chain });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`${step}: transaction ${hash} reverted`);
  record.transactions[step] = { hash, block: Number(receipt.blockNumber) };
  console.log(`  ${step}: ${hash} (block ${receipt.blockNumber}, gas ${receipt.gasUsed})`);
  return { contractAddress: receipt.contractAddress ? getAddress(receipt.contractAddress) : null };
}

async function deploy(name: string, contract: string, args: unknown[] = [], file?: string): Promise<Address> {
  const existing = record.contracts[name];
  if (existing && (await client.getCode({ address: existing }))?.length) {
    console.log(`  ${name}: ${existing} (deployed)`);
    return existing;
  }
  const { abi, bytecode } = artifact(contract, file);
  const { contractAddress } = await send(name, { data: encodeDeployData({ abi, bytecode, args }) });
  if (!contractAddress) throw new Error(`${name}: no contract address`);
  record.contracts[name] = contractAddress;
  save();
  return contractAddress;
}

async function read<T>(address: Address, abi: Abi, functionName: string, args: unknown[] = []): Promise<T> {
  return (await client.readContract({ address, abi, functionName, args })) as T;
}

async function call(step: string, address: Address, abi: Abi, functionName: string, args: unknown[], done: () => Promise<boolean>) {
  if (await done()) {
    console.log(`  ${step}: already done`);
    return;
  }
  await send(step, { to: address, data: encodeFunctionData({ abi, functionName, args }) });
  save();
  if (!(await done())) throw new Error(`${step}: the chain does not show the expected result`);
}

async function main(): Promise<void> {
  const [chainId, genesis] = await Promise.all([client.getChainId(), client.getBlock({ blockNumber: 0n })]);
  if (chainId !== manifest.chainId || genesis.hash !== manifest.genesisHash.toLowerCase()) {
    throw new Error("The RPC is not the manifest's chain");
  }
  if (!isAddressEqual(operator.address, manifest.deployer as Address)) throw new Error("The key is not the manifest's deployer/operator");
  const accountFactory = getAddress(manifest.accountFactory);
  const demoUSDC = getAddress(manifest.demoUSDC);
  console.log(`Deploying ${NAMESPACE.name} on chain ${chainId} as ${operator.address}`);

  const registry = artifact("PermissionedRegistry").abi;

  const namerImplementation = await deploy("ContractNamerImplementation", "ContractNamer");
  const namerAbi = artifact("ContractNamer").abi;
  const contractNamer = await deploy("ContractNamer", "ERC1967Proxy", [
    namerImplementation,
    encodeFunctionData({ abi: namerAbi, functionName: "initialize", args: [operator.address] }),
  ]);
  const verifiableFactory = await deploy("VerifiableFactory", "VerifiableFactory");
  const labelStore = await deploy("LabelStore", "LabelStore", [contractNamer]);
  const rootRegistry = await deploy("RootRegistry", "PermissionedRegistry", [labelStore, operator.address, ROOT_REGISTRY_ROOT_ROLES]);
  const ethRegistry = await deploy("ETHRegistry", "PermissionedRegistry", [labelStore, operator.address, ETH_REGISTRY_ROOT_ROLES]);

  await call("registerEth", rootRegistry, registry, "register", ["eth", operator.address, ethRegistry, zeroAddress, ETH_TOKEN_ROLES, MAX_EXPIRY], async () =>
    isAddressEqual(await read<Address>(rootRegistry, registry, "getSubregistry", ["eth"]), ethRegistry),
  );
  await call("setEthParent", ethRegistry, registry, "setParent", [rootRegistry, "eth"], async () => {
    const [parent, label] = await read<[Address, string]>(ethRegistry, registry, "getParent");
    return isAddressEqual(parent, rootRegistry) && label === "eth";
  });
  await call("grantEthRegistrar", ethRegistry, registry, "grantRootRoles", [R.REGISTRAR, operator.address], () =>
    read<boolean>(ethRegistry, registry, "hasRootRoles", [R.REGISTRAR, operator.address]),
  );

  const gatewayProvider = await deploy("BatchGatewayProvider", "GatewayProvider", [operator.address, []]);
  const universalResolver = await deploy("UniversalResolverV2", "UniversalResolverV2", [rootRegistry, gatewayProvider, contractNamer]);

  const qswRegistry = await deploy("QswRegistry", "PermissionedRegistry", [labelStore, operator.address, QSW_REGISTRY_ROOT_ROLES]);
  await call("registerQsw", ethRegistry, registry, "register", [NAMESPACE.label, operator.address, qswRegistry, zeroAddress, QSW_TOKEN_ROLES, MAX_EXPIRY], async () =>
    isAddressEqual(await read<Address>(ethRegistry, registry, "getSubregistry", [NAMESPACE.label]), qswRegistry),
  );
  await call("setQswParent", qswRegistry, registry, "setParent", [ethRegistry, NAMESPACE.label], async () => {
    const [parent, label] = await read<[Address, string]>(qswRegistry, registry, "getParent");
    return isAddressEqual(parent, ethRegistry) && label === NAMESPACE.label;
  });

  const resolverImplementation = await deploy("PermissionedResolverImplementation", "PermissionedResolver", [contractNamer]);
  const registrar = await deploy("SimpleSubnameRegistrar", "SimpleSubnameRegistrar", [qswRegistry, demoUSDC, operator.address, PRICE_PER_YEAR, MIN_DURATION]);
  await call("grantRegistrar", qswRegistry, registry, "grantRootRoles", [REGISTRAR_ROLES, registrar], () =>
    read<boolean>(qswRegistry, registry, "hasRootRoles", [REGISTRAR_ROLES, registrar]),
  );
  const vaultFactory = await deploy("ENSVaultFactory", "ENSVaultFactory", [accountFactory, verifiableFactory, resolverImplementation]);

  // Independent read-back of the namespace before it is published.
  const registrarAbi = artifact("SimpleSubnameRegistrar").abi;
  const vaultFactoryAbi = artifact("ENSVaultFactory").abi;
  const checks: [string, boolean][] = [
    ["root → eth", isAddressEqual(await read<Address>(rootRegistry, registry, "getSubregistry", ["eth"]), ethRegistry)],
    ["eth → qsw", isAddressEqual(await read<Address>(ethRegistry, registry, "getSubregistry", [NAMESPACE.label]), qswRegistry)],
    ["registrar registry", isAddressEqual(await read<Address>(registrar, registrarAbi, "REGISTRY"), qswRegistry)],
    ["registrar token", isAddressEqual(await read<Address>(registrar, registrarAbi, "PAYMENT_TOKEN"), demoUSDC)],
    ["registrar price", (await read<bigint>(registrar, registrarAbi, "PRICE")) === PRICE_PER_YEAR],
    ["registrar roles", await read<boolean>(qswRegistry, registry, "hasRootRoles", [REGISTRAR_ROLES, registrar])],
    ["operator cannot register qsw names", !(await read<boolean>(qswRegistry, registry, "hasRootRoles", [R.REGISTRAR, operator.address]))],
    ["vault factory accounts", isAddressEqual(await read<Address>(vaultFactory, vaultFactoryAbi, "ACCOUNT_FACTORY"), accountFactory)],
    ["vault factory resolver", isAddressEqual(await read<Address>(vaultFactory, vaultFactoryAbi, "RESOLVER_IMPLEMENTATION"), resolverImplementation)],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([what]) => what);
  if (failed.length) throw new Error(`Read-back failed: ${failed.join(", ")}`);

  record.status = "ready";
  save();

  const deploymentBlock = Math.min(...Object.values(record.transactions).map((t) => t.block));
  const ens = {
    label: "Devnet ENSv2",
    namespace: NAMESPACE.name,
    note: "Devnet-only ENSv2 names on chain 81411338; they do not reserve public .eth names.",
    contractsV2Commit: CONTRACTS_V2.commit,
    rootRegistry,
    ethRegistry,
    qswRegistry,
    universalResolver,
    registrar,
    vaultFactory,
    resolverImplementation,
    verifiableFactory,
    labelStore,
    contractNamer,
    paymentToken: demoUSDC,
    pricePerYear: Number(PRICE_PER_YEAR),
    minDuration: Number(MIN_DURATION),
    beneficiary: operator.address,
    deploymentBlock,
  };
  // `ens` is the manifest's last key: rewrite only that section and keep the rest byte for byte.
  const marker = ',\n  "ens": ';
  const base = manifestText.includes(marker) ? `${manifestText.slice(0, manifestText.indexOf(marker))}\n}\n` : manifestText;
  if (!base.endsWith("\n}\n")) throw new Error("Unexpected manifest layout");
  const section = JSON.stringify(ens, null, 2).replace(/\n/g, "\n  ");
  writeFileSync(MANIFEST, `${base.slice(0, -3)}${marker}${section}\n}\n`);
  console.log(`Ready: ${NAMESPACE.name} registrar ${registrar}, vault factory ${vaultFactory}`);
}

main().catch((error: unknown) => {
  save();
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
