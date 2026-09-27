import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { PublicKey, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearIdlCache, idlAddress, parseIdlAccount } from "@/lib/anchor/source";
import { decodeAnchorInstruction, indexIdl, type AnchorIdl } from "@/lib/anchor/idl";
import { briefSourceFromAnalysis, buildSignerBrief } from "@/lib/multisig/brief";
import { rpcCall } from "@/lib/solana/client";
import { explainTransaction } from "@/lib/transaction/explain";
import { BPF_LOADER_UPGRADEABLE_ID } from "@/lib/solana/constants";
import { SQUADS_ACCOUNT_DISCRIMINATOR, SQUADS_V4_PROGRAM_ID } from "@/lib/squads/constants";
import { decodeSquadsInstruction } from "@/lib/squads/decode";
import { proposalPda, transactionPda } from "@/lib/squads/pda";
import type { SquadsMessage } from "@/lib/squads/types";
import { evaluateTransactionRisk, rentExemptMinimum } from "@/lib/security/rules/transaction";
import { analyzeTransaction } from "@/lib/transaction/analyze";
import { decodeTransaction } from "@/lib/transaction/decoder";
import { bytesToBase64 } from "@/lib/transaction/input";
import drift from "../fixtures/drift-2026-04-01.json";
import { buildTx, key, WALLET } from "../helpers/fixtures";

// Real Drift exploit transactions (public mainnet data). Only the RPC edge is mocked.
vi.mock("@/lib/solana/client", async (importOriginal) => ({ ...(await importOriginal<object>()), rpcCall: vi.fn() }));
const rpc = vi.mocked(rpcCall);

const MULTISIG = "2LW6PSEjp81xSEttWwXDB6Etb1eKdhYPbFEojYbyhx88";
const DRIFT = "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH";
const ATTACKER_ADMIN = "H7PiGqqUaanBovwKgEtreJbKmQe6dbq6VTrw6guy7ZgL";
const SIGNER_1 = "39JyWrdbVdRqjzw9yyEjxNtTbTKcTPLdtdCgbz7C7Aq8";
const SIGNER_2 = "6UJbu9ut5VAsFYQFgPEa5xPfoyF5bB5oi4EknFPvu924";
const TX_INDEX = 7n;

/** Tiny Borsh writer for synthetic account state. */
class W {
  parts: number[] = [];
  u8(v: number) { this.parts.push(v & 0xff); return this; }
  u16(v: number) { return this.u8(v).u8(v >> 8); }
  u32(v: number) { for (let i = 0; i < 4; i++) this.u8(v >>> (8 * i)); return this; }
  u64(v: bigint) { for (let i = 0n; i < 8n; i++) this.u8(Number((v >> (8n * i)) & 0xffn)); return this; }
  key(k: string) { this.parts.push(...new PublicKey(k).toBytes()); return this; }
  bytes(b: ArrayLike<number>) { this.u32(b.length); this.parts.push(...Array.from(b)); return this; }
  hex(h: string) { this.parts.push(...Buffer.from(h, "hex")); return this; }
  done() { return Uint8Array.from(this.parts); }
}

const sha8 = (s: string) => createHash("sha256").update(s).digest().subarray(0, 8);
const txBytes = (i: number) => Buffer.from(drift.transactions[i].transaction, "base64");
const embeddedMessage = (): SquadsMessage => {
  const tx = VersionedTransaction.deserialize(txBytes(0));
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  const ix = tx.message.compiledInstructions[1];
  return decodeSquadsInstruction(ix.data, ix.accountKeyIndexes.map((k) => keys[k]))!.message!;
};

/** Configuration reported at the time of the attack: 2-of-5, no time lock, autonomous. Synthetic account bytes. */
function multisigAccount(opts: { threshold?: number; timeLock?: number } = {}) {
  const members = [SIGNER_1, SIGNER_2, key(71).toBase58(), key(72).toBase58(), key(73).toBase58()];
  const w = new W().hex(SQUADS_ACCOUNT_DISCRIMINATOR.Multisig).key(key(70).toBase58()).key("11111111111111111111111111111111")
    .u16(opts.threshold ?? 2).u32(opts.timeLock ?? 0).u64(TX_INDEX).u64(0n).u8(0).u8(255).u32(members.length);
  for (const m of members) w.key(m).u8(7);
  return w.done();
}

function vaultTransactionAccount() {
  const m = embeddedMessage();
  const w = new W().hex(SQUADS_ACCOUNT_DISCRIMINATOR.VaultTransaction).key(MULTISIG).key(SIGNER_1).u64(TX_INDEX).u8(255).u8(0).u8(255).bytes([])
    .u8(m.numSigners).u8(m.numWritableSigners).u8(m.numWritableNonSigners).u32(m.accountKeys.length);
  for (const k of m.accountKeys) w.key(k);
  w.u32(m.instructions.length);
  for (const ix of m.instructions) w.u8(ix.programIdIndex).bytes(ix.accountIndexes).bytes(ix.data);
  return w.u32(0).done();
}

function proposalAccount(approved: string[]) {
  const w = new W().hex(SQUADS_ACCOUNT_DISCRIMINATOR.Proposal).key(MULTISIG).u64(TX_INDEX).u8(1).u64(1_775_000_000n).u8(255).u32(approved.length);
  for (const a of approved) w.key(a);
  return w.u32(0).u32(0).done();
}

function idlAccount(idl: object) {
  const z = deflateSync(Buffer.from(JSON.stringify(idl)));
  return new W().hex("0000000000000000").key(key(74).toBase58()).bytes(z).done();
}

const DRIFT_IDL = { name: drift.anchorIdl.name, version: drift.anchorIdl.version, instructions: drift.anchorIdl.instructions } as unknown as AnchorIdl;

interface Chain {
  accounts: Map<string, { data: Uint8Array; owner: string }>;
}

function serve(chain: Chain) {
  rpc.mockImplementation((async (method: string, params: unknown[]) => {
    const ok = (result: unknown) => ({ result, source: "HELIUS_RPC", fallbackUsed: false });
    switch (method) {
      case "getTransaction": {
        const t = drift.transactions.find((x) => x.signature === params[0]);
        if (!t) return ok(null);
        return ok({ slot: t.slot, blockTime: t.blockTime, transaction: [t.transaction, "base64"], meta: { ...t.meta, computeUnitsConsumed: 0 } });
      }
      case "getAccountInfo": {
        const a = chain.accounts.get(params[0] as string);
        return ok({ context: { slot: 1 }, value: a ? { data: [Buffer.from(a.data).toString("base64"), "base64"], owner: a.owner, lamports: 1, executable: false } : null });
      }
      case "getMultipleAccounts":
        return ok({ context: { slot: 1 }, value: (params[0] as string[]).map(() => null) });
      case "simulateTransaction":
        throw new Error("simulation unavailable in test");
      default:
        throw new Error(`unexpected rpc ${method}`);
    }
  }) as unknown as typeof rpcCall);
}

async function chainAtAttack(opts: { idl?: boolean; multisig?: boolean } = {}): Promise<Chain> {
  const accounts = new Map<string, { data: Uint8Array; owner: string }>();
  if (opts.multisig !== false) accounts.set(MULTISIG, { data: multisigAccount(), owner: SQUADS_V4_PROGRAM_ID });
  accounts.set(transactionPda(MULTISIG, TX_INDEX), { data: vaultTransactionAccount(), owner: SQUADS_V4_PROGRAM_ID });
  accounts.set(proposalPda(MULTISIG, TX_INDEX), { data: proposalAccount([SIGNER_1]), owner: SQUADS_V4_PROGRAM_ID });
  if (opts.idl !== false) accounts.set(await idlAddress(DRIFT), { data: idlAccount(DRIFT_IDL), owner: DRIFT });
  return { accounts };
}

const unsignedTx1 = () => {
  const tx = VersionedTransaction.deserialize(txBytes(0));
  tx.signatures = tx.signatures.map(() => new Uint8Array(64));
  return bytesToBase64(tx.serialize());
};
const codes = (a: { risk: { signals: Array<{ code: string }> } }) => a.risk.signals.map((s) => s.code);

beforeEach(() => {
  rpc.mockReset();
  clearIdlCache();
});

describe("Drift exploit — pre-sign (the bytes Security Council member 1 signed)", () => {
  it("is CRITICAL: admin leaves the multisig, the approval never expires, no time lock", async () => {
    serve(await chainAtAttack());
    const a = await analyzeTransaction(unsignedTx1(), SIGNER_1);
    expect(a.risk.level).toBe("CRITICAL");
    expect(codes(a)).toEqual(expect.arrayContaining(["MS_AUTHORITY_LEAVES_MULTISIG:0", "MS_DURABLE_NONCE_GOVERNANCE", "MS_NO_TIME_LOCK", "MS_MINORITY_THRESHOLD"]));
    // Simulation could not run, so the verdict comes from the decoded bytes and is not called complete.
    expect(a.risk.status).not.toBe("COMPLETE");
    expect(a.messageHash).toMatch(/^[0-9a-f]{64}$/);

    const payload = a.multisig!.payloads[0];
    expect(payload).toMatchObject({ source: "INSTRUCTION", status: "DECODED", transactionIndex: "7" });
    expect(payload.decoded!.instructions[0]).toMatchObject({ type: "anchor:updateAdmin", programId: DRIFT });
    expect(payload.decoded!.instructions[0].info.admin).toBe(ATTACKER_ADMIN);

    const leave = a.risk.signals.find((s) => s.code === "MS_AUTHORITY_LEAVES_MULTISIG:0")!;
    const ev = a.risk.evidence.filter((e) => leave.evidenceIds.includes(e.id));
    expect(ev.some((e) => e.source === "ANCHOR_IDL" && String(e.observed).includes(ATTACKER_ADMIN))).toBe(true);
    expect(leave.description).toContain("or a member");

    // The signer brief and the deterministic explanation say the same thing in plain words.
    const brief = buildSignerBrief(briefSourceFromAnalysis(a))!;
    expect(brief.headline).toBe("You are about to create + approve proposal #7 of multisig 2LW6…hx88.");
    expect(brief.neverExpires).toBe(true);
    expect(brief.config).toBe("2 of 5 voting members · time lock none");
    expect(brief.payloads[0].steps[0].privileged).toMatchObject({ kind: "admin-transfer", control: "outside", newAuthority: ATTACKER_ADMIN });
    expect(brief.messageHash!.base58.length).toBeGreaterThan(40);
    expect(explainTransaction(a).whatHappens.some((l) => l.startsWith("If proposal #7 executes") && l.includes("updateAdmin"))).toBe(true);
  });

  it("without the program's IDL the payload is PARTIAL — still CRITICAL from the nonce, never SAFE", async () => {
    serve(await chainAtAttack({ idl: false }));
    const a = await analyzeTransaction(unsignedTx1(), SIGNER_1);
    expect(a.multisig!.payloads[0].status).toBe("PARTIAL");
    expect(codes(a)).toContain("MS_DURABLE_NONCE_GOVERNANCE");
    expect(codes(a)).toContain("MS_PAYLOAD_PARTIAL:" + transactionPda(MULTISIG, TX_INDEX));
    expect(codes(a).some((c) => c.startsWith("MS_AUTHORITY_LEAVES_MULTISIG"))).toBe(false);
    expect(a.risk.level).toBe("CRITICAL");
  });

  it("does not claim membership facts when the multisig account cannot be loaded", async () => {
    serve(await chainAtAttack({ multisig: false }));
    const a = await analyzeTransaction(unsignedTx1(), SIGNER_1);
    expect(a.multisig!.accountStatus).toBe("NOT_FOUND");
    const leave = a.risk.signals.find((s) => s.code === "MS_AUTHORITY_LEAVES_MULTISIG:0")!;
    expect(leave.description).toContain("membership could not be checked");
    expect(codes(a)).not.toContain("MS_NO_TIME_LOCK");
    expect(a.risk.status).not.toBe("COMPLETE");
  });
});

describe("Drift exploit — executed transactions (analysis by signature)", () => {
  it("tx 1: rent for the new proposal accounts is not reported as unexplained outflow", async () => {
    serve(await chainAtAttack());
    const a = await analyzeTransaction(drift.transactions[0].signature);
    expect(a.risk.level).toBe("CRITICAL");
    expect(codes(a)).toContain("TX_RENT_DEPOSIT");
    expect(codes(a)).not.toContain("TX_UNEXPECTED_SOL_OUTFLOW");
  });

  it("tx 2: approve + execute is CRITICAL, the admin change is reported once, and the vote is the deciding one", async () => {
    serve(await chainAtAttack());
    const a = await analyzeTransaction(drift.transactions[1].signature);
    expect(a.risk.level).toBe("CRITICAL");
    expect(a.decoded.innerInstructions.some((i) => i.type === "anchor:updateAdmin" && i.info.admin === ATTACKER_ADMIN)).toBe(true);
    expect(codes(a).filter((c) => c.startsWith("MS_AUTHORITY_LEAVES_MULTISIG"))).toHaveLength(1);
    expect(codes(a)).toContain(`MS_FINAL_APPROVAL:${proposalPda(MULTISIG, TX_INDEX)}`);
    expect(a.anchorIdl).toEqual([expect.objectContaining({ programId: DRIFT, status: "DECODED", decoded: 1 })]);
  });
});

describe("multisig configuration changes", () => {
  it("threshold → 1 and time lock → 0 in a config proposal are CRITICAL / HIGH", async () => {
    const member = WALLET.toBase58();
    const ms = key(80).toBase58();
    const data = new W().hex("9bec57e4894b5127").u32(2).u8(2).u16(1).u8(3).u32(0).u8(0).done();
    const ix = new TransactionInstruction({
      programId: new PublicKey(SQUADS_V4_PROGRAM_ID),
      keys: [ms, transactionPda(ms, 8n), member, member, "11111111111111111111111111111111"].map((k, i) => ({ pubkey: new PublicKey(k), isSigner: i === 2 || i === 3, isWritable: i < 4 })),
      data: Buffer.from(data),
    });
    const chain: Chain = { accounts: new Map([[ms, { data: multisigAccount({ threshold: 3, timeLock: 86_400 }), owner: SQUADS_V4_PROGRAM_ID }]]) };
    serve(chain);
    const a = await analyzeTransaction(buildTx([ix]).base64, member);
    const byCode = new Map(a.risk.signals.map((s) => [s.code, s]));
    expect(byCode.get("MS_THRESHOLD_CHANGE:0")).toMatchObject({ severity: "CRITICAL", title: "Threshold set to a single signature" });
    expect(byCode.get("MS_TIME_LOCK_CHANGE:1")).toMatchObject({ severity: "HIGH", title: "Time lock removed" });
  });
});

describe("BPF upgradeable loader", () => {
  const programData = key(81);
  const newAuthority = key(82);

  it("decodes SetAuthority and flags an upgrade authority leaving the wallet", () => {
    const ix = new TransactionInstruction({
      programId: new PublicKey(BPF_LOADER_UPGRADEABLE_ID),
      keys: [{ pubkey: programData, isSigner: false, isWritable: true }, { pubkey: WALLET, isSigner: true, isWritable: false }, { pubkey: newAuthority, isSigner: false, isWritable: false }],
      data: Buffer.from([4, 0, 0, 0]),
    });
    const decoded = decodeTransaction(VersionedTransaction.deserialize(buildTx([ix]).bytes));
    expect(decoded.instructions[0]).toMatchObject({ type: "bpfLoader:setAuthority", parsed: true });
    expect(decoded.authorityChanges).toEqual([expect.objectContaining({ kind: "program-upgrade-authority", newAuthority: newAuthority.toBase58() })]);
    const risk = evaluateTransactionRisk({ decoded, effects: null, wallet: WALLET.toBase58(), effectsStatus: "COMPLETE" });
    expect(risk.signals.find((s) => s.code === "TX_UPGRADE_AUTHORITY_CHANGE")).toMatchObject({ severity: "CRITICAL" });
  });

  it("SetAuthority without a new authority makes the program immutable (HIGH, not CRITICAL)", () => {
    const ix = new TransactionInstruction({
      programId: new PublicKey(BPF_LOADER_UPGRADEABLE_ID),
      keys: [{ pubkey: programData, isSigner: false, isWritable: true }, { pubkey: WALLET, isSigner: true, isWritable: false }],
      data: Buffer.from([4, 0, 0, 0]),
    });
    const decoded = decodeTransaction(VersionedTransaction.deserialize(buildTx([ix]).bytes));
    const risk = evaluateTransactionRisk({ decoded, effects: null, wallet: WALLET.toBase58(), effectsStatus: "COMPLETE" });
    expect(risk.signals.find((s) => s.code === "TX_UPGRADE_AUTHORITY_CHANGE")).toMatchObject({ severity: "HIGH", title: "Program made immutable" });
  });
});

describe("Anchor IDL decoding", () => {
  const index = indexIdl(DRIFT_IDL);
  const updateAdmin = (admin: string) => Uint8Array.from([...sha8("global:update_admin"), ...new PublicKey(admin).toBytes()]);

  it("decodes updateAdmin(admin) from the legacy IDL format", () => {
    const d = decodeAnchorInstruction(DRIFT_IDL, index, updateAdmin(ATTACKER_ADMIN))!;
    expect(d).toMatchObject({ name: "updateAdmin", accountNames: ["admin", "state"], complete: true });
    expect(d.args).toEqual([{ name: "admin", type: "publicKey", value: ATTACKER_ADMIN }]);
  });

  it("marks arguments after an unsupported type as undecoded instead of guessing", () => {
    const idl = { instructions: [{ name: "doThing", accounts: [], args: [{ name: "a", type: "u8" }, { name: "b", type: { defined: "Missing" } }, { name: "c", type: "u8" }] }] } as unknown as AnchorIdl;
    const data = Uint8Array.from([...sha8("global:do_thing"), 5, 1, 2]);
    const d = decodeAnchorInstruction(idl, indexIdl(idl), data)!;
    expect(d.complete).toBe(false);
    expect(d.args.map((a) => a.value)).toEqual(["5", null, null]);
  });

  it("uses explicit discriminators of the 0.30+ IDL format and renders Option::None", () => {
    const idl = { instructions: [{ name: "set_authority", discriminator: [1, 2, 3, 4, 5, 6, 7, 8], accounts: [], args: [{ name: "new_authority", type: { option: "pubkey" } }] }] } as unknown as AnchorIdl;
    const d = decodeAnchorInstruction(idl, indexIdl(idl), Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 0]))!;
    expect(d.args).toEqual([{ name: "new_authority", type: "Option<publicKey>", value: "None" }]);
  });

  it("round-trips the on-chain IDL account layout and rejects a truncated one", () => {
    expect(parseIdlAccount(idlAccount(DRIFT_IDL)).instructions).toHaveLength(3);
    expect(() => parseIdlAccount(idlAccount(DRIFT_IDL).subarray(0, 50))).toThrow();
  });

  it("an IDL account not owned by the program is ignored", async () => {
    const accounts = new Map([[await idlAddress(DRIFT), { data: idlAccount(DRIFT_IDL), owner: key(90).toBase58() }]]);
    serve({ accounts });
    const a = await analyzeTransaction(drift.transactions[1].signature);
    expect(a.anchorIdl).toEqual([expect.objectContaining({ programId: DRIFT, status: "NO_IDL" })]);
    expect(a.decoded.innerInstructions.some((i) => i.type.startsWith("anchor:"))).toBe(false);
  });
});

describe("rent deposits", () => {
  it("rent is capped at the rent-exempt minimum for the account size", () => {
    expect(rentExemptMinimum(0n)).toBe(890_880n);
    expect(rentExemptMinimum(165n)).toBe(2_039_280n);
  });
});
