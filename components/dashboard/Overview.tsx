import type { RiskVerdict } from "@/lib/security/risk";
import { formatLamports } from "@/lib/token/amount";
import { cn } from "@/lib/utils";
import type { WalletSecurityScan } from "@/lib/wallet/scan-core";
import { RISK_STYLES } from "@/components/security/badges";

function Metric({ label, value, tone, hint }: { label: string; value: string | number; tone?: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4" title={hint}>
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={cn("mt-1 text-2xl font-semibold tabular-nums", tone)}>{value}</div>
    </div>
  );
}

export function MetricsGrid({ scan }: { scan: WalletSecurityScan }) {
  const m = scan.metrics;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
      <Metric label="SOL balance" value={m.sol} />
      <Metric label="Tokens" value={m.tokenCount} hint={m.unanalyzedTokens ? `${m.unanalyzedTokens} not analyzed (scan limit)` : undefined} />
      <Metric label="Risky tokens" value={m.riskyTokenCount} tone={m.riskyTokenCount ? "text-orange-300" : undefined} />
      <Metric label="Critical issues" value={m.criticalIssues} tone={m.criticalIssues ? "text-red-300" : undefined} />
      <Metric label="Active delegations" value={m.activeDelegations} tone={m.activeDelegations ? "text-amber-200" : undefined} />
      <Metric label="Cleanup options" value={m.cleanupOpportunities} />
      <Metric label="Reclaimable rent (est.)" value={`${formatLamports(m.reclaimableLamports, 4)} SOL`} hint="Estimated gross rent in closeable accounts. Not guaranteed; fees apply." />
    </div>
  );
}

const ORDER: RiskVerdict[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "SAFE", "UNKNOWN"];
const BAR: Record<RiskVerdict, string> = {
  CRITICAL: "bg-red-500",
  HIGH: "bg-orange-500",
  MEDIUM: "bg-amber-400",
  LOW: "bg-sky-500",
  SAFE: "bg-emerald-500",
  UNKNOWN: "bg-zinc-600",
};

/** Portfolio risk distribution (FAZ 18). */
export function PortfolioBar({ portfolio }: { portfolio: Record<RiskVerdict, number> }) {
  const total = ORDER.reduce((s, k) => s + portfolio[k], 0);
  if (total === 0) return <p className="text-sm text-zinc-500">No tokens.</p>;
  return (
    <div className="space-y-2">
      <div className="flex h-2.5 overflow-hidden rounded-full bg-zinc-800">
        {ORDER.filter((k) => portfolio[k] > 0).map((k) => (
          <div key={k} className={BAR[k]} style={{ width: `${(portfolio[k] / total) * 100}%` }} title={`${k}: ${portfolio[k]}`} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {ORDER.map((k) => (
          <span key={k} className={cn(RISK_STYLES[k].text, portfolio[k] === 0 && "opacity-40")}>
            <span className={cn("mr-1 inline-block size-2 rounded-full", BAR[k])} />
            {k === "UNKNOWN" || k === "SAFE" ? RISK_STYLES[k].label : k}: {portfolio[k]}
          </span>
        ))}
      </div>
    </div>
  );
}
