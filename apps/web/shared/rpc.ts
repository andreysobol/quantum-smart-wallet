/**
 * Minimal isomorphic JSON-RPC client (browser fetch and Node 22+ fetch).
 * The public gateway requires jsonrpc "2.0", an id and array params, and accepts
 * batches of 1 to 20 requests.
 */
export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly method: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export interface RpcOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

let sequence = 0;

async function post(url: string, body: unknown, { timeoutMs = 20_000, signal }: RpcOptions): Promise<unknown> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (error) {
    if (timeout.aborted) throw new RpcError(-32000, `RPC request timed out after ${timeoutMs} ms`, "fetch");
    if (signal?.aborted) throw error;
    throw new RpcError(-32000, "RPC endpoint is unreachable", "fetch");
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new RpcError(-32700, `RPC returned HTTP ${response.status} without JSON`, "fetch");
  }
}

interface RpcEnvelope {
  id?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

function unwrap<T>(method: string, envelope: RpcEnvelope): T {
  if (envelope.error) {
    const { code = -32603, message = "RPC error", data } = envelope.error;
    throw new RpcError(code, message, method, data);
  }
  if (!("result" in envelope)) throw new RpcError(-32603, "RPC response has no result", method);
  return envelope.result as T;
}

export async function rpcCall<T = unknown>(
  url: string,
  method: string,
  params: unknown[] = [],
  options: RpcOptions = {},
): Promise<T> {
  const id = ++sequence;
  const envelope = (await post(url, { jsonrpc: "2.0", id, method, params }, options)) as RpcEnvelope;
  return unwrap<T>(method, envelope);
}

export type BatchItem = { method: string; params?: unknown[] };
export type BatchResult<T = unknown> = { ok: true; result: T } | { ok: false; error: RpcError };

/** Batched JSON-RPC (max 20 per request on the public gateway); results in request order. */
export async function rpcBatch(url: string, calls: BatchItem[], options: RpcOptions = {}): Promise<BatchResult[]> {
  if (calls.length === 0) return [];
  if (calls.length > 20) throw new RpcError(-32600, "Batch exceeds 20 requests", "batch");
  const first = sequence + 1;
  sequence += calls.length;
  const body = calls.map((call, index) => ({ jsonrpc: "2.0", id: first + index, method: call.method, params: call.params ?? [] }));
  const reply = await post(url, body, options);
  if (!Array.isArray(reply)) {
    const error = (reply as RpcEnvelope).error;
    throw new RpcError(error?.code ?? -32603, error?.message ?? "RPC batch failed", "batch", error?.data);
  }
  const byId = new Map<unknown, RpcEnvelope>((reply as RpcEnvelope[]).map((item) => [item.id, item]));
  return calls.map((call, index) => {
    const envelope = byId.get(first + index);
    if (!envelope) return { ok: false, error: new RpcError(-32603, "Missing batch response", call.method) };
    try {
      return { ok: true, result: unwrap(call.method, envelope) };
    } catch (error) {
      return { ok: false, error: error as RpcError };
    }
  });
}
