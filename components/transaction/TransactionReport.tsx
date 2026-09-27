import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { describeTransactionError } from "@/lib/cleanup/reclaim";
import { defangLinks } from "@/lib/security/text-signals";
import { formatRawAmount } from "@/lib/token/amount";
import { formatTxVersion } from "@/lib/transaction/decoder";
import { explainTransaction } from "@/lib/transaction/explain";
import type { TransactionAnalysis } from "@/lib/transaction/types";
import { cn } from "@/lib/utils";
import { Address, DemoBadge, RiskBadge, RISK_STYLES, StatusBadge } from "@/components/security/badges";
import { RiskDetails } from "@/components/security/RiskDetails";
import { SignerBrief } from "@/components/multisig/SignerBrief";

/** Instruction fields for display. Memo text is untrusted: its links are shown only as defanged hosts. */
function infoValue(key: string, value: string | null): string {
  if (value === null) return "null";
  return key === "memo" ? defangLinks(value) : value;
}

/** Decoder metadata (keys starting with "_") is not an instruction field. */
const visibleInfo = (info: Record<string, string | null>) => Object.entries(info).filter(([k]) => !k.startsWith("_"));

function Card({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-xl border border-zinc-800 bg-zinc-900/40 p-4", className)}>
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-400">{title}</h3>
      {children}
    </section>
  );
}

function Delta({ raw, decimals, unit }: { raw: string; decimals: number; unit: string }) {
  const negative = raw.startsWith("-");
  return (
    <span className={cn("inline-flex items-center gap-1 font-mono tabular-nums", negative ? "text-red-300" : "text-emerald-300")}>
      {negative ? <ArrowUpRight className="size-3.5" /> : <ArrowDownLeft className="size-3.5" />}
      {negative ? "" : "+"}
      {formatRawAmount(raw, decimals)} {unit}
    </span>
  );
}

export function TransactionReport({ analysis, symbols = {} }: { analysis: TransactionAnalysis; symbols?: Record<string, string> }) {
  const { decoded, effects, risk } = analysis;
  const wallet = analysis.perspectiveWallet;
  const walletSol = effects?.solChanges.filter((c) => c.address === wallet) ?? [];
  const walletTokens = effects?.tokenChanges.filter((c) => c.owner === wallet) ?? [];
  const others = effects?.tokenChanges.filter((c) => c.owner !== wallet) ?? [];

  return (
    <div className="space-y-4">
      <div className={cn("rounded-2xl border bg-zinc-900/50 p-5 ring-1", RISK_STYLES[risk.level].ring, risk.level === "CRITICAL" ? "border-red-500/50" : "border-zinc-800")}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">Transaction risk</h2>
          {analysis.demo && <DemoBadge />}
          <span className="text-xs text-zinc-500">
            {analysis.inputKind} · {formatTxVersion(decoded.version)} · {analysis.cluster} · perspective <Address value={wallet} /> ({analysis.perspectiveSource === "fee-payer" ? "fee payer" : "your wallet"})
          </span>
        </div>
        {risk.level === "CRITICAL" && <p className="mb-3 rounded-lg bg-red-500/15 px-3 py-2 text-sm font-semibold text-red-200">Critical signals detected. Review the evidence carefully — the decision to sign is yours.</p>}
        <RiskDetails risk={risk} />
      </div>

      <SignerBrief analysis={analysis} />

      <ExplanationCard analysis={analysis} symbols={symbols} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="What will happen to your assets?">
          {!effects ? (
            <p className="rounded-lg border border-orange-500/40 bg-orange-500/10 p-3 text-sm text-orange-200">
              Simulation could not be performed, so asset movements are UNKNOWN. This is not a safe result.
            </p>
          ) : (
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-zinc-400">{effects.source === "EXECUTED" ? "On-chain result:" : effects.source === "DEMO" ? "Demo simulation:" : "Simulation:"}</span>
                {effects.success ? <span className="text-emerald-300">succeeded</span> : <span className="text-red-300">failed {describeTransactionError(effects.error) ?? effects.error}</span>}
                <StatusBadge status={analysis.effectsStatus} />
              </div>
              {effects.source === "SIMULATION" && (
                <p className="text-xs text-zinc-500">
                  Simulated at slot {effects.slot ?? "?"} against the chain state of that moment. It is not a guarantee of the future execution result (balances, prices or the blockhash can change before it lands) and a successful simulation is not a safety verdict.
                </p>
              )}
              {walletSol.map((c) => (
                <div key={c.address} className="flex justify-between"><span className="text-zinc-400">SOL (incl. fee)</span><Delta raw={c.deltaLamports} decimals={9} unit="SOL" /></div>
              ))}
              {walletTokens.map((c) => (
                <div key={c.tokenAccount} className="flex justify-between gap-2">
                  <span className="text-zinc-400">{symbols[c.mint] ?? <Address value={c.mint} />}</span>
                  <Delta raw={c.deltaRaw} decimals={c.decimals} unit={symbols[c.mint] ?? ""} />
                </div>
              ))}
              {walletSol.length === 0 && walletTokens.length === 0 && effects.success && <p className="text-zinc-500">No balance change for your wallet besides possible fees.</p>}
              {others.length > 0 && (
                <div className="border-t border-zinc-800 pt-2">
                  <div className="mb-1 text-xs uppercase text-zinc-500">Where assets go</div>
                  {others.map((c) => (
                    <div key={c.tokenAccount} className="flex justify-between gap-2 text-xs">
                      <span>owner <Address value={c.owner} n={6} /> <span className="text-zinc-500">(unverified address)</span></span>
                      <Delta raw={c.deltaRaw} decimals={c.decimals} unit={symbols[c.mint] ?? ""} />
                    </div>
                  ))}
                </div>
              )}
              {effects.feeLamports && <div className="text-xs text-zinc-500">Network fee: {formatRawAmount(effects.feeLamports, 9)} SOL</div>}
              {effects.notes.map((n) => <p key={n} className="text-xs text-amber-200/80">{n}</p>)}
            </div>
          )}
        </Card>

        <Card title="Programs & signers">
          <ul className="space-y-1 text-sm">
            {decoded.programs.map((p) => (
              <li key={p.programId} className="flex flex-wrap items-center justify-between gap-2">
                <span>{p.name}</span>
                <span className="flex items-center gap-2">
                  <Address value={p.programId} />
                  <span className={cn("rounded px-1.5 text-[10px]", p.trust === "unknown" ? "bg-amber-500/15 text-amber-200" : "bg-zinc-800 text-zinc-400")}>{p.trust === "unknown" ? "unverified" : p.trust}</span>
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-3 border-t border-zinc-800 pt-2 text-xs text-zinc-400">
            Fee payer <Address value={decoded.feePayer} /> · signers: {decoded.signers.map((s) => <Address key={s} value={s} className="mr-1" />)}
            {decoded.usesDurableNonce && <span className="ml-2 text-amber-200">durable nonce</span>}
            {!decoded.lookupTablesResolved && <span className="ml-2 text-amber-200">lookup tables unresolved</span>}
          </div>
        </Card>
      </div>

      <Card title="Decoded instructions">
        <ol className="space-y-2">
          {decoded.instructions.map((i) => (
            <li key={i.index} className="rounded-lg bg-zinc-950 p-3 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-zinc-100">#{i.index} {i.type}</span>
                <span className="text-zinc-500">{i.programName}</span>
                {!i.parsed && <span className="rounded bg-amber-500/15 px-1.5 text-amber-200">not decoded — intent unknown ({i.dataLength} bytes)</span>}
                {i.info._decodedBy && <span className="rounded bg-sky-500/15 px-1.5 text-sky-200" title="Names come from the program's own published IDL: they state intent, not verified behavior.">named via on-chain IDL</span>}
              </div>
              {visibleInfo(i.info).length > 0 && (
                <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px]">
                  {visibleInfo(i.info).map(([k, v]) => (
                    <div key={k} className="contents"><dt className="text-zinc-500">{k}</dt><dd className="break-all text-zinc-300">{infoValue(k, v)}</dd></div>
                  ))}
                </dl>
              )}
              <div className="mt-1 flex flex-wrap gap-1">
                {i.accounts.map((a, idx) => (
                  <span key={idx} className="rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-400">
                    {a.name}: <Address value={a.address} />{a.writable ? " ✎" : ""}{a.signer ? " ✍" : ""}
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ol>
      </Card>

      {decoded.innerInstructions.length > 0 && (
        <Card title={`Internal program calls (CPI) · from ${decoded.innerInstructionsSource === "EXECUTED" ? "the executed transaction" : "simulation"}`}>
          <ol className="space-y-1 text-xs">
            {decoded.innerInstructions.map((i) => (
              <li key={i.index} className="rounded-md bg-zinc-950 px-2 py-1.5">
                <span className="text-zinc-500">under #{i.parentIndex} →</span> <span className="font-mono text-zinc-200">{i.type}</span>{" "}
                <span className="text-zinc-500">{i.programName}</span>
                {i.programTrust === "unknown" && <span className="ml-1 rounded bg-amber-500/15 px-1 text-amber-200">unverified</span>}
                {i.info._decodedBy && <span className="ml-1 rounded bg-sky-500/15 px-1 text-sky-200">via on-chain IDL</span>}
                {visibleInfo(i.info).length > 0 && (
                  <div className="mt-0.5 break-all font-mono text-[11px] text-zinc-400">{visibleInfo(i.info).map(([k, v]) => `${k}=${infoValue(k, v)}`).join("  ")}</div>
                )}
              </li>
            ))}
          </ol>
        </Card>
      )}

      {effects && effects.logs.length > 0 && (
        <Card title="Program logs (untrusted)">
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap text-[11px] text-zinc-400">{effects.logs.join("\n")}{effects.logsTruncated ? "\n…" : ""}</pre>
        </Card>
      )}

      <p className="text-xs text-zinc-500">
        <RiskBadge level={risk.level} className="mr-2" /> This report presents evidence, not a recommendation. Whether to sign is your decision.
      </p>
    </div>
  );
}

function ExplanationSection({ q, items }: { q: string; items: string[] }) {
  return items.length === 0 ? null : (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{q}</dt>
      <dd>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-zinc-300">{items.map((t, i) => <li key={i}>{t}</li>)}</ul>
      </dd>
    </div>
  );
}

function ExplanationCard({ analysis, symbols }: { analysis: TransactionAnalysis; symbols: Record<string, string> }) {
  const x = explainTransaction(analysis, symbols);
  return (
    <Card title="Explanation (deterministic)">
      <p className="mb-3 text-sm font-medium text-zinc-100">{x.headline}</p>
      <dl className="grid gap-4 md:grid-cols-2">
        <ExplanationSection q="What will happen?" items={x.whatHappens} />
        <ExplanationSection q="Which assets move, and where?" items={x.assetMovements} />
        <ExplanationSection q="Which programs run?" items={x.programs} />
        <ExplanationSection q="Which accounts change?" items={x.accountChanges} />
        <ExplanationSection q="Why is it risky?" items={x.whyRisky} />
        <ExplanationSection q="Simulation & completeness" items={[x.simulation, x.completeness]} />
      </dl>
      <p className="mt-3 text-xs text-zinc-500">{x.decisionNote}</p>
    </Card>
  );
}
