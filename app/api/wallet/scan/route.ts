import { withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { walletAddressSchema } from "@/lib/validation/schemas";
import { scanWallet } from "@/lib/wallet/scan";

export const maxDuration = 60;

/** Full wallet security scan: token/asset risk, wallet risk, cleanup eligibility, metrics. */
export const GET = withApi({ name: "wallet-scan", limit: 10, windowMs: 60_000 }, async (request) => {
  const address = walletAddressSchema.parse(new URL(request.url).searchParams.get("address") ?? "");
  return ok(await scanWallet(address));
});
