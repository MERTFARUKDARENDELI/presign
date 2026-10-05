import { readJsonBody, withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { verifyOwnership, walletCookie } from "@/lib/presign/ownership";
import { ownershipVerifySchema } from "@/lib/presign/schemas";
import { sessionIdFrom } from "@/lib/presign/tokens";

/** Verifies the wallet's ownership signature (nonce, session, wallet, message, ed25519) and marks the wallet verified for this session. */
export const POST = withApi({ name: "presign-verify", limit: 20, windowMs: 60_000 }, async (request) => {
  const body = ownershipVerifySchema.parse(await readJsonBody(request, 6_000));
  const sid = sessionIdFrom(request);
  const verified = verifyOwnership(body, sid);
  return ok(verified, { headers: { "Set-Cookie": walletCookie(request, verified, sid!) } });
});
