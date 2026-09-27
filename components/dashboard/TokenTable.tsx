"use client";

import { ChevronRight, Flame, Lock, ShieldOff, Trash2 } from "lucide-react";
import { Fragment, useState } from "react";
import type { CleanupAction, CleanupEligibility } from "@/lib/cleanup/capabilities";
import { riskRank } from "@/lib/security/risk";
import { describeAge } from "@/lib/token/age";
import { cn } from "@/lib/utils";
import type { TokenScanEntry } from "@/lib/wallet/scan-core";
import { Address, RiskBadge, StatusBadge } from "@/components/security/badges";
import { RiskDetails } from "@/components/security/RiskDetails";

export interface CleanupRequest {
  entry: TokenScanEntry;
  eligibility: CleanupEligibility;
  action: CleanupAction;
}

const ACTIONS: Array<{ action: CleanupAction; label: string; icon: typeof Flame }> = [
  { action: "BURN_AND_CLOSE", label: "Burn & close", icon: Flame },
  { action: "CLOSE", label: "Close", icon: Trash2 },
  { action: "REVOKE", label: "Revoke", icon: ShieldOff },
];

const CAP_STYLE: Record<string, string> = {
  SUPPORTED: "text-emerald-300",
  PARTIALLY_SUPPORTED: "text-amber-200",
  REQUIRES_MANUAL_REVIEW: "text-orange-300",
  UNSUPPORTED: "text-red-300",
  NOT_APPLICABLE: "text-zinc-500",
};

function tokenName(e: TokenScanEntry) {
  return e.holding.metadata?.symbol || e.holding.metadata?.name || null;
}

/** Scam & junk token center (FAZ 9): risk, status, authorities, liquidity, holders, cleanup status. */
export function TokenTable({ tokens, onCleanup, cleanupDisabledReason }: { tokens: TokenScanEntry[]; onCleanup: (r: CleanupRequest) => void; cleanupDisabledReason: string | null }) {
  const [open, setOpen] = useState<string | null>(null);
  const sorted = [...tokens].sort((a, b) => riskRank(b.report?.risk.level ?? "UNKNOWN") - riskRank(a.report?.risk.level ?? "UNKNOWN"));

  if (tokens.length === 0) return <p className="rounded-lg border border-zinc-800 p-4 text-sm text-zinc-500">No SPL / Token-2022 accounts in this wallet.</p>;

  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-800">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="bg-zinc-900 text-left text-xs uppercase tracking-wide text-zinc-500">
          <tr>
            <th className="px-3 py-2">Token</th>
            <th className="px-3 py-2">Balance</th>
            <th className="px-3 py-2">Risk</th>
            <th className="px-3 py-2">Authorities</th>
            <th className="px-3 py-2">Liquidity / holders</th>
            <th className="px-3 py-2">Cleanup</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((e) => {
            const r = e.report;
            const isOpen = open === e.holding.mint;
            const name = tokenName(e);
            return (
              <Fragment key={e.holding.mint}>
                <tr className={cn("border-t border-zinc-800 align-top hover:bg-zinc-900/50", isOpen && "bg-zinc-900/60")}>
                  <td className="px-3 py-2.5">
                    <button type="button" className="flex items-start gap-1 text-left" onClick={() => setOpen(isOpen ? null : e.holding.mint)} aria-expanded={isOpen}>
                      <ChevronRight className={cn("mt-0.5 size-4 shrink-0 text-zinc-500 transition-transform", isOpen && "rotate-90")} />
                      <span>
                        <span className="block max-w-[220px] truncate font-medium text-zinc-100" title={name ?? undefined}>{name ?? "Unknown token"}</span>
                        <Address value={e.holding.mint} className="text-zinc-500" />
                        {e.holding.program === "token-2022" && <span className="ml-1 rounded bg-violet-500/15 px-1 text-[10px] text-violet-300">Token-2022</span>}
                      </span>
                    </button>
                  </td>
                  <td className="px-3 py-2.5 font-mono text-xs tabular-nums text-zinc-300">{e.holding.uiAmount}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-col items-start gap-1">
                      <RiskBadge level={r?.risk.level ?? "UNKNOWN"} />
                      {r ? <StatusBadge status={r.risk.status} /> : <span className="text-[11px] text-zinc-500">not analyzed</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-xs">
                    {r?.mintInfo ? (
                      <div className="space-y-0.5">
                        <div className={r.mintInfo.mintAuthority ? "text-amber-200" : "text-zinc-500"}>Mint: {r.mintInfo.mintAuthority ? "active" : "revoked"}</div>
                        <div className={r.mintInfo.freezeAuthority ? "text-orange-300" : "text-zinc-500"}>Freeze: {r.mintInfo.freezeAuthority ? "active" : "revoked"}</div>
                        {r.mintInfo.extensions.permanentDelegate && <div className="text-red-300">Permanent delegate</div>}
                        {r.age && (
                          <div className={r.age.status === "UNAVAILABLE" ? "text-zinc-500" : "text-zinc-400"} title={r.age.detail}>
                            Age: {describeAge(r.age)}
                          </div>
                        )}
                      </div>
                    ) : (
                      <span className="text-zinc-500">unavailable</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-zinc-400">
                    {r?.rugcheck?.liquidityUsd != null ? `$${Math.round(r.rugcheck.liquidityUsd).toLocaleString("en-US")}` : "—"}
                    {" / "}
                    {r?.rugcheck?.totalHolders != null ? r.rugcheck.totalHolders.toLocaleString("en-US") : "—"}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {e.cleanup.flatMap((c) => c.labels).filter((l, i, a) => a.indexOf(l) === i).map((l) => (
                        <span key={l} className={cn("rounded border px-1.5 py-0.5 text-[10px]", l === "unsupported" ? "border-red-500/30 text-red-300" : l === "manual_review" ? "border-orange-500/30 text-orange-300" : "border-zinc-700 text-zinc-300")}>
                          {l.replace("_", " ")}
                        </span>
                      ))}
                      {e.holding.accounts.some((a) => a.state === "frozen") && <Lock className="size-4 text-red-300" aria-label="frozen" />}
                    </div>
                  </td>
                </tr>
                {isOpen && (
                  <tr className="border-t border-zinc-800 bg-zinc-950/60">
                    <td colSpan={6} className="px-4 py-4">
                      <div className="grid gap-6 lg:grid-cols-2">
                        <div>
                          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Security evidence</h4>
                          {r ? <RiskDetails risk={r.risk} /> : <p className="text-sm text-zinc-500">Not analyzed in this scan (limit reached). Use the token API for a deep scan.</p>}
                        </div>
                        <div>
                          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Cleanup capability</h4>
                          {e.cleanup.map((c) => (
                            <div key={c.target} className="mb-3 rounded-lg border border-zinc-800 p-3">
                              <div className="mb-2 text-xs text-zinc-500">
                                Account <Address value={c.target} /> · {c.assetClass.replace("_", " ")}
                              </div>
                              <ul className="space-y-1.5">
                                {ACTIONS.map(({ action, label, icon: Icon }) => {
                                  const cap = c.actions[action];
                                  const allowed = cap.status === "SUPPORTED" || cap.status === "PARTIALLY_SUPPORTED";
                                  return (
                                    <li key={action} className="flex items-start justify-between gap-3 text-xs">
                                      <div>
                                        <span className="font-medium text-zinc-200">{label}</span>{" "}
                                        <span className={CAP_STYLE[cap.status]}>{cap.status.replace(/_/g, " ")}</span>
                                        <div className="text-zinc-500">{cap.reason}</div>
                                      </div>
                                      {allowed && (
                                        <button
                                          type="button"
                                          disabled={cleanupDisabledReason !== null}
                                          title={cleanupDisabledReason ?? undefined}
                                          onClick={() => onCleanup({ entry: e, eligibility: c, action })}
                                          className="flex shrink-0 items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
                                        >
                                          <Icon className="size-3.5" /> Review
                                        </button>
                                      )}
                                    </li>
                                  );
                                })}
                              </ul>
                            </div>
                          ))}
                          {cleanupDisabledReason && <p className="text-xs text-zinc-500">{cleanupDisabledReason}</p>}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
