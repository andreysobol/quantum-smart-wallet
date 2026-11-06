# Devnet ENSv2 — qsw.eth

**Devnet ENSv2** names for QuantumAccounts on the shared devnet (chain 81411338), registered as
`<label>.qsw.eth` and paid in dUSDC. These names live only on this devnet. They do not reserve public
`.eth` names and do not establish ENS-prize eligibility.

Built on the official [`ensdomains/contracts-v2`](https://github.com/ensdomains/contracts-v2), pinned in
`lib/contracts-v2` at tag `v2-mainnet-deployment-1` (`62778d80038e50cb23514eab1b7d66ceb8a41e1c`). The ENSv2
contracts are deployed unmodified.

## Why names are held by a vault

ENSv2 registries mint names as ERC-1155 tokens. `ERC1155Singleton._mint` calls `onERC1155Received` on contract
owners and reverts with `ERC1155InvalidReceiver` when the owner does not implement it. `QuantumAccount` has
no receiver hooks and no fallback, so a name minted to it always reverts. `test/ENSVault.t.sol` reproduces
this with the real account contract, and the live account reverts on the call.

Instead of replacing the deployed wallet contracts, each account gets an **ENSVault**:

- **Token owner:** the vault holds the name tokens and implements the ERC-1155/ERC-721 receiver hooks and
  ERC-165.
- **Controller:** the QuantumAccount. Only it can call `execute(target, data)`, from a SENDER frame of its own
  PQ-validated transaction. The vault has no owner, operator role, upgrade or recovery path.
- **Resolver:** the vault deploys its own official `PermissionedResolver` proxy through `VerifiableFactory`
  and holds every role on it. A name's records therefore change only through its controller.
- **Vault factory:** `ENSVaultFactory` gives each factory-created account exactly one vault at a
  deterministic CREATE2 address. Creating a vault is permissionless and idempotent; the controller is fixed
  by the address.

Forward resolution points each name at the QuantumAccount: `addr(node)` is set to the account through
`UniversalResolverV2`.

## Contracts

| Contract | Source |
|---|---|
| Root, `.eth` and `qsw.eth` registries | official `PermissionedRegistry` |
| ContractNamer (UUPS), LabelStore, VerifiableFactory, GatewayProvider, UniversalResolverV2 | official |
| Per-vault resolver | official `PermissionedResolver` proxy |
| `SimpleSubnameRegistrar` | the ENSv2 contract-developer tutorial's minimal ERC20 registrar: 5 dUSDC per year, at least 1 year, no commit-reveal |
| `ENSVault`, `ENSVaultFactory` | this repository |

**What the operator can and cannot do.** The operator owns the devnet root and `.eth`. On `qsw.eth` it can
only add registrars and renewers. It holds no role that can unregister or take a name. The `qsw` token in
`.eth` carries no roles, so the namespace's registry and resolver stay as deployed. Registration fees go to
the operator.

## Registration

One EIP-8141 frame transaction: the account's SLH-DSA VERIFY frame and the sponsor's VERIFY frame, then
one atomic batch:

1. `ENSVaultFactory.createVault(account)`, idempotent
2. `dUSDC.approve(registrar, price)`
3. `registrar.register(label, vault, resolver, duration)`
4. `vault.execute(resolver, setAddress(name, 60, account))`

The web app builds it (`apps/web/shared/ens.ts`). The sponsor co-signs it only after checking:

- every byte matches this template
- the account was created by the factory and the nonce is current
- the vault and resolver are the account's own
- the label is normalized and still available
- the duration is 1–5 whole years
- the payment equals `getPrice(duration)`
- the account holds enough dUSDC
- the SLH-DSA signature verifies on chain

## Build, test, deploy

```sh
git submodule update --init --checkout --depth 1 ensv2/lib/contracts-v2   # skipped by recursive updates
for m in openzeppelin-contracts openzeppelin-contracts-upgradeable ens-contracts verifiable-factory forge-std buffer solsha1 openzeppelin-contracts-v4; do
  git -C ensv2/lib/contracts-v2 submodule update --init --depth 1 contracts/lib/$m
done
cd ensv2 && forge test
npm ci && QSW_DEPLOYER_KEY_FILE=../.secrets/devnet-operator.json npm run deploy
```

The deploy script mirrors the official `V2Fixture` wiring and uses the devnet's own `eth_estimateGas`: its
state gas is not modelled by Forge, and contract creation needs up to about 28M gas. It resumes from
`deployments/shared-devnet.json` and reads the namespace back before writing the `ens` section of
`slhsol/deployments/shared-devnet.json`.

**Publishing.** That file is the source of the published manifest, so copy it to the gateway host's
`DEPLOYMENT_MANIFEST` to serve the namespace. Until then, the web server uses an identical bundled copy
(`apps/web/server/ens.ts`); a unit test keeps the two in sync. Either way, the server verifies the
namespace's wiring on chain before enabling it.

## Deployed (shared devnet)

| | Address |
|---|---|
| Root registry | `0xFE65cfc45b406F2D95d0de80a1eA89a7C6dE9c1C` |
| `.eth` registry | `0x7f2DC8E732adb8C55AE9787c8ed4D78Ea7F35639` |
| `qsw.eth` registry | `0x5Bb30cD38cC07029729A1B614e5c834ce166c9aE` |
| UniversalResolverV2 | `0x6F36B098566f113021BB0eab239f0ba952c4b6CD` |
| SimpleSubnameRegistrar | `0xc1784536C1dF5FBAAA705F4b51e542F14215E257` |
| ENSVaultFactory | `0xA9aBbA3d31F832B3258955FA8aD0DB1B49A96e24` |

All addresses and deployment transactions are listed in `deployments/shared-devnet.json`.

**First live registration** (`apps/web/e2e/names.live.spec.ts`):

- **Name:** `qswmw56wsx5.qsw.eth`, held by vault `0xB6a82373C7531d4064e3A7DFE398aa4c02d7Ae36` and resolving
  to account `0xc19245E98CAa3680179F81b8a0C8795810Cd5775`.
- **Transaction:** `0xfcf79147e658857dca200fb97c7f6af3b440298340fa3ebf798745fa7012a7ab`.
