import { readJsonBody, withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { verifiedWalletFrom } from "@/lib/presign/ownership";
import { signingApproveSchema } from "@/lib/presign/schemas";
import { approveSigning } from "@/lib/presign/signing";
import { readCookie, sessionIdFrom, WALLET_COOKIE } from "@/lib/presign/tokens";

/**
 * The user's decision on a reviewed request. Checks the exact payload hash, wallet,
 * session, expiry, single use and that the choice matches the risk Presign computed
 * (HIGH / CRITICAL need the explicit override). Returns a short-lived approval; the
 * wallet is asked only after this.
 */
export const POST = withApi({ name: "presign-approve", limit: 20, windowMs: 60_000 }, async (request) => {
  const body = signingApproveSchema.parse(await readJsonBody(request, 24_000));
  const sid = sessionIdFrom(request);
  const verified = verifiedWalletFrom(readCookie(request, WALLET_COOKIE), sid);
  return ok(await approveSigning(body, sid, verified?.wallet ?? null));
});
