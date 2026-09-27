import { diagnoseAi } from "@/lib/ai/status";
import { withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";

/**
 * On-demand AI key check (explicit user action, never polled). Cached server-side
 * and rate limited; returns only a status enum — never the key or provider output.
 */
export const POST = withApi({ name: "ai-diagnose", limit: 3, windowMs: 60_000 }, async () => ok(await diagnoseAi()));
