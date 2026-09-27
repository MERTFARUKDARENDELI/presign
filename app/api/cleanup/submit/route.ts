import { readJsonBody, withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { submitSignedCleanup } from "@/lib/cleanup/submit";
import { submitSignedSchema } from "@/lib/validation/schemas";

export const maxDuration = 60;

/**
 * Relays a transaction signed by the user's wallet after re-verifying it
 * matches the confirmed intent (SECURITY_BLOCK otherwise).
 */
export const POST = withApi({ name: "cleanup-submit", limit: 6, windowMs: 60_000 }, async (request) => {
  const body = submitSignedSchema.parse(await readJsonBody(request, 8_000));
  return ok(await submitSignedCleanup(body.signedTransaction, body.expectedMessageHash, body.intent));
});
