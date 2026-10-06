import "server-only";
import { PublicKey, Transaction } from "@solana/web3.js";
import { AppError } from "@/lib/api/errors";
import { openToken, sealToken } from "@/lib/presign/tokens";
import { rpcCall } from "@/lib/solana/client";
import { messageHashOfTx } from "@/lib/wallet/signing";
import { bytesToBase64 } from "@/lib/transaction/input";
import { fetchGuardProgramAccount, loadGuard } from "./analyze";
import { decodeActionAccount, decodeGuardInstruction, executeInstruction, vetoInstruction, type ActionAccountData, type GuardAccountData } from "./codec";
import { guardProgramId } from "./constants";

/**
 * Builds the unsigned veto or execute transaction for a Guard action. The
 * server checks the preconditions the program will enforce anyway (so the
 * user is not asked to sign something that will fail), never signs, and
 * returns the message hash plus a sealed "prepared" token: the submit endpoint
 * relays the signed transaction only if its message is the one prepared here.
 */

export interface PreparedGuardTransaction {
  kind: "veto" | "execute";
  transaction: string;
  messageHash: string;
  summary: string;
  /** Server-sealed proof that Presign prepared exactly this message; required by /api/transaction/submit. */
  preparedToken: string;
}

export const PREPARED_TTL_MS = 5 * 60_000;

interface SealedPrepared {
  mh: string;
  s: string;
  k: "veto" | "execute";
}

/** Submission check for a Guard transaction: the token must be genuine, unexpired and for this exact message. */
export function verifyPreparedForSubmit(preparedToken: string, expectedMessageHash: string, now: number = Date.now()): void {
  const opened = openToken<SealedPrepared>("prepared", preparedToken, now);
  if (!opened.ok) {
    throw new AppError("SECURITY_BLOCK", opened.reason === "EXPIRED" ? "The prepared transaction expired. Prepare it again; it was not submitted." : "The prepared-transaction token is invalid. It was not submitted.", { reason: opened.reason === "EXPIRED" ? "REQUEST_EXPIRED" : "REQUEST_INVALID" });
  }
  if (opened.data.mh !== expectedMessageHash) {
    throw new AppError("SECURITY_BLOCK", "The transaction differs from the one Presign prepared. It was not submitted.", { reason: "PAYLOAD_MISMATCH" });
  }
}

/**
 * Mirrors the program's veto rule: a guardian cannot veto an action whose single instruction is an update_config
 * that removes that guardian and weakens nothing else (same proposer, delay not shortened, every other guardian kept).
 */
export function removesOnlyGuardian(action: ActionAccountData, guard: GuardAccountData, guardian: string, programId: string): boolean {
  if (action.instructions.length !== 1) return false;
  const [ix] = action.instructions;
  if (ix.programId !== programId) return false;
  const g = decodeGuardInstruction(ix.data);
  if (g?.name !== "updateConfig") return false;
  const next = g.config;
  return (
    !next.guardians.includes(guardian) &&
    next.proposer === guard.proposer &&
    next.delaySeconds >= guard.delaySeconds &&
    guard.guardians.every((k) => k === guardian || next.guardians.includes(k))
  );
}

export async function prepareGuardTransaction(kind: "veto" | "execute", actionAddress: string, signer: string): Promise<PreparedGuardTransaction> {
  const programId = guardProgramId();
  if (!programId) throw new AppError("NOT_CONFIGURED", "Presign Guard is not configured on this deployment.");
  const f = await fetchGuardProgramAccount(actionAddress);
  if (f.status !== "OK") throw new AppError(f.status === "FAILED" ? "RPC_ERROR" : "ACCOUNT_NOT_FOUND", "The action account could not be loaded.");
  let action;
  try {
    action = decodeActionAccount(f.data);
  } catch {
    throw new AppError("INVALID_INPUT", "This address is not a Guard action.");
  }
  if (action.status !== "Pending") throw new AppError("INVALID_INPUT", `This action is already ${action.status.toLowerCase()}.`);

  const now = BigInt(Math.floor(Date.now() / 1000));
  let ix;
  let summary: string;
  if (kind === "veto") {
    const guard = await loadGuard(action.guard);
    if (!guard.account) throw new AppError("RPC_ERROR", "The guard account could not be loaded.");
    if (!guard.account.guardians.includes(signer)) throw new AppError("OWNERSHIP_MISMATCH", "The connected wallet is not a guardian of this guard.");
    if (removesOnlyGuardian(action, guard.account, signer, programId)) {
      throw new AppError("INVALID_INPUT", "This action only removes your key as a guardian. The program does not let a guardian block its own removal; any other guardian can still veto it.");
    }
    ix = vetoInstruction(programId, { guard: action.guard, action: actionAddress, guardian: signer });
    summary = `Veto action #${action.index} of guard ${action.guard}. It will never execute.`;
  } else {
    if (now < BigInt(action.eta)) throw new AppError("INVALID_INPUT", "The delay has not passed yet; this action cannot be executed.");
    ix = executeInstruction(programId, { guard: action.guard, action: { ...action, address: actionAddress } });
    summary = `Execute action #${action.index} of guard ${action.guard} (${action.instructions.length} instruction(s)).`;
  }

  const bh = await rpcCall<{ value: { blockhash: string } }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
  const tx = new Transaction({ feePayer: new PublicKey(signer), recentBlockhash: bh.result.value.blockhash }).add(ix);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
  } catch {
    // One transaction holds about 30 distinct accounts; the program accepts actions that reference more.
    throw new AppError("INVALID_INPUT", "This action references more accounts than fit in one transaction, so it cannot be executed from here.");
  }
  const messageHash = await messageHashOfTx(bytes);
  const preparedToken = sealToken<SealedPrepared>("prepared", { mh: messageHash, s: signer, k: kind }, PREPARED_TTL_MS);
  return { kind, transaction: bytesToBase64(bytes), messageHash, summary, preparedToken };
}
