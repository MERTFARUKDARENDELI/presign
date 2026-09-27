import { PublicKey } from "@solana/web3.js";
import { SQUADS_SEED, SQUADS_V4_PROGRAM_ID, SQUADS_VAULT_SCAN } from "./constants";

/** Squads v4 PDA derivations (seeds from the program source). Isomorphic. */

const PROGRAM = new PublicKey(SQUADS_V4_PROGRAM_ID);
const enc = (s: string) => new TextEncoder().encode(s);

function u64le(n: bigint | string | number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), true);
  return out;
}

function pda(seeds: Uint8Array[]): string {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM)[0].toBase58();
}

export function vaultPda(multisig: string, vaultIndex: number): string {
  return pda([enc(SQUADS_SEED.prefix), new PublicKey(multisig).toBytes(), enc(SQUADS_SEED.vault), Uint8Array.of(vaultIndex)]);
}

export function transactionPda(multisig: string, index: bigint | string): string {
  return pda([enc(SQUADS_SEED.prefix), new PublicKey(multisig).toBytes(), enc(SQUADS_SEED.transaction), u64le(index)]);
}

export function proposalPda(multisig: string, index: bigint | string): string {
  return pda([enc(SQUADS_SEED.prefix), new PublicKey(multisig).toBytes(), enc(SQUADS_SEED.transaction), u64le(index), enc(SQUADS_SEED.proposal)]);
}

/** A transaction inside a batch; batch transaction indexes start at 1. */
export function batchTransactionPda(multisig: string, batchIndex: bigint | string, transactionIndex: number): string {
  const idx = new Uint8Array(4);
  new DataView(idx.buffer).setUint32(0, transactionIndex, true);
  return pda([enc(SQUADS_SEED.prefix), new PublicKey(multisig).toBytes(), enc(SQUADS_SEED.transaction), u64le(batchIndex), enc(SQUADS_SEED.batchTransaction), idx]);
}

export function ephemeralSignerPda(transaction: string, index: number): string {
  return pda([enc(SQUADS_SEED.prefix), new PublicKey(transaction).toBytes(), enc(SQUADS_SEED.ephemeralSigner), Uint8Array.of(index)]);
}

/** Addresses this multisig controls by construction: its own PDA and its first SQUADS_VAULT_SCAN vaults. */
export function controlledAddresses(multisig: string): string[] {
  return [multisig, ...Array.from({ length: SQUADS_VAULT_SCAN }, (_, i) => vaultPda(multisig, i))];
}
