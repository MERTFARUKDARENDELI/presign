import type { RiskVerdict } from "@/lib/security/risk";
import type { AnalysisStatus } from "@/lib/security/types";

/**
 * Deterministic pre-sign gate for automated signers (AI agents, bots,
 * backends). It maps a verdict to an action with no judgment involved, so an
 * LLM cannot argue its way past it. Missing data never maps to "no_known_risk".
 */

export type Gate = "block" | "require_human_review" | "no_known_risk";

export function gateFor(level: RiskVerdict, status: AnalysisStatus): Gate {
  if (level === "CRITICAL" || level === "HIGH") return "block";
  if (level === "MEDIUM" || level === "UNKNOWN" || status !== "COMPLETE") return "require_human_review";
  return "no_known_risk";
}

export const GATE_MEANING: Record<Gate, string> = {
  block: "Do not sign. At least one high or critical risk signal was found.",
  require_human_review: "Do not sign automatically. A human must review the signals, or the analysis was incomplete.",
  no_known_risk: "No risk signal found by complete checks. This is not a guarantee of safety.",
};
