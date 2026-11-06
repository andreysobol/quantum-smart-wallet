import { sponsorRoute } from "../server/routes.js";

/** POST /api/sponsor {tx}: validate a PQ-signed swap and co-sign it as the gas sponsor. */
export function POST(request: Request): Promise<Response> {
  return sponsorRoute(request);
}
