import { deflateSync } from "node:zlib";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { vi } from "vitest";
import type { AnchorIdl } from "@/lib/anchor/idl";
import { idlAddress } from "@/lib/anchor/source";
import { rpcCall } from "@/lib/solana/client";
import { SQUADS_ACCOUNT_DISCRIMINATOR, SQUADS_V4_PROGRAM_ID } from "@/lib/squads/constants";
import { decodeSquadsInstruction } from "@/lib/squads/decode";
import { proposalPda, transactionPda } from "@/lib/squads/pda";
import type { SquadsMessage } from "@/lib/squads/types";
import { bytesToBase64 } from "@/lib/transaction/input";
import drift from "../fixtures/drift-2026-04-01.json";
import { key } from "./fixtures";

/**
 * Chain state at the time of the Drift takeover (real exploit transactions,
 * synthetic account bytes), for tests that need the full multisig pipeline.
 * The calling test file must `vi.mock("@/lib/solana/client")` so `rpcCall` is a mock.
 */

export const MULTISIG = "2LW6PSEjp81xSEttWwXDB6Etb1eKdhYPbFEojYbyhx88";
export const DRIFT = "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH";
export const ATTACKER_ADMIN = "H7PiGqqUaanBovwKgEtreJbKmQe6dbq6VTrw6guy7ZgL";
export const SIGNER_1 = "39JyWrdbVdRqjzw9yyEjxNtTbTKcTPLdtdCgbz7C7Aq8";
export const SIGNER_2 = "6UJbu9ut5VAsFYQFgPEa5xPfoyF5bB5oi4EknFPvu924";
const TX_INDEX = 7n;

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

const txBytes = (i: number) => Buffer.from(drift.transactions[i].transaction, "base64");

function embeddedMessage(): SquadsMessage {
  const tx = VersionedTransaction.deserialize(txBytes(0));
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  const ix = tx.message.compiledInstructions[1];
  return decodeSquadsInstruction(ix.data, ix.accountKeyIndexes.map((k) => keys[k]))!.message!;
}

function multisigAccount() {
  const members = [SIGNER_1, SIGNER_2, key(71).toBase58(), key(72).toBase58(), key(73).toBase58()];
  const w = new W().hex(SQUADS_ACCOUNT_DISCRIMINATOR.Multisig).key(key(70).toBase58()).key("11111111111111111111111111111111").u16(2).u32(0).u64(TX_INDEX).u64(0n).u8(0).u8(255).u32(members.length);
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

/** Serves the Drift multisig, proposal #7, its vault transaction and Drift's IDL through the mocked rpcCall. */
export async function serveDriftChain(): Promise<void> {
  const accounts = new Map<string, { data: Uint8Array; owner: string }>();
  accounts.set(MULTISIG, { data: multisigAccount(), owner: SQUADS_V4_PROGRAM_ID });
  accounts.set(transactionPda(MULTISIG, TX_INDEX), { data: vaultTransactionAccount(), owner: SQUADS_V4_PROGRAM_ID });
  accounts.set(proposalPda(MULTISIG, TX_INDEX), { data: proposalAccount([SIGNER_1]), owner: SQUADS_V4_PROGRAM_ID });
  accounts.set(await idlAddress(DRIFT), { data: idlAccount(DRIFT_IDL), owner: DRIFT });
  vi.mocked(rpcCall).mockImplementation((async (method: string, params: unknown[]) => {
    const ok = (result: unknown) => ({ result, source: "HELIUS_RPC", fallbackUsed: false });
    switch (method) {
      case "getAccountInfo": {
        const a = accounts.get(params[0] as string);
        return ok({ context: { slot: 1 }, value: a ? { data: [Buffer.from(a.data).toString("base64"), "base64"], owner: a.owner, lamports: 1, executable: false } : null });
      }
      case "getMultipleAccounts":
        return ok({ context: { slot: 1 }, value: (params[0] as string[]).map(() => null) });
      case "getTransaction":
        return ok(null);
      default:
        throw new Error(`unexpected rpc ${method}`);
    }
  }) as unknown as typeof rpcCall);
}

/** The exact bytes Security Council member 1 signed (create + approve proposal #7 inside a durable nonce), unsigned. */
export function driftUnsignedApproval(): string {
  const tx = VersionedTransaction.deserialize(txBytes(0));
  tx.signatures = tx.signatures.map(() => new Uint8Array(64));
  return bytesToBase64(tx.serialize());
}
