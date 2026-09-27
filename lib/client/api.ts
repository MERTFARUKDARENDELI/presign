import type { ApiResponse } from "@/lib/api/response";

export class ApiClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Typed fetch for our own API routes (standard ApiResponse envelope). */
export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  let res: Response;
  try {
    res = await fetch(path, {
      ...rest,
      method: rest.method ?? (json !== undefined ? "POST" : "GET"),
      headers: json !== undefined ? { "Content-Type": "application/json", ...rest.headers } : rest.headers,
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    throw new ApiClientError("NETWORK_ERROR", "Network error — check your connection.", 0);
  }
  let body: ApiResponse<T> | null = null;
  try {
    body = (await res.json()) as ApiResponse<T>;
  } catch {
    throw new ApiClientError("BAD_RESPONSE", "Unexpected server response.", res.status);
  }
  if (!res.ok || !body.success || body.data === null) {
    throw new ApiClientError(body.error?.code ?? "UNKNOWN_ERROR", body.error?.message ?? "Request failed.", res.status, body.error?.details);
  }
  return body.data;
}
