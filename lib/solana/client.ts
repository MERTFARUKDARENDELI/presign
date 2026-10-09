import "server-only";
import { AppError } from "@/lib/api/errors";
import { logger } from "@/lib/api/logger";
import { getRpcProviders, type RpcProvider } from "./config";

/**
 * JSON-RPC client with timeout, bounded exponential backoff and
 * capability-aware fallback. DAS methods never fall back to a provider that
 * cannot serve them; callers get an explicit error and must report the data
 * as unavailable instead of assuming "safe".
 */

export const DAS_METHODS = new Set(["getAsset", "getAssetBatch", "getAssetsByOwner", "searchAssets"]);

export interface RpcCallOptions {
  timeoutMs?: number;
  /** Retries per provider for transient failures (total attempts = retries + 1). */
  retries?: number;
}

export interface RpcCallResult<T> {
  result: T;
  source: RpcProvider["source"];
  fallbackUsed: boolean;
}

export class RpcRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly rpcCode?: number,
  ) {
    super(message);
    this.name = "RpcRequestError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * At most this many requests in flight per provider in one server instance
 * (CLAUDE.md rule 2: Helius answers 429 beyond it). Every RPC call goes through
 * here, so callers that fan out (recipient history, multisig history, token
 * scans, several users at once) queue instead of each needing a limit of its
 * own. A request's timeout starts when it is sent, not while it waits; a retry
 * waits out its back-off without holding a slot.
 */
export const RPC_CONCURRENCY = 4;
/** Requests that may wait for a slot per provider; beyond that the call fails (retryable) instead of queueing without end. */
export const RPC_QUEUE_LIMIT = 500;

interface Slots {
  active: number;
  waiting: Array<() => void>;
}
const slots = new Map<RpcProvider["name"], Slots>();

/** Runs `task` in one of the provider's slots. A freed slot passes straight to the next waiter, so the count never goes above the limit. */
async function inSlot<T>(provider: RpcProvider["name"], task: () => Promise<T>): Promise<T> {
  let s = slots.get(provider);
  if (!s) slots.set(provider, (s = { active: 0, waiting: [] }));
  if (s.active < RPC_CONCURRENCY) s.active++;
  else {
    if (s.waiting.length >= RPC_QUEUE_LIMIT) throw new RpcRequestError("RPC queue full", true);
    await new Promise<void>((resolve) => s.waiting.push(resolve));
  }
  try {
    return await task();
  } finally {
    const next = s.waiting.shift();
    if (next) next();
    else s.active--;
  }
}

/** Requests in flight and waiting, per provider (tests and diagnostics). */
export function rpcSlotUsage(): Record<string, { active: number; waiting: number }> {
  return Object.fromEntries([...slots].map(([name, s]) => [name, { active: s.active, waiting: s.waiting.length }]));
}

let requestId = 0;

async function callProvider<T>(
  provider: RpcProvider,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(provider.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new RpcRequestError(timedOut ? "RPC request timed out" : "RPC network error", true);
  }

  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    throw new RpcRequestError(`RPC HTTP ${response.status}`, retryable);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new RpcRequestError("RPC returned malformed JSON", true);
  }

  if (!body || typeof body !== "object") {
    throw new RpcRequestError("RPC returned malformed response", true);
  }
  const obj = body as { result?: unknown; error?: { code?: number; message?: string } };
  if (obj.error) {
    const code = typeof obj.error.code === "number" ? obj.error.code : undefined;
    // -32005 node behind / -32004 block not available / -32016 min context slot not reached / -32603 internal are transient.
    const retryable = code === -32005 || code === -32004 || code === -32016 || code === -32603 || code === 429;
    throw new RpcRequestError(`RPC error ${code ?? "?"}: ${String(obj.error.message ?? "").slice(0, 200)}`, retryable, code);
  }
  if (!("result" in obj)) {
    throw new RpcRequestError("RPC response missing result", true);
  }
  return obj.result as T;
}

export async function rpcCall<T>(
  method: string,
  params: unknown,
  options: RpcCallOptions = {},
): Promise<RpcCallResult<T>> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retries = Math.min(options.retries ?? 2, 4);
  const needsDas = DAS_METHODS.has(method);

  const providers = getRpcProviders().filter((p) => !needsDas || p.supportsDas);
  if (providers.length === 0) {
    throw new AppError(
      "NOT_CONFIGURED",
      needsDas
        ? "Enhanced asset data (Helius DAS) is not available: HELIUS_API_KEY is not configured."
        : "No Solana RPC provider is configured.",
    );
  }

  let lastError: RpcRequestError | null = null;
  for (let index = 0; index < providers.length; index++) {
    const provider = providers[index];
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await inSlot(provider.name, () => callProvider<T>(provider, method, params, timeoutMs));
        if (index > 0) {
          logger.warn("rpc.fallback_used", { method, provider: provider.name });
        }
        return { result, source: provider.source, fallbackUsed: index > 0 };
      } catch (error) {
        lastError = error instanceof RpcRequestError ? error : new RpcRequestError("RPC failure", true);
        if (!lastError.retryable) {
          // Deterministic error (bad params, not found): another provider will answer the same.
          throw new AppError("RPC_ERROR", "The Solana RPC rejected the request.", {
            method,
            rpcCode: lastError.rpcCode,
          });
        }
        // A rate limit needs a real pause; other transient errors retry quickly.
        const rateLimited = lastError.rpcCode === 429 || /HTTP 429/.test(lastError.message);
        if (attempt < retries) await sleep(rateLimited ? Math.min(1_000 * (attempt + 1), 3_000) : Math.min(200 * 2 ** attempt, 2_000));
      }
    }
    logger.warn("rpc.provider_failed", { method, provider: provider.name, reason: lastError?.message });
  }

  throw new AppError("RPC_ERROR", "Solana RPC providers are currently unavailable.", { method });
}
