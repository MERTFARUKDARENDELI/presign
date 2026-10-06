import "server-only";
import { ZodError } from "zod";
import { AppError, isAppError } from "./errors";
import { logger } from "./logger";
import { checkRateLimitShared, clientKey } from "./rate-limit";
import { fail } from "./response";

export interface RouteOptions {
  name: string;
  /** Requests per window per client. */
  limit: number;
  windowMs: number;
}

/**
 * Wraps a route handler with rate limiting, validation-error mapping and
 * safe error responses (internal details stay in server logs).
 */
export function withApi(
  options: RouteOptions,
  handler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const rl = await checkRateLimitShared(`${options.name}:${clientKey(request)}`, options.limit, options.windowMs);
    if (!rl.allowed) {
      logger.warn("api.rate_limited", { route: options.name });
      return fail("RATE_LIMITED", "Too many requests. Please retry shortly.", 429, undefined, {
        "Retry-After": String(rl.retryAfterSeconds),
      });
    }

    try {
      return await handler(request);
    } catch (error) {
      if (error instanceof ZodError) {
        return fail("INVALID_INPUT", "Request validation failed.", 400, {
          issues: error.issues.slice(0, 5).map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      }
      if (isAppError(error)) {
        if (error.status >= 500) logger.warn("api.upstream_error", { route: options.name, code: error.code, error });
        return fail(error.code, error.message, error.status, error.details);
      }
      logger.error("api.unhandled_error", { route: options.name, error });
      return fail("UNKNOWN_ERROR", "An unexpected error occurred.", 500);
    }
  };
}

/**
 * Reads at most maxBytes of the body: a declared Content-Length above the limit
 * is refused before anything is read, and a body without one (or lying about
 * it) is cut off as soon as it passes the limit, never buffered whole.
 */
export async function readJsonBody(request: Request, maxBytes = 256_000): Promise<unknown> {
  const tooLarge = () => new AppError("INVALID_INPUT", "Request body is too large.");
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  let text = "";
  if (request.body) {
    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError("INVALID_INPUT", "Request body must be valid JSON.");
  }
}
