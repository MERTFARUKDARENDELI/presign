import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/api/errors";
import { analyzeMessage, offchainMessageBody } from "@/lib/presign/message";
import { receivedTokenSignals } from "@/lib/presign/received-tokens";
import { directRecipients, POISONING, recipientHistorySignals } from "@/lib/presign/recipient-history";
import { resetReplayRegistry } from "@/lib/presign/replay";
import { analyzeSigning } from "@/lib/presign/signing";
import { buildAssessment } from "@/lib/security/engine";
import type { RiskSignal } from "@/lib/security/risk";
import { rpcCall } from "@/lib/solana/client";
import { MEMO_PROGRAM_ID, WSOL_MINT } from "@/lib/solana/constants";
import { getTokenMetadataBatch } from "@/lib/solana/tokens";
import { analyzeTokensBatch } from "@/lib/token/scanner";
import type { TokenSecurityReport } from "@/lib/token/report";
import { resolveLookupTables, simulateTransaction } from "@/lib/transaction/simulate";
import type { TransactionAnalysis, TransactionEffects } from "@/lib/transaction/types";
import { ATTACKER, ATTACKER_ATA, buildTx, key, MINT, OTHER_MINT, WALLET, WALLET_ATA } from "../helpers/fixtures";

vi.mock("@/lib/solana/client", async (importOriginal) => ({ ...(await importOriginal<object>()), rpcCall: vi.fn() }));
vi.mock("@/lib/transaction/simulate", async (importOriginal) => ({ ...(await importOriginal<object>()), simulateTransaction: vi.fn(), resolveLookupTables: vi.fn() }));
vi.mock("@/lib/token/scanner", () => ({ analyzeTokensBatch: vi.fn() }));
vi.mock("@/lib/solana/tokens", async (importOriginal) => ({ ...(await importOriginal<object>()), getTokenMetadataBatch: vi.fn() }));

const W = WALLET.toBase58();
const SID = "session-bbbbbbbbbbbbbbbbbbbbbbbb";
const memo = () => new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM_ID), keys: [], data: Buffer.from("swap") });

function effects(o: Partial<TransactionEffects> = {}): TransactionEffects {
  return { source: "SIMULATION", success: true, error: null, logs: [], logsTruncated: false, unitsConsumed: 1, slot: 2, preStateSlot: 1, stale: false, blockhashValid: true, feeLamports: "5000", solChanges: [{ address: W, preLamports: "100000000", postLamports: "99995000", deltaLamports: "-5000" }], tokenChanges: [], accountChanges: [], notes: [], ...o };
}
const credit = (mint: string, deltaRaw = "1000000", owner = W) => ({ tokenAccount: WALLET_ATA.toBase58(), owner, mint, decimals: 6, preRaw: "0", postRaw: deltaRaw, deltaRaw });

function tokenReport(mint: string, signals: Array<Pick<RiskSignal, "code" | "severity" | "title">>, status: "COMPLETE" | "PARTIAL" | "INSUFFICIENT_DATA" = "PARTIAL"): TokenSecurityReport {
  const evidence = signals.map((_, i) => ({ id: `t${i}`, source: "ONCHAIN_RPC" as const, label: "mint", observed: true }));
  const risk = buildAssessment({ category: "token", signals: signals.map((s, i) => ({ ...s, description: s.title, evidenceIds: [`t${i}`] })), evidence, sources: [{ source: "ONCHAIN_RPC", status: "OK" }], status, now: new Date() });
  return { mint, mintInfo: null, metadata: null, rugcheck: null, concentration: null, risk };
}
const asAnalysis = (e: TransactionEffects) => ({ effects: e }) as unknown as TransactionAnalysis;

beforeEach(() => {
  vi.mocked(rpcCall).mockReset();
  vi.mocked(getTokenMetadataBatch).mockReset().mockResolvedValue(new Map());
  vi.mocked(analyzeTokensBatch).mockReset();
  vi.mocked(simulateTransaction).mockReset();
  vi.mocked(resolveLookupTables).mockReset().mockResolvedValue(null);
  resetReplayRegistry();
});

describe("MSG_OPAQUE_DATA: text you cannot read", () => {
  const codes = (text: string) => analyzeMessage(new TextEncoder().encode(text), { expectedHost: "example.com" }).risk.signals.map((s) => s.code);

  it("a long hex payload is flagged", () => {
    expect(codes(`Confirm: ${"ab".repeat(80)}`)).toContain("MSG_OPAQUE_DATA");
  });

  it("an encoded transaction inside the text is named as such", () => {
    const tx = buildTx([memo()]).bytes;
    const r = analyzeMessage(new TextEncoder().encode(`Please sign to continue\n${bs58.encode(tx)}`), { expectedHost: "example.com" });
    const s = r.risk.signals.find((x) => x.code === "MSG_OPAQUE_DATA");
    expect(s?.title).toMatch(/encoded transaction/);
    expect(r.risk.evidence.some((e) => String(e.observed).includes("decodes as a Solana transaction"))).toBe(true);
    const b64 = analyzeMessage(new TextEncoder().encode(`Payload: ${Buffer.from(tx).toString("base64")}`), { expectedHost: "example.com" });
    expect(b64.risk.signals.find((x) => x.code === "MSG_OPAQUE_DATA")?.title).toMatch(/encoded transaction/);
  });

  it("a normal sign-in message (address, 32-byte hex nonce) is not flagged", () => {
    const siws = `example.com wants you to sign in with your Solana account:\n${W}\n\nURI: https://example.com\nNonce: ${"9f".repeat(32)}\nIssued At: 2026-10-04T00:00:00Z`;
    expect(codes(siws)).not.toContain("MSG_OPAQUE_DATA");
  });
});

describe("received-token (honeypot) check", () => {
  it("a received token with HIGH/CRITICAL findings becomes a HIGH request signal", async () => {
    vi.mocked(analyzeTokensBatch).mockResolvedValue(new Map([[MINT.toBase58(), tokenReport(MINT.toBase58(), [{ code: "TOKEN_PERMANENT_DELEGATE", severity: "CRITICAL", title: "Permanent delegate" }, { code: "TOKEN_TRANSFER_HOOK", severity: "MEDIUM", title: "Transfer hook" }])]]));
    const out = await receivedTokenSignals(asAnalysis(effects({ tokenChanges: [credit(MINT.toBase58())] })), W);
    expect(out.signals).toEqual([expect.objectContaining({ code: `PRESIGN_RECEIVED_RISKY_TOKEN:${MINT.toBase58()}`, severity: "HIGH" })]);
    expect(out.signals[0].description).toMatch(/permanent delegate/);
    expect(out.signals[0].description).not.toMatch(/transfer hook/);
    expect(out.degraded).toBeFalsy();
  });

  it("only tokens credited to the wallet are scanned (not outflows, not wrapped SOL, not other owners)", async () => {
    vi.mocked(analyzeTokensBatch).mockResolvedValue(new Map());
    await receivedTokenSignals(asAnalysis(effects({ tokenChanges: [credit(MINT.toBase58(), "-5"), credit(WSOL_MINT), credit(OTHER_MINT.toBase58(), "10", "someone-else")] })), W);
    expect(analyzeTokensBatch).not.toHaveBeenCalled();
  });

  it("a scanner failure is reported and makes the analysis PARTIAL — never silently clean", async () => {
    vi.mocked(analyzeTokensBatch).mockRejectedValue(new Error("rpc down"));
    const out = await receivedTokenSignals(asAnalysis(effects({ tokenChanges: [credit(MINT.toBase58())] })), W);
    expect(out.signals).toEqual([]);
    expect(out.degraded).toBe(true);
    expect(out.sources).toEqual([expect.objectContaining({ status: "FAILED" })]);
  });

  it("a mint that could not be read counts as not scanned", async () => {
    vi.mocked(analyzeTokensBatch).mockResolvedValue(new Map([[MINT.toBase58(), tokenReport(MINT.toBase58(), [], "INSUFFICIENT_DATA")]]));
    const out = await receivedTokenSignals(asAnalysis(effects({ tokenChanges: [credit(MINT.toBase58())] })), W);
    expect(out.degraded).toBe(true);
  });

  it("end to end: a swap into a honeypot requires the user's review, and the finding is shown", async () => {
    vi.mocked(simulateTransaction).mockResolvedValue({ effects: effects({ tokenChanges: [credit(MINT.toBase58())] }), tokenAccountOwners: { [WALLET_ATA.toBase58()]: W }, tokenAccountMints: {}, innerInstructions: null });
    vi.mocked(analyzeTokensBatch).mockResolvedValue(new Map([[MINT.toBase58(), tokenReport(MINT.toBase58(), [{ code: "TOKEN_FREEZE_AUTHORITY_ACTIVE", severity: "HIGH", title: "Freeze Authority active" }])]]));
    const r = await analyzeSigning({ type: "TRANSACTION", payload: buildTx([memo()]).base64, payloadEncoding: "base64", walletAddress: W, domain: "https://some-new-dapp.io" }, SID);
    expect(r.findings.signals.map((s) => s.code)).toContain(`PRESIGN_RECEIVED_RISKY_TOKEN:${MINT.toBase58()}`);
    expect(r.decision.risk.level).toBe("HIGH");
    expect(r.decision.gate).not.toBe("no_known_risk");
  });

  it("end to end: a clean received token keeps the request SAFE", async () => {
    vi.mocked(simulateTransaction).mockResolvedValue({ effects: effects({ tokenChanges: [credit(MINT.toBase58())] }), tokenAccountOwners: { [WALLET_ATA.toBase58()]: W }, tokenAccountMints: {}, innerInstructions: null });
    vi.mocked(analyzeTokensBatch).mockResolvedValue(new Map([[MINT.toBase58(), tokenReport(MINT.toBase58(), [{ code: "TOKEN_TRANSFER_HOOK", severity: "MEDIUM", title: "Transfer hook" }])]]));
    const r = await analyzeSigning({ type: "TRANSACTION", payload: buildTx([memo()]).base64, payloadEncoding: "base64", walletAddress: W, domain: "https://some-new-dapp.io" }, SID);
    expect(r.findings.signals.filter((s) => s.code.startsWith("PRESIGN_RECEIVED"))).toEqual([]);
    expect(r.decision.risk.level).toBe("SAFE");
  });

  it("passes DAS metadata to the token rules (impersonation check), and reports NOT_CONFIGURED without Helius", async () => {
    const meta = new Map([[MINT.toBase58(), { symbol: "USDC", source: "HELIUS_DAS" as const }]]);
    vi.mocked(getTokenMetadataBatch).mockResolvedValue(meta);
    vi.mocked(analyzeTokensBatch).mockResolvedValue(new Map());
    await receivedTokenSignals(asAnalysis(effects({ tokenChanges: [credit(MINT.toBase58())] })), W);
    expect(analyzeTokensBatch).toHaveBeenCalledWith([MINT.toBase58()], meta, "OK");
    vi.mocked(getTokenMetadataBatch).mockRejectedValue(new AppError("NOT_CONFIGURED", "no helius"));
    await receivedTokenSignals(asAnalysis(effects({ tokenChanges: [credit(MINT.toBase58())] })), W);
    expect(analyzeTokensBatch).toHaveBeenLastCalledWith([MINT.toBase58()], new Map(), "NOT_CONFIGURED");
  });
});

describe("Solana off-chain message format", () => {
  const DOMAIN = [0xff, ...new TextEncoder().encode("solana offchain")];
  const sdk = (text: string) => {
    const b = new TextEncoder().encode(text);
    return Uint8Array.from([...DOMAIN, 0, 1, b.length & 0xff, b.length >> 8, ...b]);
  };
  const extended = (text: string) => {
    const b = new TextEncoder().encode(text);
    return Uint8Array.from([...DOMAIN, 0, ...new Array(32).fill(0x61), 1, 1, ...WALLET.toBytes(), b.length & 0xff, b.length >> 8, ...b]);
  };

  it("both layouts are unwrapped and the text inside is analyzed", () => {
    for (const bytes of [sdk("Enter your seed phrase to verify"), extended("Enter your seed phrase to verify")]) {
      expect(new TextDecoder().decode(offchainMessageBody(bytes)!)).toBe("Enter your seed phrase to verify");
      const r = analyzeMessage(bytes, { expectedHost: null });
      expect(r.text).toBe("Enter your seed phrase to verify");
      expect(r.technicalIssues).toEqual([]);
      expect(r.risk.signals.map((s) => s.code)).toContain("MSG_SECRET_REQUEST");
    }
  });

  it("a header whose length does not match is not unwrapped (stays unverifiable)", () => {
    const bad = sdk("hello");
    bad[18] = 99;
    expect(offchainMessageBody(bad)).toBeNull();
    expect(analyzeMessage(bad, { expectedHost: null }).technicalIssues.map((i) => i.code)).toContain("MESSAGE_NOT_TEXT");
  });
});

describe("address poisoning (recipient whose only contact was dust)", () => {
  const A = ATTACKER.toBase58();
  const sig = (n: number) => `${n}`.padStart(88, "s");
  /** jsonParsed getTransaction: `signer` (fee payer) sends `lamports` to `to`, optionally with a token gain for `to`. */
  const parsedTransfer = (signer: string, to: string, lamports: number, tokenGain?: string) => ({
    transaction: { message: { accountKeys: [{ pubkey: signer, signer: true }, { pubkey: to, signer: false }] } },
    meta: {
      preBalances: [10_000_000_000, 1_000_000],
      postBalances: [10_000_000_000 - lamports - 5_000, 1_000_000 + lamports],
      preTokenBalances: tokenGain ? [{ mint: MINT.toBase58(), owner: to, uiTokenAmount: { uiAmountString: "0" } }] : [],
      postTokenBalances: tokenGain ? [{ mint: MINT.toBase58(), owner: to, uiTokenAmount: { uiAmountString: tokenGain } }] : [],
    },
  });
  function chain(history: Record<string, string[]>, txs: Record<string, unknown>) {
    vi.mocked(rpcCall).mockImplementation(async (method: string, params: unknown) => {
      const [first] = params as [string];
      if (method === "getSignaturesForAddress") return { result: (history[first] ?? []).map((signature) => ({ signature })), source: "PUBLIC_RPC" as const, fallbackUsed: false };
      if (method === "getTransaction") return { result: txs[first] ?? null, source: "PUBLIC_RPC" as const, fallbackUsed: false };
      throw new Error(`unexpected ${method}`);
    });
  }
  const sendSol = () => ({ decoded: { solTransfers: [{ instruction: 0, from: W, to: A, lamports: "5000000000" }], tokenTransfers: [] }, effects: null }) as unknown as TransactionAnalysis;

  it("only direct transfers from the wallet are checked (not CPI, not to itself); token recipients resolve to their owner", () => {
    const a = {
      decoded: {
        solTransfers: [{ instruction: 0, from: W, to: A, lamports: "1" }, { instruction: 1, cpi: true, from: W, to: key(90).toBase58(), lamports: "1" }, { instruction: 2, from: W, to: W, lamports: "1" }],
        tokenTransfers: [{ instruction: 3, program: "spl-token", source: WALLET_ATA.toBase58(), destination: ATTACKER_ATA.toBase58(), authority: W, amountRaw: "1", mint: null, decimals: null }],
      },
      effects: effects({ tokenChanges: [{ tokenAccount: ATTACKER_ATA.toBase58(), owner: key(91).toBase58(), mint: MINT.toBase58(), decimals: 6, preRaw: "0", postRaw: "1", deltaRaw: "1" }] }),
    } as unknown as TransactionAnalysis;
    expect(directRecipients(a, W)).toEqual([A, key(91).toBase58()]);
  });

  it("a recipient whose only contact was dust it sent is flagged HIGH", async () => {
    chain({ [W]: [sig(1), sig(2)], [A]: [sig(1), sig(9)] }, { [sig(1)]: parsedTransfer(A, W, 1_000) });
    const out = await recipientHistorySignals(sendSol(), W);
    expect(out.signals).toEqual([expect.objectContaining({ code: `PRESIGN_POISONED_RECIPIENT:${A}`, severity: "HIGH" })]);
    expect(out.degraded).toBeFalsy();
  });

  it("dust-sized token gifts count as dust; real payments and the wallet's own sends are a real relationship", async () => {
    chain({ [W]: [sig(1)], [A]: [sig(1)] }, { [sig(1)]: parsedTransfer(A, W, 0, "0.0001") });
    expect((await recipientHistorySignals(sendSol(), W)).signals).toHaveLength(1);
    chain({ [W]: [sig(1)], [A]: [sig(1)] }, { [sig(1)]: parsedTransfer(A, W, 0, "25") });
    expect((await recipientHistorySignals(sendSol(), W)).signals).toEqual([]);
    chain({ [W]: [sig(1)], [A]: [sig(1)] }, { [sig(1)]: parsedTransfer(A, W, 2_000_000_000) });
    expect((await recipientHistorySignals(sendSol(), W)).signals).toEqual([]);
    chain({ [W]: [sig(1), sig(2)], [A]: [sig(1), sig(2)] }, { [sig(1)]: parsedTransfer(A, W, 1_000), [sig(2)]: parsedTransfer(W, A, 1_000_000_000) });
    expect((await recipientHistorySignals(sendSol(), W)).signals).toEqual([]);
  });

  it("no earlier contact, or a long relationship, is not flagged", async () => {
    chain({ [W]: [sig(1)], [A]: [sig(2)] }, {});
    expect((await recipientHistorySignals(sendSol(), W)).signals).toEqual([]);
    const many = Array.from({ length: POISONING.maxSharedChecked + 1 }, (_, i) => sig(i + 1));
    chain({ [W]: many, [A]: many }, {});
    expect((await recipientHistorySignals(sendSol(), W)).signals).toEqual([]);
  });

  it("an RPC failure is reported and makes the analysis PARTIAL", async () => {
    vi.mocked(rpcCall).mockRejectedValue(new Error("rate limited"));
    const out = await recipientHistorySignals(sendSol(), W);
    expect(out.degraded).toBe(true);
    expect(out.sources).toEqual([expect.objectContaining({ status: "FAILED" })]);
  });

  it("end to end: paying a poisoned address is not cleared for signing", async () => {
    chain({ [W]: [sig(1)], [A]: [sig(1)] }, { [sig(1)]: parsedTransfer(A, W, 1) });
    vi.mocked(simulateTransaction).mockResolvedValue({ effects: effects({ solChanges: [{ address: W, preLamports: "9000000000", postLamports: "3999995000", deltaLamports: "-5000005000" }] }), tokenAccountOwners: {}, tokenAccountMints: {}, innerInstructions: null });
    const r = await analyzeSigning({ type: "TRANSACTION", payload: buildTx([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 5_000_000_000 })]).base64, payloadEncoding: "base64", walletAddress: W, domain: "https://some-new-dapp.io" }, SID);
    expect(r.findings.signals.map((s) => s.code)).toContain(`PRESIGN_POISONED_RECIPIENT:${A}`);
    expect(r.decision.gate).not.toBe("no_known_risk");
  });
});
