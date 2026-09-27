import { withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { getWalletData } from "@/lib/solana/wallet";
import { walletAddressSchema } from "@/lib/validation/schemas";

/** Normalized on-chain wallet snapshot (balances as strings, no raw provider data). */
export const GET = withApi({ name: "wallet", limit: 30, windowMs: 60_000 }, async (request) => {
  const address = walletAddressSchema.parse(new URL(request.url).searchParams.get("address") ?? "");
  return ok(await getWalletData(address));
});
