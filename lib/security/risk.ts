import type { AnalysisStatus, DataSourceStatus, Evidence } from "./types";

export const RISK_LEVELS = ["SAFE", "LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];

/**
 * "UNKNOWN" is shown when no risk signal was found but the analysis was not
 * complete — absence of evidence is not proof of safety.
 */
export type RiskVerdict = RiskLevel | "UNKNOWN";

export type RiskCategory = "token" | "wallet" | "transaction" | "asset" | "proposal" | "multisig" | "message";

export interface RiskSignal {
  /** Stable rule id, e.g. TOKEN_FREEZE_AUTHORITY_ACTIVE. */
  code: string;
  title: string;
  description: string;
  severity: Exclude<RiskLevel, "SAFE">;
  /** Evidence ids backing this signal. A signal without evidence is never emitted. */
  evidenceIds: string[];
}

export interface RiskAssessment {
  category: RiskCategory;
  level: RiskVerdict;
  /** 0–100, deterministic; null when data is insufficient to avoid false precision. */
  score: number | null;
  status: AnalysisStatus;
  signals: RiskSignal[];
  evidence: Evidence[];
  sources: DataSourceStatus[];
  /** Plain statement distinguishing "no evidence of risk" from "proven safe". */
  summary: string;
  analyzedAt: string;
}

export function riskRank(level: RiskVerdict): number {
  return level === "UNKNOWN" ? -1 : RISK_LEVELS.indexOf(level);
}

export function maxRisk(levels: RiskLevel[]): RiskLevel {
  return levels.reduce<RiskLevel>(
    (acc, l) => (riskRank(l) > riskRank(acc) ? l : acc),
    "SAFE",
  );
}
