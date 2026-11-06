export const MAX_HTTP_BYTES = 1024 * 1024;
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_BATCH = 20;
export const MAX_WS_BYTES = 64 * 1024;
export const MAX_PENDING_MESSAGES = 16;
export const MAX_PENDING_BYTES = 256 * 1024;

export type RpcId = string | number | null;
export type RpcRequest = { jsonrpc: "2.0"; id: RpcId; method: string; params: unknown[] };
export type Route = "rpc" | "mempool";

export const EL_METHODS = new Set([
  "web3_clientVersion", "web3_sha3", "net_version", "net_listening", "net_peerCount",
  "eth_chainId", "eth_protocolVersion", "eth_syncing", "eth_blockNumber", "eth_gasPrice",
  "eth_maxPriorityFeePerGas", "eth_feeHistory", "eth_getBalance", "eth_getStorageAt",
  "eth_getTransactionCount", "eth_getCode", "eth_call", "eth_estimateGas",
  "eth_getBlockByHash", "eth_getBlockByNumber", "eth_getBlockTransactionCountByHash",
  "eth_getBlockTransactionCountByNumber", "eth_getTransactionByHash",
  "eth_getTransactionByBlockHashAndIndex", "eth_getTransactionByBlockNumberAndIndex",
  "eth_getTransactionReceipt", "eth_getLogs", "eth_sendRawTransaction",
]);

export const EXPLORER_METHODS = new Set([
  "qsw_explorerStatus", "qsw_explorerTransactions", "qsw_explorerTransaction",
]);

export function validateExplorerParams(method: string, params: unknown[]): void {
  if (method === "qsw_explorerStatus") {
    if (params.length === 0) return;
  } else if (method === "qsw_explorerTransaction") {
    if (params.length === 1 && typeof params[0] === "string" && /^0x[0-9a-fA-F]{64}$/.test(params[0])) return;
  } else if (method === "qsw_explorerTransactions") {
    const query = params[0];
    if (params.length === 1 && isRecord(query) &&
        Object.keys(query).every((key) => ["address", "before", "limit"].includes(key)) &&
        (query.address === undefined || (typeof query.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(query.address))) &&
        (query.before === undefined || (typeof query.before === "number" && Number.isSafeInteger(query.before) && query.before > 0)) &&
        (query.limit === undefined || (typeof query.limit === "number" && Number.isSafeInteger(query.limit) && query.limit >= 1 && query.limit <= 100))) return;
  } else {
    throw new RpcFault(-32601, "Unknown chain explorer method");
  }
  throw new RpcFault(-32602, "Invalid chain explorer parameters");
}

// Names are pinned to the sidecar's packages/api/src/constants.ts.
export const MEMPOOL_METHODS = new Set([
  "eth_chainId", "web3_clientVersion", "eth_sendFrameTransaction",
  "eth_estimateFrameTransactionGas", "eth_getFrameTransactionReceipt",
  "eth_getFrameTransactionByHash", "skandha_getGasPrice", "skandha_frameTransactionStatus",
  "skandha_explorer_info", "skandha_explorer_listTransactions",
  "skandha_explorer_listAdmissions", "skandha_explorer_getTransaction",
  "skandha_explorer_peers", "skandha_explorer_listReputation", "skandha_connectedPeers",
]);

export class RpcFault extends Error {
  constructor(
    public code: number,
    message: string,
    public id: RpcId = null,
    public status = 400,
  ) { super(message); }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const traceKeys = new Set(["trace", "tracer", "traceconfig", "erc7562trace", "debugtrace"]);
function checkParams(value: unknown, depth = 0): void {
  if (depth > 40) throw new RpcFault(-32602, "Parameters are nested too deeply");
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (traceKeys.has(key.toLowerCase())) {
      throw new RpcFault(-32602, "Trace options are not available on the public gateway", null, 403);
    }
    checkParams(child, depth + 1);
  }
}

function request(value: unknown): RpcRequest {
  if (!isRecord(value) || value.jsonrpc !== "2.0" ||
      typeof value.method !== "string" || value.method.length > 128 ||
      !Object.hasOwn(value, "id") ||
      !(value.id === null ||
        (typeof value.id === "string" && value.id.length <= 128) ||
        (typeof value.id === "number" && Number.isSafeInteger(value.id))) ||
      (value.params !== undefined && !Array.isArray(value.params))) {
    throw new RpcFault(-32600, "Invalid JSON-RPC request");
  }
  const parsed: RpcRequest = {
    jsonrpc: "2.0", id: value.id as RpcId,
    method: value.method, params: (value.params ?? []) as unknown[],
  };
  try { checkParams(parsed.params); }
  catch (error) {
    if (error instanceof RpcFault) error.id = parsed.id;
    throw error;
  }
  return parsed;
}

export function validateHttpPayload(value: unknown, route: Route): RpcRequest | RpcRequest[] {
  const allowed = route === "rpc" ? EL_METHODS : MEMPOOL_METHODS;
  const validate = (item: unknown) => {
    const parsed = request(item);
    if (!allowed.has(parsed.method) && !(route === "rpc" && EXPLORER_METHODS.has(parsed.method))) {
      throw new RpcFault(-32601, "Method is not available on this public endpoint", parsed.id, 403);
    }
    if (EXPLORER_METHODS.has(parsed.method)) {
      try { validateExplorerParams(parsed.method, parsed.params); }
      catch (error) {
        if (error instanceof RpcFault) error.id = parsed.id;
        throw error;
      }
    }
    // Public calls cannot install state/block overrides.
    if ((parsed.method === "eth_call" || parsed.method === "eth_estimateGas") &&
        parsed.params.length > 2) {
      throw new RpcFault(-32602, "State and block overrides are not available", parsed.id, 403);
    }
    return parsed;
  };
  if (!Array.isArray(value)) return validate(value);
  if (value.length === 0 || value.length > MAX_BATCH) {
    throw new RpcFault(-32600, "Batch must contain 1 to " + MAX_BATCH + " requests");
  }
  // Validate every member before any request is forwarded.
  return value.map(validate);
}

export function validateWsPayload(value: unknown): RpcRequest {
  const parsed = request(value);
  if (parsed.method === "skandha_subscribe") {
    const [event, cursor] = parsed.params;
    if (event !== "explorerEvents" || parsed.params.length < 1 || parsed.params.length > 2 ||
        (parsed.params.length === 2 && !(typeof cursor === "number" &&
          Number.isSafeInteger(cursor) && cursor >= 0))) {
      throw new RpcFault(-32602, "Only explorerEvents with an optional sequence cursor is available", parsed.id);
    }
  } else if (parsed.method === "skandha_unsubscribe") {
    if (parsed.params.length !== 1 || typeof parsed.params[0] !== "string" ||
        parsed.params[0].length === 0 || parsed.params[0].length > 256) {
      throw new RpcFault(-32602, "Expected one subscription ID", parsed.id);
    }
  } else {
    throw new RpcFault(-32601, "Only explorer subscriptions are available over WebSocket", parsed.id, 403);
  }
  return parsed;
}

export function errorResponse(error: unknown, id: RpcId = null) {
  const fault = error instanceof RpcFault ? error : new RpcFault(-32603, "Internal gateway error", id, 500);
  return { jsonrpc: "2.0", id: fault.id, error: { code: fault.code, message: fault.message } };
}

export function sanitizeResponse(value: unknown, id: RpcId) {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || value.id !== id) {
    throw new RpcFault(-32002, "Invalid upstream response", id, 502);
  }
  if (Object.hasOwn(value, "error")) {
    const error = isRecord(value.error) ? value.error : {};
    return {
      jsonrpc: "2.0", id,
      error: {
        code: Number.isSafeInteger(error.code) ? error.code : -32000,
        message: typeof error.message === "string" ? error.message.slice(0, 512) : "Upstream RPC error",
      },
    };
  }
  if (!Object.hasOwn(value, "result")) throw new RpcFault(-32002, "Invalid upstream response", id, 502);
  return { jsonrpc: "2.0", id, result: value.result };
}
