import "server-only";
import { VersionedTransaction } from "@solana/web3.js";
import { AppError, isAppError } from "@/lib/api/errors";
import { logger } from "@/lib/api/logger";
import { CONTROL_TEXT } from "@/lib/multisig/brief";
import { explainTransaction } from "@/lib/transaction/explain";
import { analyzeTransaction } from "@/lib/transaction/analyze";
import { bytesToBase64, MAX_TX_BYTES } from "@/lib/transaction/input";
import type { TransactionAnalysis } from "@/lib/transaction/types";
import { messageHashOfTx, verifyTransactionSignatures } from "@/lib/wallet/signing";
import { openConnection } from "./connection";
import { analyzeDomain } from "./domain";
import { ANALYSIS_VERSION, deriveDecision, expectedChoiceFor, machineGate, simulationSummary, transactionIssues } from "./decision";
import { domainSignals, expectedEffectSignals, mergeRisk } from "./context-rules";
import { receivedTokenSignals } from "./received-tokens";
import { recipientHistorySignals } from "./recipient-history";
import { analyzeMessage } from "./message";
import { decodePayload, payloadHashOf } from "./payload";
import { consumeOnce } from "./replay";
import { canonicalJson, openToken, randomId, sealToken, sha256Hex } from "./tokens";
import type {
  ExpectedEffects,
  MultisigSummary,
  PayloadEncoding,
  PlainExplanation,
  PresignSigningRequest,
  SigningApproval,
  SigningFindings,
  SigningRequestType,
  SigningReview,
  TechnicalIssue,
  TransactionFacts,
  UserChoice,
} from "./types";
import type { RiskVerdict } from "@/lib/security/risk";
import type { AnalysisStatus } from "@/lib/security/types";
import type { Gate } from "@/lib/agent/gate";

/**
 * Pre-sign review of the EXACT payload a wallet would sign, bound to the
 * request id, the wallet, the browser session and the payload hash.
 *
 *   analyze  → decode → simulate → deterministic rules → decision + sealed analysis token
 *   approve  → re-hash the payload the client is about to sign, check it against the
 *              token, check the user's choice against the risk the SERVER computed,
 *              spend the request id → short-lived approval token
 *   submit   → (/api/transaction/submit) the signed bytes must hash to the approved payload
 *
 * Nothing here signs: the wallet is the only signer, in the browser.
 */

export const ANALYSIS_TTL_MS = 5 * 60_000;
export const APPROVAL_TTL_MS = 2 * 60_000;

export interface AnalyzeSigningInput {
  type: SigningRequestType;
  payload: string;
  payloadEncoding?: PayloadEncoding;
  walletAddress: string;
  application?: string;
  domain?: string;
  connectionToken?: string;
  /** What the application says the request does (untrusted; compared with the simulation). */
  expectedEffects?: ExpectedEffects;
}

interface SealedAnalysis {
  rid: string;
  w: string;
  sid: string;
  ph: string;
  t: SigningRequestType;
  av: string;
  lvl: RiskVerdict;
  st: AnalysisStatus;
  gate: Gate;
  tv: "VALID";
  uco: boolean;
  choice: UserChoice;
  fh: string;
  /** Target origin of the request (Presign-verified or claimed), bound to the review. */
  to: string | null;
}

interface SealedFindings {
  fh: string;
  sid: string;
}

interface SealedApproval {
  rid: string;
  w: string;
  sid: string;
  ph: string;
  t: SigningRequestType;
  choice: UserChoice;
  lvl: RiskVerdict;
  to: string | null;
}

// ---------- findings for the explanation layer ----------

const short = (a: string | null | undefined) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "none");

function transactionFindings(a: TransactionAnalysis): Pick<SigningFindings, "authorityChanges" | "multisig"> {
  const authorityChanges = [
    ...a.decoded.authorityChanges.map((c) => `${c.authorityType} of ${short(c.account)}: ${short(c.currentAuthority)} → ${short(c.newAuthority)}`),
    ...a.decoded.approvals.map((ap) => `Token approval on ${short(ap.account)}: delegate ${short(ap.delegate)}, amount ${ap.unlimited ? "UNLIMITED" : ap.amountRaw}`),
  ];
  const multisig = a.brief
    ? [a.brief.headline, ...(a.brief.neverExpires ? ["Signed inside a durable nonce: the signature never expires."] : []), ...a.brief.signedInAdvance, ...a.brief.payloads.flatMap((p) => p.steps.map((s) => (s.privileged?.control ? `${s.text} (${CONTROL_TEXT[s.privileged.control]})` : s.text)))]
    : [];
  return { authorityChanges, multisig };
}

function multisigSummaryOf(a: TransactionAnalysis): MultisigSummary | null {
  if (!a.multisig && !a.brief) return null;
  const account = a.multisig?.account ?? null;
  const steps = a.brief?.payloads.flatMap((p) => p.steps) ?? [];
  const privileged = steps.filter((x) => x.privileged);
  const outside = privileged.find((x) => x.privileged?.control === "outside");
  const label = (kind: string) => {
    const k = kind.replace(/-transfer$|-change$/, "").replaceAll("-", " ");
    return k.charAt(0).toUpperCase() + k.slice(1);
  };
  let control: MultisigSummary["control"] = null;
  if (outside?.privileged) {
    control = { text: `${label(outside.privileged.kind)} leaves the multisig: new holder ${short(outside.privileged.newAuthority)} is ${CONTROL_TEXT.outside}`, leavesMultisig: true };
  } else if (privileged[0]?.privileged) {
    const p = privileged[0].privileged;
    control = { text: `${label(p.kind)}: ${p.control ? CONTROL_TEXT[p.control] : "holder could not be classified"}`, leavesMultisig: false };
  }
  return {
    multisig: a.multisig?.multisig ?? a.brief?.multisig ?? null,
    action: a.brief?.headline ?? "Squads multisig instruction",
    afterExecution: privileged.map((x) => x.text),
    control,
    threshold: a.brief?.config ?? (account ? `${account.threshold} of ${account.members.length}` : null),
    timeLockSeconds: account ? account.timeLock : null,
    durableNonce: a.decoded.usesDurableNonce || Boolean(a.brief?.neverExpires),
  };
}

function txFactsOf(a: TransactionAnalysis): TransactionFacts {
  const d = a.decoded;
  return {
    version: d.version === "legacy" ? "legacy" : `v${d.version}`,
    feePayer: d.feePayer,
    recentBlockhash: d.recentBlockhash,
    signers: d.signers,
    writableAccounts: d.accounts.filter((x) => x.writable).map((x) => x.address ?? "(from an unresolved lookup table)"),
    programs: d.programs,
    instructionCount: d.instructions.length,
    usesDurableNonce: d.usesDurableNonce,
  };
}

function fromTxExplanation(a: TransactionAnalysis): PlainExplanation {
  const e = explainTransaction(a);
  return { headline: e.headline, whatHappens: e.whatHappens, assetMovements: e.assetMovements, programs: e.programs, accountChanges: e.accountChanges, whyRisky: e.whyRisky, simulation: e.simulation, completeness: e.completeness };
}

// ---------- analyze ----------

export async function analyzeSigning(input: AnalyzeSigningInput, sid: string, now: number = Date.now()): Promise<SigningReview> {
  const requestId = randomId(16);
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ANALYSIS_TTL_MS).toISOString();

  // Connection context: only an origin Presign itself validated counts as verified.
  let origin: string | null = null;
  let name: string | null = input.application?.slice(0, 64) ?? null;
  let verifiedByPresign = false;
  if (input.connectionToken) {
    const conn = openConnection(input.connectionToken, sid, now);
    origin = conn.targetOrigin ?? null;
    name = conn.targetName ?? name;
    verifiedByPresign = Boolean(conn.targetOrigin);
  } else if (input.domain) {
    origin = input.domain.slice(0, 2_048);
  }
  const domain = origin ? analyzeDomain(origin, new Date(now), { name: name ?? undefined }) : null;

  const bytes = decodePayload(input.type, input.payload, input.payloadEncoding);
  const request: PresignSigningRequest = {
    requestId,
    walletAddress: input.walletAddress,
    type: input.type,
    payload: input.payload,
    ...(input.payloadEncoding ? { payloadEncoding: input.payloadEncoding } : {}),
    ...(origin ? { domain: origin } : {}),
    ...(name ? { application: name } : {}),
    ...(input.expectedEffects ? { expectedEffects: input.expectedEffects } : {}),
    createdAt,
    expiresAt,
  };
  const connection = { origin, name, verifiedByPresign, domain };

  const unverifiable = (issues: TechnicalIssue[], headline: string, detail: string[]): SigningReview => {
    const risk = { level: "UNKNOWN" as const, score: null, status: "INSUFFICIENT_DATA" as const };
    const decision = deriveDecision(risk, machineGate(risk), issues);
    const findings: SigningFindings = { type: input.type, application: name, domain: origin, riskLevel: "UNKNOWN", riskScore: null, analysisStatus: "INSUFFICIENT_DATA", technicalValidation: decision.technicalValidation, signals: [], whatHappens: detail, assetMovements: [], authorityChanges: [], programs: [], simulation: "Not run.", multisig: [] };
    return {
      request,
      connection,
      decision,
      explanation: { headline, whatHappens: detail, assetMovements: [], programs: [], accountChanges: [], whyRisky: issues.map((i) => i.message), simulation: "Not run: the request could not be decoded.", completeness: "Presign cannot determine what this request would do." },
      simulation: null,
      findings,
      risk: null,
      multisigSummary: null,
      txFacts: null,
      analysisToken: null,
      findingsToken: sealToken<SealedFindings>("findings", { fh: sha256Hex(canonicalJson(findings)), sid }, ANALYSIS_TTL_MS, now),
      transaction: null,
      message: null,
      analysisVersion: ANALYSIS_VERSION,
    };
  };

  if (!bytes) {
    return unverifiable([{ code: "PAYLOAD_UNDECODABLE", kind: "INVALID", message: input.type === "TRANSACTION" ? "The payload is not a valid serialized Solana transaction (legacy or v0, base64 or base58)." : "The message payload could not be decoded with the stated encoding." }], "Unable to safely verify this signing request.", ["Presign cannot determine what this request will do."]);
  }

  const payloadHash = await payloadHashOf(input.type, bytes);
  if (!payloadHash) return unverifiable([{ code: "PAYLOAD_UNDECODABLE", kind: "INVALID", message: "The transaction bytes could not be parsed." }], "Unable to safely verify this signing request.", ["Presign cannot determine what this request will do."]);
  request.payloadHash = payloadHash;

  let review: Omit<SigningReview, "analysisToken" | "findingsToken">;
  if (input.type === "TRANSACTION") {
    if (bytes.length > MAX_TX_BYTES) return unverifiable([{ code: "PAYLOAD_TOO_LARGE", kind: "INVALID", message: "The transaction is larger than the network allows." }], "Unable to safely verify this signing request.", ["Presign cannot determine what this request will do."]);
    let analysis: TransactionAnalysis;
    try {
      analysis = await analyzeTransaction(bytesToBase64(bytes), input.walletAddress);
    } catch (error) {
      if (isAppError(error) && (error.code === "INVALID_TRANSACTION" || error.code === "UNSUPPORTED_TRANSACTION")) {
        return unverifiable([{ code: "PAYLOAD_UNDECODABLE", kind: "INVALID", message: error.message }], "Unable to safely verify this signing request.", ["Presign cannot determine what this request will do."]);
      }
      throw error;
    }
    if (analysis.messageHash !== payloadHash) throw new AppError("SECURITY_BLOCK", "Internal integrity check failed: the analyzed bytes differ from the request.");
    const issues = transactionIssues(analysis, input.walletAddress);
    // The request's risk = the transaction rules + its context (application address, declared effects, tokens received, recipient history).
    const risk = mergeRisk(analysis.risk, [domainSignals(domain), expectedEffectSignals(analysis, input.walletAddress, input.expectedEffects), ...(await Promise.all([receivedTokenSignals(analysis, input.walletAddress), recipientHistorySignals(analysis, input.walletAddress)]))]);
    const gate = machineGate(risk);
    const decision = deriveDecision(risk, gate, issues);
    const explanation = fromTxExplanation(analysis);
    const tf = transactionFindings(analysis);
    const findings: SigningFindings = {
      type: "TRANSACTION",
      application: name,
      domain: origin,
      riskLevel: risk.level,
      riskScore: risk.score,
      analysisStatus: risk.status,
      technicalValidation: decision.technicalValidation,
      signals: risk.signals.map((s) => ({ code: s.code, severity: s.severity, title: s.title, description: s.description })),
      whatHappens: explanation.whatHappens,
      assetMovements: explanation.assetMovements,
      authorityChanges: tf.authorityChanges,
      programs: explanation.programs,
      simulation: explanation.simulation,
      multisig: tf.multisig,
    };
    review = { request, connection, decision, explanation, simulation: simulationSummary(analysis, risk), findings, risk, multisigSummary: multisigSummaryOf(analysis), txFacts: txFactsOf(analysis), transaction: analysis, message: null, analysisVersion: ANALYSIS_VERSION };
  } else {
    const m = analyzeMessage(bytes, { expectedHost: domain?.origin ? new URL(domain.origin).host : null }, new Date(now));
    const risk = mergeRisk(m.risk, [domainSignals(domain)]);
    const gate = machineGate(risk);
    const decision = deriveDecision(risk, gate, m.technicalIssues);
    const findings: SigningFindings = {
      type: "MESSAGE",
      application: name,
      domain: origin,
      riskLevel: risk.level,
      riskScore: risk.score,
      analysisStatus: risk.status,
      technicalValidation: decision.technicalValidation,
      signals: risk.signals.map((s) => ({ code: s.code, severity: s.severity, title: s.title, description: s.description })),
      whatHappens: m.explanation.whatHappens,
      assetMovements: [],
      authorityChanges: [],
      programs: [],
      simulation: m.explanation.simulation,
      multisig: [],
    };
    review = { request, connection, decision, explanation: { ...m.explanation, whyRisky: risk.signals.map((x) => `${x.severity}: ${x.title} — ${x.description}`) }, simulation: null, findings, risk, multisigSummary: null, txFacts: null, transaction: null, message: { text: m.text, byteLength: m.byteLength }, analysisVersion: ANALYSIS_VERSION };
  }

  const fh = sha256Hex(canonicalJson(review.findings));
  const d = review.decision;
  const analysisToken =
    d.technicalValidation === "VALID" && d.expectedChoice
      ? sealToken<SealedAnalysis>("analysis", { rid: requestId, w: input.walletAddress, sid, ph: payloadHash, t: input.type, av: ANALYSIS_VERSION, lvl: d.risk.level, st: d.risk.status, gate: d.gate, tv: "VALID", uco: d.userCanOverride, choice: d.expectedChoice, fh, to: origin }, ANALYSIS_TTL_MS, now)
      : null;
  logger.info("presign.signing_analyzed", { type: input.type, risk: d.risk.level, validation: d.technicalValidation, gate: d.gate });
  return { ...review, analysisToken, findingsToken: sealToken<SealedFindings>("findings", { fh, sid }, ANALYSIS_TTL_MS, now) };
}

// ---------- approve ----------

export interface ApproveSigningInput {
  analysisToken: string;
  payload: string;
  payloadEncoding?: PayloadEncoding;
  walletAddress: string;
  choice: UserChoice;
  overrideConfirmed?: boolean;
  /** The risk level the client displayed. Must equal the server's; a mismatch means a modified client. */
  riskLevel?: string;
  /** The target origin the client displayed (null = none). Must equal the reviewed one. */
  targetOrigin?: string | null;
}

function block(reason: string, message: string): AppError {
  return new AppError("SECURITY_BLOCK", message, { reason });
}

export const PAYLOAD_CHANGED_MESSAGE = "Signing request changed after security analysis. Presign will not sign an unverified payload.";

export async function approveSigning(input: ApproveSigningInput, sid: string | null, verifiedWallet: string | null, now: number = Date.now()): Promise<SigningApproval> {
  const opened = openToken<SealedAnalysis>("analysis", input.analysisToken, now);
  if (!opened.ok) throw block(opened.reason === "EXPIRED" ? "REQUEST_EXPIRED" : "REQUEST_INVALID", opened.reason === "EXPIRED" ? "This security review expired. Analyze the request again." : "The security review is invalid or was modified.");
  const a = opened.data;
  if (!sid || a.sid !== sid) throw block("SESSION_MISMATCH", "This security review belongs to another browser session.");
  if (a.w !== input.walletAddress) throw block("WALLET_MISMATCH", "The wallet changed after the security review. Analyze the request again.");
  if (verifiedWallet !== a.w) throw block("WALLET_NOT_VERIFIED", "Verify ownership of this wallet before signing.");
  if (a.tv !== "VALID") throw block("TECHNICAL_VALIDATION_FAILED", "Unable to safely verify this signing request.");
  if (input.riskLevel !== undefined && input.riskLevel !== a.lvl) throw block("RISK_MISMATCH", "The risk shown on this device does not match Presign's analysis. Nothing was approved.");
  if (input.targetOrigin !== undefined && (input.targetOrigin ?? null) !== a.to) throw block("TARGET_MISMATCH", "The application this request belongs to changed after the security review.");

  const bytes = decodePayload(a.t, input.payload, input.payloadEncoding);
  const hash = bytes ? await payloadHashOf(a.t, bytes) : null;
  if (!hash || hash !== a.ph) throw block("PAYLOAD_MISMATCH", PAYLOAD_CHANGED_MESSAGE);

  const expected = expectedChoiceFor(a.lvl, a.st);
  if (input.choice !== expected || a.choice !== expected) throw block("DECISION_MISMATCH", "This request needs a different decision for its risk level.");
  if (expected === "OVERRIDE" && input.overrideConfirmed !== true) throw block("CONFIRMATION_REQUIRED", "Confirm explicitly that you want to continue despite Presign's warning.");

  if (!(await consumeOnce("approve", a.rid, opened.exp, now))) throw block("REQUEST_REPLAYED", "This request was already approved once. Analyze it again to sign again.");
  const approval: SealedApproval = { rid: a.rid, w: a.w, sid, ph: a.ph, t: a.t, choice: input.choice, lvl: a.lvl, to: a.to };
  logger.info("presign.signing_approved", { type: a.t, risk: a.lvl, choice: input.choice });
  return { approvalToken: sealToken("approval", approval, APPROVAL_TTL_MS, now), requestId: a.rid, userDecision: input.choice, payloadHash: a.ph, expiresAt: new Date(now + APPROVAL_TTL_MS).toISOString() };
}

export type ApprovalConfirmation =
  | { valid: true; requestId: string; type: SigningRequestType; payloadHash: string; walletAddress: string; targetOrigin: string | null; choice: UserChoice; riskLevel: RiskVerdict; expiresAt: string }
  | { valid: false; reason: "INVALID" | "EXPIRED" | "PAYLOAD_MISMATCH" | "ALREADY_USED" };

/**
 * For the browser extension, before it hands a request to the wallet: is this
 * approval one this server issued, unexpired, for exactly this payload hash
 * (which the extension computes itself from the bytes it captured)? An approval
 * is confirmed once. No session is needed: the token is sealed, short-lived
 * and was issued only through approveSigning's checks.
 */
export async function confirmApprovalForExtension(approvalToken: string, payloadHash: string, now: number = Date.now()): Promise<ApprovalConfirmation> {
  const opened = openToken<SealedApproval>("approval", approvalToken, now);
  if (!opened.ok) return { valid: false, reason: opened.reason === "EXPIRED" ? "EXPIRED" : "INVALID" };
  const a = opened.data;
  if (a.ph !== payloadHash) return { valid: false, reason: "PAYLOAD_MISMATCH" };
  if (!(await consumeOnce("extension-approval", a.rid, opened.exp, now))) return { valid: false, reason: "ALREADY_USED" };
  logger.info("presign.extension_approval_confirmed", { type: a.t, risk: a.lvl, choice: a.choice });
  return { valid: true, requestId: a.rid, type: a.t, payloadHash: a.ph, walletAddress: a.w, targetOrigin: a.to, choice: a.choice, riskLevel: a.lvl, expiresAt: new Date(opened.exp).toISOString() };
}

/**
 * Submission check for a transaction signed in the Presign flow: the approval
 * must be genuine, unexpired, from this session, for this exact message, and
 * signed by the approved wallet. Spends the approval (submit once).
 */
export async function verifyApprovalForSubmit(approvalToken: string, sid: string | null, signedBase64: string, expectedMessageHash: string, now: number = Date.now()): Promise<void> {
  const opened = openToken<SealedApproval>("approval", approvalToken, now);
  if (!opened.ok) throw block(opened.reason === "EXPIRED" ? "REQUEST_EXPIRED" : "REQUEST_INVALID", opened.reason === "EXPIRED" ? "The signing approval expired. It was not submitted." : "The signing approval is invalid. It was not submitted.");
  const a = opened.data;
  if (a.t !== "TRANSACTION") throw block("REQUEST_INVALID", "This approval is not for a transaction.");
  if (!sid || a.sid !== sid) throw block("SESSION_MISMATCH", "The approval belongs to another browser session. It was not submitted.");
  if (a.ph !== expectedMessageHash) throw block("PAYLOAD_MISMATCH", PAYLOAD_CHANGED_MESSAGE);
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(Buffer.from(signedBase64, "base64"));
    VersionedTransaction.deserialize(bytes);
  } catch {
    throw new AppError("INVALID_TRANSACTION", "Signed transaction could not be parsed.");
  }
  if ((await messageHashOfTx(bytes)) !== a.ph) throw block("PAYLOAD_MISMATCH", PAYLOAD_CHANGED_MESSAGE);
  const sig = verifyTransactionSignatures(bytes, [a.w]);
  if (!sig.ok) throw block("WALLET_MISMATCH", "The transaction is not validly signed by the approved wallet.");
  if (!(await consumeOnce("submit", a.rid, opened.exp, now))) throw block("REQUEST_REPLAYED", "This approved transaction was already submitted.");
}

