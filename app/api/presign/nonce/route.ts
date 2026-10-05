import { readJsonBody, withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { createOwnershipChallenge } from "@/lib/presign/ownership";
import { ownershipNonceSchema } from "@/lib/presign/schemas";
import { ensureSession, presignHost } from "@/lib/presign/tokens";

/** Issues a one-time ownership challenge: the exact message the wallet will be asked to sign. */
export const POST = withApi({ name: "presign-nonce", limit: 20, windowMs: 60_000 }, async (request) => {
  const body = ownershipNonceSchema.parse(await readJsonBody(request, 2_000));
  const { sid, setCookie } = ensureSession(request);
  const challenge = createOwnershipChallenge(body.walletAddress, presignHost(request), sid);
  return ok(challenge, setCookie ? { headers: { "Set-Cookie": setCookie } } : undefined);
});
