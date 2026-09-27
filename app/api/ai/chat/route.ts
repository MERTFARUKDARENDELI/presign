import { runSecurityAgent } from "@/lib/ai/agent";
import { createDemoProvider, createLiveProvider } from "@/lib/ai/providers";
import { readJsonBody, withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { chatRequestSchema } from "@/lib/validation/schemas";

export const maxDuration = 60;

/** AI Security Agent — explains deterministic results; falls back to a deterministic summary. */
export const POST = withApi({ name: "ai-chat", limit: 8, windowMs: 60_000 }, async (request) => {
  const body = chatRequestSchema.parse(await readJsonBody(request, 64_000));
  const provider = body.demo ? createDemoProvider() : createLiveProvider(body.walletAddress ?? null);
  return ok(await runSecurityAgent(body.messages, provider));
});
