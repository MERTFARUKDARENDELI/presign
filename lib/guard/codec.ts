import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { BorshReader, hex } from "@/lib/squads/borsh";
import { GUARD_ACCOUNT_DISCRIMINATOR, GUARD_IX_DISCRIMINATOR, guardSignerPda, type GuardIxName } from "./constants";

/**
 * Borsh codec for Presign Guard accounts and instructions. Layouts mirror
 * guard/programs/presign-guard/src/lib.rs field by field; decoding is bounds
 * checked and never guesses.
 */

export interface GuardAccountMetaData {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

export interface GuardInstructionData {
  programId: string;
  accounts: GuardAccountMetaData[];
  data: Uint8Array;
}

export interface GuardConfigData {
  proposer: string;
  guardians: string[];
  delaySeconds: number;
}

export interface GuardAccountData extends GuardConfigData {
  createKey: string;
  actionCount: string;
  bump: number;
  signerBump: number;
}

export type ActionStatusName = "Pending" | "Executed" | "Vetoed" | "Cancelled";
const STATUSES: ActionStatusName[] = ["Pending", "Executed", "Vetoed", "Cancelled"];

export interface ActionAccountData {
  guard: string;
  index: string;
  proposer: string;
  rentPayer: string;
  scheduledAt: string;
  eta: string;
  status: ActionStatusName;
  vetoedBy: string | null;
  executedAt: string;
  memo: string;
  instructions: GuardInstructionData[];
}

function readInstruction(r: BorshReader): GuardInstructionData {
  const programId = r.pubkey();
  const accounts = r.vec(() => ({ pubkey: r.pubkey(), isSigner: r.bool(), isWritable: r.bool() }));
  return { programId, accounts, data: Uint8Array.from(r.bytes()) };
}

function readConfig(r: BorshReader): GuardConfigData {
  return { proposer: r.pubkey(), guardians: r.vec(() => r.pubkey()), delaySeconds: r.u32() };
}

function expect(data: Uint8Array, disc: string, name: string): BorshReader {
  if (data.length < 8 || hex(data.subarray(0, 8)) !== disc) throw new TypeError(`Not a Guard ${name} account`);
  return new BorshReader(data.subarray(8));
}

export function decodeGuardAccount(data: Uint8Array): GuardAccountData {
  const r = expect(data, GUARD_ACCOUNT_DISCRIMINATOR.Guard, "Guard");
  const createKey = r.pubkey();
  const config = readConfig(r);
  return { createKey, ...config, actionCount: r.u64().toString(), bump: r.u8(), signerBump: r.u8() };
}

export function decodeActionAccount(data: Uint8Array): ActionAccountData {
  const r = expect(data, GUARD_ACCOUNT_DISCRIMINATOR.Action, "Action");
  const guard = r.pubkey();
  const index = r.u64().toString();
  const proposer = r.pubkey();
  const rentPayer = r.pubkey();
  const scheduledAt = r.i64().toString();
  const eta = r.i64().toString();
  const s = r.u8();
  const status = STATUSES[s];
  if (!status) throw new RangeError(`Unknown action status ${s}`);
  const vetoedBy = r.option(() => r.pubkey());
  const executedAt = r.i64().toString();
  const memo = r.string().slice(0, 128);
  return { guard, index, proposer, rentPayer, scheduledAt, eta, status, vetoedBy, executedAt, memo, instructions: r.vec(() => readInstruction(r)) };
}

export type GuardIx =
  | { name: "schedule"; instructions: GuardInstructionData[]; memo: string }
  | { name: "updateConfig"; config: GuardConfigData }
  | { name: "createGuard"; config: GuardConfigData }
  | { name: Exclude<GuardIxName, "schedule" | "updateConfig" | "createGuard"> };

/** Decodes Guard instruction data. Unknown discriminators return null; malformed args throw. */
export function decodeGuardInstruction(data: Uint8Array): GuardIx | null {
  if (data.length < 8) return null;
  const disc = hex(data.subarray(0, 8));
  const name = (Object.entries(GUARD_IX_DISCRIMINATOR) as Array<[GuardIxName, string]>).find(([, d]) => d === disc)?.[0];
  if (!name) return null;
  const r = new BorshReader(data.subarray(8));
  switch (name) {
    case "schedule": {
      const instructions = r.vec(() => readInstruction(r));
      return { name, instructions, memo: r.string().slice(0, 128) };
    }
    case "updateConfig":
    case "createGuard":
      return { name, config: readConfig(r) };
    default:
      return { name };
  }
}

// ---------------------------------------------------------------- encoding

class Writer {
  private parts: number[] = [];
  raw(b: ArrayLike<number>) { this.parts.push(...Array.from(b)); return this; }
  u8(v: number) { this.parts.push(v & 0xff); return this; }
  bool(v: boolean) { return this.u8(v ? 1 : 0); }
  u32(v: number) { for (let i = 0; i < 4; i++) this.u8(v >>> (8 * i)); return this; }
  key(k: string) { return this.raw(new PublicKey(k).toBytes()); }
  bytes(b: ArrayLike<number>) { return this.u32(b.length).raw(b); }
  string(s: string) { return this.bytes(new TextEncoder().encode(s)); }
  done() { return Buffer.from(this.parts); }
}

const disc = (name: GuardIxName) => Buffer.from(GUARD_IX_DISCRIMINATOR[name], "hex");

function writeInstruction(w: Writer, ix: GuardInstructionData) {
  w.key(ix.programId).u32(ix.accounts.length);
  for (const m of ix.accounts) w.key(m.pubkey).bool(m.isSigner).bool(m.isWritable);
  w.bytes(ix.data);
}

export function encodeConfig(config: GuardConfigData): Buffer {
  const w = new Writer().key(config.proposer).u32(config.guardians.length);
  for (const g of config.guardians) w.key(g);
  return w.u32(config.delaySeconds).done();
}

export function scheduleInstruction(programId: string, args: { guard: string; action: string; proposer: string; payer: string; instructions: GuardInstructionData[]; memo: string }): TransactionInstruction {
  const w = new Writer().raw(disc("schedule")).u32(args.instructions.length);
  for (const ix of args.instructions) writeInstruction(w, ix);
  w.string(args.memo);
  return new TransactionInstruction({
    programId: new PublicKey(programId),
    keys: [
      { pubkey: new PublicKey(args.guard), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(args.action), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(args.proposer), isSigner: true, isWritable: false },
      { pubkey: new PublicKey(args.payer), isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: w.done(),
  });
}

export function createGuardInstruction(programId: string, args: { guard: string; createKey: string; payer: string; config: GuardConfigData }): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(programId),
    keys: [
      { pubkey: new PublicKey(args.guard), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(guardSignerPda(programId, args.guard)), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(args.createKey), isSigner: true, isWritable: false },
      { pubkey: new PublicKey(args.payer), isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("createGuard"), encodeConfig(args.config)]),
  });
}

export function vetoInstruction(programId: string, args: { guard: string; action: string; guardian: string }): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(programId),
    keys: [
      { pubkey: new PublicKey(args.guard), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(args.action), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(args.guardian), isSigner: true, isWritable: false },
    ],
    data: disc("veto"),
  });
}

/**
 * Permissionless execution: every account the scheduled instructions touch
 * (and their program ids) goes in as remaining accounts, with the writable
 * flags they need. The guard is writable when an action changes Guard's own config.
 */
export function executeInstruction(programId: string, args: { guard: string; action: ActionAccountData & { address: string } }): TransactionInstruction {
  const signer = guardSignerPda(programId, args.guard);
  const selfCall = args.action.instructions.some((ix) => ix.programId === programId);
  // A CPI cannot make an account writable that the outer instruction did not (e.g. the signer paying rent).
  let signerWritable = false;
  const remaining = new Map<string, { isWritable: boolean }>();
  for (const ix of args.action.instructions) {
    remaining.set(ix.programId, { isWritable: remaining.get(ix.programId)?.isWritable ?? false });
    for (const m of ix.accounts) {
      if (m.pubkey === signer) {
        signerWritable ||= m.isWritable;
        continue;
      }
      remaining.set(m.pubkey, { isWritable: (remaining.get(m.pubkey)?.isWritable ?? false) || m.isWritable });
    }
  }
  // Accounts a scheduled instruction references are looked up in remaining accounts on-chain,
  // so the guard itself stays in the list when a config change references it.
  return new TransactionInstruction({
    programId: new PublicKey(programId),
    keys: [
      { pubkey: new PublicKey(args.guard), isSigner: false, isWritable: selfCall },
      { pubkey: new PublicKey(args.action.address), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(signer), isSigner: false, isWritable: signerWritable },
      ...[...remaining].map(([k, v]) => ({ pubkey: new PublicKey(k), isSigner: false, isWritable: v.isWritable })),
    ],
    data: disc("execute"),
  });
}
