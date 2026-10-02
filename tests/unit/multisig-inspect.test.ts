import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as inspectRoute } from "@/app/api/multisig/inspect/route";
import { resetRateLimits } from "@/lib/api/rate-limit";
import { clearIdlCache } from "@/lib/anchor/source";
import { parseInspectInput } from "@/lib/multisig/input";
import { inspect } from "@/lib/multisig/inspect";
import { foreignSignersOf, promoteLookupPrograms, withFeePayer } from "@/lib/multisig/payload";
import { rpcCall } from "@/lib/solana/client";
import { SQUADS_V4_PROGRAM_ID } from "@/lib/squads/constants";
import { toVersionedTransaction } from "@/lib/squads/decode";
import type { SquadsMessage } from "@/lib/squads/types";
import { batchTransactionPda, ephemeralSignerPda, proposalPda, transactionPda, vaultPda } from "@/lib/squads/pda";
import { decodeTransaction } from "@/lib/transaction/decoder";
import { simulateTransaction, type SimulationOutput } from "@/lib/transaction/simulate";
import { key } from "../helpers/fixtures";
import { accountInfoValue, batchAccountBytes, DEFAULT_PUBKEY, multisigAccountBytes, proposalAccountBytes, vaultBatchTransactionBytes, vaultSolTransfer, vaultTransactionBytes, type ChainAccount } from "../helpers/squads";

vi.mock("@/lib/solana/client", async (importOriginal) => ({ ...(await importOriginal<object>()), rpcCall: vi.fn() }));
vi.mock("@/lib/transaction/simulate", async (importOriginal) => ({ ...(await importOriginal<object>()), simulateTransaction: vi.fn() }));
const rpc = vi.mocked(rpcCall);
const simulate = vi.mocked(simulateTransaction);

const MS = key(40).toBase58();
const M1 = key(41).toBase58();
const M2 = key(42).toBase58();
const M3 = key(43).toBase58();
const OUTSIDER = key(44).toBase58();
const VAULT = vaultPda(MS, 0);
const SOL = 1_000_000_000n;

function serve(accounts: Map<string, ChainAccount>) {
  rpc.mockImplementation((async (method: string, params: unknown[]) => {
    const ok = (result: unknown) => ({ result, source: "HELIUS_RPC", fallbackUsed: false });
    if (method === "getAccountInfo") return ok({ context: { slot: 1 }, value: accountInfoValue(accounts.get(params[0] as string)) });
    if (method === "getMultipleAccounts") return ok({ context: { slot: 1 }, value: (params[0] as string[]).map((a) => accountInfoValue(accounts.get(a))) });
    throw new Error(`unexpected rpc ${method}`);
  }) as unknown as typeof rpcCall);
}

function chain(opts: { threshold?: number; timeLock?: number; status?: number; approved?: string[]; message?: ReturnType<typeof vaultSolTransfer> } = {}) {
  const accounts = new Map<string, ChainAccount>();
  accounts.set(MS, { data: multisigAccountBytes({ members: [M1, M2, M3], threshold: opts.threshold ?? 2, timeLock: opts.timeLock ?? 0, transactionIndex: 3n }), owner: SQUADS_V4_PROGRAM_ID });
  accounts.set(proposalPda(MS, 3n), { data: proposalAccountBytes(MS, 3n, opts.status ?? 1, opts.approved ?? [M1]), owner: SQUADS_V4_PROGRAM_ID });
  accounts.set(transactionPda(MS, 3n), { data: vaultTransactionBytes(MS, M1, 3n, 0, opts.message ?? vaultSolTransfer(VAULT, OUTSIDER, 100n * SOL)), owner: SQUADS_V4_PROGRAM_ID });
  accounts.set(proposalPda(MS, 2n), { data: proposalAccountBytes(MS, 2n, 5, [M1, M2]), owner: SQUADS_V4_PROGRAM_ID });
  return accounts;
}

/** Simulation where the vault loses 100 of its 100.5 SOL. */
function simulatedDrain(): SimulationOutput {
  return {
    effects: { source: "SIMULATION", success: true, error: null, logs: [], logsTruncated: false, unitsConsumed: 150, slot: 10, preStateSlot: 10, stale: false, blockhashValid: null, feeLamports: "5000", solChanges: [{ address: VAULT, preLamports: String(100_500_000_000n), postLamports: String(500_000_000n), deltaLamports: String(-100n * SOL) }], tokenChanges: [], accountChanges: [], notes: [] },
    tokenAccountOwners: {},
    tokenAccountMints: {},
    innerInstructions: null,
  };
}

beforeEach(() => {
  rpc.mockReset();
  simulate.mockReset();
  clearIdlCache();
  resetRateLimits();
});

describe("inspect input parsing", () => {
  it("accepts a bare address, '<multisig> #<index>' and Squads links", () => {
    expect(parseInspectInput(MS)).toEqual({ kind: "ok", addresses: [MS], index: null });
    expect(parseInspectInput(`${MS} #7`)).toEqual({ kind: "ok", addresses: [MS], index: "7" });
    expect(parseInspectInput(`https://app.squads.so/squads/${MS}/transactions/${transactionPda(MS, 3n)}`)).toEqual({ kind: "ok", addresses: [MS, transactionPda(MS, 3n)], index: null });
    expect(parseInspectInput(`https://app.squads.so/squads/${MS}/tx/12?x=1`)).toMatchObject({ kind: "ok", index: "12" });
  });

  it("rejects text without an address, proposal #0 and oversized input", () => {
    expect(parseInspectInput("hello world").kind).toBe("invalid");
    expect(parseInspectInput(`${MS} #0`).kind).toBe("invalid");
    expect(parseInspectInput("x".repeat(600)).kind).toBe("invalid");
    expect(parseInspectInput("https://%%%").kind).toBe("invalid");
  });
});

describe("vault payload helpers", () => {
  it("prepending a fee payer shifts every index and keeps instructions intact", () => {
    const m = vaultSolTransfer(VAULT, OUTSIDER, 5n);
    const sim = decodeTransaction(toVersionedTransaction(withFeePayer(m, M1)));
    expect(sim.feePayer).toBe(M1);
    expect(sim.signers).toEqual([M1, VAULT]);
    expect(sim.solTransfers).toEqual([{ instruction: 0, from: VAULT, to: OUTSIDER, lamports: "5" }]);
    expect(() => withFeePayer(m, VAULT)).toThrow(/already/);
  });

  it("flags required signers the multisig cannot sign for", () => {
    const tx = transactionPda(MS, 3n);
    const m = { ...vaultSolTransfer(VAULT, OUTSIDER, 5n), numSigners: 3, numWritableSigners: 3, accountKeys: [VAULT, ephemeralSignerPda(tx, 0), OUTSIDER, DEFAULT_PUBKEY], numWritableNonSigners: 0 };
    expect(foreignSignersOf(m, VAULT, tx, 1)).toEqual([OUTSIDER]);
    expect(foreignSignersOf(m, VAULT, tx, 0)).toEqual([ephemeralSignerPda(tx, 0), OUTSIDER]);
  });
});

describe("proposal inspection", () => {
  it("a treasury drain is CRITICAL from the vault's simulated balance, with the executing member paying the fee", async () => {
    serve(chain());
    simulate.mockResolvedValue(simulatedDrain());
    const r = await inspect(proposalPda(MS, 3n));
    expect(r.kind).toBe("proposal");
    if (r.kind !== "proposal") return;
    const i = r.inspection;
    expect(i).toMatchObject({ multisig: MS, transactionIndex: "3", transactionKind: "vault", stale: false });
    expect(i.risk.level).toBe("CRITICAL");
    const codes = i.risk.signals.map((s) => s.code);
    expect(codes).toContain(`VAULT_TX_SOL_DRAIN:${transactionPda(MS, 3n)}`);
    expect(codes).toContain("MS_NO_TIME_LOCK");
    expect(codes.some((c) => c.startsWith("MS_VAULT_OUTFLOW"))).toBe(false);
    const simulated = simulate.mock.calls[0][0] as VersionedTransaction;
    expect(simulated.message.staticAccountKeys[0].toBase58()).toBe(M1);
    expect(i.analysis.payloads[0].simulatedFeePayer).toBe(M1);
  });

  it("the same proposal resolves from the multisig + index, the transaction address or a Squads link", async () => {
    serve(chain());
    simulate.mockResolvedValue(simulatedDrain());
    for (const input of [`${MS} #3`, transactionPda(MS, 3n), `https://app.squads.so/squads/${MS}/transactions/${transactionPda(MS, 3n)}`]) {
      const r = await inspect(input);
      expect(r.kind === "proposal" && r.inspection.transactionIndex).toBe("3");
    }
  });

  it("without a simulation the verdict falls back to decoded transfers and is not COMPLETE", async () => {
    serve(chain());
    simulate.mockRejectedValue(Object.assign(new Error("x"), { name: "AppError" }));
    const r = await inspect(`${MS} #3`);
    if (r.kind !== "proposal") throw new Error("expected proposal");
    expect(r.inspection.risk.signals.map((s) => s.code)).toContain(`MS_VAULT_OUTFLOW:${transactionPda(MS, 3n)}`);
    expect(r.inspection.risk.status).not.toBe("COMPLETE");
    expect(r.inspection.analysis.payloads[0].simulationNote).toMatch(/Not simulated/);
  });

  it("a proposal whose program id comes from a lookup table is simulated with that id listed directly", async () => {
    const table = key(45).toBase58();
    const m = { ...vaultSolTransfer(VAULT, OUTSIDER, 5n), accountKeys: [VAULT, OUTSIDER], instructions: [{ programIdIndex: 2, accountIndexes: [0, 1], data: vaultSolTransfer(VAULT, OUTSIDER, 5n).instructions[0].data }], addressTableLookups: [{ accountKey: table, writableIndexes: [], readonlyIndexes: [0] }] };
    const accounts = chain({ message: m });
    // Minimal address lookup table holding the System program at index 0.
    const lut = new Uint8Array(56 + 32);
    new DataView(lut.buffer).setUint32(0, 1, true);
    new DataView(lut.buffer).setBigUint64(4, 2n ** 64n - 1n, true);
    lut.set(new PublicKey(DEFAULT_PUBKEY).toBytes(), 56);
    accounts.set(table, { data: lut, owner: "AddressLookupTab1e1111111111111111111111111" });
    serve(accounts);
    const r = await inspect(`${MS} #3`);
    if (r.kind !== "proposal") throw new Error("expected proposal");
    const p = r.inspection.analysis.payloads[0];
    expect(p.decoded!.instructions[0].type).toBe("system:transfer");
    // A regular transaction cannot invoke a program loaded from a lookup table; the simulated one lists it statically.
    expect(simulate).toHaveBeenCalledTimes(1);
    const [simTx, simDecoded] = simulate.mock.calls[0];
    expect(simTx.message.staticAccountKeys.map((k) => k.toBase58())).toEqual([M1, VAULT, OUTSIDER, DEFAULT_PUBKEY]);
    expect(simTx.message.addressTableLookups).toEqual([{ accountKey: new PublicKey(table), writableIndexes: [], readonlyIndexes: [] }]);
    expect(simDecoded.solTransfers).toEqual([{ instruction: 0, from: VAULT, to: OUTSIDER, lamports: "5" }]);
  });

  it("listing lookup-table program ids statically keeps every instruction's program and accounts", () => {
    const [S1, S2, W1, R1, R2, R3] = [key(60), key(61), key(62), key(63), key(64), key(65)].map((k) => k.toBase58());
    const table = key(66).toBase58();
    // Static: vault (signer), S1, S2. Lookups: writable W1; read-only R1 (a program), R2, R3 (another program).
    const m = {
      numSigners: 1, numWritableSigners: 1, numWritableNonSigners: 1,
      accountKeys: [VAULT, S1, S2],
      instructions: [
        { programIdIndex: 4, accountIndexes: [0, 3, 5, 4], data: Uint8Array.from([1]) },
        { programIdIndex: 6, accountIndexes: [1, 2, 6, 3], data: Uint8Array.from([2]) },
      ],
      addressTableLookups: [{ accountKey: table, writableIndexes: [7], readonlyIndexes: [8, 9, 10] }],
    };
    const lookups = { writable: [W1], readonly: [R1, R2, R3] };
    const resolve = (msg: SquadsMessage, l: typeof lookups) => {
      const all = [...msg.accountKeys, ...l.writable, ...l.readonly];
      return msg.instructions.map((ix) => ({ program: all[ix.programIdIndex], accounts: ix.accountIndexes.map((i) => all[i]) }));
    };
    const p = promoteLookupPrograms(m, lookups)!;
    expect(p.message.accountKeys).toEqual([VAULT, S1, S2, R1, R3]);
    expect(p.lookups).toEqual({ writable: [W1], readonly: [R2] });
    expect(p.message.addressTableLookups).toEqual([{ accountKey: table, writableIndexes: [7], readonlyIndexes: [9] }]);
    expect(resolve(p.message, p.lookups)).toEqual(resolve(m, lookups));
    expect(p.message.instructions.every((ix) => ix.programIdIndex < p.message.accountKeys.length)).toBe(true);
    // A program id from a writable lookup is left alone (not simulated).
    expect(promoteLookupPrograms({ ...m, instructions: [{ programIdIndex: 3, accountIndexes: [0], data: Uint8Array.from([1]) }] }, lookups)).toBeNull();
  });

  it("a batch proposal inspects each of its transactions; a missing one is unverified, not ignored", async () => {
    const accounts = chain();
    accounts.set(transactionPda(MS, 3n), { data: batchAccountBytes(MS, M1, 3n, 0, 3), owner: SQUADS_V4_PROGRAM_ID });
    accounts.set(batchTransactionPda(MS, 3n, 1), { data: vaultBatchTransactionBytes(vaultSolTransfer(VAULT, M2, 1n)), owner: SQUADS_V4_PROGRAM_ID });
    accounts.set(batchTransactionPda(MS, 3n, 2), { data: vaultBatchTransactionBytes(vaultSolTransfer(VAULT, OUTSIDER, 7n)), owner: SQUADS_V4_PROGRAM_ID });
    serve(accounts);
    simulate.mockRejectedValue(new Error("no simulation"));
    const r = await inspect(`${MS} #3`);
    if (r.kind !== "proposal") throw new Error("expected proposal");
    expect(r.inspection.transactionKind).toBe("batch");
    const payloads = r.inspection.analysis.payloads;
    expect(payloads.map((p) => [p.transactionIndex, p.status])).toEqual([["3.1", "DECODED"], ["3.2", "DECODED"], ["3.3", "UNAVAILABLE"]]);
    expect(payloads[1].decoded!.solTransfers[0]).toMatchObject({ from: VAULT, to: OUTSIDER, lamports: "7" });
    expect(r.inspection.risk.signals.map((s) => s.code)).toContain(`MS_PAYLOAD_UNVERIFIED:${batchTransactionPda(MS, 3n, 3)}`);
  });

  it("explains a non-Squads address instead of guessing", async () => {
    const accounts = new Map<string, ChainAccount>([[OUTSIDER, { data: new Uint8Array(0), owner: DEFAULT_PUBKEY }]]);
    serve(accounts);
    await expect(inspect(OUTSIDER)).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND", message: expect.stringContaining("paste the multisig address") });
  });
});

describe("program upgrade proposals", () => {
  const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
  const code = Uint8Array.from([1, 2, 3, 4, 5, 0, 0]);
  const bufferData = Uint8Array.from([...new Array(37).fill(9), ...code, 0, 0, 0]);
  const expectedHash = createHash("sha256").update(Uint8Array.from([1, 2, 3, 4, 5])).digest("hex");

  function upgradeChain(program: string, buffer: string, withBuffer = true) {
    const m: SquadsMessage = {
      numSigners: 1,
      numWritableSigners: 1,
      numWritableNonSigners: 4,
      accountKeys: [VAULT, key(60).toBase58(), program, buffer, OUTSIDER, "SysvarRent111111111111111111111111111111111", "SysvarC1ock11111111111111111111111111111111", LOADER],
      instructions: [{ programIdIndex: 7, accountIndexes: [1, 2, 3, 4, 5, 6, 0], data: Uint8Array.from([3, 0, 0, 0]) }],
      addressTableLookups: [],
    };
    const accounts = chain({ message: m });
    if (withBuffer) accounts.set(buffer, { data: bufferData, owner: LOADER });
    return accounts;
  }

  function registry(body: object) {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
  }

  afterEach(() => vi.unstubAllGlobals());

  it("new code that is exactly the registry's verified build is reported as such", async () => {
    const program = key(61).toBase58();
    serve(upgradeChain(program, key(62).toBase58()));
    registry({ is_verified: true, on_chain_hash: "old", executable_hash: expectedHash, repo_url: "https://github.com/acme/protocol", commit: "abc" });
    const r = await inspect(`${MS} #3`);
    if (r.kind !== "proposal") throw new Error("expected proposal");
    expect(r.inspection.analysis.payloads[0].upgrades![0]).toMatchObject({ program, bufferHash: expectedHash, matchesVerifiedBuild: true });
    const codes = r.inspection.risk.signals.map((s) => s.code);
    expect(codes).toContain(`UPGRADE_MATCHES_VERIFIED_BUILD:${program}:0`);
    expect(codes.some((c) => c.startsWith("MS_PROGRAM_UPGRADE"))).toBe(true);
  });

  it("new code matching no verified build asks the signer to compare hashes", async () => {
    const program = key(63).toBase58();
    serve(upgradeChain(program, key(64).toBase58()));
    registry({ is_verified: false, on_chain_hash: "old", executable_hash: "", repo_url: null });
    const r = await inspect(`${MS} #3`);
    if (r.kind !== "proposal") throw new Error("expected proposal");
    const s = r.inspection.risk.signals.find((x) => x.code === `UPGRADE_UNVERIFIED_CODE:${program}:0`)!;
    expect(s.severity).toBe("MEDIUM");
    expect(s.description).toContain(expectedHash.slice(0, 16));
    expect(r.inspection.brief!.payloads[0].upgrades[0]).toContain(expectedHash);
  });

  it("an unreadable buffer is HIGH, not silently skipped", async () => {
    const program = key(65).toBase58();
    serve(upgradeChain(program, key(66).toBase58(), false));
    registry({ is_verified: true, executable_hash: expectedHash });
    const r = await inspect(`${MS} #3`);
    if (r.kind !== "proposal") throw new Error("expected proposal");
    expect(r.inspection.risk.signals.find((x) => x.code === `UPGRADE_CODE_UNAVAILABLE:${program}:0`)).toMatchObject({ severity: "HIGH" });
  });
});

describe("multisig overview", () => {
  it("lists recent proposals, fully inspects pending ones and rates the setup", async () => {
    serve(chain({ threshold: 1 }));
    simulate.mockResolvedValue(simulatedDrain());
    const r = await inspect(MS);
    if (r.kind !== "multisig") throw new Error("expected overview");
    const o = r.overview;
    expect(o.proposals.map((p) => [p.transactionIndex, p.status])).toEqual([["3", "Active"], ["2", "Executed"], ["1", "NOT_FOUND"]]);
    expect(o.proposals[0]).toMatchObject({ approvals: 1, verdict: "CRITICAL" });
    expect(o.proposals[1].verdict).toBeNull();
    expect(o.posture.signals.map((s) => s.code)).toEqual(expect.arrayContaining(["POSTURE_SINGLE_SIGNATURE", "POSTURE_NO_TIME_LOCK"]));
    expect(o.vaults[0]).toBe(VAULT);
  });

  it("a well-configured multisig has no posture signals and is rated from complete data", async () => {
    serve(chain({ threshold: 2, timeLock: 86_400, status: 5 }));
    const r = await inspect(MS);
    if (r.kind !== "multisig") throw new Error("expected overview");
    expect(r.overview.posture).toMatchObject({ level: "SAFE", status: "COMPLETE", signals: [] });
  });
});

describe("POST /api/multisig/inspect", () => {
  const call = (body: unknown) => inspectRoute(new Request("http://localhost/api/multisig/inspect", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));

  it("validates input and returns safe errors", async () => {
    expect((await call({})).status).toBe(400);
    expect((await call({ input: "no address here" })).status).toBe(400);
    expect((await call({ input: MS, signer: "not-a-key" })).status).toBe(400);
  });

  it("returns 404 for an unknown multisig", async () => {
    serve(new Map());
    const res = await call({ input: MS });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(JSON.stringify(json)).not.toMatch(/helius|api-key|stack/i);
  });
});
