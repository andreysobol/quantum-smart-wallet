import type { ServerWebSocket, WebSocketHandler } from "bun";
import { ChainExplorer, createInternalChainRpc } from "./explorer";
import {
  MAX_HTTP_BYTES, MAX_RESPONSE_BYTES, MAX_WS_BYTES, MAX_PENDING_MESSAGES, MAX_PENDING_BYTES,
  RpcFault, EXPLORER_METHODS, errorResponse, isRecord, sanitizeResponse, validateHttpPayload, validateWsPayload,
  type RpcId, type RpcRequest,
} from "./policy";

const encoder = new TextEncoder();
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "600",
  "Cache-Control": "no-store",
};
const MAX_SOCKETS = 100;
const MAX_IN_FLIGHT = 64;
const CONNECT_TIMEOUT_MS = 5_000;
const UPSTREAM_TIMEOUT_MS = 20_000;

export type GatewayOptions = {
  port?: number;
  hostname?: string;
  elUrl: string;
  mempoolUrl: string;
  mempoolWsUrl: string;
  explorer?: ChainExplorer;
};

type SocketState = {
  upstream?: WebSocket;
  queue: string[];
  queuedBytes: number;
  closed: boolean;
  deadline?: ReturnType<typeof setTimeout>;
  windowStart: number;
  messages: number;
  pendingSubscribeId?: RpcId;
  subscriptionId?: string;
  pendingUnsubscribeId?: RpcId;
};

async function readBounded(stream: ReadableStream<Uint8Array> | null, maximum: number): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximum) {
        await reader.cancel();
        throw new RpcFault(-32005, "Message is too large", null, 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(merged); }
  catch { throw new RpcFault(-32700, "Invalid UTF-8 JSON"); }
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); }
  catch { throw new RpcFault(-32700, "Invalid JSON"); }
}

function validUrl(value: string, websocket = false): string {
  const url = new URL(value);
  if (!(websocket ? ["ws:", "wss:"] : ["http:", "https:"]).includes(url.protocol) ||
      url.username || url.password) throw new Error("Invalid upstream URL");
  return url.toString();
}

export function createGateway(options: GatewayOptions) {
  const elUrl = validUrl(options.elUrl);
  const mempoolUrl = validUrl(options.mempoolUrl);
  const mempoolWsUrl = validUrl(options.mempoolWsUrl, true);
  const clients = new Set<ServerWebSocket<SocketState>>();
  let inFlight = 0;

  async function forward(request: RpcRequest, url: string) {
    if (EXPLORER_METHODS.has(request.method)) {
      if (!options.explorer) return errorResponse(new RpcFault(-32004, "Chain explorer is not enabled", request.id, 503));
      try {
        return { jsonrpc: "2.0", id: request.id, result: options.explorer.handle(request.method, request.params) };
      } catch (error) {
        if (error instanceof RpcFault) error.id = request.id;
        return errorResponse(error, request.id);
      }
    }
    if (inFlight >= MAX_IN_FLIGHT) {
      return errorResponse(new RpcFault(-32005, "Gateway is busy; retry shortly", request.id, 503));
    }
    inFlight++;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        redirect: "error",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error("Upstream HTTP error");
      return sanitizeResponse(parseJson(await readBounded(response.body, MAX_RESPONSE_BYTES)), request.id);
    } catch (error) {
      if (error instanceof RpcFault && error.code === -32002) return errorResponse(error);
      return errorResponse(new RpcFault(-32002, "Upstream RPC is unavailable", request.id, 502));
    } finally { inFlight--; }
  }

  function closeBridge(client: ServerWebSocket<SocketState>, code: number, reason: string) {
    const state = client.data;
    if (state.closed) return;
    state.closed = true;
    clearTimeout(state.deadline);
    state.queue.length = 0;
    state.queuedBytes = 0;
    state.pendingSubscribeId = undefined;
    state.subscriptionId = undefined;
    state.pendingUnsubscribeId = undefined;
    state.upstream?.close(1000, "Gateway connection closed");
    client.close(code, reason);
    clients.delete(client);
  }

  const websocket: WebSocketHandler<SocketState> & {
    // Bun 1.4.4 supports this hook; the workspace's older Bun declarations omit it.
    error(error: unknown, client: ServerWebSocket<SocketState>): void;
  } = {
      maxPayloadLength: MAX_WS_BYTES,
      backpressureLimit: 256 * 1024,
      closeOnBackpressureLimit: true,
      perMessageDeflate: false,
      idleTimeout: 60,
      open(client) {
        if (clients.size >= MAX_SOCKETS) { closeBridge(client, 1013, "Gateway is busy"); return; }
        clients.add(client);
        const state = client.data;
        try {
          const upstream = new WebSocket(mempoolWsUrl);
          state.upstream = upstream;
          state.deadline = setTimeout(() => closeBridge(client, 1013, "Upstream connection timed out"), CONNECT_TIMEOUT_MS);
          upstream.onopen = () => {
            if (state.closed) { upstream.close(); return; }
            clearTimeout(state.deadline);
            for (const message of state.queue) upstream.send(message);
            state.queue.length = 0;
            state.queuedBytes = 0;
          };
          upstream.onmessage = (event) => {
            if (state.closed) return;
            if (typeof event.data !== "string" || encoder.encode(event.data).byteLength > MAX_RESPONSE_BYTES) {
              closeBridge(client, 1009, "Invalid upstream message size"); return;
            }
            try {
              const message = parseJson(event.data);
              // The sidecar emits an extra empty acknowledgement after handled WS requests.
              if (isRecord(message) && Object.keys(message).length === 0) return;
              let output: unknown;
              if (isRecord(message) && message.jsonrpc === "2.0" &&
                  message.method === "skandha_subscription" && isRecord(message.params) &&
                  typeof message.params.subscription === "string" && Object.hasOwn(message.params, "result")) {
                output = { jsonrpc: "2.0", method: "skandha_subscription", params: {
                  subscription: message.params.subscription, result: message.params.result,
                } };
              } else if (isRecord(message) &&
                  (typeof message.id === "string" || typeof message.id === "number" || message.id === null)) {
                output = sanitizeResponse(message, message.id as RpcId);
                if (state.pendingSubscribeId !== undefined && message.id === state.pendingSubscribeId) {
                  state.pendingSubscribeId = undefined;
                  if (!Object.hasOwn(message, "error")) {
                    if (typeof message.result !== "string" || message.result.length === 0 || message.result.length > 256) {
                      throw new Error("Invalid subscription ID");
                    }
                    state.subscriptionId = message.result;
                  }
                } else if (state.pendingUnsubscribeId !== undefined && message.id === state.pendingUnsubscribeId) {
                  state.pendingUnsubscribeId = undefined;
                  if (message.result === "ok" || message.result === true) state.subscriptionId = undefined;
                }
              } else { throw new Error("Invalid upstream message"); }
              if (client.send(JSON.stringify(output)) === 0) closeBridge(client, 1013, "Client is too slow");
            } catch { closeBridge(client, 1011, "Invalid upstream response"); }
          };
          upstream.onerror = () => closeBridge(client, 1013, "Upstream WebSocket is unavailable");
          upstream.onclose = () => closeBridge(client, 1013, "Upstream WebSocket closed");
        } catch { closeBridge(client, 1013, "Upstream WebSocket is unavailable"); }
      },
      message(client, message) {
        const state = client.data;
        if (state.closed) return;
        if (typeof message !== "string") { closeBridge(client, 1003, "Send JSON text"); return; }
        const now = Date.now();
        if (now - state.windowStart >= 60_000) { state.windowStart = now; state.messages = 0; }
        if (++state.messages > 120) { closeBridge(client, 1008, "Too many messages"); return; }
        try {
          if (encoder.encode(message).byteLength > MAX_WS_BYTES) throw new RpcFault(-32005, "Message is too large");
          const parsed = validateWsPayload(parseJson(message));
          if (parsed.method === "skandha_subscribe") {
            if (state.pendingSubscribeId !== undefined || state.subscriptionId !== undefined) {
              throw new RpcFault(-32005, "Only one explorer subscription is allowed per connection", parsed.id);
            }
            state.pendingSubscribeId = parsed.id;
          } else {
            if (!state.subscriptionId || parsed.params[0] !== state.subscriptionId ||
                state.pendingUnsubscribeId !== undefined) {
              throw new RpcFault(-32602, "Subscription ID is not active on this connection", parsed.id);
            }
            state.pendingUnsubscribeId = parsed.id;
          }
          const serialized = JSON.stringify(parsed);
          const upstream = state.upstream;
          if (upstream?.readyState === WebSocket.OPEN) {
            if (upstream.bufferedAmount + encoder.encode(serialized).byteLength > MAX_PENDING_BYTES) {
              closeBridge(client, 1013, "Upstream is too slow"); return;
            }
            upstream.send(serialized);
          } else {
            const bytes = encoder.encode(serialized).byteLength;
            if (state.queue.length >= MAX_PENDING_MESSAGES || state.queuedBytes + bytes > MAX_PENDING_BYTES) {
              closeBridge(client, 1013, "Upstream queue is full"); return;
            }
            state.queue.push(serialized);
            state.queuedBytes += bytes;
          }
        } catch (error) { client.send(JSON.stringify(errorResponse(error))); }
      },
      close(client) { closeBridge(client, 1000, "Client closed"); },
      error(_error: unknown, client: ServerWebSocket<SocketState>) { closeBridge(client, 1011, "Gateway WebSocket error"); },
  };

  return Bun.serve<SocketState, {}>({
    port: options.port ?? 8080,
    hostname: options.hostname ?? "0.0.0.0",
    maxRequestBodySize: MAX_HTTP_BYTES + 1024,
    idleTimeout: 30,
    async fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (path === "/healthz" && request.method === "GET") {
        return Response.json({ ok: true }, { headers: cors });
      }
      const route = ["/rpc", "/rpc/"].includes(path) ? "rpc" :
        ["/mempool", "/mempool/"].includes(path) ? "mempool" : null;
      if (!route) return new Response("Not found", { status: 404, headers: cors });
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (route !== "mempool" || request.method !== "GET") {
          return new Response("WebSocket is available only at /mempool", { status: 403, headers: cors });
        }
        if (clients.size >= MAX_SOCKETS) return new Response("Gateway is busy", { status: 503, headers: cors });
        const upgraded = server.upgrade(request, {
          data: { queue: [], queuedBytes: 0, closed: false, windowStart: Date.now(), messages: 0 },
          headers: { "Access-Control-Allow-Origin": "*" },
        });
        return upgraded ? undefined : new Response("Upgrade failed", { status: 400, headers: cors });
      }
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      if (request.method !== "POST") return new Response("Use POST", { status: 405, headers: cors });
      if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
        return new Response("Use application/json", { status: 415, headers: cors });
      }
      try {
        const raw = parseJson(await readBounded(request.body, MAX_HTTP_BYTES));
        const parsed = validateHttpPayload(raw, route);
        const upstream = route === "rpc" ? elUrl : mempoolUrl;
        const result = Array.isArray(parsed) ?
          await Promise.all(parsed.map((item) => forward(item, upstream))) : await forward(parsed, upstream);
        return Response.json(result, { headers: cors });
      } catch (error) {
        return Response.json(errorResponse(error), {
          status: error instanceof RpcFault ? error.status : 500, headers: cors,
        });
      }
    },
    websocket,
    error() { return new Response("Gateway request failed", { status: 500, headers: cors }); },
  });
}

if (import.meta.main) {
  const elUrl = process.env.EL_RPC_URL ?? "http://ethrex:8545";
  const explorer = new ChainExplorer({
    rpc: createInternalChainRpc(elUrl),
    path: process.env.EXPLORER_DB_PATH ?? "/data/explorer.sqlite",
  });
  const server = createGateway({
    port: Number(process.env.PORT ?? 8080), elUrl, explorer,
    mempoolUrl: process.env.MEMPOOL_RPC_URL ?? "http://sidecar:14337/rpc/",
    mempoolWsUrl: process.env.MEMPOOL_WS_URL ?? "ws://sidecar:14337/rpc/",
  });
  explorer.start();
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    server.stop(true);
    await explorer.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  console.log("Public RPC gateway listening on port " + server.port);
}
