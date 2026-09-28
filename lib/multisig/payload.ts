import "server-only";
import { enrichWithAnchorIdl } from "@/lib/anchor/source";
import { analyzeGuardSchedules } from "@/lib/guard/analyze";
import { isAppError } from "@/lib/api/errors";
import { logger } from "@/lib/api/logger";
import { evaluateTransactionRisk } from "@/lib/security/rules/transaction";
import type { AnalysisStatus } from "@/lib/security/types";
import { toVersionedTransaction } from "@/lib/squads/decode";
import { ephemeralSignerPda } from "@/lib/squads/pda";
import type { SquadsMessage } from "@/lib/squads/types";
import { decodeTransaction } from "@/lib/transaction/decoder";
import { applyInnerInstructions } from "@/lib/transaction/inner";
import { resolveLookupTables, simulateTransaction } from "@/lib/transaction/simulate";
import type { DecodedTransaction, TransactionEffects } from "@/lib/transaction/types";
import { findPrivilegedActions } from "./privileged";
import type { VaultPayload } from "./types";

/**
 * Decodes and simulates the transaction a multisig vault would execute.
 * Simulation runs the vault message as-is with one account prepended as fee
 * payer — in reality the member who executes pays the fee, not the vault — so
 * the vault's balance changes show only what the proposal itself does.
 */

/** Prepends a fee payer as the first writable signer; every account index shifts by one. */
export function withFeePayer(m: SquadsMessage, feePayer: string): SquadsMessage {
  if (m.accountKeys.includes(feePayer)) throw new RangeError("Fee payer already in message");
  return {
    numSigners: m.numSigners + 1,
    numWritableSigners: m.numWritableSigners + 1,
    numWritableNonSigners: m.numWritableNonSigners,
    accountKeys: [feePayer, ...m.accountKeys],
    instructions: m.instructions.map((ix) => ({ programIdIndex: ix.programIdIndex + 1, accountIndexes: ix.accountIndexes.map((i) => i + 1), data: ix.data })),
    addressTableLookups: m.addressTableLookups,
  };
}

export interface PayloadContext {
  controlled: ReadonlySet<string>;
  members: ReadonlySet<string>;
  /** Candidate fee payers for simulation, in order of preference (e.g. the signer, then executing members). */
  feePayers: string[];
  label: string;
}

async function simulatePayload(message: SquadsMessage, lookups: { writable: string[]; readonly: string[] } | null, vault: string | null, feePayers: string[]) {
  const feePayer = feePayers.find((f) => !message.accountKeys.includes(f)) ?? null;
  const simMessage = feePayer ? withFeePayer(message, feePayer) : message;
  const tx = toVersionedTransaction(simMessage);
  const decoded = decodeTransaction(tx, lookups ? { loadedAddresses: lookups } : {});
  const sim = await simulateTransaction(tx, decoded, vault ? [vault] : []);
  const notes = sim.effects.notes.filter((n) => !n.includes("blockhash has expired"));
  notes.unshift(feePayer
    ? `Simulated as the vault executing this proposal now; the network fee was charged to ${feePayer} (the executing member pays it in reality).`
    : "Simulated as the vault executing this proposal now, with the vault paying the network fee.");
  return { ...sim, effects: { ...sim.effects, notes, blockhashValid: null }, feePayer };
}

/**
 * The multisig program can only sign for the vault and for this transaction's
 * ephemeral signer PDAs. Any other required signer cannot be provided at execution.
 */
export function foreignSignersOf(message: SquadsMessage, vault: string | null, transaction: string | null, ephemeralSigners: number | null): string[] {
  if (!vault) return [];
  const allowed = new Set([vault, ...(transaction && ephemeralSigners ? Array.from({ length: ephemeralSigners }, (_, i) => ephemeralSignerPda(transaction, i)) : [])]);
  return message.accountKeys.slice(0, message.numSigners).filter((k) => !allowed.has(k));
}

export async function buildVaultPayload(
  base: Pick<VaultPayload, "source" | "transaction" | "transactionIndex" | "vaultIndex" | "vault">,
  message: SquadsMessage,
  ctx: PayloadContext,
  ephemeralSigners: number | null = null,
): Promise<VaultPayload> {
  const payload: VaultPayload = { ...base, status: "UNAVAILABLE", detail: null, decoded: null, privileged: [], effects: null, effectsStatus: "INSUFFICIENT_DATA", simulatedFeePayer: null, risk: null, foreignSigners: foreignSignersOf(message, base.vault, base.transaction, ephemeralSigners) };
  let decoded: DecodedTransaction;
  let lookups: { writable: string[]; readonly: string[] } | null;
  try {
    const tx = toVersionedTransaction(message);
    lookups = await resolveLookupTables(tx);
    decoded = decodeTransaction(tx, lookups ? { loadedAddresses: lookups } : {});
  } catch {
    return { ...payload, status: "MALFORMED", detail: "The proposal's transaction message could not be decoded." };
  }

  let effects: TransactionEffects | null = null;
  let effectsStatus: AnalysisStatus = "INSUFFICIENT_DATA";
  let owners: Record<string, string> = {};
  if (message.instructions.some((ix) => ix.programIdIndex >= message.accountKeys.length)) {
    // Squads can execute programs loaded from lookup tables (via CPI); a regular transaction cannot, so it cannot be simulated as one.
    payload.simulationNote = "Not simulated: the proposal loads a program id from an address lookup table, which only the multisig program can execute.";
  } else {
    try {
      const sim = await simulatePayload(message, lookups, base.vault, ctx.feePayers);
      effects = sim.effects;
      effectsStatus = sim.effects.stale ? "PARTIAL" : "COMPLETE";
      owners = sim.tokenAccountOwners;
      payload.simulatedFeePayer = sim.feePayer;
      applyInnerInstructions(decoded, sim.innerInstructions, "SIMULATION");
    } catch (error) {
      payload.simulationNote = "Not simulated: the simulation could not be performed.";
      if (!isAppError(error) || error.code !== "SIMULATION_FAILED") logger.warn("multisig.payload_simulation_error", { error: error instanceof Error ? error.name : "unknown" });
    }
  }

  await enrichWithAnchorIdl(decoded);
  const partial = !decoded.lookupTablesResolved || decoded.undecodedInstructions.length > 0;
  payload.decoded = decoded;
  payload.status = partial ? "PARTIAL" : "DECODED";
  payload.detail = !decoded.lookupTablesResolved ? "Address lookup tables of the proposal could not be resolved." : decoded.undecodedInstructions.length ? `${decoded.undecodedInstructions.length} instruction(s) of the proposal could not be decoded.` : null;
  payload.privileged = findPrivilegedActions(decoded, ctx.label, ctx.controlled, ctx.members);
  payload.scheduled = await analyzeGuardSchedules(decoded, ctx.controlled, ctx.members, ctx.label);
  payload.effects = effects;
  payload.effectsStatus = effectsStatus;
  if (base.vault) {
    payload.risk = evaluateTransactionRisk({ decoded, effects, wallet: base.vault, tokenAccountOwners: owners, effectsStatus });
  }
  return payload;
}
