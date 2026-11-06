import { configRoute } from "../server/routes.js";

/** GET /api/config: public deployment + sponsor configuration (no secrets). */
export function GET(request: Request): Promise<Response> {
  return configRoute(request);
}
