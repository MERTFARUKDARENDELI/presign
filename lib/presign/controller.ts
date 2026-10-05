import type { SignOutcome } from "@/lib/wallet/signing";
import { decodePayload, payloadHashOf } from "./payload";
import type { SigningApproval, SigningReview, UserChoice } from "./types";

/**
 * Client-side execution of the user's decision on a reviewed request.
 * Environment-agnostic (dependencies injected) so the order of operations is
 * tested directly:
 *
 *   cancel                → nothing else happens; the wallet is never asked
 *   HIGH / CRITICAL       → requires the one explicit override confirmation first
 *   any sign path         → server approval (re-hashes the payload, checks the
 *                           choice against the server's risk) → local hash check →
 *                           ONLY THEN the wallet is asked, for exactly those bytes
 *   unverifiable request  → no sign path exists at all
 */

export interface ApproveRequestBody {
  analysisToken: string;
  payload: string;
  payloadEncoding?: SigningReview["request"]["payloadEncoding"];
  walletAddress: string;
  choice: UserChoice;
  overrideConfirmed: boolean;
  riskLevel: string;
  targetOrigin: string | null;
}

export interface DecisionDeps {
  approve: (body: ApproveRequestBody) => Promise<SigningApproval>;
  /** Wallet transaction signing, wrapped in `signExactly` (hash checked before and after the wallet). */
  walletSignTransaction?: (bytes: Uint8Array, confirmedHash: string) => Promise<SignOutcome>;
  /** Wallet message signing; returns the raw 64-byte signature. */
  walletSignMessage?: (bytes: Uint8Array) => Promise<Uint8Array>;
  /** ed25519 verification of a message signature for the wallet. */
  verifyMessageSignature: (bytes: Uint8Array, signature: Uint8Array, wallet: string) => boolean;
}

export interface UserDecision {
  choice: "CANCEL" | UserChoice;
  /** The single explicit confirmation required for HIGH / CRITICAL. */
  overrideConfirmed?: boolean;
}

/** What happened after an approved request was handed to a wallet outside this page (browser extension). */
export type ForwardOutcome =
  | { status: "SIGNED"; detail: string }
  | { status: "REJECTED"; reason: string }
  | { status: "BLOCKED"; reason: string };

export interface ForwardDeps {
  approve: DecisionDeps["approve"];
  /** Hands the approval to the extension, which lets the wallet sign exactly the captured request, and waits for the outcome. */
  forward: (approval: SigningApproval, payload: string) => Promise<ForwardOutcome>;
}

export type DecisionResult =
  | { kind: "CANCELLED" }
  | { kind: "SIGNED_IN_WALLET"; detail: string; approval: SigningApproval }
  | { kind: "NOT_ALLOWED"; reason: string }
  | { kind: "CONFIRMATION_REQUIRED" }
  | { kind: "BLOCKED"; code: string; reason: string }
  | { kind: "SIGN_REJECTED"; reason: string }
  | { kind: "SIGNED_TRANSACTION"; signed: Uint8Array; approval: SigningApproval }
  | { kind: "SIGNED_MESSAGE"; signature: Uint8Array; approval: SigningApproval };

/** Error thrown by `approve` (the API client error carries `code` and `details.reason`). */
interface ApproveError {
  code?: string;
  message?: string;
  details?: { reason?: unknown };
}

/**
 * Every check that must pass before anything is signed: decision allowed for
 * this risk, explicit override when required, payload unchanged, server
 * approval for exactly this hash. Returns the approved bytes, or the result
 * that stops the flow.
 */
async function authorize(review: SigningReview, decision: UserDecision, approve: DecisionDeps["approve"]): Promise<DecisionResult | { bytes: Uint8Array; approval: SigningApproval }> {
  if (decision.choice === "CANCEL") return { kind: "CANCELLED" };

  const d = review.decision;
  if (d.technicalValidation !== "VALID" || !review.analysisToken || !d.expectedChoice) {
    return { kind: "NOT_ALLOWED", reason: "Unable to safely verify this signing request. It cannot be signed through Presign." };
  }
  if (decision.choice !== d.expectedChoice) return { kind: "NOT_ALLOWED", reason: "This request needs a different decision for its risk level." };
  if (d.requiredConfirmation === "EXPLICIT_OVERRIDE" && decision.overrideConfirmed !== true) return { kind: "CONFIRMATION_REQUIRED" };

  const req = review.request;
  const bytes = decodePayload(req.type, req.payload, req.payloadEncoding);
  const localHash = bytes ? await payloadHashOf(req.type, bytes) : null;
  if (!bytes || !localHash || localHash !== req.payloadHash) {
    return { kind: "BLOCKED", code: "PAYLOAD_MISMATCH", reason: "Signing request changed after security analysis. Presign will not sign an unverified payload." };
  }

  let approval: SigningApproval;
  try {
    approval = await approve({
      analysisToken: review.analysisToken,
      payload: req.payload,
      payloadEncoding: req.payloadEncoding,
      walletAddress: req.walletAddress,
      choice: decision.choice,
      overrideConfirmed: decision.overrideConfirmed === true,
      riskLevel: d.risk.level,
      targetOrigin: review.connection.origin,
    });
  } catch (error) {
    const e = error as ApproveError;
    const reason = typeof e.details?.reason === "string" ? e.details.reason : (e.code ?? "APPROVAL_FAILED");
    return { kind: "BLOCKED", code: reason, reason: e.message ?? "Presign did not approve this request." };
  }

  // The server approved exactly this hash; the bytes handed to the wallet must still hash to it.
  if (approval.payloadHash !== localHash || approval.requestId !== req.requestId) {
    return { kind: "BLOCKED", code: "PAYLOAD_MISMATCH", reason: "Signing request changed after security analysis. Presign will not sign an unverified payload." };
  }
  return { bytes, approval };
}

export async function executeDecision(review: SigningReview, decision: UserDecision, deps: DecisionDeps): Promise<DecisionResult> {
  const auth = await authorize(review, decision, deps.approve);
  if ("kind" in auth) return auth;
  const { bytes, approval } = auth;
  const req = review.request;

  if (req.type === "TRANSACTION") {
    if (!deps.walletSignTransaction) return { kind: "NOT_ALLOWED", reason: "This wallet cannot sign transactions." };
    const outcome = await deps.walletSignTransaction(bytes, approval.payloadHash);
    if (!outcome.ok) return outcome.kind === "REJECTED" ? { kind: "SIGN_REJECTED", reason: outcome.reason } : { kind: "BLOCKED", code: outcome.kind, reason: outcome.reason };
    return { kind: "SIGNED_TRANSACTION", signed: outcome.signed, approval };
  }

  if (!deps.walletSignMessage) return { kind: "NOT_ALLOWED", reason: "This wallet cannot sign messages." };
  let signature: Uint8Array;
  try {
    signature = await deps.walletSignMessage(bytes);
  } catch {
    return { kind: "SIGN_REJECTED", reason: "Signing was cancelled or failed in your wallet." };
  }
  if (!deps.verifyMessageSignature(bytes, signature, req.walletAddress)) {
    return { kind: "BLOCKED", code: "INVALID_SIGNATURE", reason: "The wallet returned a signature that does not match this message and wallet." };
  }
  return { kind: "SIGNED_MESSAGE", signature, approval };
}

/**
 * Browser-extension variant: the same checks and server approval, then the
 * approval goes to the extension, whose page hook lets the wallet sign the
 * request it captured itself (and withholds the signature from the site if
 * the wallet signed anything else).
 */
export async function executeForwardedDecision(review: SigningReview, decision: UserDecision, deps: ForwardDeps): Promise<DecisionResult> {
  const auth = await authorize(review, decision, deps.approve);
  if ("kind" in auth) return auth;
  let outcome: ForwardOutcome;
  try {
    outcome = await deps.forward(auth.approval, review.request.payload);
  } catch (error) {
    return { kind: "BLOCKED", code: "EXTENSION_UNAVAILABLE", reason: error instanceof Error ? error.message : "The Presign extension did not answer." };
  }
  if (outcome.status === "SIGNED") return { kind: "SIGNED_IN_WALLET", detail: outcome.detail, approval: auth.approval };
  if (outcome.status === "REJECTED") return { kind: "SIGN_REJECTED", reason: outcome.reason };
  return { kind: "BLOCKED", code: "WALLET_RESULT_MISMATCH", reason: outcome.reason };
}
