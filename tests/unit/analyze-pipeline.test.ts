import { SystemProgram } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/api/errors";
import { SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@/lib/solana/constants";
import { analyzeTransaction } from "@/lib/transaction/analyze";
import { U64_MAX } from "@/lib/transaction/decoder";
import { resolveLookupTables, simulateTransaction, type SimulationOutput } from "@/lib/transaction/simulate";
import type { TransactionEffects } from "@/lib/transaction/types";
import { messageHashOfTx } from "@/lib/wallet/signing";
import { ATTACKER, buildTx, MINT, WALLET, WALLET_ATA } from "../helpers/fixtures";

// Full input → decode → simulate → CPI → risk pipeline; only the simulation RPC edge is mocked.
vi.mock("@/lib/transaction/simulate", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  simulateTransaction: vi.fn(),
  resolveLookupTables: vi.fn(),
}));

const simulate = vi.mocked(simulateTransaction);
const lookups = vi.mocked(resolveLookupTables);

const W = WALLET.toBase58();
const A = ATTACKER.toBase58();

function effects(overrides: Partial<TransactionEffects> = {}): TransactionEffects {
  return {
    source: "SIMULATION", success: true, error: null, logs: [], logsTruncated: false, unitsConsumed: 1_000,
    slot: 101, preStateSlot: 100, stale: false, blockhashValid: true, feeLamports: "5000",
    solChanges: [], tokenChanges: [], accountChanges: [], notes: [], ...overrides,
  };
}

function sim(e: TransactionEffects, extra: Partial<SimulationOutput> = {}) {
  simulate.mockResolvedValue({ effects: e, tokenAccountOwners: {}, tokenAccountMints: {}, innerInstructions: null, ...extra });
}

const tiny = () => buildTx([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 1 })]);

beforeEach(() => {
  simulate.mockReset();
  lookups.mockReset();
  lookups.mockResolvedValue(null);
});

describe("analyzeTransaction pipeline", () => {
  it("rejects invalid input as INVALID_TRANSACTION without simulating", async () => {
    const e = await analyzeTransaction("definitely not a tx").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).code).toBe("INVALID_TRANSACTION");
    expect(simulate).not.toHaveBeenCalled();
  });

  it("hashes the exact analyzed bytes and uses the fee payer as perspective by default", async () => {
    const { base64, bytes } = tiny();
    sim(effects({ solChanges: [{ address: W, preLamports: "10000000", postLamports: "9994999", deltaLamports: "-5001" }] }));
    const r = await analyzeTransaction(base64);
    expect(r.messageHash).toBe(await messageHashOfTx(bytes));
    expect(r.perspectiveWallet).toBe(W);
    expect(r.perspectiveSource).toBe("fee-payer");
    expect(r.signature).toBeNull();
    expect(r.demo).toBe(false);
    expect(r.effectsStatus).toBe("COMPLETE");
  });

  it("passes a provided wallet into the simulation snapshot and risk perspective", async () => {
    sim(effects());
    const r = await analyzeTransaction(tiny().base64, A);
    expect(r.perspectiveWallet).toBe(A);
    expect(r.perspectiveSource).toBe("provided");
    expect(simulate.mock.calls[0][2]).toEqual([A]);
  });

  it("a simulation that cannot run yields INSUFFICIENT_DATA — never SAFE", async () => {
    simulate.mockRejectedValue(new AppError("SIMULATION_FAILED", "Transaction simulation could not be performed."));
    const r = await analyzeTransaction(tiny().base64);
    expect(r.effects).toBeNull();
    expect(r.effectsStatus).toBe("INSUFFICIENT_DATA");
    expect(r.risk.level).not.toBe("SAFE");
    expect(r.risk.status).not.toBe("COMPLETE");
  });

  it("other errors during simulation are not swallowed", async () => {
    simulate.mockRejectedValue(new AppError("RPC_ERROR", "upstream"));
    await expect(analyzeTransaction(tiny().base64)).rejects.toMatchObject({ code: "RPC_ERROR" });
  });

  it("a stale simulation downgrades the analysis to PARTIAL", async () => {
    sim(effects({ stale: true }));
    const r = await analyzeTransaction(tiny().base64);
    expect(r.effectsStatus).toBe("PARTIAL");
    expect(r.risk.level).not.toBe("SAFE");
  });

  it("applies simulated CPI effects and fills token transfer mints from the pre-state", async () => {
    sim(effects(), {
      innerInstructions: [{ index: 0, instructions: [
        { program: "spl-token", programId: TOKEN_PROGRAM_ID, parsed: { type: "approve", info: { source: WALLET_ATA.toBase58(), delegate: A, owner: W, amount: U64_MAX.toString() } } },
        { program: "spl-token", programId: TOKEN_PROGRAM_ID, parsed: { type: "transfer", info: { source: WALLET_ATA.toBase58(), destination: A, authority: W, amount: "10" } } },
        { program: "system", programId: SYSTEM_PROGRAM_ID, parsed: { type: "transfer", info: { source: W, destination: A, lamports: 3 } } },
      ] }],
      tokenAccountMints: { [WALLET_ATA.toBase58()]: { mint: MINT.toBase58(), decimals: 6 } },
    });
    const r = await analyzeTransaction(tiny().base64);
    expect(r.decoded.innerInstructionsSource).toBe("SIMULATION");
    expect(r.decoded.innerInstructions).toHaveLength(3);
    expect(r.decoded.tokenTransfers.find((t) => t.cpi)).toMatchObject({ mint: MINT.toBase58(), decimals: 6 });
    expect(r.risk.signals.map((s) => s.code)).toContain("TX_UNLIMITED_APPROVAL");
    expect(r.risk.level).toBe("CRITICAL");
  });

  it("a successful simulation alone never makes a transaction SAFE when it moves SOL out", async () => {
    sim(effects({ solChanges: [
      { address: W, preLamports: "2000000000", postLamports: "999995000", deltaLamports: "-1000005000" },
      { address: A, preLamports: "0", postLamports: "1000000000", deltaLamports: "1000000000" },
    ] }));
    const big = buildTx([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 1_000_000_000 })]);
    const r = await analyzeTransaction(big.base64);
    expect(r.risk.level).not.toBe("SAFE");
    expect(r.risk.signals.map((s) => s.code)).toContain("TX_SOL_OUTFLOW");
  });
});
