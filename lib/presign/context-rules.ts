import { buildAssessment } from "@/lib/security/engine";
import type { RiskAssessment, RiskSignal } from "@/lib/security/risk";
import type { DataSourceStatus, Evidence } from "@/lib/security/types";
import { formatLamports, formatRawAmount } from "@/lib/token/amount";
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

/** Compares the effects an application declared with the simulated effects on the signer's wallet. */
export function expectedEffectSignals(a: TransactionAnalysis, wallet: string, expected: ExpectedEffects | undefined): ContextFindings {
  const out: ContextFindings = { signals: [], evidence: [] };
  const e = a.effects;
  if (!expected || !e || e.source !== "SIMULATION" || !e.success) return out;
  let n = 0;
  const add = (code: string, title: string, description: string, observed: string, condition: string) => {
    const id = `presign-expected-${++n}`;
    out.evidence.push({ id, source: "SIMULATION", label: "Declared by the application vs simulated", observed, condition });
    out.signals.push({ code, title, description, severity: "HIGH", evidenceIds: [id] });
  };

  if (expected.maxSolOutLamports !== undefined) {
    const delta = e.solChanges.filter((c) => c.address === wallet).reduce((s, c) => s + big(c.deltaLamports), 0n);
    const fee = big(e.feeLamports);
    const out_ = -delta - fee;
    const declared = big(expected.maxSolOutLamports);
    if (out_ > declared) {
      add("PRESIGN_SOL_EXCEEDS_DECLARED", "More SOL leaves than the application said", `The application said up to ${formatLamports(declared.toString())} SOL would leave your wallet; the simulation shows ${formatLamports(out_.toString())} SOL (network fee excluded).`, `declared ≤ ${declared} lamports, simulated ${out_} lamports`, "simulated outflow exceeds the declared maximum");
    }
  }

  if (expected.maxTokenOut !== undefined) {
    const outByMint = new Map<string, { raw: bigint; decimals: number }>();
    for (const c of e.tokenChanges) {
      const d = big(c.deltaRaw);
      if (c.owner !== wallet || d >= 0n) continue;
      const cur = outByMint.get(c.mint) ?? { raw: 0n, decimals: c.decimals };
      outByMint.set(c.mint, { raw: cur.raw - d, decimals: c.decimals });
    }
    for (const [mint, { raw, decimals }] of outByMint) {
      const declared = expected.maxTokenOut.find((t) => t.mint === mint);
      const shown = formatRawAmount(raw.toString(), decimals);
      if (!declared) {
        add(`PRESIGN_UNDECLARED_TOKEN_OUTFLOW:${mint}`, "Tokens leave that the application did not mention", `The simulation moves ${shown} of token ${mint.slice(0, 4)}…${mint.slice(-4)} out of your wallet; the application did not declare this token.`, `${mint}: simulated ${raw} raw, not declared`, "undeclared token outflow");
      } else if (raw > big(declared.amountRaw)) {
        add(`PRESIGN_TOKEN_EXCEEDS_DECLARED:${mint}`, "More tokens leave than the application said", `The application said up to ${formatRawAmount(declared.amountRaw, decimals)} of this token would leave your wallet; the simulation shows ${shown}.`, `${mint}: declared ≤ ${declared.amountRaw} raw, simulated ${raw} raw`, "simulated token outflow exceeds the declared maximum");
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
