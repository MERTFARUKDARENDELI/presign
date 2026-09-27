import { AlertOctagon, Clock, FileSearch, Fingerprint, Users } from "lucide-react";
import { buildSignerBrief, CONTROL_TEXT, type BriefStep } from "@/lib/multisig/brief";
import type { TransactionAnalysis } from "@/lib/transaction/types";
import { cn } from "@/lib/utils";
import { Address } from "@/components/security/badges";

const CONTROL_STYLE = {
  outside: "border-red-500/50 bg-red-500/15 text-red-200",
  member: "border-orange-500/50 bg-orange-500/15 text-orange-200",
  none: "border-orange-500/50 bg-orange-500/15 text-orange-200",
  multisig: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
} as const;

function Step({ step }: { step: BriefStep }) {
  const p = step.privileged;
  return (
    <li className={cn("rounded-lg border px-3 py-2 text-sm", p ? "border-zinc-700 bg-zinc-950" : "border-transparent bg-zinc-950/60")}>
      <p className="break-words text-zinc-200">{step.text}</p>
      {p && p.newAuthority !== undefined && p.control && (
        <p className={cn("mt-2 inline-flex flex-wrap items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium", CONTROL_STYLE[p.control])}>
          New holder <Address value={p.newAuthority ?? "none"} n={6} />: {CONTROL_TEXT[p.control]}
        </p>
      )}
      {p && p.newAuthority === undefined && <p className="mt-2 text-xs font-medium text-amber-200">Privileged action ({p.kind.replace("-", " ")})</p>}
    </li>
  );
}

/** What a multisig signature authorizes — shown above everything else. */
export function SignerBrief({ analysis }: { analysis: TransactionAnalysis }) {
  const brief = buildSignerBrief(analysis);
  if (!brief) return null;
  return (
    <section aria-labelledby="signer-brief" className="rounded-2xl border border-fuchsia-500/30 bg-zinc-900/60 p-5">
      <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-fuchsia-300">
        <FileSearch className="size-4" aria-hidden /> Signer brief
      </div>
      <h2 id="signer-brief" className="text-lg font-semibold text-zinc-50">{brief.headline}</h2>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400">
        <span className="inline-flex items-center gap-1"><Users className="size-3.5" aria-hidden /> Multisig <Address value={brief.multisig} n={6} /></span>
        {brief.config ? <span>{brief.config}</span> : <span className="text-amber-200">Multisig configuration could not be loaded</span>}
      </div>

      {brief.neverExpires && (
        <div className="mt-4 flex gap-3 rounded-xl border border-red-500/50 bg-red-500/10 p-3 text-sm text-red-100">
          <Clock className="mt-0.5 size-5 shrink-0 text-red-300" aria-hidden />
          <p><span className="font-semibold">This signature never expires.</span> It uses a durable nonce, so whoever holds the signed transaction can submit it at any moment — days or weeks from now.</p>
        </div>
      )}

      <div className="mt-4 space-y-4">
        {brief.payloads.length === 0 && <p className="text-sm text-zinc-400">This transaction does not create, approve or execute a vault transaction.</p>}
        {brief.payloads.map((p, i) => (
          <div key={i}>
            <h3 className="mb-2 flex flex-wrap items-center gap-2 text-sm font-semibold text-zinc-200">
              {p.source === "EXECUTION_CPI" ? p.label : `If it executes — ${p.label}`}
              {p.status !== "DECODED" && <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 text-[11px] font-medium text-amber-200">{p.status}</span>}
            </h3>
            {p.steps.length > 0 ? (
              <ol className="space-y-2">{p.steps.map((s, j) => <Step key={j} step={s} />)}</ol>
            ) : (
              <p className="flex gap-2 rounded-lg border border-orange-500/40 bg-orange-500/10 p-3 text-sm text-orange-100">
                <AlertOctagon className="mt-0.5 size-4 shrink-0" aria-hidden /> {p.detail ?? "The proposal contents could not be verified."} Do not approve what you cannot see.
              </p>
            )}
            {p.detail && p.steps.length > 0 && <p className="mt-1 text-xs text-zinc-500">{p.detail}</p>}
          </div>
        ))}
      </div>

      {brief.messageHash && (
        <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs">
          <div className="mb-1 flex items-center gap-1.5 font-semibold text-zinc-300"><Fingerprint className="size-3.5" aria-hidden /> Verify on your hardware wallet</div>
          <p className="text-zinc-500">If your hardware wallet shows a message hash when signing, it must match this one. If it differs, you are not signing what was analyzed.</p>
          <p className="mt-1 break-all font-mono text-zinc-200">{brief.messageHash.base58}</p>
        </div>
      )}
    </section>
  );
}
