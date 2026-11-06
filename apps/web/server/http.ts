import { RpcError } from "../shared/rpc.js";
import type { ApiErrorBody, ApiErrorCode } from "../shared/types.js";

/** An expected failure with a user-readable message and its HTTP status. */
export class ApiFailure extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApiFailure";
  }
}

export const fail = (status: number, code: ApiErrorCode, message: string): never => {
  throw new ApiFailure(status, code, message);
};

const HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...headers } });
}

export function errorResponse(status: number, code: ApiErrorCode, message: string, headers: Record<string, string> = {}): Response {
  const body: ApiErrorBody = { error: { code, message } };
  return json(body, status, headers);
}

export const BODY_LIMIT = { small: 64 * 1024, sponsor: 1024 * 1024 } as const;

/** Read a JSON body of at most maxBytes (checked before and while streaming). */
export async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) fail(413, "bad_request", `Request body is larger than ${maxBytes} bytes.`);
  if (!request.body) fail(400, "bad_request", "Request body must be JSON.");
  const reader = (request.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      fail(413, "bad_request", `Request body is larger than ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return fail(400, "bad_request", "Request body must be valid JSON.");
  }
}

/** Best-effort client IP from the platform proxy headers. */
export function clientIp(request: Request): string {
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

/**
 * Fixed-window in-memory rate limiter. Best effort only: each serverless instance
 * keeps its own counters; the on-chain caps (faucet balance, swap limits) are the
 * real guard rails.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns seconds to wait when limited, or 0 when the hit is allowed. */
  take(key: string): number {
    const now = this.now();
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    }
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return 0;
    }
    if (entry.count >= this.limit) return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    entry.count++;
    return 0;
  }
}

export function enforce(limiter: RateLimiter, key: string, what: string): void {
  const wait = limiter.take(key);
  if (wait > 0) throw new ApiFailure(429, "rate_limited", `Too many ${what} requests. Try again in ${wait} s.`);
}

/** Run a route, mapping expected failures to JSON errors and hiding internals. */
export async function respond(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiFailure) return errorResponse(error.status, error.code, error.message);
    if (error instanceof RpcError) {
      const timeout = /timed out/i.test(error.message);
      return errorResponse(timeout ? 504 : 502, timeout ? "timeout" : "upstream_error", `The devnet RPC failed (${error.method}): ${error.message}`);
    }
    console.error("[api] unexpected error:", error instanceof Error ? error.message : "unknown");
    return errorResponse(500, "internal", "Unexpected server error. Please try again.");
  }
}
