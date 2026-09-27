import "server-only";
import { APICallError, RetryError } from "ai";
import { logger } from "@/lib/api/logger";

/**
 * AI readiness without probing the provider on health polls. The health
 * endpoint must not call OpenAI (cost, latency, rate limits), so readiness is
 * derived from configuration plus the outcome of the last REAL provider call in
 * this server process (an agent call, or an explicit on-demand diagnostic):
 *   NOT_CONFIGURED — no key
 *   INVALID_KEY    — key malformed, or the provider rejected it (401/403)
 *   CONFIGURED     — key present, not yet exercised (unverified — NOT "ready")
 *   READY          — the last provider call succeeded
 *   UNAVAILABLE    — the last provider call failed for another reason (network, 429, 5xx)
 * An INVALID_KEY verdict sticks until restart (keys only change with the env),
 * so a rejected key is not re-sent to the provider on every chat message.
 * Nothing here ever exposes or logs the key itself.
 */
export type AiStatus = "NOT_CONFIGURED" | "CONFIGURED" | "READY" | "INVALID_KEY" | "UNAVAILABLE";

type Outcome = "READY" | "INVALID_KEY" | "UNAVAILABLE";

interface AiStatusState {
  lastOutcome: Outcome | null;
  diagnostic: { at: number; status: AiStatus } | null;
  inFlight: Promise<AiStatus> | null;
}

// Kept on globalThis so every route bundle in this process shares one verdict.
const STATE_KEY = Symbol.for("solana-ai-defender.ai-status");
function state(): AiStatusState {
  const g = globalThis as unknown as Record<symbol, AiStatusState | undefined>;
  return (g[STATE_KEY] ??= { lastOutcome: null, diagnostic: null, inFlight: null });
}

function configuredKey(): string | null {
  return process.env.OPENAI_API_KEY?.trim() || null;
}

/** OpenAI secret keys always start with "sk-"; anything else cannot authenticate. */
function hasPlausibleKeyFormat(key: string): boolean {
  return key.startsWith("sk-") && key.length >= 20 && !/\s/.test(key);
}

export function getAiStatus(): AiStatus {
  const key = configuredKey();
  if (!key) return "NOT_CONFIGURED";
  if (!hasPlausibleKeyFormat(key)) return "INVALID_KEY";
  return state().lastOutcome ?? "CONFIGURED";
}

/** Only READY means a real provider call succeeded; CONFIGURED is unverified. */
export function isAiVerified(status: AiStatus): boolean {
  return status === "READY";
}

/** True when an error means the provider rejected the credentials (not a transient failure). */
export function isAuthError(error: unknown): boolean {
  const inner = RetryError.isInstance(error) ? error.lastError : error;
  return APICallError.isInstance(inner) && (inner.statusCode === 401 || inner.statusCode === 403);
}

export function recordAiSuccess(): void {
  state().lastOutcome = "READY";
}

export function recordAiFailure(error: unknown): void {
  state().lastOutcome = isAuthError(error) ? "INVALID_KEY" : "UNAVAILABLE";
}

export const AI_DIAGNOSTIC_TTL_MS = 10 * 60_000;
const DIAGNOSTIC_TIMEOUT_MS = 8_000;

export interface AiDiagnostic {
  status: AiStatus;
  /** ISO time of the provider check; null when no network call was needed (no key / known-invalid key). */
  checkedAt: string | null;
  cached: boolean;
}

/**
 * On-demand key check — never called by /api/health. Uses the provider's
 * model-list endpoint, which authenticates the key without generating tokens.
 * Results are cached for AI_DIAGNOSTIC_TTL_MS and concurrent calls share one
 * request; a missing or already-rejected key never goes over the network.
 */
export async function diagnoseAi(now: number = Date.now()): Promise<AiDiagnostic> {
  const s = state();
  const current = getAiStatus();
  if (current === "NOT_CONFIGURED" || current === "INVALID_KEY") {
    return { status: current, checkedAt: s.diagnostic ? new Date(s.diagnostic.at).toISOString() : null, cached: true };
  }
  if (s.diagnostic && now - s.diagnostic.at < AI_DIAGNOSTIC_TTL_MS) {
    return { status: getAiStatus(), checkedAt: new Date(s.diagnostic.at).toISOString(), cached: true };
  }
  s.inFlight ??= probeProvider()
    .then((status) => {
      s.diagnostic = { at: now, status };
      return status;
    })
    .finally(() => {
      s.inFlight = null;
    });
  await s.inFlight;
  return { status: getAiStatus(), checkedAt: new Date(now).toISOString(), cached: false };
}

async function probeProvider(): Promise<AiStatus> {
  const key = configuredKey();
  if (!key) return "NOT_CONFIGURED";
  const s = state();
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(DIAGNOSTIC_TIMEOUT_MS),
      cache: "no-store",
    });
    // Body is never read or logged; only the status code matters.
    await res.body?.cancel().catch(() => {});
    if (res.ok) s.lastOutcome = "READY";
    else if (res.status === 401 || res.status === 403) s.lastOutcome = "INVALID_KEY";
    else s.lastOutcome = "UNAVAILABLE";
    logger.info("ai.diagnostic", { httpStatus: res.status, outcome: s.lastOutcome });
  } catch {
    s.lastOutcome = "UNAVAILABLE";
    logger.warn("ai.diagnostic", { outcome: "UNAVAILABLE", reason: "network_or_timeout" });
  }
  return s.lastOutcome;
}

/** Test seam: resets the in-process outcome and diagnostic cache. */
export function resetAiStatus(): void {
  const s = state();
  s.lastOutcome = null;
  s.diagnostic = null;
  s.inFlight = null;
}
