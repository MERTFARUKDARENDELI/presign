import { Check, Minus, X } from "lucide-react";
import { briefSourceFromInspection, buildSignerBrief } from "@/lib/multisig/brief";
import type { ProposalInspection } from "@/lib/multisig/types";
import { formatRawAmount } from "@/lib/token/amount";
import { cn } from "@/lib/utils";
import { Address, RISK_STYLES, StatusBadge } from "@/components/security/badges";
import { RiskDetails } from "@/components/security/RiskDetails";
import { Card } from "@/components/transaction/TransactionReport";
import { InnerInstructionList, InstructionList } from "@/components/transaction/InstructionList";
import { BriefCard } from "./SignerBrief";

export function formatUnixSeconds(ts: string | null): string | null {
  if (!ts || !/^-?\d+$/.test(ts)) return null;
  const d = new Date(Number(ts) * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function Votes({ inspection }: { inspection: ProposalInspection }) {
  const acc = inspection.analysis.account;
  const proposal = inspection.analysis.proposals[0]?.account ?? null;
  if (!acc) return <p className="text-sm text-amber-200">The multisig configuration could not be loaded, so votes cannot be shown.</p>;
  const approved = new Set(proposal?.approved ?? []);
  const rejected = new Set(proposal?.rejected ?? []);
  return (
    <div className="space-y-2 text-sm">
      <p className="text-zinc-300">
        {proposal ? <>Status <span className="font-semibold">{proposal.status}</span>{formatUnixSeconds(proposal.statusTimestamp) ? <span className="text-zinc-500"> since {formatUnixSeconds(proposal.statusTimestamp)}</span> : null} · {proposal.approved.length} of {acc.threshold} approvals</> : "No proposal account exists for this transaction yet."}
      </p>
      <ul className="space-y-1">
        {acc.members.map((m) => {
          const vote = approved.has(m.key) ? "approved" : rejected.has(m.key) ? "rejected" : "pending";
          const Icon = vote === "approved" ? Check : vote === "rejected" ? X : Minus;
          return (
            <li key={m.key} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-zinc-950 px-2 py-1">
              <span className="flex items-center gap-2">
                <Icon className={cn("size-3.5", vote === "approved" ? "text-emerald-300" : vote === "rejected" ? "text-red-300" : "text-zinc-500")} aria-label={vote} />
                <Address value={m.key} n={6} />
              </span>
              <span className="text-[11px] text-zinc-500">{m.permissions.join(" · ") || "no permissions"}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function ProposalReport({ inspection }: { inspection: ProposalInspection }) {
  const { risk, analysis } = inspection;
  const brief = buildSignerBrief(briefSourceFromInspection(inspection));
  return (
    <div className="space-y-4">
      {brief && <BriefCard brief={brief} title="Proposal brief" verdict={{ level: risk.level, status: risk.status }} />}

      <div className={cn("rounded-2xl border bg-zinc-900/50 p-5 ring-1", RISK_STYLES[risk.level].ring, risk.level === "CRITICAL" ? "border-red-500/50" : "border-zinc-800")}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">Proposal risk</h2>
          <span className="text-xs text-zinc-500">
            proposal #{inspection.transactionIndex} · {inspection.transactionKind === "config" ? "configuration change" : inspection.transactionKind === "vault" ? "vault transaction" : "transaction account missing"} · {inspection.cluster}
          </span>
          {inspection.stale && <span className="rounded border border-amber-500/40 px-1.5 text-[11px] text-amber-200" title="Created before the last configuration change; it can no longer be executed.">stale</span>}
        </div>
        {risk.level === "CRITICAL" && <p className="mb-3 rounded-lg bg-red-500/15 px-3 py-2 text-sm font-semibold text-red-200">Critical signals detected. Do not approve until every one of them is explained.</p>}
        <RiskDetails risk={risk} compact />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Votes">
          <Votes inspection={inspection} />
        </Card>
        <Card title="Accounts">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-zinc-500">Multisig</dt><dd><Address value={inspection.multisig} n={8} /></dd>
            <dt className="text-zinc-500">Proposal</dt><dd><Address value={inspection.proposalAddress} n={8} /></dd>
            <dt className="text-zinc-500">Transaction</dt><dd><Address value={inspection.transactionAddress} n={8} /></dd>
            {analysis.payloads[0]?.vault && <><dt className="text-zinc-500">Vault</dt><dd><Address value={analysis.payloads[0].vault} n={8} /></dd></>}
            {analysis.payloads[0]?.simulatedFeePayer && <><dt className="text-zinc-500">Simulated executor</dt><dd><Address value={analysis.payloads[0].simulatedFeePayer} n={8} /> <span className="text-zinc-500">(pays the fee)</span></dd></>}
          </dl>
        </Card>
      </div>

      {analysis.configActions.length > 0 && (
        <Card title="Configuration changes">
          <ul className="space-y-1 font-mono text-xs text-zinc-300">{analysis.configActions.map((c, i) => <li key={i} className="break-all rounded bg-zinc-950 px-2 py-1">{JSON.stringify(c.action)}</li>)}</ul>
        </Card>
      )}

      {analysis.payloads.filter((p) => p.decoded).map((p, i) => (
        <div key={i} className="space-y-4">
          <Card title={`Vault instructions · ${p.status.toLowerCase()}`}>
            <InstructionList instructions={p.decoded!.instructions} />
          </Card>
          {p.decoded!.innerInstructions.length > 0 && (
            <Card title="Internal program calls (from simulation)">
              <InnerInstructionList instructions={p.decoded!.innerInstructions} />
            </Card>
          )}
          {p.effects && (
            <Card title="Simulated balance changes">
              <div className="mb-2 flex items-center gap-2 text-sm">
                {p.effects.success ? <span className="text-emerald-300">Simulation succeeded</span> : <span className="text-red-300">Simulation failed {p.effects.error}</span>}
                {p.effectsStatus && <StatusBadge status={p.effectsStatus} />}
              </div>
              <ul className="space-y-1 text-xs">
                {p.effects.solChanges.map((c) => <li key={c.address} className="flex justify-between gap-2"><Address value={c.address} n={6} /><span className="font-mono">{formatRawAmount(c.deltaLamports, 9)} SOL</span></li>)}
                {p.effects.tokenChanges.map((c) => <li key={c.tokenAccount} className="flex justify-between gap-2"><span>owner <Address value={c.owner} n={6} /> · mint <Address value={c.mint} /></span><span className="font-mono">{formatRawAmount(c.deltaRaw, c.decimals)}</span></li>)}
              </ul>
              {p.effects.notes.map((n) => <p key={n} className="mt-1 text-xs text-amber-200/80">{n}</p>)}
            </Card>
          )}
        </div>
      ))}
    </div>
  );
}
