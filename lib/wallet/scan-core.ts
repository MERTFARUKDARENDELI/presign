import { evaluateAssetCleanup, evaluateTokenAccountCleanup, type CleanupEligibility } from "@/lib/cleanup/capabilities";
import type { RiskAssessment, RiskVerdict } from "@/lib/security/risk";
import { evaluateAssetRisk } from "@/lib/security/rules/asset";
import { evaluateWalletRisk } from "@/lib/security/rules/wallet";
import type { DigitalAsset } from "@/lib/solana/das";
import { isMetaplexEditionControlled } from "@/lib/solana/metaplex";
import { sumRaw } from "@/lib/token/amount";
import type { TokenSecurityReport } from "@/lib/token/report";
import type { TokenHolding } from "@/lib/token/types";
import type { WalletSnapshot } from "./types";

/** Pure aggregation of a wallet snapshot + token reports into the dashboard model. */

export const MAX_TOKENS_ANALYZED = 40;

export interface TokenScanEntry {
  holding: TokenHolding;
  report: TokenSecurityReport | null;
  cleanup: CleanupEligibility[];
}

export interface AssetScanEntry {
  asset: DigitalAsset;
  risk: RiskAssessment;
  cleanup: CleanupEligibility | null;
}

export interface WalletSecurityScan {
  demo: boolean;
  snapshot: Omit<WalletSnapshot, "holdings" | "assets" | "tokenAccounts">;
  tokens: TokenScanEntry[];
  assets: AssetScanEntry[];
  walletRisk: RiskAssessment;
  portfolio: Record<RiskVerdict, number>;
  metrics: {
    sol: string;
    lamports: string;
    tokenCount: number;
    riskyTokenCount: number;
    criticalIssues: number;
    activeDelegations: number;
    cleanupOpportunities: number;
    reclaimableLamports: string;
    unanalyzedTokens: number;
  };
}

function holdingLabel(h: TokenHolding): string {
  return h.metadata?.symbol || h.metadata?.name || `${h.mint.slice(0, 4)}…${h.mint.slice(-4)}`;
}

/** Aggregates everything shown on the dashboard. Pure over its inputs apart from the fetches. */
export function buildWalletScanFromParts(
  snapshot: WalletSnapshot,
  reports: Map<string, TokenSecurityReport>,
  demo = false,
  now?: Date,
): WalletSecurityScan {
  const nftMints = new Set(snapshot.assets.filter((a) => a.kind === "nft").map((a) => a.id));

  const tokens: TokenScanEntry[] = snapshot.holdings.map((holding) => {
    const report = reports.get(holding.mint) ?? null;
    const cleanup = holding.accounts.map((acc) =>
      evaluateTokenAccountCleanup(acc, snapshot.address, { mint: report?.mintInfo ?? null, isNft: nftMints.has(holding.mint) }),
    );
    return { holding, report, cleanup };
  });

  const assets: AssetScanEntry[] = snapshot.assets
    .filter((a) => a.kind !== "fungible" && !a.burnt)
    .map((asset) => ({ asset, risk: evaluateAssetRisk(asset, now), cleanup: evaluateAssetCleanup(asset) }));

  const portfolio: Record<RiskVerdict, number> = { SAFE: 0, LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0, UNKNOWN: 0 };
  for (const t of tokens) portfolio[t.report?.risk.level ?? "UNKNOWN"]++;

  const unanalyzed = tokens.filter((t) => !t.report).length;
  const walletRisk = evaluateWalletRisk({
    wallet: snapshot.address,
    tokenAccounts: snapshot.tokenAccounts,
    tokenRisks: tokens.filter((t) => t.report).map((t) => ({ mint: t.holding.mint, label: holdingLabel(t.holding), level: t.report!.risk.level, status: t.report!.risk.status })),
    assetRisks: assets.map((a) => ({ id: a.asset.id, label: a.asset.name ?? a.asset.id.slice(0, 8), level: a.risk.level })),
    snapshotStatus: snapshot.status,
    sources: snapshot.sources,
    unanalyzedTokens: unanalyzed,
    standardNftMints: new Set(tokens.filter((t) => t.report?.mintInfo && isMetaplexEditionControlled(t.report.mintInfo)).map((t) => t.holding.mint)),
    now,
  });

  const allCleanup = tokens.flatMap((t) => t.cleanup);
  const actionable = (c: CleanupEligibility) => c.labels.some((l) => l === "burnable" || l === "closeable" || l === "revokable");
  const riskyMints = new Set(tokens.filter((t) => ["MEDIUM", "HIGH", "CRITICAL"].includes(t.report?.risk.level ?? "")).map((t) => t.holding.mint));
  // Reclaim opportunities: empty accounts (any token) + burnable risky tokens.
  const reclaimable = allCleanup.filter((c) => c.grossReclaimLamports && (c.actions.CLOSE.status === "SUPPORTED" || c.actions.CLOSE.status === "PARTIALLY_SUPPORTED" || riskyMints.has(c.mint)));

  const { holdings: _h, assets: _a, tokenAccounts: _t, ...rest } = snapshot;
  void _h; void _a; void _t;

  return {
    demo,
    snapshot: rest,
    tokens,
    assets,
    walletRisk,
    portfolio,
    metrics: {
      sol: snapshot.sol,
      lamports: snapshot.lamports,
      tokenCount: snapshot.holdings.length,
      riskyTokenCount: riskyMints.size,
      criticalIssues: [walletRisk, ...tokens.map((t) => t.report?.risk), ...assets.map((a) => a.risk)].filter((r) => r?.level === "CRITICAL").length,
      activeDelegations: snapshot.tokenAccounts.filter((a) => a.delegate).length,
      cleanupOpportunities: allCleanup.filter(actionable).length,
      reclaimableLamports: sumRaw(reclaimable.map((c) => c.grossReclaimLamports as string)),
      unanalyzedTokens: unanalyzed,
    },
  };
}
