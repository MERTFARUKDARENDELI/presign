import { readJsonBody, withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { approvalConfirmSchema } from "@/lib/presign/schemas";
import { confirmApprovalForExtension } from "@/lib/presign/signing";

/**
 * The browser extension asks here before it sends an approved request to the
 * wallet: { valid } for a genuine, unexpired, not yet confirmed approval of
 * exactly this payload hash. Answers only yes / no and the approval's own
 * fields; nothing else about the session or the user.
 */
export const POST = withApi({ name: "presign-confirm-approval", limit: 30, windowMs: 60_000 }, async (request) => {
  const body = approvalConfirmSchema.parse(await readJsonBody(request, 9_000));
  return ok(await confirmApprovalForExtension(body.approvalToken, body.payloadHash));
});
