import { withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { verifiedWalletFrom } from "@/lib/presign/ownership";
import { cookieHeader, readCookie, sessionIdFrom, WALLET_COOKIE } from "@/lib/presign/tokens";
import type { PresignSession } from "@/lib/presign/types";

/** Current Presign session: whether a wallet's ownership was verified in this browser session. */
export const GET = withApi({ name: "presign-session", limit: 60, windowMs: 60_000 }, async (request) => {
  const sid = sessionIdFrom(request);
  const session: PresignSession = { sessionActive: sid !== null, verified: verifiedWalletFrom(readCookie(request, WALLET_COOKIE), sid) };
  return ok(session);
});

/** Forgets the verified wallet (on disconnect). The wallet's own connection is managed by the wallet. */
export const DELETE = withApi({ name: "presign-session", limit: 60, windowMs: 60_000 }, async (request) => {
  const session: PresignSession = { sessionActive: sessionIdFrom(request) !== null, verified: null };
  return ok(session, { headers: { "Set-Cookie": cookieHeader(request, WALLET_COOKIE, "", 0) } });
});
