import { withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { analyzeToken } from "@/lib/token/scanner";
import { mintAddressSchema } from "@/lib/validation/schemas";

export const maxDuration = 30;

/** Deep single-token security analysis. */
export const GET = withApi({ name: "token", limit: 20, windowMs: 60_000 }, async (request) => {
  const mint = mintAddressSchema.parse(new URL(request.url).searchParams.get("mint") ?? "");
  return ok(await analyzeToken(mint));
});
