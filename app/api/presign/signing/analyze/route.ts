import { readJsonBody, withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { signingAnalyzeSchema } from "@/lib/presign/schemas";
import { analyzeSigning } from "@/lib/presign/signing";
import { ensureSession } from "@/lib/presign/tokens";

export const maxDuration = 45;

/**
 * Pre-sign review of the exact payload: decode → simulate → deterministic risk →
 * human decision (+ the unchanged machine gate) → session-bound analysis token.
 */
export const POST = withApi({ name: "presign-analyze", limit: 15, windowMs: 60_000 }, async (request) => {
  const body = signingAnalyzeSchema.parse(await readJsonBody(request, 24_000));
  const { sid, setCookie } = ensureSession(request);
  const review = await analyzeSigning(body, sid);
  return ok(review, setCookie ? { headers: { "Set-Cookie": setCookie } } : undefined);
});
