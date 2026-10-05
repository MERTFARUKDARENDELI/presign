import { SystemProgram } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gateFor } from "@/lib/agent/gate";
import { executeForwardedDecision, type ForwardDeps } from "@/lib/presign/controller";
import { deriveDecision } from "@/lib/presign/decision";
import { forwardToExtension, getTicket } from "@/lib/presign/extension-bridge";
import { payloadHashOf } from "@/lib/presign/payload";
import type { SigningApproval, SigningReview, TechnicalIssue } from "@/lib/presign/types";
import type { RiskVerdict } from "@/lib/security/risk";
import { ATTACKER, buildTx, WALLET } from "../helpers/fixtures";

const W = WALLET.toBase58();
const EXT = "abcdefghijklmnopabcdefghijklmnop";

async function reviewFor(level: RiskVerdict, issues: TechnicalIssue[] = []): Promise<SigningReview> {
  const payload = buildTx([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 1 })]).base64;
  const status = level === "UNKNOWN" ? "PARTIAL" : "COMPLETE";
  const decision = deriveDecision({ level, score: level === "SAFE" ? 0 : 50, status }, gateFor(level, status), issues);
  return {
    request: { requestId: "req-1", walletAddress: W, type: "TRANSACTION", payload, payloadEncoding: "base64", payloadHash: (await payloadHashOf("TRANSACTION", Uint8Array.from(Buffer.from(payload, "base64"))))!, createdAt: "", expiresAt: "" },
    connection: { origin: "https://dapp.example", name: "dapp.example", verifiedByPresign: true, domain: null },
    decision,
    explanation: { headline: "", whatHappens: [], assetMovements: [], programs: [], accountChanges: [], whyRisky: [], simulation: "", completeness: "" },
    simulation: null,
    risk: null,
    multisigSummary: null,
    txFacts: null,
    findings: { type: "TRANSACTION", application: null, domain: null, riskLevel: level, riskScore: null, analysisStatus: status, technicalValidation: decision.technicalValidation, signals: [], whatHappens: [], assetMovements: [], authorityChanges: [], programs: [], simulation: "", multisig: [] },
    analysisToken: decision.technicalValidation === "VALID" ? "sealed-analysis-token-xxxxxxxx" : null,
    findingsToken: "sealed-findings",
    transaction: null,
    message: null,
    analysisVersion: "test",
  };
}

function deps(r: SigningReview, over: Partial<ForwardDeps> = {}) {
  const calls: string[] = [];
  const approve = vi.fn(async (): Promise<SigningApproval> => (calls.push("approve"), { approvalToken: "approval-token-xxxxxxxxxxxxxxxx", requestId: r.request.requestId, userDecision: r.decision.expectedChoice!, payloadHash: r.request.payloadHash!, expiresAt: "" }));
  const forward = vi.fn(async () => (calls.push("forward"), { status: "SIGNED" as const, detail: "Signed in the wallet and returned to the site." }));
  return { calls, approve, forward, d: { approve, forward, ...over } };
}

describe("extension path: same decision rules, then the approval goes to the extension", () => {
  it("Cancel: nothing is approved and nothing is forwarded", async () => {
    const r = await reviewFor("HIGH");
    const { approve, forward, d } = deps(r);
    expect(await executeForwardedDecision(r, { choice: "CANCEL" }, d)).toEqual({ kind: "CANCELLED" });
    expect(approve).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it("HIGH needs the explicit confirmation before anything leaves the page", async () => {
    const r = await reviewFor("HIGH");
    const { forward, d } = deps(r);
    expect(await executeForwardedDecision(r, { choice: "OVERRIDE" }, d)).toEqual({ kind: "CONFIRMATION_REQUIRED" });
    expect(forward).not.toHaveBeenCalled();
  });

  it("override: server approval first, then the extension receives that approval for exactly the analyzed payload", async () => {
    const r = await reviewFor("CRITICAL");
    const { calls, forward, d } = deps(r);
    const out = await executeForwardedDecision(r, { choice: "OVERRIDE", overrideConfirmed: true }, d);
    expect(out).toMatchObject({ kind: "SIGNED_IN_WALLET" });
    expect(calls).toEqual(["approve", "forward"]);
    const [approval, payload] = forward.mock.calls[0] as unknown as [SigningApproval, string];
    expect(approval.payloadHash).toBe(r.request.payloadHash);
    expect(payload).toBe(r.request.payload);
  });

  it("a payload changed after analysis is never approved or forwarded", async () => {
    const r = await reviewFor("MEDIUM");
    const tampered = { ...r, request: { ...r.request, payload: buildTx([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 5 })]).base64 } };
    const { approve, forward, d } = deps(r);
    expect(await executeForwardedDecision(tampered, { choice: "CONTINUE" }, d)).toMatchObject({ kind: "BLOCKED", code: "PAYLOAD_MISMATCH" });
    expect(approve).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it("an unverifiable request has no sign path through the extension either", async () => {
    const r = await reviewFor("UNKNOWN", [{ code: "PAYLOAD_UNDECODABLE", kind: "INVALID", message: "x" }]);
    const { forward, d } = deps(r);
    expect((await executeForwardedDecision(r, { choice: "SIGN" }, d)).kind).toBe("NOT_ALLOWED");
    expect(forward).not.toHaveBeenCalled();
  });

  it("wallet outcomes map to the review's results", async () => {
    const r = await reviewFor("SAFE");
    expect(await executeForwardedDecision(r, { choice: "SIGN" }, deps(r, { forward: async () => ({ status: "REJECTED", reason: "User rejected" }) }).d)).toEqual({ kind: "SIGN_REJECTED", reason: "User rejected" });
    expect(await executeForwardedDecision(r, { choice: "SIGN" }, deps(r, { forward: async () => ({ status: "BLOCKED", reason: "wallet changed it" }) }).d)).toMatchObject({ kind: "BLOCKED", code: "WALLET_RESULT_MISMATCH" });
    expect(await executeForwardedDecision(r, { choice: "SIGN" }, deps(r, { forward: async () => Promise.reject(new Error("gone")) }).d)).toMatchObject({ kind: "BLOCKED", code: "EXTENSION_UNAVAILABLE" });
  });
});

describe("page ↔ extension bridge", () => {
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  function fakeRuntime(handler: (msg: { kind: string; rid: string }) => unknown) {
    const sent: Array<{ ext: string; msg: { kind: string } }> = [];
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        sendMessage: (ext: string, msg: { kind: string; rid: string }, cb: (r: unknown) => void) => {
          sent.push({ ext, msg });
          queueMicrotask(() => cb(handler(msg)));
        },
      },
    };
    return sent;
  }
  const approval: SigningApproval = { approvalToken: "approval-token-xxxxxxxxxxxxxxxx", requestId: "req-1", userDecision: "SIGN", payloadHash: "f".repeat(64), expiresAt: "" };

  it("sends the approval, then follows the request until the wallet answered", async () => {
    let polls = 0;
    const sent = fakeRuntime((m) => (m.kind === "presign:approve" ? { ok: true } : { ok: true, state: ++polls < 3 ? "forwarded" : "signed", detail: "Signed in the wallet and returned to the site." }));
    const out = await forwardToExtension(EXT, "rid-1", approval, "AAAA", "LOW", "SIGN", async () => undefined);
    expect(out).toEqual({ status: "SIGNED", detail: "Signed in the wallet and returned to the site." });
    expect(sent[0]).toMatchObject({ ext: EXT, msg: { kind: "presign:approve", rid: "rid-1", payload: "AAAA", payloadHash: approval.payloadHash, approvalToken: approval.approvalToken } });
  });

  it("a refused approval (payload differs in the extension) is a block, not a signature", async () => {
    fakeRuntime(() => ({ ok: false, error: "PAYLOAD_MISMATCH" }));
    expect(await forwardToExtension(EXT, "rid-1", approval, "AAAA", "LOW", "SIGN", async () => undefined)).toMatchObject({ status: "BLOCKED" });
  });

  it("no extension, or a malformed extension id, fails closed", async () => {
    await expect(getTicket(EXT, "rid-1")).rejects.toThrow(/not reachable/);
    fakeRuntime(() => ({ ok: true }));
    await expect(getTicket("not-an-id", "rid-1")).rejects.toThrow(/not reachable/);
  });
});
