"use client";

import { ChevronRight, ShieldCheck, Timer } from "lucide-react";
import { useEffect, useState } from "react";
import type { GuardActionInspection, GuardOverview } from "@/lib/guard/types";
import { formatDelay } from "@/lib/security/rules/multisig";
import { describeInstruction } from "@/lib/transaction/explain";
import { cn } from "@/lib/utils";
import { Address, RiskBadge, RISK_STYLES, StatusBadge } from "@/components/security/badges";
import { RiskDetails } from "@/components/security/RiskDetails";
import { Card } from "@/components/transaction/TransactionReport";
import { InstructionList } from "@/components/transaction/InstructionList";
import { GuardActionButtons } from "./GuardActionButtons";

const utc = (s: string) => new Date(Number(s) * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";

function useNow(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function remaining(seconds: number): string {
  if (seconds <= 0) return "delay passed";
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return d > 0 ? `${d}d ${h}h ${m}m left` : h > 0 ? `${h}h ${m}m ${s}s left` : `${m}m ${s}s left`;
}

export function GuardActionReport({ inspection, onChanged }: { inspection: GuardActionInspection; onChanged: () => void }) {
  const now = useNow();
  const { action, risk, scheduled } = inspection;
  const eta = Number(action.eta);
  const pending = action.status === "Pending";
  return (
    <div className="space-y-4">
      <section className={cn("rounded-2xl border bg-zinc-900/60 p-5", risk.level === "CRITICAL" ? "border-red-500/50" : "border-sky-500/30")}>
        <div className="mb-1 flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wider text-sky-300">
          <ShieldCheck className="size-4" aria-hidden /> Presign Guard action #{action.index}
          <RiskBadge level={risk.level} />
          <StatusBadge status={risk.status} />
        </div>
        <h2 className="text-lg font-semibold text-zinc-50">
          {pending ? (now < eta ? "Scheduled — any one guardian can still veto it." : "The delay has passed — anyone can execute it now.") : `This action was ${action.status.toLowerCase()}.`}
        </h2>
        <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-zinc-300">
          <span className="inline-flex items-center gap-1.5"><Timer className="size-4" aria-hidden /> Executes no earlier than {utc(action.eta)}</span>
          {pending && <span className={cn("font-mono", now < eta ? "text-sky-200" : "text-amber-200")}>{remaining(eta - now)}</span>}
          {action.vetoedBy && <span>vetoed by <Address value={action.vetoedBy} n={6} /></span>}
        </p>
        {action.memo && <p className="mt-2 text-sm text-zinc-400">Memo (untrusted): “{action.memo}”</p>}

        <h3 className="mt-4 mb-2 text-sm font-semibold text-zinc-200">If it executes</h3>
        <ol className="space-y-2">
          {scheduled.decoded.instructions.map((ix) => {
            const p = scheduled.privileged.find((v) => v.origin.endsWith(`instruction ${ix.index}`) && v.programId === ix.programId);
            return (
              <li key={ix.index} className={cn("rounded-lg border px-3 py-2 text-sm", p ? "border-zinc-700 bg-zinc-950" : "border-transparent bg-zinc-950/60")}>
                <p className="break-words text-zinc-200">{describeInstruction(ix)}</p>
                {p && p.newAuthority !== undefined && (
                  <p className={cn("mt-2 inline-flex flex-wrap items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium", p.control === "outside" ? "border-red-500/50 bg-red-500/15 text-red-200" : p.control === "multisig" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200" : "border-orange-500/50 bg-orange-500/15 text-orange-200")}>
                    New holder <Address value={p.newAuthority ?? "none"} n={6} />: {p.control === "outside" ? "NOT controlled by the multisig or this guard" : p.control === "multisig" ? "the multisig or this guard" : p.control === "member" ? "a single key" : "nobody — removed"}
                  </p>
                )}
              </li>
            );
          })}
        </ol>

        <div className="mt-4">
          <GuardActionButtons action={inspection.address} guardians={inspection.guardAccount?.guardians ?? []} pending={pending} executable={pending && now >= eta} onDone={onChanged} />
        </div>
      </section>

      <div className={cn("rounded-2xl border bg-zinc-900/50 p-5 ring-1", RISK_STYLES[risk.level].ring, "border-zinc-800")}>
        <h2 className="mb-3 text-lg font-semibold">Evidence</h2>
        <RiskDetails risk={risk} compact />
      </div>

      <Card title="Scheduled instructions (decoded)">
        <InstructionList instructions={scheduled.decoded.instructions} />
      </Card>
    </div>
  );
}

export function GuardOverviewView({ overview, onInspect }: { overview: GuardOverview; onInspect: (address: string) => void }) {
  const now = useNow();
  const g = overview.account;
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-sky-500/30 bg-zinc-900/50 p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <ShieldCheck className="size-5 text-sky-300" aria-hidden />
          <h2 className="text-lg font-semibold">Presign Guard</h2>
          <span className="text-xs text-zinc-500"><Address value={overview.guard} n={8} /> · {overview.cluster}</span>
        </div>
        <p className="mb-3 text-sm text-zinc-300">
          Delay {formatDelay(g.delaySeconds)} · {g.guardians.length} guardian(s), any one can veto · proposer <Address value={g.proposer} /> · holds authorities as <Address value={overview.guardSigner} n={6} />
        </p>
        <RiskDetails risk={overview.posture} compact />
      </div>
      <Card title="Scheduled actions">
        {overview.actions.length === 0 ? (
          <p className="text-sm text-zinc-500">Nothing has been scheduled yet.</p>
        ) : (
          <ul className="divide-y divide-zinc-800">
            {overview.actions.map((a) => (
              <li key={a.address}>
                <button type="button" onClick={() => onInspect(a.address)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-1 py-2.5 text-left text-sm hover:bg-zinc-900">
                  <span className="w-10 font-mono text-zinc-400">#{a.index}</span>
                  <span className="min-w-24 font-medium">{a.status}</span>
                  <span className="text-xs text-zinc-500">{a.status === "Pending" ? (now < Number(a.eta) ? remaining(Number(a.eta) - now) : "executable now") : utc(a.eta)}</span>
                  <span className="hidden max-w-80 truncate text-xs text-zinc-400 sm:inline">{a.memo}</span>
                  <ChevronRight className="ml-auto size-4 text-zinc-500" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Guardians">
        <ul className="space-y-1 text-xs">{g.guardians.map((k) => <li key={k} className="rounded-md bg-zinc-950 px-2 py-1"><Address value={k} n={8} /></li>)}</ul>
      </Card>
    </div>
  );
}
