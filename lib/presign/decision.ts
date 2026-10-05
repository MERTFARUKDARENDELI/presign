import { gateFor, type Gate } from "@/lib/agent/gate";
import { describeTransactionError } from "@/lib/cleanup/reclaim";
import type { RiskAssessment, RiskVerdict } from "@/lib/security/risk";
import type { AnalysisStatus } from "@/lib/security/types";
import type { TransactionAnalysis } from "@/lib/transaction/types";
import type { SigningDecision, SimulationSummary, TechnicalIssue, TechnicalValidation, UserChoice } from "./types";

/**
 * The HUMAN decision layer, derived from — never instead of — the machine gate.
 *
 *   machine gate (unchanged)          human decision
 *   CRITICAL / HIGH  → block          valid → user may override after ONE explicit confirmation
 *   MEDIUM / UNKNOWN → human review   valid → user may continue
 *   LOW / SAFE       → no known risk  valid → user may sign (continue, if some checks did not run)
 *   anything         → (as above)     UNVERIFIABLE / INVALID → stop, no "sign anyway"
 *
 * Presign advises; the user decides — but only about a request Presign could
 * actually verify. "Dangerous but understood" and "cannot be verified" are
 * different outcomes and never share a code path.
 */

export const ANALYSIS_VERSION = "presign-signing-1";

export function technicalValidationOf(issues: TechnicalIssue[]): TechnicalValidation {
  if (issues.some((i) => i.kind === "INVALID")) return "INVALID";
  if (issues.some((i) => i.kind === "UNVERIFIABLE")) return "UNVERIFIABLE";
  return "VALID";
}

/**
 * The single choice the approval endpoint accepts for a VALID request at this
 * risk level. A LOW (or SAFE) result from an incomplete analysis is a
 * "continue", not a plain "sign": the checks that did not run may hold the risk.
 */
export function expectedChoiceFor(level: RiskVerdict, status: AnalysisStatus): UserChoice {
  if (level === "HIGH" || level === "CRITICAL") return "OVERRIDE";
  if (level === "MEDIUM" || level === "UNKNOWN" || status !== "COMPLETE") return "CONTINUE";
  return "SIGN";
}

export function deriveDecision(risk: Pick<RiskAssessment, "level" | "score" | "status">, gate: Gate, issues: TechnicalIssue[]): SigningDecision {
  const technicalValidation = technicalValidationOf(issues);
  const base = { risk: { level: risk.level, score: risk.score, status: risk.status }, gate, technicalValidation, technicalIssues: issues, userCanReview: technicalValidation === "VALID" };

  if (technicalValidation !== "VALID") {
    return {
      ...base,
      recommendedAction: "CANNOT_VERIFY",
      userCanOverride: false,
      requiredConfirmation: "NOT_ALLOWED",
      expectedChoice: null,
      primaryActionLabel: null,
      headline: "Unable to safely verify this signing request.",
    };
  }

  if (risk.status !== "COMPLETE" && (risk.level === "LOW" || risk.level === "SAFE")) {
    return { ...base, recommendedAction: "CAUTION", userCanOverride: true, requiredConfirmation: "ACKNOWLEDGE", expectedChoice: "CONTINUE", primaryActionLabel: "Continue anyway", headline: "Only low-risk signals found, but some checks could not run. Incomplete is not safe." };
  }

  switch (risk.level) {
    case "CRITICAL":
      return { ...base, recommendedAction: "DO_NOT_SIGN", userCanOverride: true, requiredConfirmation: "EXPLICIT_OVERRIDE", expectedChoice: "OVERRIDE", primaryActionLabel: "I understand the critical risk — sign anyway", headline: "Critical risk detected. Presign strongly recommends that you do not sign this request." };
    case "HIGH":
      return { ...base, recommendedAction: "DO_NOT_SIGN", userCanOverride: true, requiredConfirmation: "EXPLICIT_OVERRIDE", expectedChoice: "OVERRIDE", primaryActionLabel: "I understand the risk — sign anyway", headline: "High risk. Presign recommends that you do not sign this request." };
    case "MEDIUM":
      return { ...base, recommendedAction: "CAUTION", userCanOverride: true, requiredConfirmation: "ACKNOWLEDGE", expectedChoice: "CONTINUE", primaryActionLabel: "Continue anyway", headline: "Medium risk. Review the findings before you continue." };
    case "UNKNOWN":
      return { ...base, recommendedAction: "CAUTION", userCanOverride: true, requiredConfirmation: "ACKNOWLEDGE", expectedChoice: "CONTINUE", primaryActionLabel: "Continue anyway", headline: "No risk signal found, but some checks could not run. Unknown is not safe." };
    case "LOW":
      return { ...base, recommendedAction: "REVIEW", userCanOverride: false, requiredConfirmation: "ACKNOWLEDGE", expectedChoice: "SIGN", primaryActionLabel: "Sign", headline: "Low risk. Read the details, then sign if this is what you intend." };
    case "SAFE":
    default:
      return { ...base, recommendedAction: "SIGN", userCanOverride: false, requiredConfirmation: "NONE", expectedChoice: "SIGN", primaryActionLabel: "Sign with wallet", headline: "No significant security issue detected by the completed checks." };
  }
}

/**
 * Server-side technical checks of an analyzed transaction for a given wallet:
 * the same conditions the /transaction sign gate enforces, as structured issues.
 * None of them depends on the risk level.
 */
export function transactionIssues(a: TransactionAnalysis, wallet: string): TechnicalIssue[] {
  const issues: TechnicalIssue[] = [];
  const e = a.effects;
  if (a.demo) issues.push({ code: "DEMO_TRANSACTION", kind: "INVALID", message: "Demo sample data can never be signed." });
  if (a.inputKind === "signature") issues.push({ code: "ALREADY_EXECUTED", kind: "INVALID", message: "This transaction was already executed on-chain; there is nothing to sign." });
  if (a.decoded.version === 1) issues.push({ code: "UNSUPPORTED_VERSION", kind: "INVALID", message: "v1 transactions can be analyzed but not signed in this app yet." });
  if (!a.decoded.signers.includes(wallet)) issues.push({ code: "WALLET_NOT_SIGNER", kind: "INVALID", message: "The connected wallet is not a required signer of this transaction." });
  if (a.perspectiveWallet !== wallet) issues.push({ code: "PERSPECTIVE_MISMATCH", kind: "INVALID", message: "The analysis was made from another wallet's perspective." });
  if (!a.messageHash) issues.push({ code: "NO_PAYLOAD_HASH", kind: "INVALID", message: "The exact transaction bytes could not be bound to the analysis." });
  if (!a.decoded.lookupTablesResolved) issues.push({ code: "LOOKUP_TABLES_UNRESOLVED", kind: "UNVERIFIABLE", message: "Address lookup tables could not be resolved, so some accounts are unknown." });
  if (!e || e.source !== "SIMULATION") {
    issues.push({ code: "SIMULATION_UNAVAILABLE", kind: "UNVERIFIABLE", message: "The transaction could not be simulated, so its effects are unknown." });
  } else {
    if (!e.success) issues.push({ code: "SIMULATION_FAILED", kind: "UNVERIFIABLE", message: `The simulation failed${describeTransactionError(e.error) ? ` (${describeTransactionError(e.error)})` : ""}: Presign cannot show what this transaction would do.` });
    if (e.stale) issues.push({ code: "SIMULATION_STALE", kind: "UNVERIFIABLE", message: "The simulation ran against stale state." });
    if (e.blockhashValid === false && !a.decoded.usesDurableNonce) issues.push({ code: "BLOCKHASH_EXPIRED", kind: "INVALID", message: "The transaction's blockhash has expired; the network would reject it. Ask the application for a new request." });
  }
  if (a.risk.status === "INSUFFICIENT_DATA" || a.risk.status === "UNAVAILABLE") issues.push({ code: "RISK_INCOMPLETE", kind: "UNVERIFIABLE", message: "Risk analysis is incomplete (insufficient data)." });
  return issues;
}

/** Recomputes the machine gate from the risk (identical to /api/transaction/analyze). */
export function machineGate(risk: Pick<RiskAssessment, "level" | "status">): Gate {
  return gateFor(risk.level, risk.status);
}

const EXPECTED_EFFECT_CODES = /^(TX_SOL_OUTFLOW|TX_TOKEN_OUTFLOW|TX_RENT_DEPOSIT)/;

export function simulationSummary(a: TransactionAnalysis, risk: Pick<RiskAssessment, "signals"> = a.risk): SimulationSummary {
  const e = a.effects;
  const warnings = risk.signals.filter((s) => s.severity !== "LOW" || !EXPECTED_EFFECT_CODES.test(s.code)).map((s) => `${s.severity}: ${s.title}`);
  if (!e || e.source !== "SIMULATION") {
    return { status: "UNAVAILABLE", logs: [], errors: ["The simulation could not run; effects are unknown."], balanceChanges: [], tokenChanges: [], accountChanges: [], unexpectedEffects: [], warnings };
  }
  const unexpectedEffects = risk.signals
    .filter((s) => /UNEXPECTED|DRAIN|OWNER_CHANGE|OWNER_REASSIGN|APPROVAL|AUTHORITY|CLOSE_RENT|FULL_BALANCE|DECLARED|CNFT|STAKE_WITHDRAW|PRIORITY_FEE|EVASION|RECEIVED_RISKY|WALLET_ALLOCATE/.test(s.code))
    .map((s) => `${s.title}: ${s.description}`);
  const accountChanges = e.accountChanges.map((c) => ({
    address: c.address,
    change: [c.created ? "created" : null, c.closed ? "closed" : null, c.ownerBefore !== c.ownerAfter ? `owner ${c.ownerBefore ?? "none"} → ${c.ownerAfter ?? "none"}` : null, c.delegateBefore !== c.delegateAfter && (c.delegateBefore || c.delegateAfter) ? `delegate ${c.delegateBefore ?? "none"} → ${c.delegateAfter ?? "none"}` : null].filter(Boolean).join(", ") || "state changed",
  }));
  const status: SimulationSummary["status"] = !e.success ? "FAILED" : unexpectedEffects.length > 0 || e.stale ? "WARNING" : "PASS";
  return {
    status,
    logs: e.logs.slice(0, 60),
    errors: e.success ? [] : [describeTransactionError(e.error) ?? e.error ?? "Simulation failed."],
    balanceChanges: e.solChanges.map((c) => ({ address: c.address, deltaLamports: c.deltaLamports })),
    tokenChanges: e.tokenChanges.map((c) => ({ tokenAccount: c.tokenAccount, owner: c.owner, mint: c.mint, deltaRaw: c.deltaRaw, decimals: c.decimals })),
    accountChanges,
    unexpectedEffects,
    warnings: e.stale ? ["Simulated against stale state.", ...warnings] : warnings,
  };
}
