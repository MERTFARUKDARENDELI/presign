import { readJsonBody, withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { analyzeTransaction } from "@/lib/transaction/analyze";
import { withPolicy } from "@/lib/policy/schema";
import { transactionInputSchema } from "@/lib/validation/schemas";

export const maxDuration = 45;

/** Decode → simulate → deterministic risk for a signature or serialized transaction. */
export const POST = withApi({ name: "tx-analyze", limit: 15, windowMs: 60_000 }, async (request) => {
  const body = transactionInputSchema.extend(withPolicy).parse(await readJsonBody(request, 32_000));
  return ok(await analyzeTransaction(body.input, body.walletAddress, body.policy ?? null));
});
