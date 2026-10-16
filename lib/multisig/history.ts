import "server-only";
import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { logger } from "@/lib/api/logger";
import { rpcCall } from "@/lib/solana/client";
import { SYSTEM_PROGRAM_ID } from "@/lib/solana/constants";
import { SQUADS_V4_PROGRAM_ID } from "@/lib/squads/constants";
import { decodeSquadsInstruction } from "@/lib/squads/decode";
import { detectOfflineSigner, envelopeLabel, splNonceAdvance, type TopLevelInstruction } from "@/lib/transaction/offline-signers";
import { fetchExecutedTransaction } from "@/lib/transaction/simulate";
import type { NonceSignedAction, ProposalHistory } from "./types";

/**
 * How a proposal's votes reached the chain. A create, approve or execute that
 * landed inside a durable-nonce transaction may have been signed days or weeks
 * before it was submitted: the signature never expired. That is the fingerprint
 * of the Drift Security Council takeover (April 2026), and it is visible in the
 * proposal's own transaction history — no index of nonce accounts needed.
 *
 * Durable nonces are moving into on-chain programs (lib/transaction/offline-signers.ts).
 * A vote sent through one of those arrives by CPI: the member is the authority's
 * programmatic-signer PDA or vector account, and the vote is read from the
 * executed record's inner instructions.
 */

/** Landed transactions checked per proposal (the oldest one, which usually creates it, plus the most recent). */
export const HISTORY_LIMIT = 10;
const SIGNATURE_PAGE = 25;
const CONCURRENCY = 4;
/** SystemInstruction::AdvanceNonceAccount, as a little-endian u32. */
const ADVANCE_NONCE = 4;

type Nonce = Pick<NonceSignedAction, "nonceAccount" | "nonceAuthority" | "envelope">;

/** The runtime only honors a durable nonce advanced by the first instruction. */
function systemNonce(first: TopLevelInstruction | undefined): Nonce | null {
  if (!first || first.programId !== SYSTEM_PROGRAM_ID) return null;
  const d = first.data;
  if (d.length < 4 || d[0] !== ADVANCE_NONCE || d[1] !== 0 || d[2] !== 0 || d[3] !== 0) return null;
  const [nonceAccount, , nonceAuthority] = first.accounts;
  return nonceAccount && nonceAuthority ? { nonceAccount, nonceAuthority, envelope: null } : null;
}

type ResolvedInstruction = { programId: string; accounts: Array<string | null>; data: Uint8Array };

/** Inner (CPI) instructions from a getTransaction record, resolved to addresses; malformed entries are skipped. */
function innerInstructions(raw: unknown, keys: string[]): ResolvedInstruction[] {
  if (!Array.isArray(raw)) return [];
  const out: ResolvedInstruction[] = [];
  for (const group of raw as Array<{ instructions?: unknown }>) {
    if (!Array.isArray(group?.instructions)) continue;
    for (const ix of group.instructions as Array<{ programIdIndex?: unknown; accounts?: unknown; data?: unknown }>) {
      if (typeof ix?.programIdIndex !== "number" || !Array.isArray(ix.accounts) || typeof ix.data !== "string") continue;
      const programId = keys[ix.programIdIndex];
      if (!programId) continue;
      try {
        out.push({ programId, accounts: (ix.accounts as number[]).map((i) => keys[i] ?? null), data: bs58.decode(ix.data) });
      } catch {
        // Not base58: skip it.
      }
    }
  }
  return out;
}

/** The durable nonce (or offline-signer envelope) a landed transaction used to act on `proposal`, or null when it used none or did not touch the proposal. */
export function nonceSignedAction(
  bytes: Uint8Array,
  loaded: { writable: string[]; readonly: string[] } | undefined,
  proposal: string,
  meta: { signature: string; slot: number; blockTime: number | null },
  /** `meta.innerInstructions` of the executed record: where votes sent through an envelope appear. */
  inner?: unknown,
): Omit<NonceSignedAction, "nonceIdleSince"> | null {
  const m = VersionedTransaction.deserialize(bytes).message;
  const keys = [...m.staticAccountKeys.map((k) => k.toBase58()), ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
  const top: TopLevelInstruction[] = m.compiledInstructions.map((ix) => ({ programId: keys[ix.programIdIndex] ?? null, accounts: ix.accountKeyIndexes.map((i) => keys[i] ?? null), data: ix.data }));
  const cpi = innerInstructions(inner, keys);

  let nonce = systemNonce(top[0]);
  const envelope = nonce ? null : detectOfflineSigner(top);
  if (envelope) {
    const advanced = cpi.map((x) => splNonceAdvance(x.programId, x.data, x.accounts.filter((a): a is string => a !== null))).find((x) => x !== null);
    const nonceAccount = envelope.nonceAccount ?? advanced?.nonceAccount;
    const nonceAuthority = envelope.nonceAuthority ?? advanced?.nonceAuthority;
    if (nonceAccount && nonceAuthority) nonce = { nonceAccount, nonceAuthority, envelope: envelopeLabel(envelope) };
  }
  if (!nonce) return null;

  // Squads instructions: top level, then those run by CPI — from the executed record, or else from the envelope's signed bytes.
  const squads = top.filter((ix) => ix.programId === SQUADS_V4_PROGRAM_ID);
  if (envelope) {
    const viaCpi = cpi.filter((ix) => ix.programId === SQUADS_V4_PROGRAM_ID);
    squads.push(...(viaCpi.length ? viaCpi : (envelope.executes ?? []).filter((ix) => ix.programId === SQUADS_V4_PROGRAM_ID)));
  }

  const actions: string[] = [];
  const members = new Set<string>();
  for (const ix of squads) {
    const accounts = ix.accounts;
    if (!accounts.includes(proposal)) continue;
    let decoded: ReturnType<typeof decodeSquadsInstruction> = null;
    try {
      decoded = decodeSquadsInstruction(ix.data, accounts);
    } catch {
      decoded = null;
    }
    if (!decoded) continue;
    actions.push(decoded.name);
    const who = decoded.accounts.member ?? decoded.accounts.creator;
    if (who) members.add(who);
  }
  return actions.length ? { ...meta, ...nonce, actions, members: [...members] } : null;
}

// Landed transactions never change: remember each verdict (bounded).
const checkedCache = new Map<string, NonceSignedAction | null>();
const CACHE_MAX = 1_000;

export function clearProposalHistoryCache() {
  checkedCache.clear();
}

interface SignatureRow {
  signature: string;
  err?: unknown;
}

const isRow = (r: unknown): r is SignatureRow => !!r && typeof r === "object" && typeof (r as SignatureRow).signature === "string";

/** When the nonce account was used before `signature`; null when unknown. */
async function nonceIdleSince(nonceAccount: string, signature: string): Promise<number | null> {
  try {
    const res = await rpcCall<unknown[]>("getSignaturesForAddress", [nonceAccount, { before: signature, limit: 1, commitment: "confirmed" }]);
    const prev = Array.isArray(res.result) ? (res.result[0] as { blockTime?: unknown } | undefined) : undefined;
    return typeof prev?.blockTime === "number" ? prev.blockTime : null;
  } catch {
    return null;
  }
}

async function check(signature: string, proposal: string): Promise<NonceSignedAction | null> {
  if (checkedCache.has(signature)) return checkedCache.get(signature) ?? null;
  const t = await fetchExecutedTransaction(signature);
  const found = nonceSignedAction(t.bytes, t.meta.loadedAddresses, proposal, { signature, slot: t.slot, blockTime: t.blockTime }, (t.meta as { innerInstructions?: unknown }).innerInstructions);
  const result = found ? { ...found, nonceIdleSince: await nonceIdleSince(found.nonceAccount, signature) } : null;
  if (checkedCache.size >= CACHE_MAX) checkedCache.delete(checkedCache.keys().next().value!);
  checkedCache.set(signature, result);
  return result;
}

export async function loadProposalHistory(proposal: string): Promise<ProposalHistory> {
  let rows: SignatureRow[];
  try {
    const res = await rpcCall<unknown[]>("getSignaturesForAddress", [proposal, { limit: SIGNATURE_PAGE, commitment: "confirmed" }]);
    rows = (Array.isArray(res.result) ? res.result : []).filter(isRow);
  } catch {
    logger.warn("multisig.history_unavailable", { stage: "signatures" });
    return { status: "FAILED", checked: 0, nonceSigned: [] };
  }
  // Newest first. Failed transactions changed nothing.
  const landed = rows.filter((r) => r.err === null || r.err === undefined);
  const picked = landed.length > HISTORY_LIMIT ? [...landed.slice(0, HISTORY_LIMIT - 1), landed[landed.length - 1]] : landed;
  let failed = 0;
  const found: NonceSignedAction[] = [];
  for (let i = 0; i < picked.length; i += CONCURRENCY) {
    const batch = await Promise.allSettled(picked.slice(i, i + CONCURRENCY).map((r) => check(r.signature, proposal)));
    for (const b of batch) {
      if (b.status === "rejected") failed++;
      else if (b.value) found.push(b.value);
    }
  }
  if (failed) logger.warn("multisig.history_unavailable", { stage: "transactions", failed });
  const complete = failed === 0 && landed.length === picked.length && rows.length < SIGNATURE_PAGE;
  // Oldest first reads like a timeline.
  found.sort((a, b) => a.slot - b.slot);
  return { status: picked.length > 0 && failed === picked.length ? "FAILED" : complete ? "OK" : "PARTIAL", checked: picked.length - failed, nonceSigned: found };
}
