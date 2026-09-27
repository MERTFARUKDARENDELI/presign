import "server-only";
import { getWalletData } from "@/lib/solana/wallet";
import { analyzeTokensBatch } from "@/lib/token/scanner";
import { buildWalletScanFromParts, MAX_TOKENS_ANALYZED, type WalletSecurityScan } from "./scan-core";

export type { AssetScanEntry, TokenScanEntry, WalletSecurityScan } from "./scan-core";

export async function scanWallet(address: string): Promise<WalletSecurityScan> {
  const snapshot = await getWalletData(address);
  const das = snapshot.sources.filter((s) => s.source === "HELIUS_DAS" && s.detail?.startsWith("Token metadata"));
  const metadataStatus = das.some((s) => s.status === "OK")
    ? "OK"
    : das.some((s) => s.status === "NOT_CONFIGURED")
      ? "NOT_CONFIGURED"
      : "FAILED";

  // Bound cost: analyze fungible holdings with a balance first, then NFTs, then empty accounts.
  const priority = (h: (typeof snapshot.holdings)[number]) => (BigInt(h.amountRaw) > 0n ? 2 : 0) + (h.decimals > 0 ? 1 : 0);
  const ordered = [...snapshot.holdings].sort((a, b) => priority(b) - priority(a));
  const toAnalyze = ordered.slice(0, MAX_TOKENS_ANALYZED).map((h) => h.mint);
  const reports = await analyzeTokensBatch(
    toAnalyze,
    new Map(snapshot.holdings.map((h) => [h.mint, h.metadata])),
    metadataStatus,
  );
  return buildWalletScanFromParts(snapshot, reports);
}
