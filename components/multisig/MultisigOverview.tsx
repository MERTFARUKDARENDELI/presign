import { ChevronRight } from "lucide-react";
import type { MultisigOverview as Overview } from "@/lib/multisig/types";
import { Address, RiskBadge } from "@/components/security/badges";
import { RiskDetails } from "@/components/security/RiskDetails";
import { Card } from "@/components/transaction/TransactionReport";
import { formatUnixSeconds } from "./ProposalReport";

const PENDING = new Set(["Draft", "Active", "Approved"]);

export function MultisigOverview({ overview, onInspect }: { overview: Overview; onInspect: (index: string) => void }) {
  const acc = overview.account;
  const voters = acc?.members.filter((m) => m.permissions.includes("Vote")).length ?? 0;
  const pending = overview.proposals.filter((p) => PENDING.has(p.status) && !p.stale);
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">Multisig setup</h2>
          <span className="text-xs text-zinc-500"><Address value={overview.multisig} n={8} /> · {overview.cluster}</span>
        </div>
        {acc && (
          <p className="mb-3 text-sm text-zinc-300">
            {acc.threshold} of {voters} voting members · time lock {acc.timeLock === 0 ? "none" : `${acc.timeLock}s`} · {acc.configAuthority ? <>config authority <Address value={acc.configAuthority} /></> : "autonomous (changes need a vote)"} · {pending.length} pending proposal(s)
          </p>
        )}
        <RiskDetails risk={overview.posture} compact />
      </div>

      <Card title="Recent proposals">
        {overview.proposals.length === 0 ? (
          <p className="text-sm text-zinc-500">This multisig has no proposals yet.</p>
        ) : (
          <ul className="divide-y divide-zinc-800">
            {overview.proposals.map((p) => {
              const inspectable = p.status !== "NOT_FOUND" && p.status !== "UNREADABLE";
              return (
                <li key={p.transactionIndex}>
                  <button
                    type="button"
                    disabled={!inspectable}
                    onClick={() => onInspect(p.transactionIndex)}
                    className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-1 py-2.5 text-left text-sm enabled:hover:bg-zinc-900 disabled:opacity-60"
                  >
                    <span className="w-10 font-mono text-zinc-400">#{p.transactionIndex}</span>
                    <span className="min-w-24 font-medium">{p.status === "NOT_FOUND" ? "closed / none" : p.status === "NO_PROPOSAL" ? "no proposal" : p.status}</span>
                    {p.stale && <span className="rounded border border-zinc-700 px-1 text-[11px] text-zinc-400">stale</span>}
                    {acc && p.status !== "NOT_FOUND" && <span className="text-xs text-zinc-500">{p.approvals}/{acc.threshold} approvals</span>}
                    {formatUnixSeconds(p.statusTimestamp) && <span className="text-xs text-zinc-600">{formatUnixSeconds(p.statusTimestamp)}</span>}
                    <span className="ml-auto flex items-center gap-2">
                      {p.verdict && <RiskBadge level={p.verdict} />}
                      {p.topSignal && <span className="hidden max-w-64 truncate text-xs text-zinc-400 sm:inline">{p.topSignal}</span>}
                      {inspectable && <ChevronRight className="size-4 text-zinc-500" aria-hidden />}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-2 text-xs text-zinc-500">Pending proposals are inspected automatically (up to {overview.inspectedLimit}). Select any proposal to see what it does.</p>
      </Card>

      {acc && (
        <Card title="Members & vaults">
          <ul className="space-y-1 text-xs">
            {acc.members.map((m) => (
              <li key={m.key} className="flex flex-wrap justify-between gap-2 rounded-md bg-zinc-950 px-2 py-1"><Address value={m.key} n={8} /><span className="text-zinc-500">{m.permissions.join(" · ") || "no permissions"}</span></li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-zinc-500">Vaults: {overview.vaults.map((v, i) => <span key={v} className="mr-2">#{i} <Address value={v} /></span>)}</p>
        </Card>
      )}
    </div>
  );
}
