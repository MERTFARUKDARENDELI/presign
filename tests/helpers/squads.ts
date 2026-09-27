import { PublicKey } from "@solana/web3.js";
import { SQUADS_ACCOUNT_DISCRIMINATOR } from "@/lib/squads/constants";
import type { SquadsMessage } from "@/lib/squads/types";

/** Tiny Borsh writer for synthetic Squads account state in tests. */
export class W {
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

export const DEFAULT_PUBKEY = "11111111111111111111111111111111";

export function multisigAccountBytes(opts: { members: string[]; threshold: number; timeLock?: number; transactionIndex?: bigint; staleTransactionIndex?: bigint; configAuthority?: string; permissions?: number[] }) {
  const w = new W().hex(SQUADS_ACCOUNT_DISCRIMINATOR.Multisig).key(DEFAULT_PUBKEY).key(opts.configAuthority ?? DEFAULT_PUBKEY)
    .u16(opts.threshold).u32(opts.timeLock ?? 0).u64(opts.transactionIndex ?? 0n).u64(opts.staleTransactionIndex ?? 0n).u8(0).u8(255).u32(opts.members.length);
  opts.members.forEach((m, i) => w.key(m).u8(opts.permissions?.[i] ?? 7));
  return w.done();
}

export function proposalAccountBytes(multisig: string, index: bigint, status: number, approved: string[] = []) {
  const w = new W().hex(SQUADS_ACCOUNT_DISCRIMINATOR.Proposal).key(multisig).u64(index).u8(status);
  if (status !== 4) w.u64(1_775_000_000n);
  w.u8(255).u32(approved.length);
  approved.forEach((a) => w.key(a));
  return w.u32(0).u32(0).done();
}

export function vaultTransactionBytes(multisig: string, creator: string, index: bigint, vaultIndex: number, m: SquadsMessage, ephemeral = 0) {
  const w = new W().hex(SQUADS_ACCOUNT_DISCRIMINATOR.VaultTransaction).key(multisig).key(creator).u64(index).u8(255).u8(vaultIndex).u8(255).bytes(new Array(ephemeral).fill(255))
    .u8(m.numSigners).u8(m.numWritableSigners).u8(m.numWritableNonSigners).u32(m.accountKeys.length);
  m.accountKeys.forEach((k) => w.key(k));
  w.u32(m.instructions.length);
  m.instructions.forEach((ix) => w.u8(ix.programIdIndex).bytes(ix.accountIndexes).bytes(ix.data));
  w.u32(m.addressTableLookups.length);
  m.addressTableLookups.forEach((l) => w.key(l.accountKey).bytes(l.writableIndexes).bytes(l.readonlyIndexes));
  return w.done();
}

export function batchAccountBytes(multisig: string, creator: string, index: bigint, vaultIndex: number, size: number, executed = 0) {
  return new W().hex(SQUADS_ACCOUNT_DISCRIMINATOR.Batch).key(multisig).key(creator).u64(index).u8(255).u8(vaultIndex).u8(255).u32(size).u32(executed).done();
}

export function vaultBatchTransactionBytes(m: SquadsMessage) {
  const w = new W().hex(SQUADS_ACCOUNT_DISCRIMINATOR.VaultBatchTransaction).u8(255).bytes([])
    .u8(m.numSigners).u8(m.numWritableSigners).u8(m.numWritableNonSigners).u32(m.accountKeys.length);
  m.accountKeys.forEach((k) => w.key(k));
  w.u32(m.instructions.length);
  m.instructions.forEach((ix) => w.u8(ix.programIdIndex).bytes(ix.accountIndexes).bytes(ix.data));
  return w.u32(0).done();
}

/** A System transfer of `lamports` from the vault (index 0 signer) to `to`. */
export function vaultSolTransfer(vault: string, to: string, lamports: bigint): SquadsMessage {
  return {
    numSigners: 1,
    numWritableSigners: 1,
    numWritableNonSigners: 1,
    accountKeys: [vault, to, DEFAULT_PUBKEY],
    instructions: [{ programIdIndex: 2, accountIndexes: [0, 1], data: new W().u32(2).u64(lamports).done() }],
    addressTableLookups: [],
  };
}

export type ChainAccount = { data: Uint8Array; owner: string };

export function accountInfoValue(a: ChainAccount | undefined) {
  return a ? { data: [Buffer.from(a.data).toString("base64"), "base64"], owner: a.owner, lamports: 1, executable: false } : null;
}
