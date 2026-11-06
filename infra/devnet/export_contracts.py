#!/usr/bin/env python3
"""Export public deployment ABIs for the shared explorer; never read signing state."""
import argparse
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
BASE = "https://github.com/andreysobol/quantum-smart-wallet/blob/60f033881fc02e35b0468a8a9275bb1ea92afe85/"

# key, display name, artifact path, source URL, description
CONTRACTS = [
    ("demoAccount", "QuantumAccount", "out/QuantumAccount.sol/QuantumAccount.json", BASE + "slhsol/src/QuantumAccount.sol", "WASM-signed demo account using SLH-DSA-SHA2-128s."),
    ("accountFactory", "QuantumAccountFactory", "out/QuantumAccountFactory.sol/QuantumAccountFactory.json", BASE + "slhsol/src/QuantumAccountFactory.sol", "Deploys and registers the QuantumAccounts accepted by QuantumGuard."),
    ("verifier", "SLH-DSA verifier", "out/SlhDsaSha2_128s.sol/SlhDsaVerifier.json", BASE + "slhsol/src/SlhDsaSha2_128s.sol", "Onchain verification of 7,856-byte post-quantum signatures."),
    ("quantumGuardHook", "QuantumGuardHook", "out/QuantumGuardHook.sol/QuantumGuardHook.json", BASE + "slhsol/src/QuantumGuardHook.sol", "Accepts factory-created accounts through the pinned Universal Router. No volume or daily limits."),
    ("poolManager", "Uniswap v4 PoolManager", "out/PoolManager.sol/PoolManager.json", "https://github.com/Uniswap/v4-core/blob/59d3ecf53afa9264a16bba0e38f4c5d2231f80bc/src/PoolManager.sol", "Singleton holding the guarded USDC/WETH pool."),
    ("universalRouter", "Uniswap Universal Router", "out/UniversalRouter.sol/UniversalRouter.json", "https://github.com/Uniswap/universal-router/blob/64027f3372aa235734207c4e05667204f6f927e1/contracts/UniversalRouter.sol", "Trusted router used by the sponsored swap."),
    ("permit2", "Permit2", "lib/permit2/out/Permit2.sol/Permit2.json", "https://github.com/Uniswap/permit2/blob/cc56ad0f3439c502c246fc5cfcc3db92bb8b7219/src/Permit2.sol", "Token approvals for Universal Router; compiled separately with Solidity 0.8.17."),
    ("positionManager", "Uniswap v4 PositionManager", "out/PositionManager.sol/PositionManager.json", "https://github.com/Uniswap/v4-periphery/blob/a7af5b345b479b05fde9182d7e40913a73b3e18f/src/PositionManager.sol", "Manages the funded demo liquidity position."),
    ("quoter", "Uniswap v4 Quoter", "out/V4Quoter.sol/V4Quoter.json", "https://github.com/Uniswap/v4-periphery/blob/a7af5b345b479b05fde9182d7e40913a73b3e18f/src/lens/V4Quoter.sol", "Deployed v4 quoter. The guarded pool rejects its callback path; quote through the registered account and router."),
    ("stateView", "Uniswap v4 StateView", "out/StateView.sol/StateView.json", "https://github.com/Uniswap/v4-periphery/blob/a7af5b345b479b05fde9182d7e40913a73b3e18f/src/lens/StateView.sol", "Read-only access to PoolManager state."),
    ("demoUSDC", "Demo USDC", "out/DemoUSDC.sol/DemoUSDC.json", BASE + "slhsol/src/DemoUSDC.sol", "Test token with 6 decimals; no monetary value."),
    ("weth9", "Wrapped ETH", "out/WETH.sol/WETH.json", "https://github.com/transmissions11/solmate/blob/8d910d876f51c3b2585c9109409d601f600e68e1/src/tokens/WETH.sol", "Solmate WETH with 18 decimals; IWETH9-compatible."),
    ("hookDeployer", "Hook CREATE2 deployer", "out/DeployDemo.s.sol/DemoHookDeployer.json", BASE + "slhsol/script/DeployDemo.s.sol", "Deploys the hook at an address with the required v4 permission bits."),
]

# Devnet ENSv2 (qsw.eth): official contracts-v2 at the pinned tag, plus this repository's vault and registrar.
ENS_V2 = "https://github.com/ensdomains/contracts-v2/blob/62778d80038e50cb23514eab1b7d66ceb8a41e1c/contracts/"
ENS_BASE = "https://github.com/andreysobol/quantum-smart-wallet/blob/416fe40131065a7ec6c05a2acd4622ce71b440b4/"
# key in the manifest's `ens` section, display name, ensv2 artifact, source URL, description
ENS_CONTRACTS = [
    ("rootRegistry", "Devnet ENSv2 root registry", "out/PermissionedRegistry.sol/PermissionedRegistry.json", ENS_V2 + "src/registry/PermissionedRegistry.sol", "Official ENSv2 PermissionedRegistry for the devnet root; points eth at the .eth registry."),
    ("ethRegistry", "Devnet ENSv2 .eth registry", "out/PermissionedRegistry.sol/PermissionedRegistry.json", ENS_V2 + "src/registry/PermissionedRegistry.sol", "Official PermissionedRegistry for .eth; points qsw at the qsw.eth registry. Devnet only, not public .eth."),
    ("qswRegistry", "qsw.eth registry", "out/PermissionedRegistry.sol/PermissionedRegistry.json", ENS_V2 + "src/registry/PermissionedRegistry.sol", "Official PermissionedRegistry holding qsw.eth subnames as ERC-1155 tokens owned by account vaults."),
    ("registrar", "qsw.eth registrar", "out/SimpleSubnameRegistrar.sol/SimpleSubnameRegistrar.json", ENS_BASE + "ensv2/src/SimpleSubnameRegistrar.sol", "Fixed-price registrar from the ENSv2 tutorial pattern: 5 dUSDC per year, at least one year."),
    ("vaultFactory", "ENSVaultFactory", "out/ENSVaultFactory.sol/ENSVaultFactory.json", ENS_BASE + "ensv2/src/ENSVaultFactory.sol", "One ENSVault per factory-created QuantumAccount: the vault holds its names, the account controls the vault."),
    ("universalResolver", "Devnet ENSv2 UniversalResolverV2", "out/UniversalResolverV2.sol/UniversalResolverV2.json", ENS_V2 + "src/universalResolver/UniversalResolverV2.sol", "Official resolution entry point: resolves qsw.eth names through the registry tree."),
    ("resolverImplementation", "PermissionedResolver implementation", "out/PermissionedResolver.sol/PermissionedResolver.json", ENS_V2 + "src/resolver/PermissionedResolver.sol", "Implementation behind each vault's own resolver proxy."),
    ("verifiableFactory", "VerifiableFactory", "out/VerifiableFactory.sol/VerifiableFactory.json", "https://github.com/ensdomains/verifiable-factory/blob/c1090aec465ab30d494c96bd7d2a147b4f0b0173/src/VerifiableFactory.sol", "Deploys the vaults' resolver proxies."),
    ("labelStore", "Devnet ENSv2 LabelStore", "out/LabelStore.sol/LabelStore.json", ENS_V2 + "src/utils/LabelStore.sol", "Stores registered labels for the devnet ENSv2 registries."),
    ("contractNamer", "Devnet ENSv2 ContractNamer", "out/ContractNamer.sol/ContractNamer.json", ENS_V2 + "src/utils/ContractNamer.sol", "UUPS proxy of the official ContractNamer used by the registries and resolvers."),
]


def ens_entries(project, ens):
    entries = []
    for key, name, artifact, source, description in ENS_CONTRACTS:
        address = ens[key]
        if not re.fullmatch(r"0x[0-9a-fA-F]{40}", address):
            raise ValueError("Invalid ENS deployment address: " + key)
        abi = json.loads((project / "slhsol/ensv2" / artifact).read_text())["abi"]
        if not isinstance(abi, list) or not abi:
            raise ValueError("Missing ENS artifact ABI: " + artifact)
        entries.append({"address": address, "name": name, "kind": "contract", "abi": abi,
                        "sourceUrl": source, "description": description})
    return entries


def build_registry(project, manifest):
    contracts = []
    for key, name, artifact, source, description in CONTRACTS:
        address = manifest[key]
        if not re.fullmatch(r"0x[0-9a-fA-F]{40}", address):
            raise ValueError("Invalid deployment address: " + key)
        data = json.loads((project / "slhsol" / artifact).read_text())
        abi = data["abi"]
        if not isinstance(abi, list) or not abi:
            raise ValueError("Missing artifact ABI: " + artifact)
        contracts.append({"address": address, "name": name, "kind": "contract", "abi": abi,
                          "sourceUrl": source, "description": description})
    # This predeploy is built from infra/devnet/genesis, outside the Foundry project.
    contracts.append({"address": manifest["stakingRegistry"], "name": "Staking registry", "kind": "contract",
                      "abi": json.loads((project / "infra/devnet/genesis/registry.abi.json").read_text()),
                      "sourceUrl": BASE + "infra/devnet/genesis/NaiveStakingRegistry.sol",
                      "description": "Genesis predeploy holding alternative-mempool stakes."})
    contracts.append({"address": manifest["deployer"], "name": "Demo sponsor", "kind": "eoa", "abi": [],
                      "description": "Test-funded sponsor paying gas for the demo account."})
    if "ens" in manifest:
        contracts.extend(ens_entries(project, manifest["ens"]))
    addresses = [c["address"].lower() for c in contracts]
    if len(addresses) != len(set(addresses)):
        raise ValueError("Duplicate deployment address")
    return {"chainId": manifest["chainId"], "genesisHash": manifest["genesisHash"],
            "rpcUrl": manifest["rpcUrl"], "mempoolUrl": manifest["mempoolUrl"],
            "demoTransactionHash": manifest["demoTransactionHash"], "contracts": contracts,
            "poolId": manifest["poolId"], "poolKey": manifest["poolKey"],
            "abiProvenance": "Published deployment artifacts; source verification is not provided by this explorer."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=ROOT / "slhsol/deployments/shared-devnet.json")
    parser.add_argument("--output", type=Path, default=ROOT / "infra/devnet/contracts.json")
    args = parser.parse_args()
    registry = build_registry(ROOT, json.loads(args.manifest.read_text()))
    args.output.write_text(json.dumps(registry, indent=2) + "\n")
    print(f"Exported {len(registry['contracts'])} public addresses for chain {registry['chainId']}")


if __name__ == "__main__":
    main()
