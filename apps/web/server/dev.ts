import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { createServer, loadEnv, type Plugin, type ViteDevServer } from "vite";

const ROUTES = new Set(["config", "account", "faucet", "sponsor"]);
type Handler = (request: Request) => Promise<Response> | Response;
type LoadModule = (path: string) => Promise<Record<string, unknown>>;

/**
 * Node request -> Web Request. The client IP (rate-limit key) comes from the socket only: Vercel's
 * edge overwrites these headers, and a dev or preview server must not trust client-sent ones either.
 */
export function toRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
    else if (value !== undefined) headers.set(name, value);
  }
  for (const name of ["x-real-ip", "x-forwarded-for", "x-vercel-forwarded-for"]) headers.delete(name);
  if (req.socket.remoteAddress) headers.set("x-real-ip", req.socket.remoteAddress);
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(url, init);
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
}

function middleware(load: () => Promise<LoadModule>) {
  return async (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => {
    const match = /^\/api\/([a-z]+)\/?(?:\?.*)?$/.exec(req.url ?? "");
    if (!match) return next();
    const name = match[1] as string;
    const reply = (status: number, code: string, message: string) =>
      send(res, Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } }));
    try {
      if (!ROUTES.has(name)) return await reply(404, "bad_request", `Unknown API route /api/${name}.`);
      const mod = await (await load())(`/api/${name}.ts`);
      const handler = mod[req.method ?? "GET"];
      if (typeof handler !== "function") return await reply(405, "bad_request", `Method ${req.method} is not allowed on /api/${name}.`);
      await send(res, await (handler as Handler)(toRequest(req)));
    } catch (error) {
      console.error(`[api dev] /api/${name} failed:`, error instanceof Error ? error.message : error);
      if (!res.headersSent) await reply(500, "internal", "The dev API handler crashed; see the Vite console.");
    }
  };
}

/** Copy QSW_* variables from .env / .env.local / .env.[mode] into process.env (never VITE_*). */
function loadServerEnv(mode: string, root: string): void {
  for (const [name, value] of Object.entries(loadEnv(mode, root, "QSW_"))) {
    if (process.env[name] === undefined) process.env[name] = value;
  }
}

/**
 * Serves api/*.ts in `vite dev` and `vite preview` with the same Web-standard
 * handlers Vercel runs, so the browser always talks to same-origin /api/*.
 */
export function apiDevPlugin(): Plugin {
  let root = process.cwd();
  let mode = "development";
  return {
    name: "qsw-api-dev",
    configResolved(config) {
      root = config.root;
      mode = config.mode;
    },
    configureServer(server: ViteDevServer) {
      loadServerEnv(mode, root);
      server.middlewares.use(middleware(async () => (path) => server.ssrLoadModule(path)));
    },
    configurePreviewServer(server) {
      loadServerEnv(mode, root);
      // The preview server cannot load TS modules itself: use a private SSR-only Vite server.
      let loader: Promise<ViteDevServer> | null = null;
      const load = async (): Promise<LoadModule> => {
        loader ??= createServer({ root, configFile: false, logLevel: "error", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
        const ssr = await loader;
        return (path) => ssr.ssrLoadModule(path);
      };
      server.middlewares.use(middleware(load));
      server.httpServer?.once("close", () => void loader?.then((s) => s.close()));
    },
  };
}
