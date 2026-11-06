import { accountRoute } from "../server/routes.js";

/** POST /api/account {publicKey}: create (or find) the QuantumAccount for a public key. */
export function POST(request: Request): Promise<Response> {
  return accountRoute(request);
}
