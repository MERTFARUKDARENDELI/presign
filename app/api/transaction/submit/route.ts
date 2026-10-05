import { readJsonBody, withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { verifyApprovalForSubmit } from "@/lib/presign/signing";
import { sessionIdFrom } from "@/lib/presign/tokens";
import { submitAnalyzedTransaction } from "@/lib/transaction/submit";
import { signedTransactionSchema } from "@/lib/validation/schemas";

export const maxDuration = 60;

/**
 * Relays a transaction the user signed after analysis + confirmation (re-verified; never signed here).
 * With an approval token from the pre-sign review, the signed bytes must also match that exact approval.
 */
export const POST = withApi({ name: "tx-submit", limit: 5, windowMs: 60_000 }, async (request) => {
  const body = signedTransactionSchema.parse(await readJsonBody(request, 16_000));
  if (body.approvalToken) await verifyApprovalForSubmit(body.approvalToken, sessionIdFrom(request), body.signedTransaction, body.expectedMessageHash);
  return ok(await submitAnalyzedTransaction(body.signedTransaction, body.expectedMessageHash));
});
