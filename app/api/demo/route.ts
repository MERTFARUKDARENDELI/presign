import { withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { buildDemoTransaction, buildDemoWalletScan } from "@/lib/demo/scenario";

/** Deterministic DEMO MODE data (synthetic; never blockchain data). */
export const GET = withApi({ name: "demo", limit: 60, windowMs: 60_000 }, async () => {
  const tx = buildDemoTransaction();
  return ok({ demo: true, scan: buildDemoWalletScan(), transaction: tx.analysis, transactionBase64: tx.base64 });
});
