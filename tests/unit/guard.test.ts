import { createHash } from "node:crypto";
import { PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearIdlCache } from "@/lib/anchor/source";
import { decodeActionAccount, decodeGuardAccount, decodeGuardInstruction, executeInstruction, scheduleInstruction, vetoInstruction, type GuardInstructionData } from "@/lib/guard/codec";
import { clearGuardHolderCache } from "@/lib/guard/holders";
import { removesOnlyGuardian } from "@/lib/guard/prepare";
import { actionPda, GUARD_ACCOUNT_DISCRIMINATOR, GUARD_IX_DISCRIMINATOR, guardPda, guardSignerPda } from "@/lib/guard/constants";
import { inspect } from "@/lib/multisig/inspect";
import { rpcCall } from "@/lib/solana/client";
import { TOKEN_PROGRAM_ID } from "@/lib/solana/constants";
import { SQUADS_V4_PROGRAM_ID } from "@/lib/squads/constants";
import { transactionPda, vaultPda, proposalPda } from "@/lib/squads/pda";
import type { SquadsMessage } from "@/lib/squads/types";
import { decodeTransaction } from "@/lib/transaction/decoder";
import { simulateTransaction } from "@/lib/transaction/simulate";
import { buildTx, key } from "../helpers/fixtures";
import { accountInfoValue, multisigAccountBytes, proposalAccountBytes, vaultTransactionBytes, W, type ChainAccount } from "../helpers/squads";

vi.mock("@/lib/solana/client", async (importOriginal) => ({ ...(await importOriginal<object>()), rpcCall: vi.fn() }));
vi.mock("@/lib/transaction/simulate", async (importOriginal) => ({ ...(await importOriginal<object>()), simulateTransaction: vi.fn() }));
const rpc = vi.mocked(rpcCall);
const simulate = vi.mocked(simulateTransaction);

const PROGRAM = key(90).toBase58();
const CREATE_KEY = key(91).toBase58();
const MS = key(40).toBase58();
const [M1, M2, M3] = [key(41), key(42), key(43)].map((k) => k.toBase58());
const OUTSIDER = key(44).toBase58();
const MINT = key(45).toBase58();
const VAULT = vaultPda(MS, 0);
let GUARD: string;
let SIGNER: string;

const sha8 = (s: string) => createHash("sha256").update(s).digest().subarray(0, 8).toString("hex");

/** SPL Token SetAuthority(MintTokens → newAuthority), signed by the guard signer. */
function setMintAuthority(newAuthority: string): GuardInstructionData {
  return {
    programId: TOKEN_PROGRAM_ID,
    accounts: [{ pubkey: MINT, isSigner: false, isWritable: true }, { pubkey: SIGNER, isSigner: true, isWritable: false }],
    data: Uint8Array.from([6, 0, 1, ...new PublicKey(newAuthority).toBytes()]),
  };
}

function guardBytes(opts: { guardians?: string[]; delay?: number; actionCount?: bigint } = {}) {
  const guardians = opts.guardians ?? [M1, M2, M3];
  const w = new W().hex(GUARD_ACCOUNT_DISCRIMINATOR.Guard).key(CREATE_KEY).key(VAULT).u32(guardians.length);
  guardians.forEach((g) => w.key(g));
  return w.u32(opts.delay ?? 86_400).u64(opts.actionCount ?? 1n).u8(255).u8(254).done();
}

function actionBytes(opts: { status?: number; eta: bigint; instructions: GuardInstructionData[] }) {
  const memo = new TextEncoder().encode("rotate mint authority");
  const w = new W().hex(GUARD_ACCOUNT_DISCRIMINATOR.Action).key(GUARD).u64(0n).key(VAULT).key(VAULT).u64(1_700_000_000n).u64(opts.eta).u8(opts.status ?? 0).u8(0).u64(0n).bytes(memo).u32(opts.instructions.length);
  for (const ix of opts.instructions) {
    w.key(ix.programId).u32(ix.accounts.length);
    ix.accounts.forEach((a) => w.key(a.pubkey).u8(a.isSigner ? 1 : 0).u8(a.isWritable ? 1 : 0));
    w.bytes(ix.data);
  }
  return w.u8(255).done();
}

/** A Squads vault message whose one instruction is guard.schedule(...). */
function scheduleMessage(instructions: GuardInstructionData[]): SquadsMessage {
  const action = actionPda(PROGRAM, GUARD, 0);
  const ix = scheduleInstruction(PROGRAM, { guard: GUARD, action, proposer: VAULT, payer: VAULT, instructions, memo: "rotate mint authority" });
  const keys = [VAULT, GUARD, action, SystemProgram.programId.toBase58(), PROGRAM];
  return { numSigners: 1, numWritableSigners: 1, numWritableNonSigners: 2, accountKeys: keys, instructions: [{ programIdIndex: 4, accountIndexes: [1, 2, 0, 0, 3], data: Uint8Array.from(ix.data) }], addressTableLookups: [] };
}

function serve(accounts: Map<string, ChainAccount>) {
  rpc.mockImplementation((async (method: string, params: unknown[]) => {
    const ok = (result: unknown) => ({ result, source: "HELIUS_RPC", fallbackUsed: false });
    if (method === "getAccountInfo") return ok({ context: { slot: 1 }, value: accountInfoValue(accounts.get(params[0] as string)) });
    if (method === "getMultipleAccounts") return ok({ context: { slot: 1 }, value: (params[0] as string[]).map((a) => accountInfoValue(accounts.get(a))) });
    throw new Error(`unexpected rpc ${method}`);
  }) as unknown as typeof rpcCall);
}

function chainWithProposal(opts: { guard?: boolean } = {}) {
  const accounts = new Map<string, ChainAccount>();
  accounts.set(MS, { data: multisigAccountBytes({ members: [M1, M2, M3], threshold: 2, timeLock: 0, transactionIndex: 3n }), owner: SQUADS_V4_PROGRAM_ID });
  accounts.set(proposalPda(MS, 3n), { data: proposalAccountBytes(MS, 3n, 1, [M1]), owner: SQUADS_V4_PROGRAM_ID });
  accounts.set(transactionPda(MS, 3n), { data: vaultTransactionBytes(MS, M1, 3n, 0, scheduleMessage([setMintAuthority(OUTSIDER)])), owner: SQUADS_V4_PROGRAM_ID });
  if (opts.guard !== false) accounts.set(GUARD, { data: guardBytes(), owner: PROGRAM });
  return accounts;
}

beforeAll(() => {
  process.env.NEXT_PUBLIC_GUARD_PROGRAM_ID = PROGRAM;
  GUARD = guardPda(PROGRAM, CREATE_KEY);
  SIGNER = guardSignerPda(PROGRAM, GUARD);
});

beforeEach(() => {
  rpc.mockReset();
  simulate.mockReset();
  simulate.mockRejectedValue(new Error("no simulation in test"));
  clearIdlCache();
  clearGuardHolderCache();
});

describe("Guard codec", () => {
  it("discriminators are Anchor's sha256 prefixes", () => {
    const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    for (const [name, disc] of Object.entries(GUARD_IX_DISCRIMINATOR)) expect(sha8(`global:${snake(name)}`), name).toBe(disc);
    for (const [name, disc] of Object.entries(GUARD_ACCOUNT_DISCRIMINATOR)) expect(sha8(`account:${name}`), name).toBe(disc);
  });

  it("decodes Guard and Action accounts field by field", () => {
    expect(decodeGuardAccount(guardBytes())).toEqual({ createKey: CREATE_KEY, proposer: VAULT, guardians: [M1, M2, M3], delaySeconds: 86_400, actionCount: "1", bump: 255, signerBump: 254 });
    const a = decodeActionAccount(actionBytes({ eta: 1_700_086_400n, instructions: [setMintAuthority(OUTSIDER)] }));
    expect(a).toMatchObject({ guard: GUARD, index: "0", status: "Pending", eta: "1700086400", vetoedBy: null, memo: "rotate mint authority" });
    expect(a.instructions[0].accounts[1]).toEqual({ pubkey: SIGNER, isSigner: true, isWritable: false });
  });

  it("schedule instructions round-trip through the encoder and decoder", () => {
    const ix = scheduleInstruction(PROGRAM, { guard: GUARD, action: actionPda(PROGRAM, GUARD, 0), proposer: VAULT, payer: VAULT, instructions: [setMintAuthority(OUTSIDER)], memo: "m" });
    const d = decodeGuardInstruction(Uint8Array.from(ix.data));
    expect(d).toMatchObject({ name: "schedule", memo: "m" });
    expect(d && d.name === "schedule" && Buffer.from(d.instructions[0].data).equals(Buffer.from(setMintAuthority(OUTSIDER).data))).toBe(true);
    expect(decodeGuardInstruction(Uint8Array.from(vetoInstruction(PROGRAM, { guard: GUARD, action: actionPda(PROGRAM, GUARD, 0), guardian: M1 }).data))).toEqual({ name: "veto" });
  });

  it("the transaction decoder names Guard instructions", () => {
    const tx = buildTx([vetoInstruction(PROGRAM, { guard: GUARD, action: actionPda(PROGRAM, GUARD, 0), guardian: M1 })], new PublicKey(M1));
    const d = decodeTransaction(VersionedTransaction.deserialize(tx.bytes));
    expect(d.instructions[0]).toMatchObject({ type: "guard:veto", programName: "Presign Guard", parsed: true });
    expect(d.instructions[0].accounts.map((a) => a.name)).toEqual(["guard", "action", "guardian"]);
  });

  it("execute passes every referenced account and program; the guard is writable only for config changes", () => {
    const action = { ...decodeActionAccount(actionBytes({ eta: 0n, instructions: [setMintAuthority(OUTSIDER)] })), address: actionPda(PROGRAM, GUARD, 0) };
    const ix = executeInstruction(PROGRAM, { guard: GUARD, action });
    const keys = ix.keys.map((k) => [k.pubkey.toBase58(), k.isWritable]);
    expect(keys.slice(0, 3)).toEqual([[GUARD, false], [action.address, true], [SIGNER, false]]);
    expect(keys).toContainEqual([MINT, true]);
    expect(keys).toContainEqual([TOKEN_PROGRAM_ID, false]);
    expect(ix.keys.some((k) => k.isSigner)).toBe(false);
  });

  it("execute marks the guard signer writable when a scheduled instruction spends from it", () => {
    const pay: GuardInstructionData = { programId: SystemProgram.programId.toBase58(), accounts: [{ pubkey: SIGNER, isSigner: true, isWritable: true }, { pubkey: OUTSIDER, isSigner: false, isWritable: true }], data: Uint8Array.from([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]) };
    const action = { ...decodeActionAccount(actionBytes({ eta: 0n, instructions: [pay] })), address: actionPda(PROGRAM, GUARD, 0) };
    const keys = executeInstruction(PROGRAM, { guard: GUARD, action }).keys.map((k) => [k.pubkey.toBase58(), k.isWritable]);
    expect(keys[2]).toEqual([SIGNER, true]);
    expect(keys.filter(([k]) => k === SIGNER)).toHaveLength(1);
  });
});

describe("a multisig proposal that schedules through Guard", () => {
  it("is analyzed with the guard's delay and veto: the authority change stays visible, one level lower", async () => {
    serve(chainWithProposal());
    const r = await inspect(`${MS} #3`);
    if (r.kind !== "proposal") throw new Error("expected proposal");
    const p = r.inspection.analysis.payloads[0];
    expect(p.scheduled).toHaveLength(1);
    expect(p.scheduled![0]).toMatchObject({ guard: GUARD, guardSigner: SIGNER, guardStatus: "OK", memo: "rotate mint authority" });
    expect(p.scheduled![0].privileged[0]).toMatchObject({ kind: "token-authority", newAuthority: OUTSIDER, control: "outside" });
    const byCode = new Map(r.inspection.risk.signals.map((s) => [s.code.split(":")[0], s]));
    expect(byCode.get("GUARD_SCHEDULED")).toMatchObject({ severity: "LOW" });
    expect(byCode.get("GUARD_MS_AUTHORITY_LEAVES_MULTISIG")).toMatchObject({ severity: "HIGH", title: "Scheduled: token authority moves outside the multisig" });
    expect(byCode.get("GUARD_MS_AUTHORITY_LEAVES_MULTISIG")!.description).toContain("any one of 3 guardian(s) can veto");

    const brief = r.inspection.brief!;
    expect(brief.payloads[0].scheduled[0]).toMatchObject({ verified: true, protection: "waits 1 day(s) after this proposal executes; any one of 3 guardian(s) can veto", memo: "rotate mint authority" });
    expect(brief.payloads[0].scheduled[0].steps[0].privileged).toMatchObject({ kind: "token-authority", control: "outside", newAuthority: OUTSIDER });
  });

  it("an unverifiable guard keeps the finding CRITICAL", async () => {
    serve(chainWithProposal({ guard: false }));
    const r = await inspect(`${MS} #3`);
    if (r.kind !== "proposal") throw new Error("expected proposal");
    const codes = r.inspection.risk.signals.map((s) => s.code);
    expect(codes).toContain(`GUARD_UNVERIFIED:${GUARD}`);
    expect(r.inspection.risk.signals.find((s) => s.code.startsWith("MS_AUTHORITY_LEAVES_MULTISIG"))).toMatchObject({ severity: "CRITICAL" });
    expect(r.inspection.risk.level).toBe("CRITICAL");
  });
});

describe("veto / execute preparation", () => {
  const future = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const past = BigInt(Math.floor(Date.now() / 1000) - 60);
  const address = () => actionPda(PROGRAM, GUARD, 0);
  const serveAction = (eta: bigint, status = 0) => {
    const accounts = new Map<string, ChainAccount>([[GUARD, { data: guardBytes(), owner: PROGRAM }], [address(), { data: actionBytes({ eta, status, instructions: [setMintAuthority(OUTSIDER)] }), owner: PROGRAM }]]);
    rpc.mockImplementation((async (method: string, params: unknown[]) => {
      const ok = (result: unknown) => ({ result, source: "HELIUS_RPC", fallbackUsed: false });
      if (method === "getAccountInfo") return ok({ context: { slot: 1 }, value: accountInfoValue(accounts.get(params[0] as string)) });
      if (method === "getLatestBlockhash") return ok({ value: { blockhash: key(99).toBase58(), lastValidBlockHeight: 1 } });
      throw new Error(`unexpected rpc ${method}`);
    }) as unknown as typeof rpcCall);
  };

  it("a guardian gets an unsigned veto paid by themselves, with a verifiable hash", async () => {
    const { prepareGuardTransaction } = await import("@/lib/guard/prepare");
    const { messageHashOfTx } = await import("@/lib/wallet/signing");
    serveAction(future);
    const p = await prepareGuardTransaction("veto", address(), M2);
    const bytes = Uint8Array.from(Buffer.from(p.transaction, "base64"));
    const d = decodeTransaction(VersionedTransaction.deserialize(bytes));
    expect(d.feePayer).toBe(M2);
    expect(d.instructions.map((i) => i.type)).toEqual(["guard:veto"]);
    expect(d.signaturesPresent).toBe(0);
    expect(await messageHashOfTx(bytes)).toBe(p.messageHash);
  });

  it("refuses a veto from a non-guardian, an early execute, and anything on a finished action", async () => {
    const { prepareGuardTransaction } = await import("@/lib/guard/prepare");
    serveAction(future);
    await expect(prepareGuardTransaction("veto", address(), OUTSIDER)).rejects.toMatchObject({ code: "OWNERSHIP_MISMATCH" });
    await expect(prepareGuardTransaction("execute", address(), OUTSIDER)).rejects.toThrow(/delay has not passed/);
    serveAction(past, 2);
    await expect(prepareGuardTransaction("veto", address(), M1)).rejects.toThrow(/already vetoed/);
  });

  it("anyone can prepare the execution once the delay has passed", async () => {
    const { prepareGuardTransaction } = await import("@/lib/guard/prepare");
    serveAction(past);
    const p = await prepareGuardTransaction("execute", address(), OUTSIDER);
    const d = decodeTransaction(VersionedTransaction.deserialize(Uint8Array.from(Buffer.from(p.transaction, "base64"))));
    expect(d.instructions[0]).toMatchObject({ type: "guard:execute" });
    expect(d.accounts.map((a) => a.address)).toEqual(expect.arrayContaining([MINT, TOKEN_PROGRAM_ID, SIGNER]));
  });
});

describe("Guard inspection", () => {
  const future = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const past = BigInt(Math.floor(Date.now() / 1000) - 60);

  it("a guard address shows its setup and scheduled actions", async () => {
    const accounts = new Map<string, ChainAccount>([[GUARD, { data: guardBytes({ guardians: [M1], delay: 600 }), owner: PROGRAM }], [actionPda(PROGRAM, GUARD, 0), { data: actionBytes({ eta: future, instructions: [setMintAuthority(OUTSIDER)] }), owner: PROGRAM }]]);
    serve(accounts);
    const r = await inspect(GUARD);
    if (r.kind !== "guard") throw new Error("expected guard");
    expect(r.overview.actions).toEqual([expect.objectContaining({ index: "0", status: "Pending", instructions: 1 })]);
    expect(r.overview.posture.signals.map((s) => s.code)).toEqual(expect.arrayContaining(["GUARD_SINGLE_GUARDIAN", "GUARD_SHORT_DELAY"]));
  });

  it("a pending action that hands an authority outside is CRITICAL for guardians, with time left to veto", async () => {
    const address = actionPda(PROGRAM, GUARD, 0);
    serve(new Map([[GUARD, { data: guardBytes(), owner: PROGRAM }], [address, { data: actionBytes({ eta: future, instructions: [setMintAuthority(OUTSIDER)] }), owner: PROGRAM }]]));
    const r = await inspect(address);
    if (r.kind !== "guard-action") throw new Error("expected action");
    expect(r.inspection.risk.level).toBe("CRITICAL");
    expect(r.inspection.gate).toBe("block");
    expect(r.inspection.risk.signals.map((s) => s.code)).toContain("GUARD_ACTION_PENDING");
  });

  it("moving the authority back to the proposer vault is not 'outside'", async () => {
    const address = actionPda(PROGRAM, GUARD, 0);
    serve(new Map([[GUARD, { data: guardBytes(), owner: PROGRAM }], [address, { data: actionBytes({ eta: past, instructions: [setMintAuthority(VAULT)] }), owner: PROGRAM }]]));
    const r = await inspect(address);
    if (r.kind !== "guard-action") throw new Error("expected action");
    expect(r.inspection.scheduled.privileged[0].control).toBe("multisig");
    expect(r.inspection.risk.signals.map((s) => s.code)).toContain("GUARD_ACTION_EXECUTABLE");
    expect(r.inspection.risk.signals.some((s) => s.severity === "CRITICAL")).toBe(false);
  });
});

describe("Handing an authority to the multisig's own guard", () => {
  /** Vault proposal #4: SPL Token SetAuthority(MintTokens → newAuthority), executed immediately by the vault. */
  function chainHandingMintTo(newAuthority: string) {
    const message: SquadsMessage = {
      numSigners: 1, numWritableSigners: 1, numWritableNonSigners: 1,
      accountKeys: [VAULT, MINT, TOKEN_PROGRAM_ID],
      instructions: [{ programIdIndex: 2, accountIndexes: [1, 0], data: Uint8Array.from([6, 0, 1, ...new PublicKey(newAuthority).toBytes()]) }],
      addressTableLookups: [],
    };
    return new Map<string, ChainAccount>([
      [MS, { data: multisigAccountBytes({ members: [M1, M2, M3], threshold: 2, timeLock: 0, transactionIndex: 4n }), owner: SQUADS_V4_PROGRAM_ID }],
      [proposalPda(MS, 4n), { data: proposalAccountBytes(MS, 4n, 1, [M1]), owner: SQUADS_V4_PROGRAM_ID }],
      [transactionPda(MS, 4n), { data: vaultTransactionBytes(MS, M1, 4n, 0, message), owner: SQUADS_V4_PROGRAM_ID }],
    ]);
  }

  /** Like `serve`, plus getProgramAccounts over the guard program, filtered by proposer like the RPC does. */
  function serveWithGuards(accounts: Map<string, ChainAccount>, guards: Array<{ address: string; data: Uint8Array }> | "fail") {
    rpc.mockImplementation((async (method: string, params: unknown[]) => {
      const ok = (result: unknown) => ({ result, source: "HELIUS_RPC", fallbackUsed: false });
      if (method === "getAccountInfo") return ok({ context: { slot: 1 }, value: accountInfoValue(accounts.get(params[0] as string)) });
      if (method === "getMultipleAccounts") return ok({ context: { slot: 1 }, value: (params[0] as string[]).map((a) => accountInfoValue(accounts.get(a))) });
      if (method === "getProgramAccounts") {
        if (guards === "fail") throw new Error("gPA disabled");
        const filters = (params[1] as { filters: Array<{ memcmp: { offset: number; bytes: string } }> }).filters;
        const proposer = filters.find((f) => f.memcmp.offset === 40)!.memcmp.bytes;
        return ok(guards.filter((g) => new PublicKey(g.data.subarray(40, 72)).toBase58() === proposer).map((g) => ({ pubkey: g.address, account: { data: [Buffer.from(g.data).toString("base64"), "base64"] } })));
      }
      throw new Error(`unexpected rpc ${method}`);
    }) as unknown as typeof rpcCall);
  }

  it("is recognized as staying under the multisig's control (delayed, vetoable), not as leaving it", async () => {
    serveWithGuards(chainHandingMintTo(SIGNER), [{ address: GUARD, data: guardBytes() }]);
    const r = await inspect(`${MS} #4`);
    if (r.kind !== "proposal") throw new Error("expected proposal");
    const p = r.inspection.analysis.payloads[0].privileged[0];
    expect(p).toMatchObject({ control: "guard", guard: { address: GUARD, delaySeconds: 86_400, guardians: 3 } });
    const codes = r.inspection.risk.signals.map((s) => s.code);
    expect(codes).toContain("MS_AUTHORITY_TO_GUARD:0");
    expect(codes.some((c) => c.startsWith("MS_AUTHORITY_LEAVES_MULTISIG"))).toBe(false);
    expect(r.inspection.risk.signals.find((s) => s.code === "MS_AUTHORITY_TO_GUARD:0")?.description).toContain("after a 1 day(s) delay");
    // A protective move does not make the missing time lock HIGH (found in the local-validator rehearsal).
    expect(r.inspection.risk.signals.find((s) => s.code === "MS_NO_TIME_LOCK")?.severity).toBe("MEDIUM");
  });

  it("a guard proposed by someone else, or guards that cannot be listed, leave it outside", async () => {
    const foreign = new W().hex(GUARD_ACCOUNT_DISCRIMINATOR.Guard).key(CREATE_KEY).key(OUTSIDER).u32(1).key(M1).u32(86_400).u64(0n).u8(255).u8(254).done();
    serveWithGuards(chainHandingMintTo(SIGNER), [{ address: GUARD, data: foreign }]);
    const r1 = await inspect(`${MS} #4`);
    if (r1.kind !== "proposal") throw new Error("expected proposal");
    expect(r1.inspection.analysis.payloads[0].privileged[0].control).toBe("outside");
    expect(r1.inspection.risk.level).toBe("CRITICAL");

    serveWithGuards(chainHandingMintTo(SIGNER), "fail");
    const r2 = await inspect(`${MS} #4`);
    if (r2.kind !== "proposal") throw new Error("expected proposal");
    expect(r2.inspection.risk.level).toBe("CRITICAL");
  });
});

describe("Scheduled guard configuration changes", () => {
  /** guard.update_config(proposer, guardians, delay), signed by the guard signer (only reachable through a scheduled action). */
  function updateConfig(proposer: string, guardians: string[], delay: number): GuardInstructionData {
    const w = new W().hex(GUARD_IX_DISCRIMINATOR.updateConfig).key(proposer).u32(guardians.length);
    guardians.forEach((g) => w.key(g));
    return { programId: PROGRAM, accounts: [{ pubkey: GUARD, isSigner: false, isWritable: true }, { pubkey: SIGNER, isSigner: true, isWritable: false }], data: w.u32(delay).done() };
  }

  async function inspectPendingConfig(change: GuardInstructionData) {
    const address = actionPda(PROGRAM, GUARD, 0);
    serve(new Map([[GUARD, { data: guardBytes(), owner: PROGRAM }], [address, { data: actionBytes({ eta: BigInt(Math.floor(Date.now() / 1000) + 86_400), instructions: [change] }), owner: PROGRAM }]]));
    const r = await inspect(address);
    if (r.kind !== "guard-action") throw new Error("expected action");
    return r.inspection.risk.signals.filter((s) => s.code.startsWith("GUARD_CONFIG"));
  }

  it("replacing every guardian or handing the proposer role away is CRITICAL", async () => {
    expect(await inspectPendingConfig(updateConfig(VAULT, [OUTSIDER], 86_400))).toEqual([expect.objectContaining({ code: "GUARD_CONFIG_WEAKENED:action:0", severity: "CRITICAL" })]);
    const [s] = await inspectPendingConfig(updateConfig(OUTSIDER, [M1, M2, M3], 86_400));
    expect(s).toMatchObject({ severity: "CRITICAL" });
    expect(s.description).toContain(`the proposer changes to ${OUTSIDER}`);
  });

  it("removing a guardian or shortening the delay is HIGH; adding guardians or lengthening the delay is LOW", async () => {
    const [removed] = await inspectPendingConfig(updateConfig(VAULT, [M1, M2], 86_400));
    expect(removed).toMatchObject({ code: "GUARD_CONFIG_WEAKENED:action:0", severity: "HIGH" });
    const [shorter] = await inspectPendingConfig(updateConfig(VAULT, [M1, M2, M3], 3_600));
    expect(shorter.description).toContain("the delay shrinks from 1 day(s) to 1 hour(s)");
    expect(await inspectPendingConfig(updateConfig(VAULT, [M1, M2, M3, OUTSIDER], 172_800))).toEqual([expect.objectContaining({ code: "GUARD_CONFIG_CHANGE:action:0", severity: "LOW" })]);
  });
});

describe("Veto preparation mirrors the program's own-removal rule", () => {
  const config = (proposer: string, guardians: string[], delay: number): GuardInstructionData => {
    const w = new W().hex(GUARD_IX_DISCRIMINATOR.updateConfig).key(proposer).u32(guardians.length);
    guardians.forEach((g) => w.key(g));
    return { programId: PROGRAM, accounts: [{ pubkey: GUARD, isSigner: false, isWritable: true }, { pubkey: SIGNER, isSigner: true, isWritable: false }], data: w.u32(delay).done() };
  };
  const action = (instructions: GuardInstructionData[]) => decodeActionAccount(actionBytes({ eta: 0n, instructions }));
  const guard = decodeGuardAccount(guardBytes());

  it("only a removal of that one guardian, weakening nothing else, is not vetoable by it", () => {
    expect(removesOnlyGuardian(action([config(VAULT, [M2, M3], 86_400)]), guard, M1, PROGRAM)).toBe(true);
    // Other guardians can veto it.
    expect(removesOnlyGuardian(action([config(VAULT, [M2, M3], 86_400)]), guard, M2, PROGRAM)).toBe(false);
    // Removing two, shortening the delay, changing the proposer or bundling anything stays vetoable.
    expect(removesOnlyGuardian(action([config(VAULT, [M3], 86_400)]), guard, M1, PROGRAM)).toBe(false);
    expect(removesOnlyGuardian(action([config(VAULT, [M2, M3], 3_600)]), guard, M1, PROGRAM)).toBe(false);
    expect(removesOnlyGuardian(action([config(OUTSIDER, [M2, M3], 86_400)]), guard, M1, PROGRAM)).toBe(false);
    expect(removesOnlyGuardian(action([config(VAULT, [M2, M3], 86_400), setMintAuthority(OUTSIDER)]), guard, M1, PROGRAM)).toBe(false);
    expect(removesOnlyGuardian(action([setMintAuthority(OUTSIDER)]), guard, M1, PROGRAM)).toBe(false);
  });
});
