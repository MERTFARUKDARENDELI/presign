import "server-only";
import { enrichWithAnchorIdl } from "@/lib/anchor/source";
import { findPrivilegedActions } from "@/lib/multisig/privileged";
import { rpcCall } from "@/lib/solana/client";
import { decodeInnerRaw } from "@/lib/transaction/decoder";
import type { DecodedTransaction } from "@/lib/transaction/types";
import { decodeGuardAccount, type GuardAccountData, type GuardInstructionData } from "./codec";
import { guardProgramId, guardSignerPda } from "./constants";
import type { ScheduledActions } from "./types";

/**
 * Finds Presign Guard `schedule` instructions in a decoded transaction (or a
 * multisig payload) and analyzes what they schedule, with the guard's delay
 * and guardians loaded from chain. Scheduled instructions run later; their
 * authority changes are classified exactly like immediate ones.
 */

export type GuardFetch = { status: "OK"; data: Uint8Array } | { status: "NOT_FOUND" } | { status: "FAILED" };

/** Loads an account only if the Guard program owns it. */
export async function fetchGuardProgramAccount(address: string): Promise<GuardFetch> {
  const programId = guardProgramId();
  if (!programId) return { status: "NOT_FOUND" };
  try {
    const res = await rpcCall<{ value: { data: [string, string]; owner: string } | null }>("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }]);
    const v = res.result?.value;
    if (!v || v.owner !== programId) return { status: "NOT_FOUND" };
    return { status: "OK", data: Uint8Array.from(Buffer.from(v.data[0], "base64")) };
  } catch {
    return { status: "FAILED" };
  }
}

export async function loadGuard(address: string): Promise<{ account: GuardAccountData | null; status: ScheduledActions["guardStatus"] }> {
  const f = await fetchGuardProgramAccount(address);
  if (f.status !== "OK") return { account: null, status: f.status };
  try {
    return { account: decodeGuardAccount(f.data), status: "OK" };
  } catch {
    return { account: null, status: "FAILED" };
  }
}

function emptyDecoded(): DecodedTransaction {
  return { version: 0, transactionConfig: null, feePayer: "", signers: [], signaturesPresent: 0, recentBlockhash: "", accounts: [], instructions: [], programs: [], solTransfers: [], tokenTransfers: [], approvals: [], authorityChanges: [], closes: [], usesDurableNonce: false, lookupTablesResolved: true, undecodedInstructions: [], innerInstructions: [], innerInstructionsSource: "NONE" };
}

/** Decodes scheduled instructions as top-level instructions of a pseudo transaction (with their declared account flags). */
export function decodeScheduled(instructions: GuardInstructionData[]): DecodedTransaction {
  const out = emptyDecoded();
  instructions.forEach((ix, i) => {
    const d = decodeInnerRaw(ix.programId, ix.accounts.map((a) => a.pubkey), ix.data, i, null, out);
    out.instructions.push({
      ...d,
      index: i,
      parentIndex: undefined,
      stackHeight: undefined,
      accounts: d.accounts.map((a, j) => ({ ...a, signer: ix.accounts[j]?.isSigner ?? false, writable: ix.accounts[j]?.isWritable ?? false })),
    });
    if (!d.parsed) out.undecodedInstructions.push(i);
  });
  // Effects of scheduled instructions are direct actions of the guard signer, not program-internal calls.
  for (const list of [out.solTransfers, out.tokenTransfers, out.approvals, out.authorityChanges, out.closes]) for (const e of list) delete e.cpi;
  const seen = new Set<string>();
  for (const ix of out.instructions) {
    if (seen.has(ix.programId)) continue;
    seen.add(ix.programId);
    out.programs.push({ programId: ix.programId, name: ix.programName, trust: ix.programTrust });
  }
  return out;
}

function parseScheduled(json: string | null | undefined): GuardInstructionData[] | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as Array<{ programId: string; accounts: GuardInstructionData["accounts"]; data: string }>;
    return raw.map((ix) => ({ programId: ix.programId, accounts: ix.accounts, data: Uint8Array.from(Buffer.from(ix.data, "base64")) }));
  } catch {
    return null;
  }
}

export async function analyzeScheduledInstructions(
  guard: string,
  instructions: GuardInstructionData[],
  memo: string,
  origin: string,
  controlled: ReadonlySet<string>,
  members: ReadonlySet<string>,
): Promise<ScheduledActions> {
  const programId = guardProgramId()!;
  const guardSigner = guardSignerPda(programId, guard);
  const loaded = await loadGuard(guard);
  const decoded = decodeScheduled(instructions);
  await enrichWithAnchorIdl(decoded);
  // The guard signer (and the guard itself) are controlled by whoever controls the guard's proposer.
  const withGuard = new Set([...controlled, guardSigner, guard]);
  return { guard, guardSigner, guardAccount: loaded.account, guardStatus: loaded.status, memo, origin, decoded, privileged: findPrivilegedActions(decoded, `${origin}, scheduled via Guard, `, withGuard, members) };
}

/** Every Guard schedule inside a decoded transaction or payload. */
export async function analyzeGuardSchedules(decoded: DecodedTransaction, controlled: ReadonlySet<string>, members: ReadonlySet<string>, originPrefix: string): Promise<ScheduledActions[]> {
  const programId = guardProgramId();
  if (!programId) return [];
  const out: ScheduledActions[] = [];
  for (const ix of decoded.instructions) {
    if (ix.programId !== programId || ix.type !== "guard:schedule") continue;
    const guard = ix.accounts[0]?.address;
    const instructions = parseScheduled(ix.info._scheduled);
    if (!guard || !instructions) continue;
    out.push(await analyzeScheduledInstructions(guard, instructions, ix.info.memo ?? "", `${originPrefix}instruction ${ix.index}`, controlled, members));
  }
  return out;
}
