import type { ApiErrorCode } from "./errors";

export interface ApiError {
  code: ApiErrorCode | string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ApiResponse<T> {
  success: boolean;
  data: T | null;
  error: ApiError | null;
}

/** JSON replacer that serializes bigint as decimal strings (u64 values never lose precision). */
export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function toJson(value: unknown): string {
  return JSON.stringify(value, bigintReplacer);
}

function jsonResponse(body: unknown, status: number, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json; charset=utf-8");
  h.set("Cache-Control", "no-store");
  return new Response(toJson(body), { status, headers: h });
}

export function ok<T>(data: T, init?: { status?: number; headers?: HeadersInit }): Response {
  const body: ApiResponse<T> = { success: true, data, error: null };
  return jsonResponse(body, init?.status ?? 200, init?.headers);
}

export function fail(
  code: ApiErrorCode,
  message: string,
  status: number,
  details?: Record<string, unknown>,
  headers?: HeadersInit,
): Response {
  const body: ApiResponse<null> = {
    success: false,
    data: null,
    error: { code, message, ...(details ? { details } : {}) },
  };
  return jsonResponse(body, status, headers);
}
