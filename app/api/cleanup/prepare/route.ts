import { readJsonBody, withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { prepareCleanup } from "@/lib/cleanup/prepare";
import { cleanupPrepareSchema } from "@/lib/validation/schemas";

export const maxDuration = 45;

/**
 * Builds an UNSIGNED cleanup transaction for the connected wallet, simulates
 * it and returns the confirmation data. The server never signs.
 */
export const POST = withApi({ name: "cleanup-prepare", limit: 10, windowMs: 60_000 }, async (request) => {
  const body = cleanupPrepareSchema.parse(await readJsonBody(request, 4_000));
  return ok(await prepareCleanup(body.owner, body.tokenAccount, body.action));
});
