import { riskRank } from "@/lib/security/risk";
import type { AssetScanEntry } from "@/lib/wallet/scan-core";
import { Address, RiskBadge, StatusBadge } from "@/components/security/badges";
import { RiskDetails } from "@/components/security/RiskDetails";

/** NFTs and compressed NFTs — shown separately; cNFTs never enter SPL cleanup. */
export function AssetList({ assets, dasAvailable }: { assets: AssetScanEntry[]; dasAvailable: boolean }) {
  if (!dasAvailable) {
    return <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-200">NFT / cNFT data requires Helius DAS, which is unavailable. These assets were NOT analyzed (this is not a safe result).</p>;
  }
  if (assets.length === 0) return <p className="text-sm text-zinc-500">No NFTs or cNFTs found.</p>;

  const sorted = [...assets].sort((a, b) => riskRank(b.risk.level) - riskRank(a.risk.level));
  return (
    <ul className="space-y-3">
      {sorted.map((a) => (
        <li key={a.asset.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {/* Metadata name is UNTRUSTED text; rendered as plain text only. */}
            <span className="max-w-full truncate font-medium text-zinc-100">{a.asset.name ?? "Unnamed asset"}</span>
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase text-zinc-400">{a.asset.compressed ? "cNFT" : a.asset.interface}</span>
            <Address value={a.asset.id} className="text-zinc-500" />
            <RiskBadge level={a.risk.level} />
            <StatusBadge status={a.risk.status} />
          </div>
          <RiskDetails risk={a.risk} compact />
          {a.cleanup && (
            <p className="mt-2 text-xs text-orange-300">
              Cleanup: {a.cleanup.actions.BURN_AND_CLOSE.status.replace("_", " ")} — {a.cleanup.actions.BURN_AND_CLOSE.reason} Hide it in your wallet and never visit links it advertises.
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
