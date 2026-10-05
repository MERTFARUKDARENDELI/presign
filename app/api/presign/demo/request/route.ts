import { readJsonBody, withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { buildDemoRequest } from "@/lib/presign/demo";
import { demoRequestSchema } from "@/lib/presign/schemas";
import { presignHost } from "@/lib/presign/tokens";

export const maxDuration = 20;

/** Controlled demo dApp: builds a real, unsigned request for the connected wallet (analyzed like any other). */
export const POST = withApi({ name: "presign-demo", limit: 20, windowMs: 60_000 }, async (request) => {
  const body = demoRequestSchema.parse(await readJsonBody(request, 2_000));
  return ok(await buildDemoRequest(body.scenario, body.walletAddress, presignHost(request)));
});
