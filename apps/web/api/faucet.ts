import { faucetRoute } from "../server/routes.js";

/** POST /api/faucet {account}: mint test dUSDC to a registered account. */
export function POST(request: Request): Promise<Response> {
  return faucetRoute(request);
}
