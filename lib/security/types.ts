/**
 * Core security model shared by every analysis layer.
 *
 * Risk level and analysis status are deliberately independent:
 * a missing data source never collapses into "SAFE".
 */

export type AnalysisStatus =
  | "COMPLETE"
  | "PARTIAL"
  | "INSUFFICIENT_DATA"
  | "UNAVAILABLE";

/** Where a piece of evidence came from. On-chain facts and provider opinions are kept apart. */
export type DataSource =
  | "ONCHAIN_RPC"
  | "HELIUS_DAS"
  | "HELIUS_RPC"
  | "PUBLIC_RPC"
  | "RUGCHECK"
  | "SIMULATION"
  | "TRANSACTION_DECODER"
  /** Instruction names/arguments from the program's own on-chain Anchor IDL (describes intent, not verified behavior). */
  | "ANCHOR_IDL"
  | "SQUADS_ACCOUNT"
  /** OtterSec verified-builds registry (external opinion about source ↔ code). */
  | "VERIFIED_BUILDS"
  /** The team policy supplied with the request (the team's own rules). */
  | "TEAM_POLICY"
  | "DETERMINISTIC_RULE"
  | "DEMO";

export interface Evidence {
  /** Stable id so AI explanations and UI can reference the exact fact. */
  id: string;
  source: DataSource;
  /** Human readable description of what was observed. */
  label: string;
  /** Observed value, always serialized as string/boolean/null (never bigint). */
  observed: string | boolean | null;
  /** Condition under which this value becomes a risk signal. */
  condition?: string;
}

export interface DataSourceStatus {
  source: DataSource;
  status: "OK" | "FAILED" | "SKIPPED" | "NOT_CONFIGURED" | "UNSUPPORTED";
  /** Short, non-sensitive detail (never provider URLs or keys). */
  detail?: string;
}

export function combineStatuses(statuses: AnalysisStatus[]): AnalysisStatus {
  if (statuses.length === 0) return "INSUFFICIENT_DATA";
  if (statuses.every((s) => s === "COMPLETE")) return "COMPLETE";
  if (statuses.every((s) => s === "UNAVAILABLE")) return "UNAVAILABLE";
  if (statuses.some((s) => s === "INSUFFICIENT_DATA" || s === "UNAVAILABLE")) {
    return statuses.some((s) => s === "COMPLETE" || s === "PARTIAL")
      ? "PARTIAL"
      : "INSUFFICIENT_DATA";
  }
  return "PARTIAL";
}
