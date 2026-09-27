export type ApiErrorCode =
  | "INVALID_INPUT"
  | "INVALID_WALLET"
  | "INVALID_MINT"
  | "INVALID_TRANSACTION"
  | "UNSUPPORTED_TRANSACTION"
  | "WALLET_NOT_FOUND"
  | "TOKEN_NOT_FOUND"
  | "TRANSACTION_NOT_FOUND"
  | "ACCOUNT_NOT_FOUND"
  | "RPC_ERROR"
  | "API_ERROR"
  | "RATE_LIMITED"
  | "SIMULATION_FAILED"
  | "AI_ERROR"
  | "AI_UNAVAILABLE"
  | "NOT_CONFIGURED"
  | "CLEANUP_NOT_ELIGIBLE"
  | "OWNERSHIP_MISMATCH"
  | "INSUFFICIENT_SOL"
  | "SECURITY_BLOCK"
  | "UNKNOWN_ERROR";

const STATUS_BY_CODE: Partial<Record<ApiErrorCode, number>> = {
  INVALID_INPUT: 400,
  INVALID_WALLET: 400,
  INVALID_MINT: 400,
  INVALID_TRANSACTION: 400,
  UNSUPPORTED_TRANSACTION: 422,
  WALLET_NOT_FOUND: 404,
  TOKEN_NOT_FOUND: 404,
  TRANSACTION_NOT_FOUND: 404,
  ACCOUNT_NOT_FOUND: 404,
  RATE_LIMITED: 429,
  NOT_CONFIGURED: 503,
  AI_UNAVAILABLE: 503,
  CLEANUP_NOT_ELIGIBLE: 422,
  OWNERSHIP_MISMATCH: 403,
  INSUFFICIENT_SOL: 422,
  SECURITY_BLOCK: 409,
  RPC_ERROR: 502,
  API_ERROR: 502,
};

/**
 * Error safe to show to users. `message` must never contain secrets,
 * provider URLs or stack traces; diagnostic detail stays server-side.
 */
export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ApiErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS_BY_CODE[code] ?? 500;
    this.details = details;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
