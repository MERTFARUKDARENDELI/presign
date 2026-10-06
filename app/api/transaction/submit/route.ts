import { AppError } from "@/lib/api/errors";
import { readJsonBody, withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { verifyPreparedForSubmit } from "@/lib/guard/prepare";
import { verifyApprovalForSubmit } from "@/lib/presign/signing";
import { sessionIdFrom } from "@/lib/presign/tokens";
import { NOT_BOUND_MESSAGE, submitAnalyzedTransaction } from "@/lib/transaction/submit";
import { signedTransactionSchema } from "@/lib/validation/schemas";

export const maxDuration = 60;

/**
 * Relays a transaction the user's wallet signed. Not a general relay: the
 * signed message must be bound to a server-sealed token — the pre-sign
 * approval (same session, wallet, exact payload; single use) or a Guard
 * transaction Presign prepared. Then the exact bytes and every signature are
 * re-checked. Nothing is signed here.
 */
export const POST = withApi({ name: "tx-submit", limit: 5, windowMs: 60_000 }, async (request) => {
  const body = signedTransactionSchema.parse(await readJsonBody(request, 16_000));
  if (body.approvalToken) await verifyApprovalForSubmit(body.approvalToken, sessionIdFrom(request), body.signedTransaction, body.expectedMessageHash);
  else if (body.preparedToken) verifyPreparedForSubmit(body.preparedToken, body.expectedMessageHash);
  else throw new AppError("SECURITY_BLOCK", NOT_BOUND_MESSAGE, { reason: "NOT_BOUND" });
  return ok(await submitAnalyzedTransaction(body.signedTransaction, body.expectedMessageHash));
});
