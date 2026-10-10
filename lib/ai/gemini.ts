import "server-only";
import { logger } from "@/lib/api/logger";

/**
 * Backup provider for the pre-sign explanations: Google's Gemini API, asked only
 * when Claude cannot answer (no or rejected key, credit or rate limit, outage).
 * Every request still asks Claude first, so Claude takes over again as soon as it
 * answers. Server-only; the key travels in a request header, never in the URL,
 * a log or a response.
 */

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
// A model name only (e.g. "gemini-3.5-flash-lite"): it becomes part of the request path.
const MODEL_NAME = /^[a-z0-9][a-z0-9.-]{0,63}$/;
// The prompt or the answer was stopped by Gemini's own filters.
const BLOCKED_FINISH = new Set(["SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "RECITATION"]);

export function geminiKey(): string | null {
  return process.env.GEMINI_API_KEY?.trim() || null;
}

export function geminiModel(): string {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
}

export interface FallbackRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
}

export type FallbackResult = { kind: "text"; text: string } | { kind: "blocked" };

export type GenerateFallback = (request: FallbackRequest, options?: { signal?: AbortSignal }) => Promise<FallbackResult>;

interface GenerateContentResponse {
  promptFeedback?: { blockReason?: string };
  candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: unknown; thought?: unknown }> } }>;
}

/** One generateContent call. Throws on a missing key, a bad model name, an HTTP error or a network failure. */
export const generateWithGemini: GenerateFallback = async (request, options = {}) => {
  const key = geminiKey();
  if (!key) throw new Error("Gemini is not configured.");
  const model = geminiModel();
  if (!MODEL_NAME.test(model)) throw new Error("GEMINI_MODEL is not a model name.");
  const res = await fetch(`${BASE}/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: "user", parts: [{ text: request.user }] }],
      generationConfig: { maxOutputTokens: request.maxOutputTokens },
    }),
    signal: options.signal,
    cache: "no-store",
  });
  // The status only: Google's error body can echo request details.
  if (!res.ok) throw new Error(`Gemini answered HTTP ${res.status}.`);
  const data = (await res.json()) as GenerateContentResponse;
  if (data.promptFeedback?.blockReason) return { kind: "blocked" };
  const candidate = data.candidates?.[0];
  if (candidate?.finishReason && BLOCKED_FINISH.has(candidate.finishReason)) return { kind: "blocked" };
  const text = (candidate?.content?.parts ?? [])
    .filter((p) => p.thought !== true && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("")
    .trim();
  return { kind: "text", text };
};

export type GeminiStatus = "NOT_CONFIGURED" | "READY" | "INVALID_KEY" | "MODEL_NOT_FOUND" | "UNAVAILABLE";

export interface GeminiDiagnostic {
  provider: "gemini";
  model: string;
  status: GeminiStatus;
  cached: boolean;
}

const DIAGNOSTIC_TTL_MS = 10 * 60_000;
let diagnostic: { at: number; model: string; status: GeminiStatus } | null = null;

/**
 * On-demand check of the backup key and model. Reads the model's metadata, which
 * authenticates the key without generating tokens; cached for ten minutes. Without
 * a key nothing goes over the network.
 */
export async function diagnoseGemini(now: number = Date.now()): Promise<GeminiDiagnostic> {
  const key = geminiKey();
  const model = geminiModel();
  if (!key) return { provider: "gemini", model, status: "NOT_CONFIGURED", cached: true };
  if (!MODEL_NAME.test(model)) return { provider: "gemini", model: "[invalid]", status: "MODEL_NOT_FOUND", cached: true };
  if (diagnostic && diagnostic.model === model && now - diagnostic.at < DIAGNOSTIC_TTL_MS) return { provider: "gemini", model, status: diagnostic.status, cached: true };
  let status: GeminiStatus;
  try {
    const res = await fetch(`${BASE}/${model}`, { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(8_000), cache: "no-store" });
    // Google answers an unknown key with 400 (API_KEY_INVALID), a key without access with 403.
    status = res.ok ? "READY" : res.status === 404 ? "MODEL_NOT_FOUND" : res.status === 400 || res.status === 401 || res.status === 403 ? "INVALID_KEY" : "UNAVAILABLE";
  } catch {
    status = "UNAVAILABLE";
  }
  diagnostic = { at: now, model, status };
  logger.info("ai.fallback_diagnostic", { status });
  return { provider: "gemini", model, status, cached: false };
}

/** Test seam: forgets the cached diagnostic. */
export function resetGeminiDiagnostic(): void {
  diagnostic = null;
}
