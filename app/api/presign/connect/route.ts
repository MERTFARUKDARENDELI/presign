import { readJsonBody, withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { createConnection } from "@/lib/presign/connection";
import { connectRequestSchema } from "@/lib/presign/schemas";
import { ensureSession } from "@/lib/presign/tokens";

/** Pre-connect stage: validates the connection context (origin, session, target dApp) before any wallet opens. */
export const POST = withApi({ name: "presign-connect", limit: 20, windowMs: 60_000 }, async (request) => {
  const body = connectRequestSchema.parse(await readJsonBody(request, 8_000));
  const { sid, setCookie } = ensureSession(request);
  const context = createConnection(body, request, sid);
  return ok(context, setCookie ? { headers: { "Set-Cookie": setCookie } } : undefined);
});
