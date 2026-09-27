import { readJsonBody, withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { submitAnalyzedTransaction } from "@/lib/transaction/submit";
import { signedTransactionSchema } from "@/lib/validation/schemas";

export const maxDuration = 60;

/** Relays a transaction the user signed after analysis + confirmation (re-verified; never signed here). */
export const POST = withApi({ name: "tx-submit", limit: 5, windowMs: 60_000 }, async (request) => {
  const body = signedTransactionSchema.parse(await readJsonBody(request, 8_000));
  return ok(await submitAnalyzedTransaction(body.signedTransaction, body.expectedMessageHash));
});
