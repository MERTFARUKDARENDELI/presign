import {
  maxRisk,
  type RiskAssessment,
  type RiskCategory,
  type RiskLevel,
  type RiskSignal,
} from "./risk";
import type { AnalysisStatus, DataSourceStatus, Evidence } from "./types";

/**
 * Deterministic risk aggregation. Same inputs → same output, no AI involved.
 *
 * Rules:
 *  - level = highest signal severity
 *  - no signals + COMPLETE analysis → SAFE (no evidence of risk found by all required checks)
 *  - no signals + anything less than COMPLETE → UNKNOWN (never SAFE)
 *  - score is a capped weighted sum; null when there is no signal and data is incomplete
 */

export const SEVERITY_WEIGHT: Record<Exclude<RiskLevel, "SAFE">, number> = {
  LOW: 10,
  MEDIUM: 25,
  HIGH: 50,
  CRITICAL: 90,
};

export interface AssessmentInput {
  category: RiskCategory;
  signals: RiskSignal[];
  evidence: Evidence[];
  sources: DataSourceStatus[];
  status: AnalysisStatus;
  now?: Date;
}

export function computeScore(signals: RiskSignal[]): number {
  const total = signals.reduce((sum, s) => sum + SEVERITY_WEIGHT[s.severity], 0);
  return Math.min(100, total);
}

export function assertSignalsHaveEvidence(
  signals: RiskSignal[],
  evidence: Evidence[],
): void {
  const ids = new Set(evidence.map((e) => e.id));
  for (const signal of signals) {
    if (signal.evidenceIds.length === 0) {
      throw new Error(`Risk signal ${signal.code} has no evidence.`);
    }
    for (const id of signal.evidenceIds) {
      if (!ids.has(id)) {
        throw new Error(`Risk signal ${signal.code} references missing evidence ${id}.`);
      }
    }
  }
}

function dedupeSignals(signals: RiskSignal[]): RiskSignal[] {
  const seen = new Map<string, RiskSignal>();
  for (const s of signals) {
    if (!seen.has(s.code)) seen.set(s.code, s);
  }
  return [...seen.values()];
}

export function buildAssessment(input: AssessmentInput): RiskAssessment {
  const signals = dedupeSignals(input.signals).sort(
    (a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity] || a.code.localeCompare(b.code),
  );
  assertSignalsHaveEvidence(signals, input.evidence);

  const complete = input.status === "COMPLETE";
  let level: RiskAssessment["level"];
  let score: number | null;
  let summary: string;

  if (signals.length === 0) {
    level = complete ? "SAFE" : "UNKNOWN";
    score = complete ? 0 : null;
    summary = complete
      ? "No evidence of risk was found by the completed checks. This is not a guarantee of safety."
      : `No risk signal was found, but the analysis is ${input.status}. Missing data is not evidence of safety.`;
  } else {
    level = maxRisk(signals.map((s) => s.severity));
    score = computeScore(signals);
    summary = `${signals.length} risk signal(s) found; highest severity ${level}.` +
      (complete ? "" : ` Analysis is ${input.status}, so additional risks may exist.`);
  }

  return {
    category: input.category,
    level,
    score,
    status: input.status,
    signals,
    evidence: input.evidence,
    sources: input.sources,
    summary,
    analyzedAt: (input.now ?? new Date()).toISOString(),
  };
}
