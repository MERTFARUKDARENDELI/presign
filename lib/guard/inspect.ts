import "server-only";
import { gateFor } from "@/lib/agent/gate";
import { AppError } from "@/lib/api/errors";
import { evaluateGuardAction, evaluateGuardPosture } from "@/lib/security/rules/guard";
import { rpcCall } from "@/lib/solana/client";
import { getCluster } from "@/lib/solana/config";
import { hex } from "@/lib/squads/borsh";
import { analyzeScheduledInstructions, fetchGuardProgramAccount, loadGuard } from "./analyze";
import { decodeActionAccount, decodeGuardAccount } from "./codec";
import { actionPda, GUARD_ACCOUNT_DISCRIMINATOR, guardProgramId, guardSignerPda } from "./constants";
import type { GuardActionInspection, GuardActionSummary, GuardOverview } from "./types";

/** Guard and scheduled-action inspection for the /verify flow. Read-only. */

export const GUARD_OVERVIEW_LIMIT = 15;

export async function inspectGuard(guard: string): Promise<GuardOverview> {
  const programId = guardProgramId();
  if (!programId) throw new AppError("NOT_CONFIGURED", "Presign Guard is not configured on this deployment.");
  const loaded = await loadGuard(guard);
  if (!loaded.account) throw new AppError(loaded.status === "FAILED" ? "RPC_ERROR" : "ACCOUNT_NOT_FOUND", "The guard account could not be loaded.");
  const count = BigInt(loaded.account.actionCount);
  const indexes: bigint[] = [];
  for (let i = count - 1n; i >= 0n && indexes.length < GUARD_OVERVIEW_LIMIT; i--) indexes.push(i);
  const addresses = indexes.map((i) => actionPda(programId, guard, i));
  const actions: GuardActionSummary[] = [];
  if (addresses.length) {
    const res = await rpcCall<{ value: Array<{ data: [string, string]; owner: string } | null> }>("getMultipleAccounts", [addresses, { encoding: "base64", commitment: "confirmed" }]);
    res.result.value.forEach((v, i) => {
      if (!v || v.owner !== programId) return;
      try {
        const a = decodeActionAccount(Uint8Array.from(Buffer.from(v.data[0], "base64")));
        actions.push({ address: addresses[i], index: a.index, status: a.status, scheduledAt: a.scheduledAt, eta: a.eta, memo: a.memo, vetoedBy: a.vetoedBy, instructions: a.instructions.length });
      } catch {
        // closed or unreadable actions are simply not listed
      }
    });
  }
  return { programId, guard, guardSigner: guardSignerPda(programId, guard), account: loaded.account, posture: evaluateGuardPosture(guard, loaded.account), actions, cluster: getCluster(), inspectedAt: new Date().toISOString() };
}

export async function inspectGuardAction(address: string, data?: Uint8Array): Promise<GuardActionInspection> {
  const programId = guardProgramId();
  if (!programId) throw new AppError("NOT_CONFIGURED", "Presign Guard is not configured on this deployment.");
  let bytes = data;
  if (!bytes) {
    const f = await fetchGuardProgramAccount(address);
    if (f.status !== "OK") throw new AppError(f.status === "FAILED" ? "RPC_ERROR" : "ACCOUNT_NOT_FOUND", "The action account could not be loaded.");
    bytes = f.data;
  }
  const action = decodeActionAccount(bytes);
  const loaded = await loadGuard(action.guard);
  const guardSigner = guardSignerPda(programId, action.guard);
  // The proposer (the multisig vault) and the guard's own accounts count as the multisig's side.
  const controlled = new Set([action.guard, guardSigner, ...(loaded.account ? [loaded.account.proposer] : [])]);
  const scheduled = await analyzeScheduledInstructions(action.guard, action.instructions, action.memo, `action #${action.index}`, controlled, new Set());
  const now = BigInt(Math.floor(Date.now() / 1000));
  const risk = evaluateGuardAction(scheduled, action, now);
  return { programId, guard: action.guard, guardSigner, guardAccount: loaded.account, address, action, scheduled, risk, gate: gateFor(risk.level, risk.status), now: now.toString(), cluster: getCluster(), inspectedAt: new Date().toISOString() };
}

/** Recognizes a Guard or Action account by discriminator; null when it is neither. */
export function guardAccountKind(data: Uint8Array): "guard" | "action" | null {
  if (data.length < 8) return null;
  const d = hex(data.subarray(0, 8));
  if (d === GUARD_ACCOUNT_DISCRIMINATOR.Guard) {
    try {
      decodeGuardAccount(data);
      return "guard";
    } catch {
      return null;
    }
  }
  return d === GUARD_ACCOUNT_DISCRIMINATOR.Action ? "action" : null;
}
