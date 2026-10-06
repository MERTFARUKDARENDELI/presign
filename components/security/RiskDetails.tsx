"use client";

import { ChevronDown } from "lucide-react";
import { useState } from "react";
import type { RiskAssessment } from "@/lib/security/risk";
import type { DataSource } from "@/lib/security/types";
import { cn } from "@/lib/utils";
import { RiskBadge, RISK_STYLES, StatusBadge, statusHelp } from "./badges";

const SOURCE_LABEL: Record<DataSource, string> = {
  ONCHAIN_RPC: "On-chain (RPC)",
  HELIUS_DAS: "Helius DAS",
  HELIUS_RPC: "Helius RPC",
  PUBLIC_RPC: "Public RPC",
  RUGCHECK: "RugCheck (external)",
  SIMULATION: "Simulation",
  TRANSACTION_DECODER: "Transaction decoder",
  ANCHOR_IDL: "Program's on-chain IDL",
  SQUADS_ACCOUNT: "Squads multisig account (on-chain)",
  VERIFIED_BUILDS: "OtterSec verified builds (external)",
  TEAM_POLICY: "Your team policy",
  DETERMINISTIC_RULE: "Deterministic rule",
  DEMO: "DEMO data",
};

export function sourceLabel(s: DataSource): string {
  return SOURCE_LABEL[s];
}

/** Signals + the exact evidence behind each one + data sources. */
export function RiskDetails({ risk, compact = false }: { risk: RiskAssessment; compact?: boolean }) {
  const [open, setOpen] = useState(!compact);
  const byId = new Map(risk.evidence.map((e) => [e.id, e]));

  return (
    // Signals and evidence quote full addresses; they wrap instead of widening the page on a phone.
    <div className="min-w-0 space-y-3 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-center gap-2">
        <RiskBadge level={risk.level} />
        <StatusBadge status={risk.status} />
        {risk.score !== null && <span className="text-xs text-zinc-500">score {risk.score}/100</span>}
      </div>
      <p className="text-sm text-zinc-400">{risk.summary}</p>
      {risk.status !== "COMPLETE" && <p className="text-xs text-amber-200/80">{statusHelp(risk.status)}</p>}

      {risk.signals.length > 0 && (
        <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 text-xs font-medium text-zinc-300 hover:text-white">
          <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
          {open ? "Hide" : "Show"} {risk.signals.length} signal(s) and evidence
        </button>
      )}

      {open && (
        <ul className="space-y-2">
          {risk.signals.map((s) => (
            <li key={s.code} className={cn("rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 ring-1", RISK_STYLES[s.severity].ring)}>
              <div className="flex flex-wrap items-center gap-2">
                <RiskBadge level={s.severity} />
                <span className="text-sm font-semibold text-zinc-100">{s.title}</span>
              </div>
              <p className="mt-1 text-sm text-zinc-400">{s.description}</p>
              <ul className="mt-2 space-y-1">
                {s.evidenceIds.map((id) => {
                  const e = byId.get(id);
                  if (!e) return null;
                  return (
                    <li key={id} className="rounded-md bg-zinc-900 px-2 py-1.5 text-xs text-zinc-300">
                      <span className="mr-2 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">{sourceLabel(e.source)}</span>
                      <span className="text-zinc-400">{e.label}:</span>{" "}
                      <span className="break-all font-mono text-zinc-100">{e.observed === null ? "none" : String(e.observed)}</span>
                      {e.condition && <span className="text-zinc-500"> · rule: {e.condition}</span>}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {!compact && risk.sources.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {risk.sources.map((s, i) => (
            <span key={`${s.source}-${i}`} title={s.detail} className={cn("rounded border px-1.5 py-0.5 text-[10px]", s.status === "OK" ? "border-zinc-700 text-zinc-400" : "border-amber-500/40 text-amber-200")}>
              {sourceLabel(s.source)}: {s.status}
              {s.detail ? ` · ${s.detail}` : ""}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
