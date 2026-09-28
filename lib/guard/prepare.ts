import "server-only";
import { PublicKey, Transaction } from "@solana/web3.js";
import { AppError } from "@/lib/api/errors";
import { rpcCall } from "@/lib/solana/client";
import { messageHashOfTx } from "@/lib/wallet/signing";
import { bytesToBase64 } from "@/lib/transaction/input";
import { fetchGuardProgramAccount, loadGuard } from "./analyze";
import { decodeActionAccount, executeInstruction, vetoInstruction } from "./codec";
import { guardProgramId } from "./constants";

/**
 * Builds the unsigned veto or execute transaction for a Guard action. The
 * server checks the preconditions the program will enforce anyway (so the
 * user is not asked to sign something that will fail), never signs, and
 * returns the message hash the submit endpoint re-checks.
 */

export interface PreparedGuardTransaction {
  kind: "veto" | "execute";
  transaction: string;
  messageHash: string;
  summary: string;
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
    ix = vetoInstruction(programId, { guard: action.guard, action: actionAddress, guardian: signer });
    summary = `Veto action #${action.index} of guard ${action.guard}. It will never execute.`;
  } else {
    if (now < BigInt(action.eta)) throw new AppError("INVALID_INPUT", "The delay has not passed yet; this action cannot be executed.");
    ix = executeInstruction(programId, { guard: action.guard, action: { ...action, address: actionAddress } });
    summary = `Execute action #${action.index} of guard ${action.guard} (${action.instructions.length} instruction(s)).`;
  }

  const bh = await rpcCall<{ value: { blockhash: string } }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
  const tx = new Transaction({ feePayer: new PublicKey(signer), recentBlockhash: bh.result.value.blockhash }).add(ix);
  const bytes = new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
  return { kind, transaction: bytesToBase64(bytes), messageHash: await messageHashOfTx(bytes), summary };
}
