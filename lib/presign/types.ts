import type { Gate } from "@/lib/agent/gate";
import type { RiskAssessment, RiskVerdict } from "@/lib/security/risk";
import type { AnalysisStatus } from "@/lib/security/types";

/**
 * Secure connect + pre-sign review: shared types.
 *
 * Two decision layers are kept apart on purpose:
 *  - the MACHINE gate (`Gate`, lib/agent/gate.ts) stays fail-closed for bots,
 *    backends and AI agents: HIGH / CRITICAL → "block";
 *  - the HUMAN decision (`SigningDecision`) lets a person who has seen the
 *    evidence explicitly continue with a valid, analyzable request.
 * A request Presign cannot verify (malformed, changed, expired…) is neither:
 * it is stopped, and no "sign anyway" is offered.
 */

/** Outcome of one pre-connect / domain check. NOT_PROVIDED and UNKNOWN are never shown as passing. */
export type CheckStatus = "PASS" | "WARN" | "FAIL" | "UNKNOWN" | "NOT_PROVIDED";

export interface ConnectCheck {
  id: "presign-origin" | "https" | "session" | "request-structure" | "target-domain" | "request-expiry";
  label: string;
  status: CheckStatus;
  detail: string;
}

export type DomainStatus = "SAFE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "UNKNOWN";

export interface SecurityFinding {
  code: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  title: string;
  detail: string;
}

export interface DomainAnalysis {
  /** Display-safe (defanged) host, e.g. "app[.]example[.]com". */
  domain: string;
  /** Normalized origin, or null when the input was not a valid URL. */
  origin: string | null;
  valid: boolean;
  status: DomainStatus;
  /** Deterministic weighted score of the findings; null when nothing was found and reputation is unknown. */
  score: number | null;
  findings: SecurityFinding[];
  reasons: string[];
  /** External reputation is not configured: only structural pattern checks ran. */
  reputation: "NOT_CONFIGURED";
  checkedAt: string;
}

/** Normalized context of a connection request (dApp integration, SDK, extension, demo, deep link). */
export interface PresignConnectionRequest {
  requestId: string;
  targetOrigin?: string;
  targetHostname?: string;
  /** Name as claimed by the request — untrusted display text, never verified. */
  targetName?: string;
  walletType?: string;
  /** Validated: same origin as `targetOrigin`, https only. */
  returnUrl?: string;
  createdAt: string;
  expiresAt: string;
  nonce: string;
}

export interface ConnectionContext {
  request: PresignConnectionRequest;
  /** Sealed, session-bound copy of `request` the client hands back later. */
  connectionToken: string;
  checks: ConnectCheck[];
  domain: DomainAnalysis | null;
  /** True when every check that ran passed; NOT_PROVIDED target keeps this false (unknown is not safe). */
  allChecksPassed: boolean;
}

export interface OwnershipChallenge {
  message: string;
  nonceToken: string;
  issuedAt: string;
  expiresAt: string;
}

export interface VerifiedWallet {
  wallet: string;
  verifiedAt: string;
  expiresAt: string;
}

export interface PresignSession {
  sessionActive: boolean;
  verified: VerifiedWallet | null;
}

export type SigningRequestType = "MESSAGE" | "TRANSACTION";
export type PayloadEncoding = "base58" | "base64" | "utf8";

/** What the requesting application SAYS the request does — untrusted, compared with the simulation. */
export interface ExpectedEffects {
  summary?: string;
  /** Maximum SOL (lamports) the application says leaves the wallet, network fee excluded. */
  maxSolOutLamports?: string;
  /** Maximum raw amount per mint the application says leaves the wallet; a mint not listed is undeclared. */
  maxTokenOut?: Array<{ mint: string; amountRaw: string }>;
}

export interface PresignSigningRequest {
  requestId: string;
  walletAddress: string;
  type: SigningRequestType;
  payload: string;
  payloadEncoding?: PayloadEncoding;
  /** sha256 (hex) of the exact bytes the wallet would sign (transaction message bytes, or message bytes). */
  payloadHash?: string;
  domain?: string;
  application?: string;
  expectedEffects?: ExpectedEffects;
  createdAt: string;
  expiresAt: string;
}

/**
 * VALID: decoded, simulated where applicable, integrity verified — the user may decide.
 * UNVERIFIABLE: Presign cannot reliably tell what it does (no simulation, unresolved accounts…).
 * INVALID: malformed, unsupported, wrong wallet, expired — cannot be signed as presented.
 */
export type TechnicalValidation = "VALID" | "UNVERIFIABLE" | "INVALID";

export type RecommendedAction = "SIGN" | "REVIEW" | "CAUTION" | "DO_NOT_SIGN" | "CANNOT_VERIFY";

/** What the human must do before the wallet is asked: nothing extra, look at the findings, or confirm one explicit override. */
export type RequiredConfirmation = "NONE" | "ACKNOWLEDGE" | "EXPLICIT_OVERRIDE" | "NOT_ALLOWED";

export type UserChoice = "SIGN" | "CONTINUE" | "OVERRIDE";

export interface TechnicalIssue {
  code: string;
  kind: "INVALID" | "UNVERIFIABLE";
  message: string;
}

export interface SigningDecision {
  risk: { level: RiskVerdict; score: number | null; status: AnalysisStatus };
  /** Machine gate, unchanged: automated signers must follow it. */
  gate: Gate;
  technicalValidation: TechnicalValidation;
  technicalIssues: TechnicalIssue[];
  recommendedAction: RecommendedAction;
  /** True for a VALID request: the human reviews the evidence and makes the decision (whatever the machine gate says). */
  userCanReview: boolean;
  /** True only for a VALID request whose risk is MEDIUM, UNKNOWN, HIGH or CRITICAL. */
  userCanOverride: boolean;
  requiredConfirmation: RequiredConfirmation;
  /** The one choice the approval endpoint accepts for this request (null when signing is not possible). */
  expectedChoice: UserChoice | null;
  primaryActionLabel: string | null;
  headline: string;
}

export interface SimulationSummary {
  status: "PASS" | "WARNING" | "FAILED" | "UNAVAILABLE";
  logs: string[];
  errors: string[];
  balanceChanges: Array<{ address: string; deltaLamports: string }>;
  tokenChanges: Array<{ tokenAccount: string; owner: string | null; mint: string; deltaRaw: string; decimals: number }>;
  accountChanges: Array<{ address: string; change: string }>;
  unexpectedEffects: string[];
  warnings: string[];
}

export interface PlainExplanation {
  headline: string;
  whatHappens: string[];
  assetMovements: string[];
  programs: string[];
  accountChanges: string[];
  whyRisky: string[];
  simulation: string;
  completeness: string;
}

/** Structured, server-attested findings — the only input the AI explanation layer receives. */
export interface SigningFindings {
  type: SigningRequestType;
  application: string | null;
  domain: string | null;
  riskLevel: RiskVerdict;
  riskScore: number | null;
  analysisStatus: AnalysisStatus;
  technicalValidation: TechnicalValidation;
  signals: Array<{ code: string; severity: string; title: string; description: string }>;
  whatHappens: string[];
  assetMovements: string[];
  authorityChanges: string[];
  programs: string[];
  simulation: string;
  multisig: string[];
}

/** The multisig view of a Squads request, in the order a council member checks it. */
export interface MultisigSummary {
  multisig: string | null;
  action: string;
  afterExecution: string[];
  /** e.g. "Admin leaves the multisig" (control outside) — null when no privileged change. */
  control: { text: string; leavesMultisig: boolean } | null;
  threshold: string | null;
  /** Seconds; null when the multisig account could not be loaded. */
  timeLockSeconds: number | null;
  durableNonce: boolean;
}

export interface TransactionFacts {
  version: string;
  feePayer: string;
  recentBlockhash: string;
  signers: string[];
  writableAccounts: string[];
  programs: Array<{ programId: string; name: string; trust: string }>;
  instructionCount: number;
  usesDurableNonce: boolean;
}

export interface SigningReview {
  request: PresignSigningRequest;
  connection: { origin: string | null; name: string | null; verifiedByPresign: boolean; domain: DomainAnalysis | null };
  decision: SigningDecision;
  explanation: PlainExplanation;
  simulation: SimulationSummary | null;
  findings: SigningFindings;
  /** The authoritative deterministic risk of this request (transaction or message rules + request context). */
  risk: RiskAssessment | null;
  multisigSummary: MultisigSummary | null;
  txFacts: TransactionFacts | null;
  /** Sealed binding of request + wallet + session + payload hash + risk; null when the request cannot be signed. */
  analysisToken: string | null;
  /** Sealed hash of `findings`, so the AI layer only explains what Presign actually found. */
  findingsToken: string;
  /** The full transaction analysis (TransactionAnalysis) or message analysis — evidence for the UI. */
  transaction: unknown | null;
  message: { text: string | null; byteLength: number } | null;
  analysisVersion: string;
}

export interface SigningApproval {
  approvalToken: string;
  requestId: string;
  /** The decision the user made (recorded with this approval only — never reused). */
  userDecision: UserChoice;
  payloadHash: string;
  expiresAt: string;
}
