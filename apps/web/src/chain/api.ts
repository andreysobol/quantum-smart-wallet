import type {
  ApiErrorBody,
  ApiErrorCode,
  CreateAccountRequest,
  CreateAccountResponse,
  FaucetRequest,
  FaucetResponse,
  PublicConfig,
  SponsorRequest,
  SponsorResponse,
} from "../../shared/types.js";

/** Error from the app's own /api endpoints, with the server's code and message. */
export class ApiError extends Error {
  constructor(
    public readonly code: ApiErrorCode | "network",
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { timeoutMs = 90_000, ...rest } = init;
  let response: Response;
  try {
    response = await fetch(path, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new ApiError("network", "The wallet server could not be reached. Check your connection and try again.", 0);
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // handled below
  }
  if (!response.ok) {
    const error = (body as ApiErrorBody | null)?.error;
    throw new ApiError(
      error?.code ?? "internal",
      error?.message ?? `The wallet server returned HTTP ${response.status}.`,
      response.status,
    );
  }
  return body as T;
}

const post = <T>(path: string, body: unknown) =>
  request<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const api = {
  config: () => request<PublicConfig>("/api/config", { timeoutMs: 20_000 }),
  createAccount: (body: CreateAccountRequest) => post<CreateAccountResponse>("/api/account", body),
  faucet: (body: FaucetRequest) => post<FaucetResponse>("/api/faucet", body),
  sponsor: (body: SponsorRequest) => post<SponsorResponse>("/api/sponsor", body),
};
