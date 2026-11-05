import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createGateway } from "./server";
import {
  MAX_BATCH, MAX_HTTP_BYTES, MAX_PENDING_MESSAGES, MAX_WS_BYTES,
  RpcFault, validateHttpPayload, validateWsPayload,
} from "./policy";

const rpc = (method: string, params: unknown[] = [], id: string | number = 1) =>
  ({ jsonrpc: "2.0", id, method, params });
const received: Array<{ path: string; body: Record<string, unknown>; authorization: string | null }> = [];
const wsReceived: Record<string, unknown>[] = [];
let holdUnsubscribe = false;
let acknowledgeUnsubscribe: (() => void) | undefined;

const upstream = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  async fetch(request, server) {
    if (request.headers.get("upgrade") === "websocket") {
      if (server.upgrade(request)) return;
      return new Response("No upgrade", { status: 400 });
    }
    const body = await request.json() as Record<string, unknown>;
    received.push({ path: new URL(request.url).pathname, body, authorization: request.headers.get("authorization") });
    if (body.method === "eth_getCode") return Response.json({
      jsonrpc: "2.0", id: body.id,
      error: { code: -32001, message: "Contract unavailable", data: { internalStack: "must not leave the backend" } },
    });
    return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x539" });
  },
  websocket: {
    message(socket, message) {
      const request = JSON.parse(message.toString()) as Record<string, unknown>;
      wsReceived.push(request);
      if (request.method === "skandha_unsubscribe") {
        const acknowledge = () => socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "ok" }));
        if (holdUnsubscribe) acknowledgeUnsubscribe = acknowledge; else acknowledge();
        return;
      }
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "subscription-1" }));
      if (request.method === "skandha_subscribe") socket.send(JSON.stringify({
        jsonrpc: "2.0", method: "skandha_subscription",
        params: { subscription: "subscription-1", result: { seq: 1, type: "admitted" } },
      }));
      socket.send("{}");
    },
  },
});
const gateway = createGateway({
  port: 0, hostname: "127.0.0.1",
  elUrl: upstream.url + "el", mempoolUrl: upstream.url + "rpc/",
  mempoolWsUrl: upstream.url.toString().replace("http:", "ws:") + "rpc/",
});
const sockets: WebSocket[] = [];

async function post(body: unknown, path = "/rpc") {
  return fetch(new URL(path, gateway.url), {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "do-not-forward" },
    body: JSON.stringify(body),
  });
}

async function openClient(url = new URL("/mempool", gateway.url).toString().replace("http:", "ws:")) {
  const socket = new WebSocket(url);
  sockets.push(socket);
  const messages: unknown[] = [];
  const waiting: Array<(value: unknown) => void> = [];
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data.toString());
    const resolve = waiting.shift();
    if (resolve) resolve(message); else messages.push(message);
  };
  const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("Socket upgrade failed")), { once: true });
  });
  return {
    socket, closed,
    next(): Promise<any> {
      if (messages.length) return Promise.resolve(messages.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("No WebSocket response")), 1500);
        waiting.push((value) => { clearTimeout(timer); resolve(value); });
      });
    },
  };
}

beforeEach(() => { received.length = 0; wsReceived.length = 0; holdUnsubscribe = false; acknowledgeUnsubscribe = undefined; });
afterEach(() => { for (const socket of sockets.splice(0)) socket.close(); });
afterAll(() => { gateway.stop(true); upstream.stop(true); });

describe("HTTP gateway", () => {
  test("validates the whole batch before any member reaches a backend", async () => {
    const response = await post([rpc("eth_chainId"), rpc("debug_setHead", ["0x0"], 2)]);
    expect(response.status).toBe(403);
    expect((await response.json() as any).error.code).toBe(-32601);
    expect(received).toHaveLength(0);
  });

  test("routes allowed calls and strips unknown top-level fields and incoming credentials", async () => {
    const response = await post([
      { ...rpc("eth_chainId", [], 1), injected: "discard" },
      rpc("eth_blockNumber", [], 2),
    ]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { jsonrpc: "2.0", id: 1, result: "0x539" },
      { jsonrpc: "2.0", id: 2, result: "0x539" },
    ]);
    expect(received).toHaveLength(2);
    expect(received.every((item) => item.path === "/el" && item.authorization === null)).toBe(true);
    expect(received[0].body).not.toHaveProperty("injected");
    await post(rpc("eth_sendFrameTransaction", [{ sender: "0x1234" }]), "/mempool");
    expect(received[2].path).toBe("/rpc/");
  });

  test("blocks nested trace switches and private simulation before forwarding", async () => {
    for (const body of [
      rpc("eth_call", [{ to: "0x1234", trace: true }]),
      rpc("ethrex_simulateFrameTransaction", [{ rawTx: "0x06", trace: true }]),
      rpc("eth_call", [{}, "latest", { anyAddress: { code: "0x00" } }]),
    ]) expect((await post(body)).status).toBe(403);
    expect(received).toHaveLength(0);
  });

  test("limits batch size, nesting, request IDs, and body bytes", async () => {
    expect((await post([])).status).toBe(400);
    expect((await post(Array.from({ length: MAX_BATCH + 1 }, (_, i) => rpc("eth_chainId", [], i)))).status).toBe(400);
    expect((await post({ ...rpc("eth_chainId"), id: "x".repeat(129) })).status).toBe(400);
    let nested: any = {};
    for (let i = 0; i < 45; i++) nested = { nested };
    expect((await post(rpc("eth_call", [nested]))).status).toBe(400);
    const response = await fetch(new URL("/rpc", gateway.url), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: " ".repeat(MAX_HTTP_BYTES + 1),
    });
    expect(response.status).toBe(413);
    expect(received).toHaveLength(0);
  });

  test("provides CORS preflight, rejects malformed JSON, and hides upstream error data", async () => {
    const preflight = await fetch(new URL("/rpc", gateway.url), { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    const malformed = await fetch(new URL("/rpc", gateway.url), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{",
    });
    expect((await malformed.json() as any).error.code).toBe(-32700);
    const result = await (await post(rpc("eth_getCode", ["0x1234", "latest"]))).json();
    expect(result).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32001, message: "Contract unavailable" } });
  });
});

describe("WebSocket gateway", () => {
  test("rejects HTTP RPC methods on sockets and forwards only sanitized explorer subscriptions", async () => {
    const client = await openClient();
    client.socket.send(JSON.stringify(rpc("debug_bundler_clearState")));
    expect((await client.next()).error.code).toBe(-32601);
    client.socket.send(JSON.stringify([rpc("skandha_subscribe", ["explorerEvents"])]));
    expect((await client.next()).error.code).toBe(-32600);
    expect(wsReceived).toHaveLength(0);
    client.socket.send(JSON.stringify({
      ...rpc("skandha_subscribe", ["explorerEvents", 0], 7), ignored: "must not reach upstream",
    }));
    expect(await client.next()).toEqual({ jsonrpc: "2.0", id: 7, result: "subscription-1" });
    expect(await client.next()).toEqual({
      jsonrpc: "2.0", method: "skandha_subscription",
      params: { subscription: "subscription-1", result: { seq: 1, type: "admitted" } },
    });
    expect(wsReceived).toEqual([rpc("skandha_subscribe", ["explorerEvents", 0], 7)]);
  });

  test("blocks other channels, invalid cursors, trace flags, and nonstring unsubscribe IDs", () => {
    for (const body of [
      rpc("skandha_subscribe", ["pendingUserOps"]),
      rpc("skandha_subscribe", ["explorerEvents", -1]),
      rpc("skandha_subscribe", ["explorerEvents", 0, "extra"]),
      rpc("skandha_subscribe", ["explorerEvents", { trace: true }]),
      rpc("skandha_unsubscribe", [12]),
      rpc("skandha_unsubscribe", [""]),
      rpc("eth_sendFrameTransaction", [{}]),
    ]) expect(() => validateWsPayload(body)).toThrow(RpcFault);
    expect(validateWsPayload(rpc("skandha_unsubscribe", ["subscription-1"])).params).toEqual(["subscription-1"]);
  });

  test("closes oversized frames and rejects upgrades on the EL endpoint", async () => {
    const client = await openClient();
    client.socket.send(" ".repeat(MAX_WS_BYTES + 1));
    expect(await client.closed).toBe(1009);
    await expect(openClient(new URL("/rpc", gateway.url).toString().replace("http:", "ws:"))).rejects.toThrow();
  });

  test("bounds pending subscriptions before the upstream handshake finishes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let forwarded = 0;
    const slow = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      async fetch(request, server) {
        await gate;
        if (server.upgrade(request)) return;
        return new Response("No upgrade", { status: 400 });
      },
      websocket: {
        message(socket, text) {
          forwarded++;
          const message = JSON.parse(text.toString());
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: "slow-subscription" }));
        },
      },
    });
    const limited = createGateway({
      port: 0, hostname: "127.0.0.1", elUrl: upstream.url.toString(),
      mempoolUrl: upstream.url.toString(),
      mempoolWsUrl: slow.url.toString().replace("http:", "ws:"),
    });
    try {
      const client = await openClient(new URL("/mempool", limited.url).toString().replace("http:", "ws:"));
      client.socket.send(JSON.stringify(rpc("skandha_subscribe", ["explorerEvents"], 1)));
      for (let i = 0; i < MAX_PENDING_MESSAGES; i++) {
        client.socket.send(JSON.stringify(rpc("skandha_subscribe", ["explorerEvents"], i + 2)));
      }
      for (let i = 0; i < MAX_PENDING_MESSAGES; i++) expect((await client.next()).error.code).toBe(-32005);
      expect(forwarded).toBe(0);
      release();
      expect(await client.next()).toEqual({ jsonrpc: "2.0", id: 1, result: "slow-subscription" });
      expect(forwarded).toBe(1);
    } finally {
      release();
      limited.stop(true);
      slow.stop(true);
    }
  });

  test("releases an active subscription only after the matching successful unsubscribe response", async () => {
    const client = await openClient();
    client.socket.send(JSON.stringify(rpc("skandha_subscribe", ["explorerEvents"], 1)));
    await client.next();
    await client.next();
    client.socket.send(JSON.stringify(rpc("skandha_subscribe", ["explorerEvents"], 2)));
    expect((await client.next()).error.code).toBe(-32005);
    client.socket.send(JSON.stringify(rpc("skandha_unsubscribe", ["someone-elses-subscription"], 3)));
    expect((await client.next()).error.code).toBe(-32602);
    expect(wsReceived).toHaveLength(1);

    holdUnsubscribe = true;
    client.socket.send(JSON.stringify(rpc("skandha_unsubscribe", ["subscription-1"], 4)));
    client.socket.send(JSON.stringify(rpc("skandha_subscribe", ["explorerEvents"], 5)));
    expect((await client.next()).error.code).toBe(-32005);
    for (let i = 0; !acknowledgeUnsubscribe && i < 100; i++) await Bun.sleep(1);
    expect(acknowledgeUnsubscribe).toBeDefined();
    acknowledgeUnsubscribe!();
    expect(await client.next()).toEqual({ jsonrpc: "2.0", id: 4, result: "ok" });
    client.socket.send(JSON.stringify(rpc("skandha_subscribe", ["explorerEvents"], 6)));
    expect(await client.next()).toEqual({ jsonrpc: "2.0", id: 6, result: "subscription-1" });
    await client.next();
    expect(wsReceived.map((item) => item.method)).toEqual([
      "skandha_subscribe", "skandha_unsubscribe", "skandha_subscribe",
    ]);
  });

  test("bounds request frequency on an open socket", async () => {
    const client = await openClient();
    for (let i = 0; i < 121; i++) client.socket.send(JSON.stringify(rpc("eth_sign", [], i)));
    expect(await client.closed).toBe(1008);
    expect(wsReceived).toHaveLength(0);
  });
});

test("explicit allowlists reject private families and signing on both HTTP routes", () => {
  for (const method of [
    "admin_addPeer", "debug_setHead", "testing_buildBlockV1",
    "ethrex_submitPrivilegedFrameTransaction", "ethrex_simulateFrameTransaction",
    "eth_sign", "eth_sendTransaction", "debug_bundler_setPrivilegedRelayTargetBlock",
    "skandha_config", "skandha_explorer_faucet",
  ]) for (const route of ["rpc", "mempool"] as const) {
    expect(() => validateHttpPayload(rpc(method), route)).toThrow(RpcFault);
  }
});
