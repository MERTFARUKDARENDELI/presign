import { createHash } from "node:crypto";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { SQUADS_ACCOUNT_DISCRIMINATOR, SQUADS_IX_BY_DISCRIMINATOR, SQUADS_V4_PROGRAM_ID } from "@/lib/squads/constants";
import {
  decodeConfigTransactionAccount,
  decodeMultisigAccount,
  decodeProposalAccount,
  decodeSquadsInstruction,
  decodeVaultTransactionAccount,
  parseTransactionMessage,
  toVersionedTransaction,
} from "@/lib/squads/decode";
import { controlledAddresses, proposalPda, transactionPda, vaultPda } from "@/lib/squads/pda";
import { decodeTransaction } from "@/lib/transaction/decoder";
import drift from "../fixtures/drift-2026-04-01.json";

// Real mainnet transactions of the Drift exploit (public on-chain data, fetched read-only).
const DRIFT_MULTISIG = "2LW6PSEjp81xSEttWwXDB6Etb1eKdhYPbFEojYbyhx88";
const DRIFT_PROGRAM = "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH";
const ATTACKER_ADMIN = "H7PiGqqUaanBovwKgEtreJbKmQe6dbq6VTrw6guy7ZgL";

const txOf = (i: number) => VersionedTransaction.deserialize(Buffer.from(drift.transactions[i].transaction, "base64"));
const keysOf = (tx: VersionedTransaction) => tx.message.staticAccountKeys.map((k) => k.toBase58());
const squadsIxs = (tx: VersionedTransaction) => {
  const keys = keysOf(tx);
  return tx.message.compiledInstructions
    .filter((ix) => keys[ix.programIdIndex] === SQUADS_V4_PROGRAM_ID)
    .map((ix) => decodeSquadsInstruction(ix.data, ix.accountKeyIndexes.map((k) => keys[k])));
};

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const sha8 = (s: string) => createHash("sha256").update(s).digest().subarray(0, 8).toString("hex");

/** Tiny Borsh writer for synthetic account fixtures. */
class W {
  parts: number[] = [];
  u8(v: number) { this.parts.push(v & 0xff); return this; }
  u16(v: number) { return this.u8(v).u8(v >> 8); }
  u32(v: number) { for (let i = 0; i < 4; i++) this.u8(v >>> (8 * i)); return this; }
  u64(v: bigint) { for (let i = 0n; i < 8n; i++) this.u8(Number((v >> (8n * i)) & 0xffn)); return this; }
  key(k: string) { this.parts.push(...new PublicKey(k).toBytes()); return this; }
  bytes(b: number[] | Uint8Array) { this.u32(b.length); this.parts.push(...b); return this; }
  hex(h: string) { this.parts.push(...Buffer.from(h, "hex")); return this; }
  done() { return Uint8Array.from(this.parts); }
}

describe("Squads v4 constants", () => {
  it("every instruction discriminator is sha256('global:<snake_name>')[0..8]", () => {
    for (const [disc, name] of Object.entries(SQUADS_IX_BY_DISCRIMINATOR)) {
      expect(sha8(`global:${snake(name)}`), name).toBe(disc);
    }
    expect(Object.keys(SQUADS_IX_BY_DISCRIMINATOR)).toHaveLength(36);
  });

  it("every account discriminator is sha256('account:<Name>')[0..8]", () => {
    for (const [name, disc] of Object.entries(SQUADS_ACCOUNT_DISCRIMINATOR)) expect(sha8(`account:${name}`), name).toBe(disc);
  });
});

describe("Drift exploit transaction 1 (pre-signed create + approve)", () => {
  const tx = txOf(0);
  const ixs = squadsIxs(tx);

  it("decodes the three Squads instructions in order", () => {
    expect(ixs.map((i) => i?.name)).toEqual(["vaultTransactionCreate", "proposalCreate", "proposalApprove"]);
    expect(ixs.every((i) => i?.accounts.multisig === DRIFT_MULTISIG)).toBe(true);
  });

  it("extracts the embedded vault message: Drift updateAdmin executed by vault 0", () => {
    const create = ixs[0]!;
    expect(create.vaultIndex).toBe(0);
    const m = create.message!;
    expect(m.accountKeys[0]).toBe(vaultPda(DRIFT_MULTISIG, 0));
    expect(m.accountKeys).toContain(DRIFT_PROGRAM);
    expect(m.instructions).toHaveLength(1);
    const ix = m.instructions[0];
    expect(m.accountKeys[ix.programIdIndex]).toBe(DRIFT_PROGRAM);
    // Anchor sha256("global:update_admin") followed by the new admin pubkey.
    expect(Buffer.from(ix.data.subarray(0, 8)).toString("hex")).toBe(sha8("global:update_admin"));
    expect(new PublicKey(ix.data.subarray(8, 40)).toBase58()).toBe(ATTACKER_ADMIN);
  });

  it("derives the on-chain transaction and proposal PDAs from the proposal index", () => {
    const index = ixs[1]!.transactionIndex!;
    expect(transactionPda(DRIFT_MULTISIG, index)).toBe(ixs[0]!.accounts.transaction);
    expect(proposalPda(DRIFT_MULTISIG, index)).toBe(ixs[1]!.accounts.proposal);
    expect(ixs[2]!.accounts.proposal).toBe(ixs[1]!.accounts.proposal);
    expect(ixs[2]!.vote).toBe("approve");
  });

  it("the vault message round-trips into the regular decoder", () => {
    const inner = decodeTransaction(toVersionedTransaction(ixs[0]!.message!));
    expect(inner.feePayer).toBe(vaultPda(DRIFT_MULTISIG, 0));
    expect(inner.signers).toEqual([vaultPda(DRIFT_MULTISIG, 0)]);
    expect(inner.instructions[0].programId).toBe(DRIFT_PROGRAM);
    expect(inner.instructions[0].parsed).toBe(false);
  });
});

describe("Drift exploit transaction 2 (pre-signed approve + execute)", () => {
  it("decodes approve then execute on the same proposal", () => {
    const ixs = squadsIxs(txOf(1));
    expect(ixs.map((i) => i?.name)).toEqual(["proposalApprove", "vaultTransactionExecute"]);
    expect(ixs[1]!.kind).toBe("execute");
    expect(ixs[1]!.accounts.proposal).toBe(ixs[0]!.accounts.proposal);
  });
});

describe("Squads accounts", () => {
  const multisig = Keypair.generate().publicKey.toBase58();
  const m1 = Keypair.generate().publicKey.toBase58();
  const m2 = Keypair.generate().publicKey.toBase58();

  it("decodes a Multisig account (autonomous, 2-of-2, no time lock) and ignores trailing space", () => {
    const data = new W().hex(SQUADS_ACCOUNT_DISCRIMINATOR.Multisig)
      .key(Keypair.generate().publicKey.toBase58()).key("11111111111111111111111111111111")
      .u16(2).u32(0).u64(7n).u64(3n).u8(0).u8(255)
      .u32(2).key(m1).u8(7).key(m2).u8(2)
      .bytes([0, 0, 0]).done();
    const a = decodeMultisigAccount(data);
    expect(a).toMatchObject({ configAuthority: null, threshold: 2, timeLock: 0, transactionIndex: "7", staleTransactionIndex: "3", rentCollector: null });
    expect(a.members).toEqual([{ key: m1, permissions: ["Initiate", "Vote", "Execute"] }, { key: m2, permissions: ["Vote"] }]);
  });

  it("decodes a Proposal account", () => {
    const data = new W().hex(SQUADS_ACCOUNT_DISCRIMINATOR.Proposal).key(multisig).u64(5n).u8(1).u64(1_700_000_000n).u8(254)
      .u32(1).key(m1).u32(0).u32(0).done();
    expect(decodeProposalAccount(data)).toEqual({ multisig, transactionIndex: "5", status: "Active", statusTimestamp: "1700000000", approved: [m1], rejected: [], cancelled: [] });
  });

  it("decodes a VaultTransaction account and its standard-Borsh message", () => {
    const vault = vaultPda(multisig, 0);
    const data = new W().hex(SQUADS_ACCOUNT_DISCRIMINATOR.VaultTransaction).key(multisig).key(m1).u64(5n).u8(1).u8(0).u8(2).bytes([])
      .u8(1).u8(1).u8(1).u32(3).key(vault).key(m2).key("11111111111111111111111111111111")
      .u32(1).u8(2).bytes([0, 1]).bytes([2, 0, 0, 0, 0xe8, 3, 0, 0, 0, 0, 0, 0])
      .u32(0).done();
    const a = decodeVaultTransactionAccount(data);
    expect(a).toMatchObject({ multisig, creator: m1, index: "5", vaultIndex: 0, ephemeralSignerCount: 0 });
    const inner = decodeTransaction(toVersionedTransaction(a.message));
    expect(inner.solTransfers).toEqual([{ instruction: 0, from: vault, to: m2, lamports: "1000" }]);
  });

  it("decodes config actions (threshold, time lock, members)", () => {
    const data = new W().hex(SQUADS_ACCOUNT_DISCRIMINATOR.ConfigTransaction).key(multisig).key(m1).u64(9n).u8(1)
      .u32(3).u8(2).u16(1).u8(3).u32(0).u8(0).key(m2).u8(7).done();
    expect(decodeConfigTransactionAccount(data).actions).toEqual([
      { type: "ChangeThreshold", newThreshold: 1 },
      { type: "SetTimeLock", newTimeLock: 0 },
      { type: "AddMember", member: { key: m2, permissions: ["Initiate", "Vote", "Execute"] } },
    ]);
  });

  it("rejects an account with the wrong discriminator", () => {
    expect(() => decodeMultisigAccount(new W().hex(SQUADS_ACCOUNT_DISCRIMINATOR.Proposal).u64(0n).done())).toThrow(/Not a Squads Multisig/);
  });
});

describe("hostile input", () => {
  it("returns null for an unknown discriminator", () => {
    expect(decodeSquadsInstruction(new Uint8Array(16), [])).toBeNull();
  });

  it("throws on a truncated embedded message instead of half-decoding it", () => {
    const tx = txOf(0);
    const keys = keysOf(tx);
    const create = tx.message.compiledInstructions[1];
    expect(() => decodeSquadsInstruction(create.data.subarray(0, 60), create.accountKeyIndexes.map((k) => keys[k]))).toThrow(RangeError);
  });

  it("rejects messages whose account indexes point outside the key list", () => {
    const bytes = Uint8Array.from([1, 1, 0, 1, ...new PublicKey(SQUADS_V4_PROGRAM_ID).toBytes(), 1, 0, 1, 9, 0, 0, 0]);
    expect(() => parseTransactionMessage(bytes)).toThrow(/out of range/);
  });

  it("rejects inconsistent headers", () => {
    const bytes = Uint8Array.from([2, 3, 0, 1, ...new PublicKey(SQUADS_V4_PROGRAM_ID).toBytes(), 0, 0]);
    expect(() => parseTransactionMessage(bytes)).toThrow(/header/);
  });

  it("controlled addresses include the multisig and its first vaults", () => {
    const set = controlledAddresses(DRIFT_MULTISIG);
    expect(set[0]).toBe(DRIFT_MULTISIG);
    expect(set).toContain(vaultPda(DRIFT_MULTISIG, 0));
    expect(set).not.toContain(ATTACKER_ADMIN);
  });
});
