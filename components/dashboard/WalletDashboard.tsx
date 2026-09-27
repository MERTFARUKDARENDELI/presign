"use client";

import { useState } from "react";
import type { WalletSecurityScan } from "@/lib/wallet/scan-core";
import { AiChat } from "@/components/ai/AiChat";
import { CleanupDialog, DemoCleanupDialog, type CleanupTarget } from "@/components/cleanup/CleanupDialog";
import { AssetList } from "@/components/dashboard/AssetList";
import { MetricsGrid, PortfolioBar } from "@/components/dashboard/Overview";
import { TokenTable, type CleanupRequest } from "@/components/dashboard/TokenTable";
import { Address, DemoBadge, RISK_STYLES } from "@/components/security/badges";
import { RiskDetails } from "@/components/security/RiskDetails";
import type { DemoCleanupPreview } from "@/lib/demo/scenario";
import { cn } from "@/lib/utils";

export type DashboardMode =
  | { kind: "live"; connectedWallet: string | null; onChanged: () => void }
  | { kind: "demo"; onDemoCleanup: (preview: DemoCleanupPreview) => void };

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

export function WalletDashboard({ scan, mode, extra }: { scan: WalletSecurityScan; mode: DashboardMode; extra?: React.ReactNode }) {
  const [target, setTarget] = useState<CleanupTarget | null>(null);
  const address = scan.snapshot.address;
  const level = scan.walletRisk.level;
  const dasAvailable = scan.demo || scan.snapshot.sources.some((s) => s.source === "HELIUS_DAS" && s.status === "OK" && s.detail?.startsWith("NFT"));

  const cleanupDisabledReason =
    mode.kind === "demo"
      ? null
      : !mode.connectedWallet
        ? "Connect the wallet that owns these accounts to clean up."
        : mode.connectedWallet !== address
          ? "The connected wallet is not the scanned wallet. Cleanup is only possible for your own accounts."
          : null;

  function openCleanup(r: CleanupRequest) {
    setTarget({ tokenAccount: r.eligibility.target, action: r.action, symbol: r.entry.holding.metadata?.symbol ?? null });
  }

  return (
    <div className="space-y-8">
      <div className={cn("rounded-2xl border bg-zinc-900/50 p-5 ring-1", RISK_STYLES[level].ring, level === "CRITICAL" ? "border-red-500/50" : "border-zinc-800")}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">Wallet security</h2>
          <Address value={address} n={6} className="text-zinc-400" />
          <span className="text-xs text-zinc-500">{scan.snapshot.cluster}</span>
          {scan.demo && <DemoBadge />}
        </div>
        {level === "CRITICAL" && <p className="mb-3 rounded-lg bg-red-500/15 px-3 py-2 text-sm font-semibold text-red-200">Critical risk detected — review the evidence below before interacting with any of these assets.</p>}
        <RiskDetails risk={scan.walletRisk} />
      </div>

      <MetricsGrid scan={scan} />

      <div className="grid gap-8 xl:grid-cols-[1fr_380px]">
        <div className="min-w-0 space-y-8">
          <Section title="Portfolio risk">
            <PortfolioBar portfolio={scan.portfolio} />
          </Section>
          <Section title="Scam & junk token center">
            <TokenTable tokens={scan.tokens} onCleanup={openCleanup} cleanupDisabledReason={cleanupDisabledReason} />
          </Section>
          <Section title="NFTs & compressed NFTs">
            <AssetList assets={scan.assets} dasAvailable={dasAvailable} />
          </Section>
          {extra}
        </div>
        <div className="xl:sticky xl:top-4 xl:h-[calc(100vh-2rem)]">
          <AiChat walletAddress={address} demo={scan.demo} />
        </div>
      </div>

      {mode.kind === "live" ? (
        <CleanupDialog target={target} owner={address} onClose={() => setTarget(null)} onDone={mode.onChanged} />
      ) : (
        <DemoCleanupDialog target={target} onClose={() => setTarget(null)} onSimulated={mode.onDemoCleanup} />
      )}
    </div>
  );
}
