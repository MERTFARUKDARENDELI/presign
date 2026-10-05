import { ed25519 } from "@noble/curves/ed25519.js";
import { SystemProgram } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { gateFor } from "@/lib/agent/gate";
import { executeDecision, type DecisionDeps } from "@/lib/presign/controller";
import { deriveDecision, expectedChoiceFor } from "@/lib/presign/decision";
import { canTransition, transition, walletSigningAllowedFrom } from "@/lib/presign/flow";
import { payloadHashOf } from "@/lib/presign/payload";
import type { SigningApproval, SigningReview, TechnicalIssue } from "@/lib/presign/types";
import type { RiskVerdict } from "@/lib/security/risk";
import { bytesToBase64 } from "@/lib/transaction/input";
import { ATTACKER, buildTx, keypair, WALLET } from "../helpers/fixtures";

const W = WALLET.toBase58();
const OWNER = keypair(1);

async function reviewFor(level: RiskVerdict, opts: { issues?: TechnicalIssue[]; type?: "TRANSACTION" | "MESSAGE" } = {}): Promise<SigningReview> {
  const type = opts.type ?? "TRANSACTION";
  const payload = type === "TRANSACTION" ? buildTx([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 1 })]).base64 : "Sign in to example.com\nNonce: 1\nIssued At: now";
  const bytes = type === "TRANSACTION" ? Uint8Array.from(Buffer.from(payload, "base64")) : new TextEncoder().encode(payload);
  const status = level === "UNKNOWN" ? "PARTIAL" : "COMPLETE";
  const risk = { level, score: level === "SAFE" ? 0 : 50, status } as const;
  const decision = deriveDecision(risk, gateFor(level, status), opts.issues ?? []);
  return {
    request: { requestId: "req-1", walletAddress: W, type, payload, payloadEncoding: type === "TRANSACTION" ? "base64" : "utf8", payloadHash: (await payloadHashOf(type, bytes))!, createdAt: "", expiresAt: "" },
    connection: { origin: null, name: null, verifiedByPresign: false, domain: null },
    decision,
    explanation: { headline: "", whatHappens: [], assetMovements: [], programs: [], accountChanges: [], whyRisky: [], simulation: "", completeness: "" },
    simulation: null,
    risk: null,
    multisigSummary: null,
    txFacts: null,
    findings: { type, application: null, domain: null, riskLevel: level, riskScore: null, analysisStatus: status, technicalValidation: decision.technicalValidation, signals: [], whatHappens: [], assetMovements: [], authorityChanges: [], programs: [], simulation: "", multisig: [] },
    analysisToken: decision.technicalValidation === "VALID" ? "sealed-analysis-token-xxxxxxxx" : null,
    findingsToken: "sealed-findings",
    transaction: null,
    message: null,
    analysisVersion: "test",
  };
}

function deps(review: SigningReview, overrides: Partial<DecisionDeps> = {}) {
  const calls: string[] = [];
  const approval: SigningApproval = { approvalToken: "approval", requestId: review.request.requestId, userDecision: review.decision.expectedChoice ?? "SIGN", payloadHash: review.request.payloadHash!, expiresAt: "" };
  const approve = vi.fn(async () => {
    calls.push("approve");
    return approval;
  });
  const walletSignTransaction = vi.fn<(bytes: Uint8Array, confirmedHash: string) => Promise<{ ok: true; signed: Uint8Array }>>(async (bytes) => {
    calls.push("wallet");
    return { ok: true as const, signed: bytes };
  });
  const walletSignMessage = vi.fn(async (bytes: Uint8Array) => {
    calls.push("wallet");
    return ed25519.sign(bytes, OWNER.secretKey.slice(0, 32));
  });
  const verifyMessageSignature = (bytes: Uint8Array, sig: Uint8Array) => ed25519.verify(sig, bytes, WALLET.toBytes());
  return { calls, approve, walletSignTransaction, walletSignMessage, d: { approve, walletSignTransaction, walletSignMessage, verifyMessageSignature, ...overrides } as DecisionDeps };
}

describe("human decision layer vs machine gate", () => {
  it("machine gate stays fail-closed while the human may decide", () => {
    for (const level of ["HIGH", "CRITICAL"] as const) {
      const d = deriveDecision({ level, score: 90, status: "COMPLETE" }, gateFor(level, "COMPLETE"), []);
      expect(d.gate).toBe("block");
      expect(d.recommendedAction).toBe("DO_NOT_SIGN");
      expect(d.userCanOverride).toBe(true);
      expect(d.requiredConfirmation).toBe("EXPLICIT_OVERRIDE");
    }
    expect(deriveDecision({ level: "MEDIUM", score: 25, status: "COMPLETE" }, "require_human_review", []).primaryActionLabel).toBe("Continue anyway");
    expect(deriveDecision({ level: "LOW", score: 10, status: "COMPLETE" }, "no_known_risk", []).expectedChoice).toBe("SIGN");
    expect(deriveDecision({ level: "SAFE", score: 0, status: "COMPLETE" }, "no_known_risk", []).requiredConfirmation).toBe("NONE");
  });

  it("button labels by level", () => {
    const label = (level: RiskVerdict) => deriveDecision({ level, score: null, status: "COMPLETE" }, gateFor(level, "COMPLETE"), []).primaryActionLabel;
    expect(label("MEDIUM")).toBe("Continue anyway");
    expect(label("HIGH")).toBe("I understand the risk — sign anyway");
    expect(label("CRITICAL")).toBe("I understand the critical risk — sign anyway");
  });

  it("unverifiable / invalid requests never offer an override, whatever the risk", () => {
    for (const kind of ["INVALID", "UNVERIFIABLE"] as const) {
      const d = deriveDecision({ level: "CRITICAL", score: 90, status: "COMPLETE" }, "block", [{ code: "X", kind, message: "x" }]);
      expect(d.technicalValidation).toBe(kind);
      expect(d.userCanOverride).toBe(false);
      expect(d.primaryActionLabel).toBeNull();
      expect(d.expectedChoice).toBeNull();
      expect(d.recommendedAction).toBe("CANNOT_VERIFY");
    }
    expect(expectedChoiceFor("UNKNOWN")).toBe("CONTINUE");
  });
});

describe("decision execution — order of operations", () => {
  it("A. the review exists before the wallet is asked, and approval precedes the wallet call", async () => {
    const r = await reviewFor("HIGH");
    const { calls, d } = deps(r);
    await executeDecision(r, { choice: "OVERRIDE", overrideConfirmed: true }, d);
    expect(calls).toEqual(["approve", "wallet"]);
  });

  it("B. HIGH + Cancel → neither the approval nor the wallet signing API is called", async () => {
    const r = await reviewFor("HIGH");
    const { approve, walletSignTransaction, d } = deps(r);
    expect(await executeDecision(r, { choice: "CANCEL" }, d)).toEqual({ kind: "CANCELLED" });
    expect(approve).not.toHaveBeenCalled();
    expect(walletSignTransaction).not.toHaveBeenCalled();
  });

  it("C. HIGH + explicit 'sign anyway' → the wallet signs EXACTLY the analyzed payload", async () => {
    const r = await reviewFor("HIGH");
    const { walletSignTransaction, d } = deps(r);
    const out = await executeDecision(r, { choice: "OVERRIDE", overrideConfirmed: true }, d);
    expect(out.kind).toBe("SIGNED_TRANSACTION");
    expect(walletSignTransaction).toHaveBeenCalledTimes(1);
    const [bytes, hash] = walletSignTransaction.mock.calls[0];
    expect(bytesToBase64(bytes)).toBe(r.request.payload);
    expect(hash).toBe(r.request.payloadHash);
  });

  it("D. a payload modified on the client after analysis is never sent to the wallet", async () => {
    const r = await reviewFor("HIGH");
    const tampered = { ...r, request: { ...r.request, payload: buildTx([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 999_999 })]).base64 } };
    const { approve, walletSignTransaction, d } = deps(r);
    const out = await executeDecision(tampered, { choice: "OVERRIDE", overrideConfirmed: true }, d);
    expect(out).toMatchObject({ kind: "BLOCKED", code: "PAYLOAD_MISMATCH" });
    expect(approve).not.toHaveBeenCalled();
    expect(walletSignTransaction).not.toHaveBeenCalled();
  });

  it("D'. if the server approves a different hash, the wallet is not asked", async () => {
    const r = await reviewFor("HIGH");
    const { walletSignTransaction, d } = deps(r, { approve: async () => ({ approvalToken: "a", requestId: "req-1", userDecision: "OVERRIDE" as const, payloadHash: "0".repeat(64), expiresAt: "" }) });
    expect(await executeDecision(r, { choice: "OVERRIDE", overrideConfirmed: true }, d)).toMatchObject({ kind: "BLOCKED", code: "PAYLOAD_MISMATCH" });
    expect(walletSignTransaction).not.toHaveBeenCalled();
  });

  it("server refusals (e.g. modified risk) stop before the wallet", async () => {
    const r = await reviewFor("HIGH");
    const err = Object.assign(new Error("The risk shown on this device does not match Presign's analysis."), { code: "SECURITY_BLOCK", details: { reason: "RISK_MISMATCH" } });
    const { walletSignTransaction, d } = deps(r, { approve: async () => Promise.reject(err) });
    expect(await executeDecision(r, { choice: "OVERRIDE", overrideConfirmed: true }, d)).toMatchObject({ kind: "BLOCKED", code: "RISK_MISMATCH" });
    expect(walletSignTransaction).not.toHaveBeenCalled();
  });

  it("E. CRITICAL can be explicitly overridden when the request is valid", async () => {
    const r = await reviewFor("CRITICAL");
    const { walletSignTransaction, d } = deps(r);
    expect((await executeDecision(r, { choice: "OVERRIDE", overrideConfirmed: true }, d)).kind).toBe("SIGNED_TRANSACTION");
    expect(walletSignTransaction).toHaveBeenCalledTimes(1);
  });

  it("F. an invalid / unverifiable payload offers no misleading override", async () => {
    const r = await reviewFor("UNKNOWN", { issues: [{ code: "PAYLOAD_UNDECODABLE", kind: "INVALID", message: "x" }] });
    expect(r.decision.userCanOverride).toBe(false);
    expect(r.analysisToken).toBeNull();
    const { approve, walletSignTransaction, d } = deps(r);
    for (const choice of ["SIGN", "CONTINUE", "OVERRIDE"] as const) {
      expect((await executeDecision(r, { choice, overrideConfirmed: true }, d)).kind).toBe("NOT_ALLOWED");
    }
    expect(approve).not.toHaveBeenCalled();
    expect(walletSignTransaction).not.toHaveBeenCalled();
  });

  it("the user rejecting the second confirmation means no wallet call", async () => {
    const r = await reviewFor("CRITICAL");
    const { approve, walletSignTransaction, d } = deps(r);
    expect(await executeDecision(r, { choice: "OVERRIDE", overrideConfirmed: false }, d)).toEqual({ kind: "CONFIRMATION_REQUIRED" });
    expect(approve).not.toHaveBeenCalled();
    expect(walletSignTransaction).not.toHaveBeenCalled();
  });

  it("SAFE signs directly; MEDIUM continues; wrong choice for the level is refused", async () => {
    const safe = await reviewFor("SAFE");
    expect((await executeDecision(safe, { choice: "SIGN" }, deps(safe).d)).kind).toBe("SIGNED_TRANSACTION");
    const medium = await reviewFor("MEDIUM");
    expect((await executeDecision(medium, { choice: "CONTINUE" }, deps(medium).d)).kind).toBe("SIGNED_TRANSACTION");
    expect((await executeDecision(medium, { choice: "SIGN" }, deps(medium).d)).kind).toBe("NOT_ALLOWED");
  });

  it("the wallet rejecting the signature is reported as such", async () => {
    const r = await reviewFor("SAFE");
    const { d } = deps(r, { walletSignTransaction: async () => ({ ok: false as const, kind: "REJECTED" as const, reason: "Signing was cancelled." }) });
    expect(await executeDecision(r, { choice: "SIGN" }, d)).toMatchObject({ kind: "SIGN_REJECTED" });
  });

  it("messages: the returned signature must verify for the wallet and the exact text", async () => {
    const r = await reviewFor("SAFE", { type: "MESSAGE" });
    expect((await executeDecision(r, { choice: "SIGN" }, deps(r).d)).kind).toBe("SIGNED_MESSAGE");
    const bad = deps(r, { walletSignMessage: async () => new Uint8Array(64).fill(1) });
    expect(await executeDecision(r, { choice: "SIGN" }, bad.d)).toMatchObject({ kind: "BLOCKED", code: "INVALID_SIGNATURE" });
  });
});

describe("flow state machine", () => {
  it("follows the documented path", () => {
    const path = ["IDLE", "PRE_CONNECT_CHECK", "PRE_CONNECT_VERIFIED", "WALLET_CONNECTING", "WALLET_CONNECTED", "OWNERSHIP_VERIFICATION", "WALLET_VERIFIED", "WAITING_FOR_SIGN_REQUEST", "REQUEST_RECEIVED", "DECODING", "SIMULATING", "RISK_ANALYSIS", "SECURITY_REVIEW", "USER_APPROVAL", "OPTIONAL_RISK_OVERRIDE", "WALLET_SIGNING", "SIGNED", "OPTIONAL_SUBMISSION", "DASHBOARD"] as const;
    for (let i = 1; i < path.length; i++) expect(transition(path[i - 1], path[i])).toBe(path[i]);
  });

  it("cannot jump to signing without the review and the decision", () => {
    expect(() => transition("IDLE", "WALLET_SIGNING")).toThrow();
    expect(() => transition("REQUEST_RECEIVED", "WALLET_SIGNING")).toThrow();
    expect(() => transition("SECURITY_REVIEW", "WALLET_SIGNING")).toThrow();
    expect(() => transition("USER_APPROVAL", "SIGNED")).toThrow();
    expect(canTransition("PRE_CONNECT_CHECK", "WALLET_CONNECTED")).toBe(false);
    expect(["USER_APPROVAL", "OPTIONAL_RISK_OVERRIDE"].every((s) => walletSigningAllowedFrom(s as never))).toBe(true);
    expect(walletSigningAllowedFrom("SECURITY_REVIEW")).toBe(false);
  });
});
