import { diagnoseGemini } from "@/lib/ai/gemini";
import { diagnoseAi } from "@/lib/ai/status";
import { withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";

/**
 * On-demand AI key check (explicit user action, never polled): Claude, and the
 * backup model that explains pre-sign reviews when Claude cannot. Neither check
 * generates tokens. Cached server-side and rate limited; returns only status
 * enums and the backup's model name — never a key or provider output.
 */
export const POST = withApi({ name: "ai-diagnose", limit: 3, windowMs: 60_000 }, async () => {
  const [claude, backup] = await Promise.all([diagnoseAi(), diagnoseGemini()]);
  return ok({ ...claude, backup });
});
