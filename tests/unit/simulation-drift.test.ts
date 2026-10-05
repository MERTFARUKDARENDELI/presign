import { type PublicKey, SystemProgram, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/api/errors";
import { evaluateTransactionRisk } from "@/lib/security/rules/transaction";
import { rpcCall } from "@/lib/solana/client";
import { SYSTEM_PROGRAM_ID } from "@/lib/solana/constants";
import { decodeTransaction } from "@/lib/transaction/decoder";
import { diffSnapshots } from "@/lib/transaction/effects";
import { simulateTransaction } from "@/lib/transaction/simulate";
import type { TransactionEffects } from "@/lib/transaction/types";
import { ATTACKER, buildTx, key, parsedTokenAccount, WALLET, WALLET_ATA } from "../helpers/fixtures";

// Regression for 2026-10-05: a 0.001 SOL transfer from a busy devnet faucet was rated HIGH ("Unexpected SOL
// outflow") because the pre-state was read at slot N and the simulation ran at N+k, after other transactions
// had already moved the faucet's SOL. Only the RPC edge is mocked; it serves a chain whose confirmed slot moves.
vi.mock("@/lib/solana/client", async (importOriginal) => ({ ...(await importOriginal<object>()), rpcCall: vi.fn() }));
const rpc = vi.mocked(rpcCall);

const W = WALLET.toBase58();
const A = ATTACKER.toBase58();
const ATA = WALLET_ATA.toBase58();
const DRAINER = key(7);
const SOL = 1_000_000_000n;
const FEE = 5_000n;
const SENT = 1_000_000n; // 0.001 SOL, the visible transfer

/** The faucet: other transactions take 0.05 SOL from it every slot. */
const busy = (slot: number) => 10n * SOL - BigInt(slot - 100) * 50_000_000n;
const quiet = () => 10n * SOL;
const system = (lamports: bigint) => ({ lamports: Number(lamports), owner: SYSTEM_PROGRAM_ID, executable: false, rentEpoch: 0, space: 0, data: ["", "base64"] });

interface Chain {
  /** Slots the successive getMultipleAccounts / simulateTransaction calls land on. */
  snapshots: number[];
  simulations: number[];
  /** Account state before this transaction, at a slot. */
  state: (address: string, slot: number) => unknown;
  /** Account state after this transaction runs on top of the state at a slot. */
  apply: (address: string, slot: number) => unknown;
}

function serve(chain: Chain) {
  const calls: Array<{ method: string; minContextSlot: number | undefined }> = [];
  const ok = (result: unknown) => ({ result, source: "HELIUS_RPC" as const, fallbackUsed: false });
  rpc.mockImplementation((async (method: string, params: unknown[]) => {
    const cfg = (params[1] ?? {}) as { minContextSlot?: number; accounts?: { addresses: string[] } };
    if (method === "getMultipleAccounts" || method === "simulateTransaction") calls.push({ method, minContextSlot: cfg.minContextSlot });
    if (method === "getMultipleAccounts") {
      const slot = chain.snapshots.shift();
      if (slot === undefined) throw new AppError("RPC_ERROR", "Solana RPC providers are currently unavailable.");
      expect(slot).toBeGreaterThanOrEqual(cfg.minContextSlot ?? 0);
      return ok({ context: { slot }, value: (params[0] as string[]).map((a) => chain.state(a, slot)) });
    }
    if (method === "simulateTransaction") {
      const slot = chain.simulations.shift()!;
      expect(slot).toBeGreaterThanOrEqual(cfg.minContextSlot ?? 0);
      return ok({ context: { slot }, value: { err: null, logs: [], accounts: cfg.accounts!.addresses.map((a) => chain.apply(a, slot)), unitsConsumed: 450, innerInstructions: [] } });
    }
    if (method === "isBlockhashValid") return ok({ context: { slot: 0 }, value: true });
    if (method === "getFeeForMessage") return ok({ context: { slot: 0 }, value: Number(FEE) });
    throw new Error(`unexpected rpc ${method}`);
  }) as unknown as typeof rpcCall);
  return calls;
}

/** A SOL transfer of 0.001 from `wallet`; with `hidden`, an unidentified program also takes that many lamports. */
function solChain(balance: (slot: number) => bigint, snapshots: number[], simulations: number[], hidden = 0n): Chain {
  return {
    snapshots,
    simulations,
    state: (a, slot) => (a === W ? system(balance(slot)) : a === A ? system(SOL) : null),
    apply: (a, slot) => (a === W ? system(balance(slot) - SENT - FEE - hidden) : a === A ? system(SOL + SENT + hidden) : null),
  };
}

/** An unidentified program call that gets the wallet and `account` writable. */
const drainer = (account: PublicKey) =>
  new TransactionInstruction({ programId: DRAINER, keys: [{ pubkey: WALLET, isSigner: true, isWritable: true }, { pubkey: account, isSigner: false, isWritable: true }], data: Buffer.from([1]) });

async function analyze(...ixs: TransactionInstruction[]) {
  const vtx = VersionedTransaction.deserialize(buildTx(ixs).bytes);
  const decoded = decodeTransaction(vtx);
  const sim = await simulateTransaction(vtx, decoded, [W]);
  const risk = (effects: TransactionEffects) =>
    evaluateTransactionRisk({ decoded, effects, wallet: W, tokenAccountOwners: sim.tokenAccountOwners, effectsStatus: effects.stale ? "PARTIAL" : "COMPLETE" });
  return { effects: sim.effects, risk: risk(sim.effects), riskOf: risk };
}

const transfer = () => SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: SENT });
const codes = (r: { signals: Array<{ code: string }> }) => r.signals.map((s) => s.code);

beforeEach(() => {
  rpc.mockReset();
});

describe("pre-state snapshot vs simulation slot (busy wallet)", () => {
  it("re-reads the pre-state at the simulation's slot: the 0.001 SOL transfer is not an unexpected outflow", async () => {
    const calls = serve(solChain(busy, [100, 103], [103]));
    const { effects, risk, riskOf } = await analyze(transfer());

    expect(calls).toEqual([
      { method: "getMultipleAccounts", minContextSlot: undefined },
      { method: "simulateTransaction", minContextSlot: 100 },
      { method: "getMultipleAccounts", minContextSlot: 103 },
    ]);
    expect(effects.preStateConsistency).toEqual({ kind: "EXACT", laterSlot: null, concurrent: [] });
    expect(effects.preStateSlot).toBe(103);
    expect(effects.solChanges.find((c) => c.address === W)?.deltaLamports).toBe(String(-(SENT + FEE)));
    expect(codes(risk)).toContain("TX_SOL_OUTFLOW");
    expect(codes(risk)).not.toContain("TX_UNEXPECTED_SOL_OUTFLOW");
    expect(risk.level).toBe("MEDIUM");
    expect(risk.status).toBe("COMPLETE");

    // The comparison this replaces — the slot-100 snapshot against the slot-103 simulation — is the false HIGH.
    const old = diffSnapshots([W], [system(busy(100))], [system(busy(103) - SENT - FEE)]);
    const before = riskOf({ ...effects, preStateSlot: 100, preStateConsistency: undefined, solChanges: old.solChanges });
    expect(codes(before)).toContain("TX_UNEXPECTED_SOL_OUTFLOW");
    expect(before.level).toBe("HIGH");
  });

  it("when the slots never line up, no false HIGH: the uncertainty is reported and the analysis is PARTIAL, not SAFE", async () => {
    const calls = serve(solChain(busy, [100, 105, 109], [103, 107]));
    const { effects, risk } = await analyze(transfer());

    // Concurrent change seen → one more simulation from the later snapshot; the second bracket is kept.
    expect(calls.map((c) => [c.method, c.minContextSlot])).toEqual([
      ["getMultipleAccounts", undefined], ["simulateTransaction", 100], ["getMultipleAccounts", 103],
      ["simulateTransaction", 105], ["getMultipleAccounts", 107],
    ]);
    expect(effects.preStateSlot).toBe(105);
    expect(effects.slot).toBe(107);
    expect(effects.preStateConsistency).toMatchObject({ kind: "BRACKETED", laterSlot: 109, concurrent: [{ address: W, lamports: { pre: String(busy(105)), later: String(busy(109)) } }] });
    expect(effects.notes.join(" ")).toMatch(/changed by other transactions/);

    expect(codes(risk)).not.toContain("TX_UNEXPECTED_SOL_OUTFLOW");
    expect(codes(risk)).toEqual(expect.arrayContaining(["TX_SOL_OUTFLOW", "TX_SOL_CHANGE_UNCERTAIN"]));
    expect(risk.level).toBe("MEDIUM");
    expect(risk.status).toBe("PARTIAL");
    const outflow = risk.evidence.find((e) => e.label === "Net SOL leaving your wallet");
    expect(outflow?.observed).toMatch(/^0\.001 SOL → /);
  });

  it("a real hidden outflow from the same busy wallet is still caught", async () => {
    serve(solChain(busy, [100, 105, 109], [103, 107], 2n * SOL));
    const { risk } = await analyze(transfer(), drainer(ATTACKER));
    expect(codes(risk)).toContain("TX_UNEXPECTED_SOL_OUTFLOW");
    expect(risk.level).toBe("HIGH");
    expect(risk.status).toBe("PARTIAL");
    // Reported as what persists against both snapshots: 2.001 SOL minus the 0.1 SOL others took meanwhile.
    expect(risk.evidence.find((e) => e.label === "Net SOL leaving your wallet")?.observed).toMatch(/^1\.901 SOL → /);
  });

  it("a quiet wallet: differing slots are confirmed by the second snapshot, analysis stays COMPLETE", async () => {
    const calls = serve(solChain(quiet, [100, 104], [102]));
    const { effects, risk } = await analyze(transfer());
    expect(calls.filter((c) => c.method === "simulateTransaction")).toHaveLength(1);
    expect(effects.preStateConsistency).toEqual({ kind: "BRACKETED", laterSlot: 104, concurrent: [] });
    expect(codes(risk)).toEqual(["TX_SOL_OUTFLOW"]);
    expect(risk.status).toBe("COMPLETE");
  });

  it("a quiet wallet with a hidden outflow is HIGH", async () => {
    serve(solChain(quiet, [100, 104], [102], 2n * SOL));
    const { risk } = await analyze(transfer(), drainer(ATTACKER));
    expect(codes(risk)).toContain("TX_UNEXPECTED_SOL_OUTFLOW");
    expect(codes(risk)).not.toContain("TX_SOL_CHANGE_UNCERTAIN");
    expect(risk.level).toBe("HIGH");
    expect(risk.evidence.find((e) => e.label === "Net SOL leaving your wallet")?.observed).toMatch(/^2\.001 SOL → /);
  });

  it("if no snapshot can be taken after the simulation, the signal is kept and the analysis is PARTIAL (fail closed)", async () => {
    serve(solChain(busy, [100], [103]));
    const { effects, risk } = await analyze(transfer());
    expect(effects.preStateConsistency?.kind).toBe("UNVERIFIED");
    expect(effects.notes.join(" ")).toMatch(/could not be confirmed at the simulation slot/);
    expect(codes(risk)).toContain("TX_UNEXPECTED_SOL_OUTFLOW");
    expect(risk.status).toBe("PARTIAL");
  });
});

describe("pre-state snapshot vs simulation slot (busy token account)", () => {
  // Other transactions take 1,000 raw tokens per slot from the wallet's token account; the transaction under
  // analysis only passes it to an unidentified program, which may or may not take tokens itself.
  const amount = (slot: number) => 1_000_000n - BigInt(slot - 100) * 1_000n;
  const tokenChain = (hidden: bigint): Chain => ({
    snapshots: [100, 105, 109],
    simulations: [103, 107],
    state: (a, slot) => (a === W ? system(quiet()) : a === ATA ? parsedTokenAccount({ owner: W, amount: String(amount(slot)) }) : null),
    apply: (a, slot) => (a === W ? system(quiet() - FEE) : a === ATA ? parsedTokenAccount({ owner: W, amount: String(amount(slot) - hidden) }) : null),
  });

  it("no false 'unexpected token outflow' from others' activity; the uncertainty is reported", async () => {
    serve(tokenChain(0n));
    const { risk } = await analyze(drainer(WALLET_ATA));
    expect(codes(risk).some((c) => c.startsWith("TX_UNEXPECTED_TOKEN_OUTFLOW"))).toBe(false);
    expect(codes(risk).some((c) => c.startsWith("TX_TOKEN_CHANGE_UNCERTAIN"))).toBe(true);
    expect(risk.status).toBe("PARTIAL");
    expect(risk.level).not.toBe("SAFE");
  });

  it("a real hidden token drain is still caught", async () => {
    serve(tokenChain(500_000n));
    const { risk } = await analyze(drainer(WALLET_ATA));
    expect(codes(risk).some((c) => c.startsWith("TX_UNEXPECTED_TOKEN_OUTFLOW"))).toBe(true);
    expect(risk.level).toBe("HIGH");
  });
});
