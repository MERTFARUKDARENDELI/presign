import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/api/errors";
import { analyzeDomain } from "@/lib/presign/domain";
import { onWalletEvent } from "@/lib/presign/flow";
import { analyzeBody, WebAppSigningInterceptor } from "@/lib/presign/interceptor";
import { resetReplayRegistry } from "@/lib/presign/replay";
import { analyzeSigning, approveSigning } from "@/lib/presign/signing";
import type { SigningReview } from "@/lib/presign/types";
import { MEMO_PROGRAM_ID } from "@/lib/solana/constants";
import { resolveLookupTables, simulateTransaction } from "@/lib/transaction/simulate";
import type { TransactionEffects } from "@/lib/transaction/types";
import { ATTACKER, ATTACKER_ATA, buildTx, MINT, WALLET, WALLET_ATA } from "../helpers/fixtures";
import { ATTACKER_ADMIN, driftUnsignedApproval, serveDriftChain, SIGNER_1 } from "../helpers/drift-chain";

// Real decoder, multisig layer, rules and decision; the RPC edge (Drift chain state) and the
// top-level simulation are mocked.
vi.mock("@/lib/solana/client", async (importOriginal) => ({ ...(await importOriginal<object>()), rpcCall: vi.fn() }));
vi.mock("@/lib/transaction/simulate", async (importOriginal) => ({ ...(await importOriginal<object>()), simulateTransaction: vi.fn(), resolveLookupTables: vi.fn() }));

const W = WALLET.toBase58();
const A = ATTACKER.toBase58();
const SID = "session-aaaaaaaaaaaaaaaaaaaaaaaa";
const memo = () => new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM_ID), keys: [], data: Buffer.from("hi") });

function effects(o: Partial<TransactionEffects> = {}): TransactionEffects {
  return { source: "SIMULATION", success: true, error: null, logs: [], logsTruncated: false, unitsConsumed: 1, slot: 2, preStateSlot: 1, stale: false, blockhashValid: true, feeLamports: "5000", solChanges: [{ address: W, preLamports: "100000000", postLamports: "99995000", deltaLamports: "-5000" }], tokenChanges: [], accountChanges: [], notes: [], ...o };
}
function sim(e: TransactionEffects, owners: Record<string, string> = {}) {
  vi.mocked(simulateTransaction).mockResolvedValue({ effects: e, tokenAccountOwners: owners, tokenAccountMints: {}, innerInstructions: null });
}

beforeEach(() => {
  vi.mocked(simulateTransaction).mockReset();
  vi.mocked(resolveLookupTables).mockReset().mockResolvedValue(null);
  resetReplayRegistry();
});

describe("application address in the request's risk", () => {
  it("a name claiming a known brand on another domain is flagged", () => {
    expect(analyzeDomain("https://swap-portal.io", new Date(), { name: "Jupiter Exchange" }).findings.map((f) => f.code)).toContain("DOMAIN_NAME_IMPERSONATION");
    expect(analyzeDomain("https://jup.ag", new Date(), { name: "Jupiter" }).findings.map((f) => f.code)).not.toContain("DOMAIN_NAME_IMPERSONATION");
    expect(analyzeDomain("https://toolbox-app.io", new Date(), { name: "Solana Tools" }).findings.map((f) => f.code)).not.toContain("DOMAIN_NAME_IMPERSONATION");
  });

  it("a harmless transaction from a phishing-pattern domain is not shown as SAFE, and the machine gate follows", async () => {
    sim(effects());
    const r = await analyzeSigning({ type: "TRANSACTION", payload: buildTx([memo()]).base64, payloadEncoding: "base64", walletAddress: W, domain: "https://phant0m-wallet.app" }, SID);
    expect(r.findings.signals.some((s) => s.code.startsWith("DOMAIN_"))).toBe(true);
    expect(r.decision.risk.level).toBe("HIGH");
    expect(r.decision.gate).toBe("block");
    expect(r.decision.userCanOverride).toBe(true);
    expect(r.risk?.evidence.some((e) => e.label === "Application address")).toBe(true);
  });

  it("an unknown but clean domain adds no signal (unknown is shown, not scored)", async () => {
    sim(effects());
    const r = await analyzeSigning({ type: "TRANSACTION", payload: buildTx([memo()]).base64, payloadEncoding: "base64", walletAddress: W, domain: "https://some-new-dapp.io" }, SID);
    expect(r.decision.risk.level).toBe("SAFE");
    expect(r.connection.domain?.status).toBe("UNKNOWN");
  });
});

describe("declared effects vs simulation", () => {
  const out = (lamports: number) => effects({ solChanges: [{ address: W, preLamports: "1000000000", postLamports: String(1_000_000_000 - lamports - 5_000), deltaLamports: String(-lamports - 5_000) }] });

  it("more SOL than declared is HIGH and listed as an unexpected effect", async () => {
    sim(out(250_000_000));
    const r = await analyzeSigning({ type: "TRANSACTION", payload: buildTx([memo()]).base64, payloadEncoding: "base64", walletAddress: W, expectedEffects: { summary: "Swap 0.01 SOL", maxSolOutLamports: "10000000" } }, SID);
    expect(r.findings.signals.map((s) => s.code)).toContain("PRESIGN_SOL_EXCEEDS_DECLARED");
    expect(r.decision.risk.level).toBe("HIGH");
    expect(r.simulation?.unexpectedEffects.join(" ")).toMatch(/More SOL leaves than the application said/);
    expect(r.request.expectedEffects?.summary).toBe("Swap 0.01 SOL");
  });

  it("within the declared amount adds nothing (fee excluded)", async () => {
    sim(out(5_000_000));
    const r = await analyzeSigning({ type: "TRANSACTION", payload: buildTx([memo()]).base64, payloadEncoding: "base64", walletAddress: W, expectedEffects: { maxSolOutLamports: "10000000" } }, SID);
    expect(r.findings.signals.map((s) => s.code)).not.toContain("PRESIGN_SOL_EXCEEDS_DECLARED");
  });

  it("swap 10 USDC that moves 250 USDC, or an undeclared token, is caught", async () => {
    const usdcOut = (raw: string) => effects({ tokenChanges: [{ tokenAccount: WALLET_ATA.toBase58(), owner: W, mint: MINT.toBase58(), decimals: 6, preRaw: "300000000", postRaw: String(300_000_000 - Number(raw)), deltaRaw: `-${raw}` }, { tokenAccount: ATTACKER_ATA.toBase58(), owner: A, mint: MINT.toBase58(), decimals: 6, preRaw: "0", postRaw: raw, deltaRaw: raw }] });
    sim(usdcOut("250000000"), { [WALLET_ATA.toBase58()]: W, [ATTACKER_ATA.toBase58()]: A });
    const over = await analyzeSigning({ type: "TRANSACTION", payload: buildTx([memo()]).base64, payloadEncoding: "base64", walletAddress: W, expectedEffects: { summary: "Swap 10 USDC → SOL", maxTokenOut: [{ mint: MINT.toBase58(), amountRaw: "10000000" }] } }, SID);
    expect(over.findings.signals.map((s) => s.code)).toContain(`PRESIGN_TOKEN_EXCEEDS_DECLARED:${MINT.toBase58()}`);
    const undeclared = await analyzeSigning({ type: "TRANSACTION", payload: buildTx([memo()]).base64, payloadEncoding: "base64", walletAddress: W, expectedEffects: { maxTokenOut: [] } }, SID);
    expect(undeclared.findings.signals.map((s) => s.code)).toContain(`PRESIGN_UNDECLARED_TOKEN_OUTFLOW:${MINT.toBase58()}`);
  });
});

describe("binding and decision fields", () => {
  it("the target origin is bound: a client showing another application is refused; the approval records the decision", async () => {
    sim(effects());
    const r = await analyzeSigning({ type: "TRANSACTION", payload: buildTx([memo()]).base64, payloadEncoding: "base64", walletAddress: W, domain: "https://some-new-dapp.io" }, SID);
    expect(r.decision.userCanReview).toBe(true);
    const base = { analysisToken: r.analysisToken!, payload: r.request.payload, payloadEncoding: "base64" as const, walletAddress: W, choice: "SIGN" as const };
    const e = (await approveSigning({ ...base, targetOrigin: "https://other.example" }, SID, W).catch((x: unknown) => x)) as AppError;
    expect(e.details?.reason).toBe("TARGET_MISMATCH");
    const ok = await approveSigning({ ...base, targetOrigin: "https://some-new-dapp.io" }, SID, W);
    expect(ok.userDecision).toBe("SIGN");
  });

  it("an unverifiable request has no review-and-decide path", async () => {
    const r = await analyzeSigning({ type: "TRANSACTION", payload: "AAAAbm90IGEgdHJhbnNhY3Rpb24=", payloadEncoding: "base64", walletAddress: W }, SID);
    expect(r.decision.userCanReview).toBe(false);
    expect(r.decision.userCanOverride).toBe(false);
  });
});

describe("multisig approval — the Drift proposal #7 review", () => {
  it("shows action, admin leaving the multisig, no time lock, durable nonce — CRITICAL, and still the signer's decision", async () => {
    await serveDriftChain();
    sim(effects({ solChanges: [], blockhashValid: false }));
    const r: SigningReview = await analyzeSigning({ type: "TRANSACTION", payload: driftUnsignedApproval(), payloadEncoding: "base64", walletAddress: SIGNER_1 }, SID);
    expect(r.decision.risk.level).toBe("CRITICAL");
    expect(r.decision.gate).toBe("block");
    expect(r.decision.technicalValidation).toBe("VALID");
    expect(r.decision.userCanOverride).toBe(true);
    const m = r.multisigSummary!;
    expect(m.action).toMatch(/proposal #7/);
    expect(m.control?.leavesMultisig).toBe(true);
    expect(m.control?.text).toContain(`${ATTACKER_ADMIN.slice(0, 4)}…${ATTACKER_ADMIN.slice(-4)}`);
    expect(m.timeLockSeconds).toBe(0);
    expect(m.durableNonce).toBe(true);
    expect(r.findings.signals.map((s) => s.code)).toEqual(expect.arrayContaining(["MS_NO_TIME_LOCK", "MS_DURABLE_NONCE_GOVERNANCE"]));
    expect(r.txFacts?.usesDurableNonce).toBe(true);
    expect(r.txFacts?.signers).toContain(SIGNER_1);
  });
});

describe("interceptor boundary", () => {
  const review = { decision: { technicalValidation: "VALID" } } as unknown as SigningReview;

  it("runs receive → analyze → present → decide → forward, and a cancel never reaches the wallet", async () => {
    const order: string[] = [];
    const walletSignTransaction = vi.fn();
    const i = new WebAppSigningInterceptor({
      analyze: async (body) => {
        order.push(`analyze:${"connectionToken" in body ? "token" : "domain" in body ? "claimed" : "none"}`);
        return review;
      },
      present: () => order.push("present"),
      decide: async () => {
        order.push("decide");
        return { choice: "CANCEL" };
      },
      decision: { approve: vi.fn(), walletSignTransaction, verifyMessageSignature: () => false },
    });
    const { result } = await i.handle({ type: "TRANSACTION", payload: "x", walletAddress: W, origin: "https://app.example" });
    expect(order).toEqual(["analyze:claimed", "present", "decide"]);
    expect(result).toEqual({ kind: "CANCELLED" });
    expect(walletSignTransaction).not.toHaveBeenCalled();
  });

  it("an origin is sent as a claim unless a Presign connection token vouches for it; bad shapes are refused", () => {
    expect(analyzeBody({ type: "MESSAGE", payload: "x", walletAddress: W, origin: "https://a.example", connectionToken: "t".repeat(30) })).not.toHaveProperty("domain");
    const i = new WebAppSigningInterceptor({ analyze: vi.fn(), present: vi.fn(), decide: vi.fn(), decision: { approve: vi.fn(), verifyMessageSignature: () => false } });
    expect(() => i.receiveRequest({ type: "TRANSACTION", payload: "", walletAddress: W })).toThrow();
    expect(() => i.receiveRequest({ type: "OTHER" as never, payload: "x", walletAddress: W })).toThrow();
  });
});

describe("wallet events", () => {
  it("successful connection, rejected connection, disconnect, account change", () => {
    expect(onWalletEvent("WALLET_CONNECTING", { kind: "CONNECTED", address: W })).toBe("WALLET_CONNECTED");
    expect(onWalletEvent("WALLET_CONNECTING", { kind: "CONNECT_FAILED", reason: "User rejected the request" })).toBe("WALLET_CONNECTING");
    expect(onWalletEvent("WALLET_VERIFIED", { kind: "DISCONNECTED" })).toBe("WALLET_CONNECTING");
    expect(onWalletEvent("USER_APPROVAL", { kind: "DISCONNECTED" })).toBe("WAITING_FOR_SIGN_REQUEST");
    expect(onWalletEvent("WALLET_VERIFIED", { kind: "ACCOUNT_CHANGED", address: A })).toBe("WALLET_CONNECTED");
    expect(onWalletEvent("OPTIONAL_RISK_OVERRIDE", { kind: "ACCOUNT_CHANGED", address: A })).toBe("WAITING_FOR_SIGN_REQUEST");
    expect(onWalletEvent("PRE_CONNECT_VERIFIED", { kind: "CONNECTED", address: W })).toBe("PRE_CONNECT_VERIFIED");
  });
});
