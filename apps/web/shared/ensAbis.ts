/**
 * Devnet ENSv2 ABIs (viem `as const`), the functions, events and errors the wallet uses, from the
 * Foundry artifacts of ensv2/ (official ensdomains/contracts-v2 @ 62778d8 plus ENSVault, ENSVaultFactory
 * and SimpleSubnameRegistrar).
 */

export const ensRegistrarAbi = [
  {"type": "function", "name": "BENEFICIARY", "inputs": [], "outputs": [{"name": "", "type": "address", "internalType": "address"}], "stateMutability": "view"},
  {"type": "function", "name": "MIN_DURATION", "inputs": [], "outputs": [{"name": "", "type": "uint64", "internalType": "uint64"}], "stateMutability": "view"},
  {"type": "function", "name": "PAYMENT_TOKEN", "inputs": [], "outputs": [{"name": "", "type": "address", "internalType": "contract IERC20"}], "stateMutability": "view"},
  {"type": "function", "name": "PRICE", "inputs": [], "outputs": [{"name": "", "type": "uint256", "internalType": "uint256"}], "stateMutability": "view"},
  {"type": "function", "name": "REGISTRY", "inputs": [], "outputs": [{"name": "", "type": "address", "internalType": "contract IPermissionedRegistry"}], "stateMutability": "view"},
  {"type": "function", "name": "getPrice", "inputs": [{"name": "duration", "type": "uint64", "internalType": "uint64"}], "outputs": [{"name": "", "type": "uint256", "internalType": "uint256"}], "stateMutability": "view"},
  {"type": "function", "name": "isAvailable", "inputs": [{"name": "label", "type": "string", "internalType": "string"}], "outputs": [{"name": "", "type": "bool", "internalType": "bool"}], "stateMutability": "view"},
  {"type": "function", "name": "register", "inputs": [{"name": "label", "type": "string", "internalType": "string"}, {"name": "owner", "type": "address", "internalType": "address"}, {"name": "resolver", "type": "address", "internalType": "address"}, {"name": "duration", "type": "uint64", "internalType": "uint64"}], "outputs": [{"name": "tokenId", "type": "uint256", "internalType": "uint256"}], "stateMutability": "nonpayable"},
  {"type": "function", "name": "renew", "inputs": [{"name": "label", "type": "string", "internalType": "string"}, {"name": "duration", "type": "uint64", "internalType": "uint64"}], "outputs": [], "stateMutability": "nonpayable"},
  {"type": "event", "name": "NameRegistered", "inputs": [{"name": "tokenId", "type": "uint256", "indexed": true, "internalType": "uint256"}, {"name": "label", "type": "string", "indexed": false, "internalType": "string"}, {"name": "owner", "type": "address", "indexed": true, "internalType": "address"}, {"name": "payer", "type": "address", "indexed": true, "internalType": "address"}, {"name": "resolver", "type": "address", "indexed": false, "internalType": "address"}, {"name": "price", "type": "uint256", "indexed": false, "internalType": "uint256"}, {"name": "expiry", "type": "uint64", "indexed": false, "internalType": "uint64"}], "anonymous": false},
  {"type": "event", "name": "NameRenewed", "inputs": [{"name": "tokenId", "type": "uint256", "indexed": true, "internalType": "uint256"}, {"name": "label", "type": "string", "indexed": false, "internalType": "string"}, {"name": "payer", "type": "address", "indexed": true, "internalType": "address"}, {"name": "price", "type": "uint256", "indexed": false, "internalType": "uint256"}, {"name": "expiry", "type": "uint64", "indexed": false, "internalType": "uint64"}], "anonymous": false},
  {"type": "error", "name": "DurationTooShort", "inputs": [{"name": "duration", "type": "uint64", "internalType": "uint64"}, {"name": "minDuration", "type": "uint64", "internalType": "uint64"}]},
  {"type": "error", "name": "InvalidOwner", "inputs": []},
  {"type": "error", "name": "NameNotAvailable", "inputs": [{"name": "label", "type": "string", "internalType": "string"}]},
  {"type": "error", "name": "NameNotRegistered", "inputs": [{"name": "label", "type": "string", "internalType": "string"}]},
] as const;

export const ensVaultFactoryAbi = [
  {"type": "function", "name": "ACCOUNT_FACTORY", "inputs": [], "outputs": [{"name": "", "type": "address", "internalType": "contract IQuantumAccountRegistry"}], "stateMutability": "view"},
  {"type": "function", "name": "PROXY_FACTORY", "inputs": [], "outputs": [{"name": "", "type": "address", "internalType": "contract IVerifiableFactory"}], "stateMutability": "view"},
  {"type": "function", "name": "RESOLVER_IMPLEMENTATION", "inputs": [], "outputs": [{"name": "", "type": "address", "internalType": "address"}], "stateMutability": "view"},
  {"type": "function", "name": "createVault", "inputs": [{"name": "controller", "type": "address", "internalType": "address"}], "outputs": [{"name": "vault", "type": "address", "internalType": "contract ENSVault"}], "stateMutability": "nonpayable"},
  {"type": "function", "name": "resolverAddress", "inputs": [{"name": "controller", "type": "address", "internalType": "address"}], "outputs": [{"name": "", "type": "address", "internalType": "address"}], "stateMutability": "view"},
  {"type": "function", "name": "vaultAddress", "inputs": [{"name": "controller", "type": "address", "internalType": "address"}], "outputs": [{"name": "", "type": "address", "internalType": "address"}], "stateMutability": "view"},
  {"type": "event", "name": "VaultCreated", "inputs": [{"name": "controller", "type": "address", "indexed": true, "internalType": "address"}, {"name": "vault", "type": "address", "indexed": true, "internalType": "address"}, {"name": "resolver", "type": "address", "indexed": false, "internalType": "address"}], "anonymous": false},
  {"type": "error", "name": "NotQuantumAccount", "inputs": [{"name": "account", "type": "address", "internalType": "address"}]},
] as const;

export const ensVaultAbi = [
  {"type": "function", "name": "CONTROLLER", "inputs": [], "outputs": [{"name": "", "type": "address", "internalType": "address"}], "stateMutability": "view"},
  {"type": "function", "name": "RESOLVER", "inputs": [], "outputs": [{"name": "", "type": "address", "internalType": "address"}], "stateMutability": "view"},
  {"type": "function", "name": "execute", "inputs": [{"name": "target", "type": "address", "internalType": "address"}, {"name": "data", "type": "bytes", "internalType": "bytes"}], "outputs": [{"name": "result", "type": "bytes", "internalType": "bytes"}], "stateMutability": "nonpayable"},
  {"type": "event", "name": "Executed", "inputs": [{"name": "target", "type": "address", "indexed": true, "internalType": "address"}, {"name": "selector", "type": "bytes4", "indexed": true, "internalType": "bytes4"}], "anonymous": false},
  {"type": "error", "name": "InvalidController", "inputs": []},
  {"type": "error", "name": "UnauthorizedCaller", "inputs": [{"name": "caller", "type": "address", "internalType": "address"}]},
] as const;

export const ensRegistryAbi = [
  {"type": "function", "name": "getParent", "inputs": [], "outputs": [{"name": "parent", "type": "address", "internalType": "contract IRegistry"}, {"name": "label", "type": "string", "internalType": "string"}], "stateMutability": "view"},
  {"type": "function", "name": "getResolver", "inputs": [{"name": "label", "type": "string", "internalType": "string"}], "outputs": [{"name": "", "type": "address", "internalType": "address"}], "stateMutability": "view"},
  {"type": "function", "name": "getState", "inputs": [{"name": "anyId", "type": "uint256", "internalType": "uint256"}], "outputs": [{"name": "state", "type": "tuple", "internalType": "struct IPermissionedRegistry.State", "components": [{"name": "status", "type": "uint8", "internalType": "enum IPermissionedRegistry.Status"}, {"name": "expiry", "type": "uint64", "internalType": "uint64"}, {"name": "latestOwner", "type": "address", "internalType": "address"}, {"name": "tokenId", "type": "uint256", "internalType": "uint256"}, {"name": "resource", "type": "uint256", "internalType": "uint256"}]}], "stateMutability": "view"},
  {"type": "function", "name": "getSubregistry", "inputs": [{"name": "label", "type": "string", "internalType": "string"}], "outputs": [{"name": "", "type": "address", "internalType": "contract IRegistry"}], "stateMutability": "view"},
  {"type": "function", "name": "hasRoles", "inputs": [{"name": "anyId", "type": "uint256", "internalType": "uint256"}, {"name": "roleBitmap", "type": "uint256", "internalType": "uint256"}, {"name": "account", "type": "address", "internalType": "address"}], "outputs": [{"name": "", "type": "bool", "internalType": "bool"}], "stateMutability": "view"},
  {"type": "function", "name": "hasRootRoles", "inputs": [{"name": "roleBitmap", "type": "uint256", "internalType": "uint256"}, {"name": "account", "type": "address", "internalType": "address"}], "outputs": [{"name": "", "type": "bool", "internalType": "bool"}], "stateMutability": "view"},
  {"type": "function", "name": "latestOwnerOf", "inputs": [{"name": "tokenId", "type": "uint256", "internalType": "uint256"}], "outputs": [{"name": "", "type": "address", "internalType": "address"}], "stateMutability": "view"},
  {"type": "function", "name": "ownerOf", "inputs": [{"name": "tokenId", "type": "uint256", "internalType": "uint256"}], "outputs": [{"name": "", "type": "address", "internalType": "address"}], "stateMutability": "view"},
  {"type": "event", "name": "LabelRegistered", "inputs": [{"name": "tokenId", "type": "uint256", "indexed": true, "internalType": "uint256"}, {"name": "labelHash", "type": "bytes32", "indexed": true, "internalType": "bytes32"}, {"name": "label", "type": "string", "indexed": false, "internalType": "string"}, {"name": "owner", "type": "address", "indexed": false, "internalType": "address"}, {"name": "expiry", "type": "uint64", "indexed": false, "internalType": "uint64"}, {"name": "sender", "type": "address", "indexed": true, "internalType": "address"}], "anonymous": false},
] as const;

export const universalResolverAbi = [
  {"type": "function", "name": "ROOT_REGISTRY", "inputs": [], "outputs": [{"name": "", "type": "address", "internalType": "contract IPermissionedRegistry"}], "stateMutability": "view"},
  {"type": "function", "name": "findResolver", "inputs": [{"name": "name", "type": "bytes", "internalType": "bytes"}], "outputs": [{"name": "resolver", "type": "address", "internalType": "address"}, {"name": "node", "type": "bytes32", "internalType": "bytes32"}, {"name": "offset", "type": "uint256", "internalType": "uint256"}], "stateMutability": "view"},
  {"type": "function", "name": "resolve", "inputs": [{"name": "name", "type": "bytes", "internalType": "bytes"}, {"name": "data", "type": "bytes", "internalType": "bytes"}], "outputs": [{"name": "", "type": "bytes", "internalType": "bytes"}, {"name": "", "type": "address", "internalType": "address"}], "stateMutability": "view"},
] as const;

export const permissionedResolverAbi = [
  {"type": "function", "name": "setAddress", "inputs": [{"name": "name", "type": "bytes", "internalType": "bytes"}, {"name": "coinType", "type": "uint256", "internalType": "uint256"}, {"name": "addressBytes", "type": "bytes", "internalType": "bytes"}], "outputs": [], "stateMutability": "nonpayable"},
  {"type": "function", "name": "setText", "inputs": [{"name": "name", "type": "bytes", "internalType": "bytes"}, {"name": "key", "type": "string", "internalType": "string"}, {"name": "value", "type": "string", "internalType": "string"}], "outputs": [], "stateMutability": "nonpayable"},
] as const;
