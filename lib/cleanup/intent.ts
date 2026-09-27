import {
  createBurnCheckedInstruction,
  createCloseAccountInstruction,
  createRevokeInstruction,
} from "@solana/spl-token";
import { PublicKey, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@/lib/solana/constants";
import type { CleanupAction } from "./capabilities";

/**
 * A CleanupIntent is exactly what the user sees on the confirmation screen.
 * The transaction sent to the wallet must be byte-for-byte derivable from it:
 * verifyCleanupTransaction() rebuilds the expected instructions and blocks on
 * any difference (program, accounts, mint, amount, destination, authority).
 * Isomorphic: runs in the browser before signing and on the server on submit.
 */
export interface CleanupIntent {
  action: CleanupAction;
  owner: string;
  tokenAccount: string;
  mint: string;
  tokenProgram: string;
  /** Raw amount to burn ("0" for CLOSE/REVOKE). */
  amountRaw: string;
  decimals: number;
  /** Rent destination for CloseAccount — always the owner. */
  destination: string;
  cluster: "mainnet-beta" | "devnet";
  /**
   * REVOKE only: the account-level delegate verified on-chain at preparation.
   * Display/verification data — the Revoke instruction itself removes whatever
   * delegate is set, so post-state verification checks the delegate is gone.
   */
  delegate?: string | null;
}

export function buildCleanupInstructions(intent: CleanupIntent): TransactionInstruction[] {
  if (intent.tokenProgram !== TOKEN_PROGRAM_ID && intent.tokenProgram !== TOKEN_2022_PROGRAM_ID) {
    throw new Error("Unsupported token program.");
  }
  if (intent.destination !== intent.owner) {
    throw new Error("Rent destination must be the owner.");
  }
  const program = new PublicKey(intent.tokenProgram);
  const account = new PublicKey(intent.tokenAccount);
  const owner = new PublicKey(intent.owner);

  switch (intent.action) {
    case "BURN_AND_CLOSE": {
      const amount = BigInt(intent.amountRaw);
      if (amount <= 0n) throw new Error("Burn amount must be positive.");
      return [
        createBurnCheckedInstruction(account, new PublicKey(intent.mint), owner, amount, intent.decimals, [], program),
        createCloseAccountInstruction(account, owner, owner, [], program),
      ];
    }
    case "CLOSE":
      if (BigInt(intent.amountRaw) !== 0n) throw new Error("Close requires a zero balance.");
      return [createCloseAccountInstruction(account, owner, owner, [], program)];
    case "REVOKE":
      return [createRevokeInstruction(account, owner, [], program)];
  }
}

export interface IntegrityResult {
  ok: boolean;
  mismatches: string[];
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function verifyCleanupTransaction(bytes: Uint8Array, intent: CleanupIntent): IntegrityResult {
  const mismatches: string[] = [];
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(bytes);
  } catch {
    return { ok: false, mismatches: ["Transaction bytes could not be parsed."] };
  }
  const msg = tx.message;
  if (msg.version !== "legacy") mismatches.push("Unexpected transaction version.");
  if ("addressTableLookups" in msg && msg.addressTableLookups.length > 0) mismatches.push("Unexpected address lookup tables.");
  if (msg.header.numRequiredSignatures !== 1) mismatches.push("Transaction requires signers other than the wallet.");
  const keys = msg.staticAccountKeys.map((k) => k.toBase58());
  if (keys[0] !== intent.owner) mismatches.push("Fee payer is not the connected wallet.");

  let expected: TransactionInstruction[];
  try {
    expected = buildCleanupInstructions(intent);
  } catch (e) {
    return { ok: false, mismatches: [...mismatches, e instanceof Error ? e.message : "Invalid intent."] };
  }

  const actual = msg.compiledInstructions;
  if (actual.length !== expected.length) {
    mismatches.push(`Expected ${expected.length} instruction(s), found ${actual.length}.`);
  } else {
    actual.forEach((ix, i) => {
      const exp = expected[i];
      const programId = keys[ix.programIdIndex];
      if (programId !== exp.programId.toBase58()) mismatches.push(`Instruction ${i}: program changed.`);
      const accs = ix.accountKeyIndexes.map((k) => keys[k]);
      const expAccs = exp.keys.map((k) => k.pubkey.toBase58());
      if (accs.length !== expAccs.length || accs.some((a, j) => a !== expAccs[j])) {
        mismatches.push(`Instruction ${i}: accounts changed (source/destination/mint/authority).`);
      }
      if (!equalBytes(ix.data, exp.data)) mismatches.push(`Instruction ${i}: data changed (instruction/amount/decimals).`);
    });
  }

  return { ok: mismatches.length === 0, mismatches };
}

export { sha256Hex } from "@/lib/wallet/signing";

/** Hash of the message (what signatures cover), independent of signatures. */
export { messageHashOfTx as messageHashOf } from "@/lib/wallet/signing";
