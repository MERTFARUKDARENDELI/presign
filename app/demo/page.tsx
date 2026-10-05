"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { WalletDashboard } from "@/components/dashboard/WalletDashboard";
import { DemoBadge } from "@/components/security/badges";
import { TransactionReport } from "@/components/transaction/TransactionReport";
import { api, ApiClientError } from "@/lib/client/api";
import type { DemoCleanupPreview } from "@/lib/demo/scenario";
import { markDemo } from "@/lib/demo/scenario";
import { evaluateWalletRisk } from "@/lib/security/rules/wallet";
import { formatLamports, sumRaw } from "@/lib/token/amount";
import type { TransactionAnalysis } from "@/lib/transaction/types";
import type { WalletSecurityScan } from "@/lib/wallet/scan-core";
import { cn } from "@/lib/utils";

interface DemoPayload {
  demo: true;
  scan: WalletSecurityScan;
  transaction: TransactionAnalysis;
  transactionBase64: string;
}

const STEPS = ["Wallet scan", "Risk detection", "Suspicious transaction", "Scam & cNFT detection", "Cleanup"];

/** Applies demo cleanup outcomes to the demo scan (client-side, deterministic, clearly DEMO). */
function applyDemoOutcomes(scan: WalletSecurityScan, done: DemoCleanupPreview[]): WalletSecurityScan {
  const closed = new Set(done.filter((d) => d.intent.action !== "REVOKE").map((d) => d.intent.tokenAccount));
  const revoked = new Set(done.filter((d) => d.intent.action === "REVOKE").map((d) => d.intent.tokenAccount));
  const tokens = scan.tokens
    .map((t) => ({
      ...t,
      holding: {
        ...t.holding,
        accounts: t.holding.accounts
          .filter((a) => !closed.has(a.address))
          .map((a) => (revoked.has(a.address) ? { ...a, delegate: null, delegatedAmountRaw: null } : a)),
      },
      cleanup: t.cleanup
        .filter((c) => !closed.has(c.target))
        .map((c) => (revoked.has(c.target) ? { ...c, actions: { ...c.actions, REVOKE: { status: "NOT_APPLICABLE" as const, reason: "DEMO: delegate revoked." } }, labels: c.labels.filter((l) => l !== "revokable") } : c)),
    }))
    .filter((t) => t.holding.accounts.length > 0);

  const walletRisk = markDemo(
    evaluateWalletRisk({
      wallet: scan.snapshot.address,
      tokenAccounts: tokens.flatMap((t) => t.holding.accounts),
      tokenRisks: tokens.filter((t) => t.report).map((t) => ({ mint: t.holding.mint, label: t.holding.metadata?.symbol ?? t.holding.mint, level: t.report!.risk.level, status: t.report!.risk.status })),
      assetRisks: scan.assets.map((a) => ({ id: a.asset.id, label: a.asset.name ?? a.asset.id, level: a.risk.level })),
      snapshotStatus: "COMPLETE",
      sources: scan.snapshot.sources,
      unanalyzedTokens: 0,
      now: new Date(scan.snapshot.fetchedAt),
    }),
  );

  const risky = tokens.filter((t) => ["MEDIUM", "HIGH", "CRITICAL"].includes(t.report?.risk.level ?? ""));
  const portfolio = { SAFE: 0, LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0, UNKNOWN: 0 };
  tokens.forEach((t) => portfolio[t.report?.risk.level ?? "UNKNOWN"]++);
  return {
    ...scan,
    tokens,
    walletRisk,
    portfolio,
    metrics: {
      ...scan.metrics,
      tokenCount: tokens.length,
      riskyTokenCount: risky.length,
      activeDelegations: tokens.flatMap((t) => t.holding.accounts).filter((a) => a.delegate).length,
      criticalIssues: [walletRisk, ...tokens.map((t) => t.report?.risk), ...scan.assets.map((a) => a.risk)].filter((r) => r?.level === "CRITICAL").length,
      cleanupOpportunities: tokens.flatMap((t) => t.cleanup).filter((c) => c.labels.some((l) => l === "burnable" || l === "closeable" || l === "revokable")).length,
      reclaimableLamports: sumRaw(tokens.flatMap((t) => t.cleanup).map((c) => c.grossReclaimLamports ?? "0")),
    },
  };
}

export default function DemoPage() {
  const [data, setData] = useState<DemoPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [done, setDone] = useState<DemoCleanupPreview[]>([]);

  useEffect(() => {
    api<DemoPayload>("/api/demo").then(setData).catch((e) => setError(e instanceof ApiClientError ? e.message : "Demo failed to load."));
  }, []);

  const scan = useMemo(() => (data ? applyDemoOutcomes(data.scan, done) : null), [data, done]);

  if (error) return <p className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">{error}</p>;
  if (!data || !scan) return <div className="space-y-3"><p className="flex items-center gap-2 text-sm text-zinc-400"><Loader2 className="size-4 animate-spin" /> Loading demo…</p><Skeleton className="h-64 w-full" /></div>;

  const symbols = Object.fromEntries(data.scan.tokens.map((t) => [t.holding.mint, t.holding.metadata?.symbol ?? ""]));
  const metrics = {
    "Analyzed transactions": step >= 2 ? 1 : 0,
    "Detected threats": data.scan.walletRisk.signals.length + data.transaction.risk.signals.filter((s) => s.severity !== "LOW").length,
    "High-risk tokens & NFTs":data.scan.tokens.filter((t) => ["HIGH", "CRITICAL"].includes(t.report?.risk.level ?? "")).length + data.scan.assets.filter((a) => ["HIGH", "CRITICAL"].includes(a.risk.level)).length,
    "Cleaned token accounts": done.filter((d) => d.intent.action !== "REVOKE").length,
    "Reclaimed (est.)": `${formatLamports(sumRaw(done.map((d) => (d.reclaim && !d.reclaim.estimatedNetLamports.startsWith("-") ? d.reclaim.estimatedNetLamports : "0"))), 6)} SOL`,
    "Revoked authorizations": done.filter((d) => d.intent.action === "REVOKE").length,
  };

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-fuchsia-500/40 bg-fuchsia-500/10 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <DemoBadge />
          <span className="font-semibold">Synthetic, deterministic demo wallet — not real blockchain data.</span>
        </div>
        <p className="mt-1 text-sm text-fuchsia-100/80">
          The data runs through the real risk engine, decoder, capability matrix and integrity checks. No wallet is connected, nothing is fetched from or sent to a blockchain, and signing is disabled.
        </p>
      </div>

      <a href="/demo/sign" className="block rounded-xl border border-violet-500/40 bg-violet-500/10 p-4 transition hover:border-violet-400/70">
        <span className="font-semibold text-violet-100">Pre-sign demo with your own wallet →</span>
        <span className="mt-1 block text-sm text-violet-100/80">A controlled demo dApp sends real signing requests (safe, risky, critical, unverifiable) through Presign Secure Connect and the pre-sign review. Presign warns; you decide.</span>
      </a>

      <ol className="flex gap-2 overflow-x-auto pb-1">
        {STEPS.map((s, i) => (
          <li key={s}>
            <button type="button" onClick={() => setStep(i)} className={cn("whitespace-nowrap rounded-full border px-3 py-1 text-sm", i === step ? "border-white bg-white text-black" : i < step ? "border-zinc-600 text-zinc-200" : "border-zinc-800 text-zinc-500")}>
              {i + 1}. {s}
            </button>
          </li>
        ))}
      </ol>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {Object.entries(metrics).map(([k, v]) => (
          <div key={k} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
            <div className="text-[11px] uppercase tracking-wide text-zinc-500">{k}</div>
            <div className="text-xl font-semibold tabular-nums">{v}</div>
          </div>
        ))}
      </div>
      <p className="-mt-3 text-[11px] text-zinc-500">Demo metrics are computed from this demo session only.</p>

      {step === 2 ? (
        <div className="space-y-3">
          <p className="text-sm text-zinc-400">A dApp asks the demo wallet to sign this transaction. Before signing, we decode and simulate it:</p>
          <TransactionReport analysis={data.transaction} symbols={symbols} />
        </div>
      ) : (
        <WalletDashboard scan={scan} mode={{ kind: "demo", onDemoCleanup: (p) => setDone((d) => (d.some((x) => x.intent.tokenAccount === p.intent.tokenAccount && x.intent.action === p.intent.action) ? d : [...d, p])) }} />
      )}

      <div className="flex justify-between">
        <button type="button" disabled={step === 0} onClick={() => setStep((s) => s - 1)} className="rounded-lg border border-zinc-800 px-4 py-2 text-sm disabled:opacity-40">Back</button>
        <button type="button" disabled={step === STEPS.length - 1} onClick={() => setStep((s) => s + 1)} className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black disabled:opacity-40">Next: {STEPS[Math.min(step + 1, STEPS.length - 1)]}</button>
      </div>
    </div>
  );
}
