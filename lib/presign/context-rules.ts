import { buildAssessment } from "@/lib/security/engine";
import type { RiskAssessment, RiskSignal } from "@/lib/security/risk";
import type { DataSourceStatus, Evidence } from "@/lib/security/types";
import { formatLamports, formatRawAmount } from "@/lib/token/amount";
import { boundedOutflow } from "@/lib/transaction/effects";
import type { TransactionAnalysis } from "@/lib/transaction/types";
import type { DomainAnalysis, ExpectedEffects } from "./types";

/**
 * Deterministic rules about the CONTEXT of a signing request, merged into the
 * request's risk so the verdict (and the machine gate) reflects them:
 *  - the application's address (domain findings; unknown reputation is not a signal);
 *  - what the application SAID the request does versus what the simulation shows
 *    ("swap 10 USDC" that actually moves 250 USDC).
 */

/** Local development (localhost over http) is shown on the connect screen but is not a risk of the request. */
const NOT_A_REQUEST_RISK = new Set(["DOMAIN_LOCAL_DEVELOPMENT"]);

export interface ContextFindings {
  signals: RiskSignal[];
  evidence: Evidence[];
  /** Extra data sources consulted (e.g. the received-token scan). */
  sources?: DataSourceStatus[];
  /** A context check could not run completely: the analysis is no longer COMPLETE. */
  degraded?: boolean;
}

export function domainSignals(domain: DomainAnalysis | null): ContextFindings {
  const out: ContextFindings = { signals: [], evidence: [] };
  if (!domain) return out;
  domain.findings.filter((f) => !NOT_A_REQUEST_RISK.has(f.code)).forEach((f, i) => {
    const id = `presign-domain-${i + 1}`;
    out.evidence.push({ id, source: "DETERMINISTIC_RULE", label: "Application address", observed: domain.domain, condition: f.detail });
    out.signals.push({ code: f.code, title: `Application address: ${f.title}`, description: f.detail, severity: f.severity, evidenceIds: [id] });
  });
  return out;
}

function big(v: string | null | undefined): bigint {
  try {
    return v ? BigInt(v) : 0n;
  } catch {
    return 0n;
  }
}

const nonNegative = (v: bigint) => (v > 0n ? v : 0n);

/**
 * Compares the effects an application declared with the simulated effects on the signer's wallet.
 * Where other transactions changed the wallet's balances around the simulation (BRACKETED with
 * concurrent changes), the transaction's own outflow is only known as a range; it is reported as
 * exceeding the declaration only if every reading of that activity does, and the analysis is PARTIAL.
 * An UNVERIFIED pre-state keeps the raw reading (fail closed), also PARTIAL.
 */
export function expectedEffectSignals(a: Pick<TransactionAnalysis, "effects">, wallet: string, expected: ExpectedEffects | undefined): ContextFindings {
  const out: ContextFindings = { signals: [], evidence: [] };
  const e = a.effects;
  if (!expected || !e || e.source !== "SIMULATION" || !e.success) return out;
  const unverified = e.preStateConsistency?.kind === "UNVERIFIED";
  const concurrent = e.preStateConsistency?.concurrent ?? [];
  if (unverified && (expected.maxSolOutLamports !== undefined || expected.maxTokenOut !== undefined)) out.degraded = true;
  let n = 0;
  const add = (code: string, title: string, description: string, observed: string, condition: string) => {
    const id = `presign-expected-${++n}`;
    out.evidence.push({ id, source: "SIMULATION", label: "Declared by the application vs simulated", observed, condition: unverified ? `${condition}; pre-state not confirmed at the simulation slot, so this may include other transactions' activity` : condition });
    out.signals.push({ code, title, description, severity: "HIGH", evidenceIds: [id] });
  };

  if (expected.maxSolOutLamports !== undefined) {
    const delta = e.solChanges.filter((c) => c.address === wallet).reduce((s, c) => s + big(c.deltaLamports), 0n);
    const fee = big(e.feeLamports);
    const declared = big(expected.maxSolOutLamports);
    let outflow = -delta - fee;
    let range: { lo: bigint; hi: bigint } | null = null;
    // Other transactions moved the wallet's SOL around the simulation: `later - post - fee` is the other reading.
    const conc = concurrent.find((c) => c.address === wallet && c.lamports.pre !== c.lamports.later);
    if (conc) {
      out.degraded = true;
      const b = boundedOutflow(outflow, big(conc.lamports.later) - big(conc.lamports.post) - fee, declared);
      outflow = b.value;
      range = b;
    }
    if (outflow > declared) {
      const shown = `${range ? "at least " : ""}${formatLamports(outflow.toString())} SOL (network fee excluded${range ? "; other transactions also moved your SOL while it was simulated" : ""})`;
      const simulated = range ? `between ${range.lo} and ${range.hi} lamports` : `${outflow} lamports`;
      add("PRESIGN_SOL_EXCEEDS_DECLARED", "More SOL leaves than the application said", `The application said up to ${formatLamports(declared.toString())} SOL would leave your wallet; the simulation shows ${shown}.`, `declared ≤ ${declared} lamports, simulated ${simulated}`, range ? "simulated outflow exceeds the declared maximum under every reading of the concurrent activity" : "simulated outflow exceeds the declared maximum");
    }
  }

  if (expected.maxTokenOut !== undefined) {
    // Gross outflow per mint over the wallet's token accounts, as a range: for an account other transactions
    // changed around the simulation, its own outflow lies between `pre - post` and `later - post`.
    const concAccounts = new Map(concurrent.flatMap((c) => (c.token && c.token.owner === wallet && c.token.pre !== c.token.later ? [[c.address, c.token] as const] : [])));
    if (concAccounts.size > 0) out.degraded = true;
    const outByMint = new Map<string, { lo: bigint; hi: bigint; decimals: number; uncertain: boolean }>();
    const count = (mint: string, decimals: number, earlier: bigint, later: bigint, uncertain: boolean) => {
      const b = boundedOutflow(earlier, later, 0n);
      const cur = outByMint.get(mint) ?? { lo: 0n, hi: 0n, decimals, uncertain: false };
      outByMint.set(mint, { lo: cur.lo + nonNegative(b.lo), hi: cur.hi + nonNegative(b.hi), decimals: cur.decimals, uncertain: cur.uncertain || uncertain });
    };
    for (const c of e.tokenChanges) {
      const d = big(c.deltaRaw);
      if (c.owner !== wallet || d >= 0n || concAccounts.has(c.tokenAccount)) continue;
      count(c.mint, c.decimals, -d, -d, false);
    }
    for (const t of concAccounts.values()) count(t.mint, t.decimals, big(t.pre) - big(t.post), big(t.later) - big(t.post), true);

    for (const [mint, { lo, hi, decimals, uncertain }] of outByMint) {
      const declared = expected.maxTokenOut.find((t) => t.mint === mint);
      const max = declared ? big(declared.amountRaw) : 0n;
      const raw = boundedOutflow(lo, hi, max).value;
      if (raw <= max) continue;
      const shown = `${uncertain ? "at least " : ""}${formatRawAmount(raw.toString(), decimals)}${uncertain ? " (other transactions also changed this token balance while it was simulated)" : ""}`;
      const simulated = uncertain ? `between ${lo} and ${hi} raw` : `${raw} raw`;
      const everyReading = uncertain ? " under every reading of the concurrent activity" : "";
      if (!declared) {
        add(`PRESIGN_UNDECLARED_TOKEN_OUTFLOW:${mint}`, "Tokens leave that the application did not mention", `The simulation moves ${shown} of token ${mint.slice(0, 4)}…${mint.slice(-4)} out of your wallet; the application did not declare this token.`, `${mint}: simulated ${simulated}, not declared`, `undeclared token outflow${everyReading}`);
      } else {
        add(`PRESIGN_TOKEN_EXCEEDS_DECLARED:${mint}`, "More tokens leave than the application said", `The application said up to ${formatRawAmount(declared.amountRaw, decimals)} of this token would leave your wallet; the simulation shows ${shown}.`, `${mint}: declared ≤ ${declared.amountRaw} raw, simulated ${simulated}`, `simulated token outflow exceeds the declared maximum${everyReading}`);
      }
    }
  }
  return out;
}

/** Adds context findings to a risk assessment (same deterministic engine; level and score recomputed). */
export function mergeRisk(base: RiskAssessment, extra: ContextFindings[]): RiskAssessment {
  const signals = extra.flatMap((x) => x.signals);
  const sources = extra.flatMap((x) => x.sources ?? []);
  const degraded = extra.some((x) => x.degraded);
  if (signals.length === 0 && sources.length === 0 && !degraded) return base;
  return buildAssessment({
    category: base.category,
    signals: [...base.signals, ...signals],
    evidence: [...base.evidence, ...extra.flatMap((x) => x.evidence)],
    sources: [...base.sources, ...(signals.length > 0 ? [{ source: "DETERMINISTIC_RULE" as const, status: "OK" as const, detail: "request context (application address, declared effects, received tokens)" }] : []), ...sources],
    status: degraded && base.status === "COMPLETE" ? "PARTIAL" : base.status,
    now: new Date(base.analyzedAt),
  });
}
