import "server-only";
import type { VersionedTransaction } from "@solana/web3.js";
import { enrichWithAnchorIdl } from "@/lib/anchor/source";
import { logger } from "@/lib/api/logger";
import { rpcCall } from "@/lib/solana/client";
import { SQUADS_V4_PROGRAM_ID } from "@/lib/squads/constants";
import {
  decodeConfigTransactionAccount,
  decodeMultisigAccount,
  decodeProposalAccount,
  decodeSquadsInstruction,
  decodeTransactionBufferAccount,
  decodeVaultTransactionAccount,
  parseTransactionMessage,
  toVersionedTransaction,
} from "@/lib/squads/decode";
import { controlledAddresses, transactionPda, vaultPda } from "@/lib/squads/pda";
import type { SquadsInstruction, SquadsMessage } from "@/lib/squads/types";
import { decodeTransaction } from "@/lib/transaction/decoder";
import { resolveLookupTables } from "@/lib/transaction/simulate";
import type { DecodedTransaction } from "@/lib/transaction/types";
import { findPrivilegedActions } from "./privileged";
import type { MultisigAnalysis, ProposalRef, VaultPayload } from "./types";

/**
 * Multisig layer of the analysis pipeline. For every Squads instruction in the
 * analyzed transaction it loads what a signer is actually agreeing to — the
 * multisig configuration, the proposal and the vault transaction it will
 * execute — and decodes that payload with the same decoder as any other
 * transaction. Anything that cannot be loaded is reported, never assumed.
 */

type FetchResult = { status: "OK"; data: Uint8Array } | { status: "NOT_FOUND" } | { status: "FAILED" } | { status: "WRONG_OWNER" };

async function fetchSquadsAccount(address: string): Promise<FetchResult> {
  try {
    const res = await rpcCall<{ value: { data: [string, string]; owner: string } | null }>("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }]);
    const v = res.result?.value;
    if (!v) return { status: "NOT_FOUND" };
    // Only accounts owned by the Squads program can be Squads state.
    if (v.owner !== SQUADS_V4_PROGRAM_ID) return { status: "WRONG_OWNER" };
    return { status: "OK", data: Uint8Array.from(Buffer.from(v.data[0], "base64")) };
  } catch {
    return { status: "FAILED" };
  }
}

async function decodePayloadMessage(message: SquadsMessage): Promise<{ decoded: DecodedTransaction; status: VaultPayload["status"]; detail: string | null }> {
  const tx = toVersionedTransaction(message);
  const lookups = await resolveLookupTables(tx);
  const decoded = decodeTransaction(tx, lookups ? { loadedAddresses: lookups } : {});
  await enrichWithAnchorIdl(decoded);
  const partial = !decoded.lookupTablesResolved || decoded.undecodedInstructions.length > 0;
  return {
    decoded,
    status: partial ? "PARTIAL" : "DECODED",
    detail: !decoded.lookupTablesResolved ? "Address lookup tables of the proposal could not be resolved." : decoded.undecodedInstructions.length ? `${decoded.undecodedInstructions.length} instruction(s) of the proposal could not be decoded.` : null,
  };
}

export async function analyzeMultisig(tx: VersionedTransaction, decoded: DecodedTransaction): Promise<MultisigAnalysis | null> {
  const keys = decoded.accounts.map((a) => a.address);
  const squads: Array<{ index: number; ix: SquadsInstruction }> = [];
  const malformed: number[] = [];
  tx.message.compiledInstructions.forEach((cix, index) => {
    if (keys[cix.programIdIndex] !== SQUADS_V4_PROGRAM_ID) return;
    try {
      const ix = decodeSquadsInstruction(cix.data, cix.accountKeyIndexes.map((k) => keys[k] ?? null));
      if (ix) squads.push({ index, ix });
      else malformed.push(index);
    } catch {
      malformed.push(index);
    }
  });
  const hasExecutionCpi = decoded.innerInstructions.some((i) => i.parentIndex !== undefined && keys[tx.message.compiledInstructions[i.parentIndex]?.programIdIndex] === SQUADS_V4_PROGRAM_ID);
  if (squads.length === 0 && malformed.length === 0) return null;

  const multisig = squads.find((s) => s.ix.accounts.multisig)?.ix.accounts.multisig ?? null;
  const controlled = multisig ? controlledAddresses(multisig) : [];
  const out: MultisigAnalysis = {
    programId: SQUADS_V4_PROGRAM_ID,
    multisig,
    account: null,
    accountStatus: "FAILED",
    instructions: squads.map(({ index, ix }) => ({
      index,
      name: ix.name,
      kind: ix.kind,
      vote: ix.vote,
      proposal: ix.accounts.proposal ?? null,
      transactionIndex: ix.transactionIndex,
      member: ix.accounts.member ?? ix.accounts.creator ?? ix.accounts.configAuthority ?? null,
    })),
    proposals: [],
    payloads: [],
    configActions: [],
    controlled,
    malformed,
  };

  if (multisig) {
    const acc = await fetchSquadsAccount(multisig);
    if (acc.status === "OK") {
      try {
        out.account = decodeMultisigAccount(acc.data);
        out.accountStatus = "OK";
      } catch {
        out.accountStatus = "FAILED";
      }
    } else {
      out.accountStatus = acc.status === "FAILED" ? "FAILED" : "NOT_FOUND";
    }
  }
  const members = new Set(out.account?.members.map((m) => m.key) ?? []);
  const controlledSet = new Set(controlled);

  // Proposals referenced by this transaction. Those created here are not on-chain yet (pre-sign).
  const created = new Map(squads.filter((s) => s.ix.name === "proposalCreate").map((s) => [s.ix.accounts.proposal ?? "", s.ix.transactionIndex]));
  for (const address of [...new Set(squads.map((s) => s.ix.accounts.proposal).filter((p): p is string => Boolean(p)))]) {
    if (created.has(address)) {
      out.proposals.push({ address, transactionIndex: created.get(address) ?? null, status: "CREATED_IN_THIS_TX", account: null });
      continue;
    }
    const acc = await fetchSquadsAccount(address);
    let ref: ProposalRef = { address, transactionIndex: null, status: acc.status === "OK" ? "FAILED" : acc.status === "FAILED" ? "FAILED" : "NOT_FOUND", account: null };
    if (acc.status === "OK") {
      try {
        const account = decodeProposalAccount(acc.data);
        ref = { address, transactionIndex: account.transactionIndex, status: "OK", account };
      } catch {
        // stays FAILED
      }
    }
    out.proposals.push(ref);
  }

  // Payloads carried directly by instruction arguments.
  const payloadFor = new Set<string>();
  for (const { index, ix } of squads) {
    if (ix.kind === "create-vault-transaction" || ix.name === "batchAddTransaction") {
      const transaction = ix.accounts.transaction ?? null;
      const transactionIndex = [...created.values()].find((i) => i && multisig && transactionPda(multisig, i) === transaction) ?? null;
      const vaultIndex = ix.vaultIndex;
      const payload: VaultPayload = { source: "INSTRUCTION", transaction, transactionIndex, vaultIndex, vault: multisig && vaultIndex !== null ? vaultPda(multisig, vaultIndex) : null, status: "UNAVAILABLE", detail: null, decoded: null, privileged: [] };
      let message = ix.message;
      if (!message && ix.accounts.transactionBuffer) {
        payload.source = "BUFFER_ACCOUNT";
        const buf = await fetchSquadsAccount(ix.accounts.transactionBuffer);
        try {
          message = buf.status === "OK" ? parseTransactionMessage(decodeTransactionBufferAccount(buf.data).buffer) : null;
        } catch {
          message = null;
        }
        if (!message) payload.detail = "The proposal is stored in a transaction buffer that could not be loaded.";
      }
      if (message) {
        try {
          Object.assign(payload, await decodePayloadMessage(message));
        } catch {
          payload.status = "MALFORMED";
          payload.detail = "The proposal's transaction message could not be decoded.";
        }
      }
      if (transaction) payloadFor.add(transaction);
      out.payloads.push(payload);
      logger.info("multisig.payload", { index, source: payload.source, status: payload.status });
    }
    if (ix.configActions.length) {
      for (const action of ix.configActions) out.configActions.push({ origin: `instruction ${index} (${ix.name})`, action });
    }
  }

  // Payloads of existing proposals this transaction votes on or executes: load them from chain.
  const toLoad = new Map<string, { transactionIndex: string | null }>();
  for (const { ix } of squads) {
    if (!multisig || !["vote", "execute", "activate-proposal"].includes(ix.kind)) continue;
    const proposal = out.proposals.find((p) => p.address === ix.accounts.proposal);
    const txAddr = ix.accounts.transaction ?? (proposal?.transactionIndex ? transactionPda(multisig, proposal.transactionIndex) : null);
    if (txAddr && !payloadFor.has(txAddr)) toLoad.set(txAddr, { transactionIndex: proposal?.transactionIndex ?? null });
  }
  for (const [txAddr, meta] of toLoad) {
    const acc = await fetchSquadsAccount(txAddr);
    const payload: VaultPayload = { source: "TRANSACTION_ACCOUNT", transaction: txAddr, transactionIndex: meta.transactionIndex, vaultIndex: null, vault: null, status: "UNAVAILABLE", detail: null, decoded: null, privileged: [] };
    if (acc.status !== "OK") {
      payload.detail = acc.status === "NOT_FOUND" ? "The proposal's transaction account does not exist (not created yet, or already closed after execution)." : "The proposal's transaction account could not be loaded.";
      out.payloads.push(payload);
      continue;
    }
    try {
      const vt = decodeVaultTransactionAccount(acc.data);
      payload.transactionIndex = vt.index;
      payload.vaultIndex = vt.vaultIndex;
      payload.vault = vaultPda(vt.multisig, vt.vaultIndex);
      Object.assign(payload, await decodePayloadMessage(vt.message));
      out.payloads.push(payload);
    } catch {
      try {
        const ct = decodeConfigTransactionAccount(acc.data);
        for (const action of ct.actions) out.configActions.push({ origin: `config transaction #${ct.index}`, action });
      } catch {
        payload.status = "MALFORMED";
        payload.detail = "The proposal's transaction account could not be decoded.";
        out.payloads.push(payload);
      }
    }
  }

  // Already-executed or simulated execution: the vault's calls appear as CPIs of the execute instruction.
  if (hasExecutionCpi) {
    const execIdx = new Set(squads.filter((s) => s.ix.kind === "execute").map((s) => s.index));
    const cpi = findPrivilegedActions(decoded, "", controlledSet, members, (i) => i.parentIndex !== undefined && execIdx.has(i.parentIndex) && i.programId !== SQUADS_V4_PROGRAM_ID);
    if (cpi.length) out.payloads.push({ source: "EXECUTION_CPI", transaction: null, transactionIndex: null, vaultIndex: null, vault: null, status: "DECODED", detail: decoded.innerInstructionsSource === "EXECUTED" ? "Observed in the executed transaction record." : "Observed in simulation.", decoded: null, privileged: cpi });
  }

  for (const p of out.payloads) {
    if (!p.decoded) continue;
    const label = p.transactionIndex ? `proposal #${p.transactionIndex}, ` : "proposal, ";
    p.privileged = findPrivilegedActions(p.decoded, label, controlledSet, members);
  }
  return out;
}
