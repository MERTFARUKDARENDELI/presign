import { readJsonBody, withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { prepareGuardTransaction } from "@/lib/guard/prepare";
import { guardPrepareSchema } from "@/lib/validation/schemas";

export const maxDuration = 30;

/** Unsigned veto / execute transaction for a Guard action plus its prepared token; the user's wallet signs, /api/transaction/submit relays. */
export const POST = withApi({ name: "guard-prepare", limit: 10, windowMs: 60_000 }, async (request) => {
  const body = guardPrepareSchema.parse(await readJsonBody(request, 2_000));
  return ok(await prepareGuardTransaction(body.kind, body.action, body.signer));
});
