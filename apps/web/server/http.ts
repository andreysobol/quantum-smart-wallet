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

/** A signed swap body is about 20 KB, most of it the 7,856-byte SLH-DSA signature. */
export const BODY_LIMIT = { small: 64 * 1024, sponsor: 32 * 1024 } as const;

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).host;
  } catch {
    return null; // the opaque origin "null"
  }
};

/** Hosts the request was sent to. Platforms build request.url from Host or X-Forwarded-Host; a browser page can set neither. */
function ownHosts(request: Request): string[] {
  const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0];
  return [new URL(request.url).host, request.headers.get("host"), forwarded].flatMap((host) => (host?.trim() ? [host.trim().toLowerCase()] : []));
}

/**
 * Writes take same-origin JSON only. Without CORS, a page on another site can still send a
 * "simple" POST (text/plain or form body, no preflight), and the browser delivers it even though
 * the page cannot read the answer. Requiring application/json forces a preflight these functions
 * never approve; Sec-Fetch-Site and Origin then refuse what the browser marks as foreign.
 * Requests without those headers do not come from a browser page and are left to the rate limits.
 */
export function requireSameOriginJson(request: Request): void {
  const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") fail(415, "bad_request", "Content-Type must be application/json.");
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") fail(403, "bad_request", "Cross-site requests are not accepted.");
  const origin = request.headers.get("origin");
  if (origin === null) return;
  const host = hostOf(origin);
  if (host === null || !ownHosts(request).includes(host)) fail(403, "bad_request", "Requests from other origins are not accepted.");
}

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

/** Keys remembered for a fixed time; per instance and best effort, like RateLimiter. */
export class RecentKeys {
  private readonly expiries = new Map<string, number>();
  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  has(key: string): boolean {
    return (this.expiries.get(key) ?? 0) > this.now();
  }

  add(key: string): void {
    const now = this.now();
    if (this.expiries.size > 10_000) {
      for (const [k, expires] of this.expiries) if (expires <= now) this.expiries.delete(k);
    }
    this.expiries.set(key, now + this.ttlMs);
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
