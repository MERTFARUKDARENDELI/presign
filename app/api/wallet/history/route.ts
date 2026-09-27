import { withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { getTransactionHistory } from "@/lib/solana/history";
import { walletAddressSchema } from "@/lib/validation/schemas";

/** Recent transaction signatures for the security timeline. */
export const GET = withApi({ name: "wallet-history", limit: 20, windowMs: 60_000 }, async (request) => {
  const params = new URL(request.url).searchParams;
  const address = walletAddressSchema.parse(params.get("address") ?? "");
  const limit = Math.min(Math.max(Number.parseInt(params.get("limit") ?? "20", 10) || 20, 1), 50);
  return ok(await getTransactionHistory(address, limit));
});
