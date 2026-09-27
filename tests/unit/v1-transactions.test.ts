import { ComputeBudgetProgram, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as analyzeRoute } from "@/app/api/transaction/analyze/route";
import { resetRateLimits } from "@/lib/api/rate-limit";
import { rpcCall } from "@/lib/solana/client";
import { SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@/lib/solana/constants";
import { analyzeTransaction } from "@/lib/transaction/analyze";
import { decodeTransaction, estimatePriorityFeeLamports, formatTxVersion } from "@/lib/transaction/decoder";
import { explainTransaction } from "@/lib/transaction/explain";
import { parseTransactionInput } from "@/lib/transaction/input";
import { assessSignability } from "@/lib/transaction/sign-gate";
import { simulateTransaction } from "@/lib/transaction/simulate";
import { messageBytesOf, messageHashOfTx, signExactly, verifyTransactionSignatures } from "@/lib/wallet/signing";
import fixtures from "../fixtures/mainnet-v1.json";
import { ATTACKER, BLOCKHASH, buildTx, WALLET } from "../helpers/fixtures";

// Real mainnet v1 transactions (public on-chain data, fetched read-only). Only the RPC edge is mocked.
vi.mock("@/lib/solana/client", async (importOriginal) => ({ ...(await importOriginal<object>()), rpcCall: vi.fn() }));
const rpc = vi.mocked(rpcCall);

type Fixture = (typeof fixtures.transactions)[keyof typeof fixtures.transactions];
const ALL = Object.entries(fixtures.transactions) as Array<[string, Fixture]>;
const bytesOf = (f: Fixture) => Uint8Array.from(Buffer.from(f.getTransaction.transaction[0], "base64"));
const decodeFixture = (f: Fixture) => decodeTransaction(VersionedTransaction.deserialize(bytesOf(f)));
const serveFixture = (f: Fixture) =>
  rpc.mockImplementation((async (method: string) => {
    if (method === "getTransaction") return { result: f.getTransaction, source: "HELIUS_RPC", fallbackUsed: false };
    throw new Error(`unexpected rpc ${method}`);
  }) as unknown as typeof rpcCall);

/** RPC jsonParsed type → our decoder's type for programs both sides decode. */
function expectedType(programId: string, rpcType: string | null): string | null {
  if (!rpcType) return null;
  if (programId === SYSTEM_PROGRAM_ID) return `system:${rpcType}`;
  if (programId === TOKEN_PROGRAM_ID) return `token:${rpcType}`;
  if (programId === TOKEN_2022_PROGRAM_ID) return `token-2022:${rpcType}`;
  return null;
}

beforeEach(() => {
  rpc.mockReset();
  resetRateLimits();
});

describe("v1 decode matches the RPC's own parse (real mainnet transactions)", () => {
  it.each(ALL)("%s: version, accounts, program ids, instruction types and v1 config", (_name, f) => {
    const d = decodeFixture(f);
    expect(d.version).toBe(1);
    expect(formatTxVersion(d.version)).toBe("v1");
    expect(d.accounts.map((a) => a.address)).toEqual(f.rpcView.accountKeys);
    expect(d.instructions.map((i) => i.programId)).toEqual(f.rpcView.instructions.map((i) => i.programId));
    f.rpcView.instructions.forEach((r, idx) => {
      const want = expectedType(r.programId, r.type);
      if (want) expect(d.instructions[idx].type).toBe(want);
    });
    const cfg = f.rpcView.transactionConfig as { priorityFee: number | null; computeUnitLimit: number | null; loadedAccountsDataSizeLimit: number | null; heapSize: number | null };
    expect(d.transactionConfig).toEqual({
      computeUnitLimit: cfg.computeUnitLimit,
      heapSize: cfg.heapSize,
      loadedAccountsDataSizeLimit: cfg.loadedAccountsDataSizeLimit,
      priorityFeeLamports: cfg.priorityFee === null ? null : String(cfg.priorityFee),
    });
    // v1 has no address lookup tables
    expect(d.lookupTablesResolved).toBe(true);
    expect(d.accounts.every((a) => a.source === "static")).toBe(true);
    expect(d.signers[0]).toBe(d.feePayer);
  });

  it("the v1 total priority fee comes from the message config and matches the fee charged on-chain", () => {
    const f = fixtures.transactions.systemTransfer;
    const d = decodeFixture(f);
    expect(estimatePriorityFeeLamports(d)).toBe(100_000n);
    expect(BigInt(f.getTransaction.meta.fee)).toBe(5_000n + 100_000n);
  });

  it("message bytes = bytes before the trailing signatures: the real ed25519 signatures verify", async () => {
    for (const [, f] of ALL) {
      const bytes = bytesOf(f);
      expect(verifyTransactionSignatures(bytes)).toEqual({ ok: true, missing: [], invalid: [] });
      expect(await messageHashOfTx(bytes)).toMatch(/^[0-9a-f]{64}$/);
      const tampered = bytes.slice();
      tampered[tampered.length - 64 - 3] ^= 0x01; // instruction data, just before the signatures
      expect(verifyTransactionSignatures(tampered).ok).toBe(false);
    }
  });
});

describe("v1 executed-transaction analysis (inner instructions, balances, risk, explanation)", () => {
  it("Token-2022 + SPL CPI transfers: inner instructions match the RPC and keep program identity", async () => {
    const f = fixtures.transactions.token2022Cpi;
    serveFixture(f);
    const a = await analyzeTransaction(f.signature);
    expect(a.decoded.version).toBe(1);
    expect(a.decoded.innerInstructionsSource).toBe("EXECUTED");
    const rpcInner = f.rpcView.innerInstructions.flatMap((g) => g.instructions);
    expect(a.decoded.innerInstructions.map((i) => i.programId)).toEqual(rpcInner.map((i) => i.programId));
    rpcInner.forEach((r, idx) => {
      const want = expectedType(r.programId, r.type);
      if (want) expect(a.decoded.innerInstructions[idx].type).toBe(want);
    });
    const programs = new Set(a.decoded.tokenTransfers.map((t) => t.program));
    expect(programs).toEqual(new Set(["token-2022", "spl-token"]));
    expect(a.decoded.tokenTransfers.every((t) => t.cpi)).toBe(true);
    // executed effects come from meta, never from a simulation
    expect(a.effects?.source).toBe("EXECUTED");
    const payer = a.effects!.solChanges.find((c) => c.address === a.decoded.feePayer);
    const idx = f.rpcView.accountKeys.indexOf(a.decoded.feePayer);
    expect(payer?.deltaLamports).toBe(String(f.getTransaction.meta.postBalances[idx] - f.getTransaction.meta.preBalances[idx]));
    expect(a.effects!.logs.length).toBeGreaterThan(0);
    expect(a.effects!.tokenChanges.length).toBeGreaterThan(0);
  });

  it("risk is evaluated with the same rules as v0/legacy: evidence-backed, never SAFE by default", async () => {
    for (const [, f] of ALL) {
      serveFixture(f);
      const a = await analyzeTransaction(f.signature);
      const ids = new Set(a.risk.evidence.map((e) => e.id));
      a.risk.signals.forEach((s) => s.evidenceIds.forEach((id) => expect(ids.has(id)).toBe(true)));
      expect(a.risk.sources[0].detail).toContain("v1");
      if (a.decoded.programs.some((p) => p.trust === "unknown")) expect(a.risk.signals.map((s) => s.code)).toContain("TX_UNKNOWN_PROGRAM");
    }
  });

  it("the explanation states the v1 compute settings instead of inventing ComputeBudget instructions", async () => {
    const f = fixtures.transactions.systemTransfer;
    serveFixture(f);
    const a = await analyzeTransaction(f.signature);
    const lines = explainTransaction(a).whatHappens;
    expect(lines[0]).toBe("Transaction settings (v1 message): compute limit 200000 units, priority fee 0.0001 SOL (total), loaded-account data limit 67108864 bytes.");
    expect(lines.some((l) => /^Send .* SOL from /.test(l))).toBe(true);
    expect(a.decoded.instructions.some((i) => i.type.startsWith("computeBudget:"))).toBe(false);
  });
});

describe("malformed and unsupported v1", () => {
  const good = () => bytesOf(fixtures.transactions.systemTransfer);
  const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

  it("serialized v1 input is accepted; truncated, trailing-garbage, bad config mask and v2+ are rejected", () => {
    expect(parseTransactionInput(b64(good())).kind).toBe("serialized-base64");
    const truncated = good().slice(0, 120);
    const withGarbage = new Uint8Array([...good().slice(0, good().length - 64), 7, ...good().slice(good().length - 64)]);
    const badMask = good().slice();
    badMask[4] = 0xff; // reserved config-mask bits
    const v2 = good().slice();
    v2[0] = 0x82;
    for (const bad of [truncated, withGarbage, badMask, v2]) expect(parseTransactionInput(b64(bad)).kind).toBe("invalid");
  });

  it("signing v1 is refused before any wallet call; the sign gate blocks it", async () => {
    const sign = vi.fn();
    const r = await signExactly({ bytes: good(), confirmedHash: await messageHashOfTx(good()), signer: VersionedTransaction.deserialize(good()).message.staticAccountKeys[0].toBase58(), sign });
    expect(r).toMatchObject({ ok: false, kind: "UNSUPPORTED" });
    expect(sign).not.toHaveBeenCalled();
    serveFixture(fixtures.transactions.systemTransfer);
    const a = await analyzeTransaction(fixtures.transactions.systemTransfer.signature);
    expect(assessSignability(a, a.decoded.feePayer, a.messageHash).blockers).toContain("v1 transactions can be analyzed but not signed in this app yet.");
  });

  it("submitting a v1 transaction is refused before any network call", async () => {
    const { submitAnalyzedTransaction } = await import("@/lib/transaction/submit");
    const f = fixtures.transactions.systemTransfer;
    await expect(submitAnalyzedTransaction(f.getTransaction.transaction[0], await messageHashOfTx(good()))).rejects.toMatchObject({ code: "UNSUPPORTED_TRANSACTION" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("v1 simulation needs the original bytes (web3.js cannot re-serialize v1) and never proceeds without them", async () => {
    const tx = VersionedTransaction.deserialize(good());
    await expect(simulateTransaction(tx, decodeTransaction(tx))).rejects.toMatchObject({ code: "SIMULATION_FAILED" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a serialized v1 is simulated from its exact bytes; if simulation cannot run it is INSUFFICIENT_DATA, never SAFE", async () => {
    const { AppError } = await import("@/lib/api/errors");
    const sent: string[] = [];
    rpc.mockImplementation((async (method: string, params: unknown[]) => {
      if (method === "getMultipleAccounts") return { result: { context: { slot: 1 }, value: (params[0] as string[]).map(() => null) }, source: "HELIUS_RPC", fallbackUsed: false };
      if (method === "simulateTransaction") {
        sent.push(params[0] as string);
        throw new AppError("RPC_ERROR", "The Solana RPC rejected the request.");
      }
      throw new Error(`unexpected rpc ${method}`);
    }) as unknown as typeof rpcCall);
    const a = await analyzeTransaction(b64(good()));
    expect(sent).toEqual([b64(good())]);
    expect(a.decoded.version).toBe(1);
    expect(a.messageHash).toBe(await messageHashOfTx(good()));
    expect(a.effectsStatus).toBe("INSUFFICIENT_DATA");
    expect(a.risk.level).not.toBe("SAFE");
  });
});

describe("legacy / v0 regressions", () => {
  it("message bytes for legacy and v0 are unchanged (re-serialized message)", () => {
    const legacy = buildTx([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 1 })]).bytes;
    const v0tx = new VersionedTransaction(new TransactionMessage({ payerKey: WALLET, recentBlockhash: BLOCKHASH, instructions: [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }), ComputeBudgetProgram.setComputeUnitLimit({ units: 10_000 }), SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 1 })] }).compileToV0Message());
    const v0 = v0tx.serialize();
    expect(messageBytesOf(legacy)).toEqual(VersionedTransaction.deserialize(legacy).message.serialize());
    expect(messageBytesOf(v0)).toEqual(v0tx.message.serialize());
    const d0 = decodeTransaction(VersionedTransaction.deserialize(v0));
    expect(d0.version).toBe(0);
    expect(d0.transactionConfig).toBeNull();
    expect(estimatePriorityFeeLamports(d0)).toBe(10_000n); // ComputeBudget instructions still drive v0: 1e6 µL × 10k CU / 1e6
    const dl = decodeTransaction(VersionedTransaction.deserialize(legacy));
    expect([dl.version, formatTxVersion(dl.version), dl.transactionConfig]).toEqual(["legacy", "legacy", null]);
  });
});

describe("API regression: POST /api/transaction/analyze", () => {
  it("returns a decoded v1 analysis over HTTP", async () => {
    const f = fixtures.transactions.jupiterSwap;
    serveFixture(f);
    const res = await analyzeRoute(new Request("http://localhost/api/transaction/analyze", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.7.7.7" }, body: JSON.stringify({ input: f.signature }) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.decoded.version).toBe(1);
    expect(body.data.decoded.transactionConfig.priorityFeeLamports).toBe(String(f.rpcView.transactionConfig!.priorityFee));
    expect(body.data.decoded.instructions.map((i: { programId: string }) => i.programId)).toEqual(f.rpcView.instructions.map((i) => i.programId));
  });

  it("a version above v1 still maps to 422 UNSUPPORTED_TRANSACTION", async () => {
    rpc.mockImplementation((async () => {
      const { AppError } = await import("@/lib/api/errors");
      throw new AppError("RPC_ERROR", "The Solana RPC rejected the request.", { rpcCode: -32015 });
    }) as unknown as typeof rpcCall);
    const res = await analyzeRoute(new Request("http://localhost/api/transaction/analyze", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.7.7.8" }, body: JSON.stringify({ input: "5".repeat(88) }) }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/above v1/);
  });
});
