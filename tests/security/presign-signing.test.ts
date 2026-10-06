import { createApproveInstruction, createSetAuthorityInstruction, createTransferInstruction, AuthorityType } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/api/errors";
import { enrichWithAnchorIdl } from "@/lib/anchor/source";
import { resetReplayRegistry } from "@/lib/presign/replay";
import { analyzeSigning, approveSigning, confirmApprovalForExtension, PAYLOAD_CHANGED_MESSAGE, verifyApprovalForSubmit, type AnalyzeSigningInput } from "@/lib/presign/signing";
import type { SigningReview } from "@/lib/presign/types";
import { MEMO_PROGRAM_ID } from "@/lib/solana/constants";
import { U64_MAX } from "@/lib/transaction/decoder";
import { bytesToBase64 } from "@/lib/transaction/input";
import { simulateTransaction, resolveLookupTables, type SimulationOutput } from "@/lib/transaction/simulate";
import type { TransactionEffects } from "@/lib/transaction/types";
import { ATTACKER, ATTACKER_ATA, buildTx, keypair, MINT, WALLET, WALLET_ATA } from "../helpers/fixtures";

// The pre-sign review runs the REAL decoder, rules and decision layer; only the
// simulation RPC edge and on-chain IDL lookups are mocked.
vi.mock("@/lib/transaction/simulate", async (importOriginal) => ({ ...(await importOriginal<object>()), simulateTransaction: vi.fn(), resolveLookupTables: vi.fn() }));
vi.mock("@/lib/anchor/source", async (importOriginal) => ({ ...(await importOriginal<object>()), enrichWithAnchorIdl: vi.fn() }));

const simulate = vi.mocked(simulateTransaction);
const W = WALLET.toBase58();
const A = ATTACKER.toBase58();
const SID = "session-aaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_SID = "session-bbbbbbbbbbbbbbbbbbbbbbbb";
const OWNER = keypair(1); // === WALLET

function effects(o: Partial<TransactionEffects> = {}): TransactionEffects {
  return { source: "SIMULATION", success: true, error: null, logs: [], logsTruncated: false, unitsConsumed: 1_000, slot: 101, preStateSlot: 100, stale: false, blockhashValid: true, feeLamports: "5000", solChanges: [], tokenChanges: [], accountChanges: [], notes: [], ...o };
}
function sim(e: TransactionEffects, extra: Partial<SimulationOutput> = {}) {
  simulate.mockResolvedValue({ effects: e, tokenAccountOwners: {}, tokenAccountMints: {}, innerInstructions: null, ...extra });
}

const memo = (text = "hello") => new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM_ID), keys: [], data: Buffer.from(text) });
const txInput = (base64: string, wallet = W): AnalyzeSigningInput => ({ type: "TRANSACTION", payload: base64, payloadEncoding: "base64", walletAddress: wallet });
const fee = { address: W, preLamports: "10000000", postLamports: "9995000", deltaLamports: "-5000" };

async function review(base64: string, wallet = W): Promise<SigningReview> {
  return analyzeSigning(txInput(base64, wallet), SID);
}

beforeEach(() => {
  simulate.mockReset();
  vi.mocked(resolveLookupTables).mockReset().mockResolvedValue(null);
  vi.mocked(enrichWithAnchorIdl).mockReset().mockResolvedValue([]);
  resetReplayRegistry();
});

describe("pre-sign review — risk levels from the real engine", () => {
  it("SAFE transaction: user may sign; machine gate no_known_risk; payload bound", async () => {
    const { base64 } = buildTx([memo()]);
    sim(effects({ solChanges: [fee] }));
    const r = await review(base64);
    expect(r.decision.risk.level).toBe("SAFE");
    expect(r.decision.technicalValidation).toBe("VALID");
    expect(r.decision.gate).toBe("no_known_risk");
    expect(r.decision.expectedChoice).toBe("SIGN");
    expect(r.decision.requiredConfirmation).toBe("NONE");
    expect(r.analysisToken).toBeTruthy();
    expect(r.request.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.simulation?.status).toBe("PASS");
  });

  it("unexpected SOL transfer (more SOL leaves than visible instructions explain) is HIGH: override allowed, gate block", async () => {
    const { base64 } = buildTx([memo()]);
    sim(effects({ solChanges: [{ address: W, preLamports: "2000000000", postLamports: "1499995000", deltaLamports: "-500005000" }, { address: A, preLamports: "0", postLamports: "500000000", deltaLamports: "500000000" }] }));
    const r = await review(base64);
    expect(r.findings.signals.map((s) => s.code)).toContain("TX_UNEXPECTED_SOL_OUTFLOW");
    expect(r.decision.risk.level).toBe("HIGH");
    expect(r.decision.gate).toBe("block");
    expect(r.decision.userCanOverride).toBe(true);
    expect(r.decision.requiredConfirmation).toBe("EXPLICIT_OVERRIDE");
    expect(r.decision.primaryActionLabel).toMatch(/I understand the risk/i);
    expect(r.simulation?.unexpectedEffects.length).toBeGreaterThan(0);
  });

  it("visible SOL transfer is MEDIUM: continue anyway, gate require_human_review", async () => {
    const { base64 } = buildTx([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 100_000_000 })]);
    sim(effects({ solChanges: [{ address: W, preLamports: "2000000000", postLamports: "1899995000", deltaLamports: "-100005000" }, { address: A, preLamports: "0", postLamports: "100000000", deltaLamports: "100000000" }] }));
    const r = await review(base64);
    expect(r.decision.risk.level).toBe("MEDIUM");
    expect(r.decision.gate).toBe("require_human_review");
    expect(r.decision.expectedChoice).toBe("CONTINUE");
    expect(r.decision.primaryActionLabel).toBe("Continue anyway");
  });

  it("unexpected token transfer is flagged", async () => {
    const { base64 } = buildTx([memo()]);
    sim(effects({ solChanges: [fee], tokenChanges: [{ tokenAccount: WALLET_ATA.toBase58(), owner: W, mint: MINT.toBase58(), decimals: 6, preRaw: "250000000", postRaw: "0", deltaRaw: "-250000000" }, { tokenAccount: ATTACKER_ATA.toBase58(), owner: A, mint: MINT.toBase58(), decimals: 6, preRaw: "0", postRaw: "250000000", deltaRaw: "250000000" }] }), { tokenAccountOwners: { [WALLET_ATA.toBase58()]: W, [ATTACKER_ATA.toBase58()]: A } });
    const r = await review(base64);
    expect(r.findings.signals.some((s) => s.code.startsWith("TX_UNEXPECTED_TOKEN_OUTFLOW") || s.code.startsWith("TX_FULL_BALANCE_TRANSFER"))).toBe(true);
    expect(["HIGH", "CRITICAL"]).toContain(r.decision.risk.level);
  });

  it("visible token transfer is reported with its destination", async () => {
    const { base64 } = buildTx([createTransferInstruction(WALLET_ATA, ATTACKER_ATA, WALLET, 10n)]);
    sim(effects({ solChanges: [fee], tokenChanges: [{ tokenAccount: WALLET_ATA.toBase58(), owner: W, mint: MINT.toBase58(), decimals: 6, preRaw: "100", postRaw: "90", deltaRaw: "-10" }] }), { tokenAccountOwners: { [WALLET_ATA.toBase58()]: W, [ATTACKER_ATA.toBase58()]: A } });
    const r = await review(base64);
    expect(r.findings.signals.some((s) => s.code.startsWith("TX_TOKEN_OUTFLOW"))).toBe(true);
  });

  it("authority escalation (token account ownership transfer) is CRITICAL — and still overridable for a human", async () => {
    const { base64 } = buildTx([createSetAuthorityInstruction(WALLET_ATA, WALLET, AuthorityType.AccountOwner, ATTACKER)]);
    sim(effects({ solChanges: [fee] }));
    const r = await review(base64);
    expect(r.findings.signals.map((s) => s.code)).toContain("TX_TOKEN_ACCOUNT_OWNER_CHANGE");
    expect(r.decision.risk.level).toBe("CRITICAL");
    expect(r.decision.gate).toBe("block");
    expect(r.decision.userCanOverride).toBe(true);
    expect(r.decision.primaryActionLabel).toMatch(/critical risk/i);
    expect(r.findings.authorityChanges.join(" ")).toMatch(/AccountOwner/);
  });

  it("delegate approval is HIGH; unlimited approval is CRITICAL", async () => {
    sim(effects({ solChanges: [fee] }));
    const limited = await review(buildTx([createApproveInstruction(WALLET_ATA, ATTACKER, WALLET, 5n)]).base64);
    expect(limited.findings.signals.map((s) => s.code)).toContain("TX_TOKEN_APPROVAL");
    expect(limited.decision.risk.level).toBe("HIGH");
    const unlimited = await review(buildTx([createApproveInstruction(WALLET_ATA, ATTACKER, WALLET, U64_MAX)]).base64);
    expect(unlimited.findings.signals.map((s) => s.code)).toContain("TX_UNLIMITED_APPROVAL");
    expect(unlimited.decision.risk.level).toBe("CRITICAL");
  });

  it("durable nonce is surfaced", async () => {
    const nonce = Keypair.fromSeed(new Uint8Array(32).fill(7)).publicKey;
    const { base64 } = buildTx([SystemProgram.nonceAdvance({ noncePubkey: nonce, authorizedPubkey: WALLET }), memo()]);
    sim(effects({ solChanges: [fee], blockhashValid: false }));
    const r = await review(base64);
    expect(r.findings.signals.map((s) => s.code)).toContain("TX_DURABLE_NONCE");
    expect(r.decision.technicalValidation).toBe("VALID");
  });

  it("an unidentified program is never SAFE", async () => {
    const unknown = Keypair.fromSeed(new Uint8Array(32).fill(8)).publicKey;
    const { base64 } = buildTx([new TransactionInstruction({ programId: unknown, keys: [{ pubkey: WALLET, isSigner: true, isWritable: true }], data: Buffer.from([1, 2, 3]) })]);
    sim(effects({ solChanges: [fee] }));
    const r = await review(base64);
    expect(r.findings.signals.map((s) => s.code)).toContain("TX_UNKNOWN_PROGRAM");
    expect(r.decision.risk.level).not.toBe("SAFE");
  });

  it("simulation failure: cannot verify — no sign option, no analysis token", async () => {
    const { base64 } = buildTx([memo()]);
    sim(effects({ success: false, error: "InstructionError: custom program error 0x1" }));
    const r = await review(base64);
    expect(r.decision.technicalValidation).toBe("UNVERIFIABLE");
    expect(r.decision.userCanOverride).toBe(false);
    expect(r.decision.expectedChoice).toBeNull();
    expect(r.decision.primaryActionLabel).toBeNull();
    expect(r.analysisToken).toBeNull();
    expect(r.simulation?.status).toBe("FAILED");
    expect(r.decision.technicalIssues.map((i) => i.code)).toContain("SIMULATION_FAILED");
  });

  it("simulation unavailable is never 'passed'", async () => {
    simulate.mockRejectedValue(new AppError("SIMULATION_FAILED", "could not run"));
    const r = await review(buildTx([memo()]).base64);
    expect(r.simulation?.status).toBe("UNAVAILABLE");
    expect(r.decision.technicalValidation).toBe("UNVERIFIABLE");
    expect(r.analysisToken).toBeNull();
    expect(r.decision.risk.level).not.toBe("SAFE");
  });

  it("undecodable payload: UNKNOWN / INVALID, no override, simulation never runs", async () => {
    const r = await analyzeSigning({ type: "TRANSACTION", payload: Buffer.from("not a transaction at all, just bytes!!").toString("base64"), payloadEncoding: "base64", walletAddress: W }, SID);
    expect(r.decision.risk.level).toBe("UNKNOWN");
    expect(r.decision.technicalValidation).toBe("INVALID");
    expect(r.decision.userCanOverride).toBe(false);
    expect(r.analysisToken).toBeNull();
    expect(simulate).not.toHaveBeenCalled();
  });

  it("a wallet that is not a required signer cannot sign it", async () => {
    sim(effects());
    const r = await review(buildTx([memo()]).base64, A);
    expect(r.decision.technicalValidation).toBe("INVALID");
    expect(r.decision.technicalIssues.map((i) => i.code)).toContain("WALLET_NOT_SIGNER");
  });
});

describe("pre-sign review — messages", () => {
  const msg = (payload: string, extra: Partial<AnalyzeSigningInput> = {}) => analyzeSigning({ type: "MESSAGE", payload, payloadEncoding: "utf8", walletAddress: W, ...extra }, SID);

  it("safe sign-in message with nonce and expiry", async () => {
    const r = await msg("example.com wants you to sign in with your Solana account:\nNonce: 12345678\nIssued At: 2026-10-04T00:00:00Z\nExpiration Time: 2026-10-04T00:10:00Z", { domain: "https://example.com" });
    expect(r.decision.risk.level).toBe("SAFE");
    expect(r.decision.expectedChoice).toBe("SIGN");
    expect(r.message?.text).toContain("Nonce");
  });

  it("suspicious message: other domain + seed phrase + transfer language → HIGH, overridable", async () => {
    const r = await msg("phantom-support.xyz wants you to sign in\nI authorize the transfer of all assets. Have your seed phrase ready.", { domain: "https://example.com" });
    const codes = r.findings.signals.map((s) => s.code);
    expect(codes).toEqual(expect.arrayContaining(["MSG_DOMAIN_MISMATCH", "MSG_SECRET_REQUEST", "MSG_AUTHORIZATION_LANGUAGE"]));
    expect(r.decision.risk.level).toBe("HIGH");
    expect(r.decision.userCanOverride).toBe(true);
  });

  it("transaction bytes disguised as a message are CRITICAL", async () => {
    const { tx } = buildTx([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 1 })]);
    const r = await msg(bytesToBase64(new Uint8Array(tx.serializeMessage())), { payloadEncoding: "base64" });
    expect(r.findings.signals.map((s) => s.code)).toContain("MSG_IS_TRANSACTION");
    expect(r.decision.risk.level).toBe("CRITICAL");
  });

  it("binary that is not text cannot be verified", async () => {
    const r = await msg(bytesToBase64(new Uint8Array([0, 1, 2, 3, 255, 254, 253, 0, 7])), { payloadEncoding: "base64" });
    expect(r.decision.technicalValidation).toBe("UNVERIFIABLE");
    expect(r.analysisToken).toBeNull();
  });
});

describe("approval — exact payload, wallet, session, expiry, single use, server-side risk", () => {
  async function highReview() {
    const built = buildTx([createApproveInstruction(WALLET_ATA, ATTACKER, WALLET, 5n)]);
    sim(effects({ solChanges: [fee] }));
    const r = await review(built.base64);
    expect(r.decision.risk.level).toBe("HIGH");
    return { r, built };
  }
  const approve = (r: SigningReview, o: Partial<Parameters<typeof approveSigning>[0]> = {}, sid: string | null = SID, verified: string | null = W, now?: number) =>
    approveSigning({ analysisToken: r.analysisToken!, payload: r.request.payload, payloadEncoding: r.request.payloadEncoding, walletAddress: W, choice: "OVERRIDE", overrideConfirmed: true, riskLevel: r.decision.risk.level, ...o }, sid, verified, now);
  const reason = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as AppError).details?.reason;

  it("HIGH with the explicit override → approval bound to the analyzed hash", async () => {
    const { r } = await highReview();
    const a = await approve(r);
    expect(a.payloadHash).toBe(r.request.payloadHash);
    expect(a.requestId).toBe(r.request.requestId);
  });

  it("HIGH without the second confirmation is refused", async () => {
    const { r } = await highReview();
    expect(await reason(approve(r, { overrideConfirmed: false }))).toBe("CONFIRMATION_REQUIRED");
  });

  it("HIGH cannot be approved as a plain SIGN", async () => {
    const { r } = await highReview();
    expect(await reason(approve(r, { choice: "SIGN" }))).toBe("DECISION_MISMATCH");
  });

  it("payload modified after analysis → PAYLOAD_MISMATCH with the user-facing message", async () => {
    const { r } = await highReview();
    const other = buildTx([memo("something else")]).base64;
    const e = (await approve(r, { payload: other }).catch((x: unknown) => x)) as AppError;
    expect(e.details?.reason).toBe("PAYLOAD_MISMATCH");
    expect(e.message).toBe(PAYLOAD_CHANGED_MESSAGE);
  });

  it("wallet mismatch, session mismatch, unverified wallet are refused", async () => {
    const { r } = await highReview();
    expect(await reason(approve(r, { walletAddress: A }))).toBe("WALLET_MISMATCH");
    expect(await reason(approve(r, {}, OTHER_SID))).toBe("SESSION_MISMATCH");
    expect(await reason(approve(r, {}, null))).toBe("SESSION_MISMATCH");
    expect(await reason(approve(r, {}, SID, null))).toBe("WALLET_NOT_VERIFIED");
  });

  it("expired review is refused", async () => {
    const { r } = await highReview();
    expect(await reason(approve(r, {}, SID, W, Date.now() + 6 * 60_000))).toBe("REQUEST_EXPIRED");
  });

  it("replayed approval is refused", async () => {
    const { r } = await highReview();
    await approve(r);
    expect(await reason(approve(r))).toBe("REQUEST_REPLAYED");
  });

  it("a risk result modified on the client is detected", async () => {
    const { r } = await highReview();
    expect(await reason(approve(r, { riskLevel: "SAFE" }))).toBe("RISK_MISMATCH");
  });

  it("a forged or tampered analysis token is refused", async () => {
    const { r } = await highReview();
    const t = r.analysisToken!;
    const tampered = `${t.slice(0, 10)}${t[10] === "A" ? "B" : "A"}${t.slice(11)}`;
    expect(await reason(approve({ ...r, analysisToken: tampered }))).toBe("REQUEST_INVALID");
  });

  it("CRITICAL is overridable for a valid request", async () => {
    sim(effects({ solChanges: [fee] }));
    const r = await review(buildTx([createSetAuthorityInstruction(WALLET_ATA, WALLET, AuthorityType.AccountOwner, ATTACKER)]).base64);
    expect(r.decision.risk.level).toBe("CRITICAL");
    await expect(approve(r)).resolves.toMatchObject({ payloadHash: r.request.payloadHash });
  });
});

describe("submission bound to the approval", () => {
  async function approved() {
    const built = buildTx([createApproveInstruction(WALLET_ATA, ATTACKER, WALLET, 5n)]);
    sim(effects({ solChanges: [fee] }));
    const r = await review(built.base64);
    const a = await approveSigning({ analysisToken: r.analysisToken!, payload: r.request.payload, payloadEncoding: "base64", walletAddress: W, choice: "OVERRIDE", overrideConfirmed: true }, SID, W);
    return { built, a };
  }
  const signed = (tx: ReturnType<typeof buildTx>["tx"], kp = OWNER) => {
    tx.partialSign(kp);
    return bytesToBase64(new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false })));
  };

  it("accepts exactly the approved, validly signed transaction once", async () => {
    const { built, a } = await approved();
    const s = signed(built.tx);
    await expect(verifyApprovalForSubmit(a.approvalToken, SID, s, a.payloadHash)).resolves.toBeUndefined();
    await expect(verifyApprovalForSubmit(a.approvalToken, SID, s, a.payloadHash)).rejects.toMatchObject({ details: { reason: "REQUEST_REPLAYED" } });
  });

  it("the extension's confirmation and the final submission are separate single uses: approve → confirm → sign → submit, each once", async () => {
    const { built, a } = await approved();
    // A confirmation for other bytes is refused and spends nothing.
    expect(await confirmApprovalForExtension(a.approvalToken, "0".repeat(64))).toEqual({ valid: false, reason: "PAYLOAD_MISMATCH" });
    expect(await confirmApprovalForExtension(a.approvalToken, a.payloadHash)).toMatchObject({ valid: true, payloadHash: a.payloadHash, walletAddress: W, type: "TRANSACTION" });
    // Asking again — however often — never re-confirms the same approval …
    for (let i = 0; i < 3; i++) expect(await confirmApprovalForExtension(a.approvalToken, a.payloadHash)).toEqual({ valid: false, reason: "ALREADY_USED" });
    // … and does not touch the submission's own single use: the signed transaction is accepted exactly once.
    const s = signed(built.tx);
    await expect(verifyApprovalForSubmit(a.approvalToken, SID, s, a.payloadHash)).resolves.toBeUndefined();
    await expect(verifyApprovalForSubmit(a.approvalToken, SID, s, a.payloadHash)).rejects.toMatchObject({ details: { reason: "REQUEST_REPLAYED" } });
    expect(await confirmApprovalForExtension(a.approvalToken, a.payloadHash)).toEqual({ valid: false, reason: "ALREADY_USED" });
  });

  it("rejects a different transaction signed under the same approval", async () => {
    const { a } = await approved();
    const other = buildTx([memo("swap")]);
    await expect(verifyApprovalForSubmit(a.approvalToken, SID, signed(other.tx), a.payloadHash)).rejects.toMatchObject({ details: { reason: "PAYLOAD_MISMATCH" } });
  });

  it("rejects a signature by another key and another session", async () => {
    const { built, a } = await approved();
    const bytes = new Uint8Array(built.tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
    const forged = VersionedTransaction.deserialize(bytes);
    forged.signatures[0] = new Uint8Array(64).fill(9);
    await expect(verifyApprovalForSubmit(a.approvalToken, SID, bytesToBase64(forged.serialize()), a.payloadHash)).rejects.toMatchObject({ details: { reason: "WALLET_MISMATCH" } });
    await expect(verifyApprovalForSubmit(a.approvalToken, OTHER_SID, signed(built.tx), a.payloadHash)).rejects.toMatchObject({ details: { reason: "SESSION_MISMATCH" } });
  });
});
