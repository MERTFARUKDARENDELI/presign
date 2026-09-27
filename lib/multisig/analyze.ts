import "server-only";
import type { VersionedTransaction } from "@solana/web3.js";
import { logger } from "@/lib/api/logger";
import { SQUADS_V4_PROGRAM_ID } from "@/lib/squads/constants";
import {
  decodeConfigTransactionAccount,
  decodeMultisigAccount,
  decodeProposalAccount,
  decodeSquadsInstruction,
  decodeTransactionBufferAccount,
  decodeVaultTransactionAccount,
  parseTransactionMessage,
} from "@/lib/squads/decode";
import { controlledAddresses, transactionPda, vaultPda } from "@/lib/squads/pda";
import type { MultisigAccount, SquadsInstruction } from "@/lib/squads/types";
import type { DecodedTransaction } from "@/lib/transaction/types";
import { fetchSquadsAccount, type SquadsFetch } from "./chain";
import { buildVaultPayload, type PayloadContext } from "./payload";
import { findPrivilegedActions } from "./privileged";
import type { MultisigAnalysis, ProposalRef, VaultPayload } from "./types";

/**
 * Multisig layer of the transaction pipeline. For every Squads instruction in
 * the analyzed transaction it loads what a signer is actually agreeing to —
 * the multisig configuration, the proposal and the vault transaction it will
 * execute — then decodes and simulates that payload like any other
 * transaction. Anything that cannot be loaded is reported, never assumed.
 */

export async function loadMultisigAccount(address: string): Promise<{ account: MultisigAccount | null; status: MultisigAnalysis["accountStatus"] }> {
  const acc = await fetchSquadsAccount(address);
  if (acc.status !== "OK") return { account: null, status: acc.status === "FAILED" ? "FAILED" : "NOT_FOUND" };
  try {
    return { account: decodeMultisigAccount(acc.data), status: "OK" };
  } catch {
    return { account: null, status: "FAILED" };
  }
}

export function proposalRefFrom(address: string, acc: SquadsFetch): ProposalRef {
  if (acc.status !== "OK") return { address, transactionIndex: null, status: acc.status === "FAILED" ? "FAILED" : "NOT_FOUND", account: null };
  try {
    const account = decodeProposalAccount(acc.data);
    return { address, transactionIndex: account.transactionIndex, status: "OK", account };
  } catch {
    return { address, transactionIndex: null, status: "FAILED", account: null };
  }
}

/** Members that can execute come first: in reality one of them pays the execution fee. */
export function feePayerCandidates(account: MultisigAccount | null, preferred: string[] = []): string[] {
  const executors = account?.members.filter((m) => m.permissions.includes("Execute")).map((m) => m.key) ?? [];
  return [...new Set([...preferred, ...executors, ...(account?.members.map((m) => m.key) ?? [])])];
}

/** Payload stored in a VaultTransaction / ConfigTransaction account. Config actions are appended to `configActions`. */
export async function payloadFromTransactionAccount(
  txAddr: string,
  transactionIndex: string | null,
  acc: SquadsFetch,
  ctx: Omit<PayloadContext, "label">,
  configActions: MultisigAnalysis["configActions"],
): Promise<VaultPayload | null> {
  const empty: VaultPayload = { source: "TRANSACTION_ACCOUNT", transaction: txAddr, transactionIndex, vaultIndex: null, vault: null, status: "UNAVAILABLE", detail: null, decoded: null, privileged: [] };
  if (acc.status !== "OK") {
    return { ...empty, detail: acc.status === "NOT_FOUND" ? "The proposal's transaction account does not exist (not created yet, or already closed after execution)." : "The proposal's transaction account could not be loaded." };
  }
  try {
    const vt = decodeVaultTransactionAccount(acc.data);
    const vault = vaultPda(vt.multisig, vt.vaultIndex);
    return await buildVaultPayload({ source: "TRANSACTION_ACCOUNT", transaction: txAddr, transactionIndex: vt.index, vaultIndex: vt.vaultIndex, vault }, vt.message, { ...ctx, label: `proposal #${vt.index}, ` }, vt.ephemeralSignerCount);
  } catch {
    try {
      const ct = decodeConfigTransactionAccount(acc.data);
      for (const action of ct.actions) configActions.push({ origin: `config transaction #${ct.index}`, action });
      return null;
    } catch {
      return { ...empty, status: "MALFORMED", detail: "The proposal's transaction account could not be decoded." };
    }
  }
}

export async function analyzeMultisig(tx: VersionedTransaction, decoded: DecodedTransaction, signer: string | null = null): Promise<MultisigAnalysis | null> {
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
  if (squads.length === 0 && malformed.length === 0) return null;

  const multisig = squads.find((s) => s.ix.accounts.multisig)?.ix.accounts.multisig ?? null;
  const controlled = multisig ? controlledAddresses(multisig) : [];
  const loaded = multisig ? await loadMultisigAccount(multisig) : { account: null, status: "NOT_FOUND" as const };
  const out: MultisigAnalysis = {
    programId: SQUADS_V4_PROGRAM_ID,
    multisig,
    account: loaded.account,
    accountStatus: loaded.status,
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
  const ctx: Omit<PayloadContext, "label"> = {
    controlled: new Set(controlled),
    members: new Set(out.account?.members.map((m) => m.key) ?? []),
    feePayers: feePayerCandidates(out.account, signer ? [signer] : []),
  };

  // Proposals referenced by this transaction. Those created here are not on-chain yet (pre-sign).
  const created = new Map(squads.filter((s) => s.ix.name === "proposalCreate").map((s) => [s.ix.accounts.proposal ?? "", s.ix.transactionIndex]));
  for (const address of [...new Set(squads.map((s) => s.ix.accounts.proposal).filter((p): p is string => Boolean(p)))]) {
    out.proposals.push(created.has(address) ? { address, transactionIndex: created.get(address) ?? null, status: "CREATED_IN_THIS_TX", account: null } : proposalRefFrom(address, await fetchSquadsAccount(address)));
  }

  // Payloads carried directly by instruction arguments (or a transaction buffer).
  const payloadFor = new Set<string>();
  for (const { index, ix } of squads) {
    if (ix.kind === "create-vault-transaction") {
      const transaction = ix.accounts.transaction ?? null;
      const transactionIndex = [...created.values()].find((i) => i && multisig && transactionPda(multisig, i) === transaction) ?? null;
      const vault = multisig && ix.vaultIndex !== null ? vaultPda(multisig, ix.vaultIndex) : null;
      const base = { source: "INSTRUCTION" as VaultPayload["source"], transaction, transactionIndex, vaultIndex: ix.vaultIndex, vault };
      let message = ix.message;
      if (!message && ix.accounts.transactionBuffer) {
        base.source = "BUFFER_ACCOUNT";
        const buf = await fetchSquadsAccount(ix.accounts.transactionBuffer);
        try {
          message = buf.status === "OK" ? parseTransactionMessage(decodeTransactionBufferAccount(buf.data).buffer) : null;
        } catch {
          message = null;
        }
      }
      const payload = message
        ? await buildVaultPayload(base, message, { ...ctx, label: transactionIndex ? `proposal #${transactionIndex}, ` : "proposal, " }, Number(ix.extra.ephemeralSigners ?? 0))
        : { ...base, status: "UNAVAILABLE" as const, detail: base.source === "BUFFER_ACCOUNT" ? "The proposal is stored in a transaction buffer that could not be loaded." : "The proposal carries no transaction message.", decoded: null, privileged: [] };
      if (transaction) payloadFor.add(transaction);
      out.payloads.push(payload);
      logger.info("multisig.payload", { index, source: payload.source, status: payload.status });
    }
    for (const action of ix.configActions) out.configActions.push({ origin: `instruction ${index} (${ix.name})`, action });
  }

  // Payloads of existing proposals this transaction votes on or executes: load them from chain.
  const toLoad = new Map<string, string | null>();
  for (const { ix } of squads) {
    if (!multisig || !["vote", "execute", "activate-proposal"].includes(ix.kind)) continue;
    const proposal = out.proposals.find((p) => p.address === ix.accounts.proposal);
    const txAddr = ix.accounts.transaction ?? (proposal?.transactionIndex ? transactionPda(multisig, proposal.transactionIndex) : null);
    if (txAddr && !payloadFor.has(txAddr)) toLoad.set(txAddr, proposal?.transactionIndex ?? null);
  }
  for (const [txAddr, transactionIndex] of toLoad) {
    const payload = await payloadFromTransactionAccount(txAddr, transactionIndex, await fetchSquadsAccount(txAddr), ctx, out.configActions);
    if (payload) out.payloads.push(payload);
  }

  // Already-executed or simulated execution: the vault's calls appear as CPIs of the execute instruction.
  const execIdx = new Set(squads.filter((s) => s.ix.kind === "execute").map((s) => s.index));
  const cpi = findPrivilegedActions(decoded, "", ctx.controlled, ctx.members, (i) => i.parentIndex !== undefined && execIdx.has(i.parentIndex) && i.programId !== SQUADS_V4_PROGRAM_ID);
  if (cpi.length) {
    out.payloads.push({ source: "EXECUTION_CPI", transaction: null, transactionIndex: null, vaultIndex: null, vault: null, status: "DECODED", detail: decoded.innerInstructionsSource === "EXECUTED" ? "Observed in the executed transaction record." : "Observed in simulation.", decoded: null, privileged: cpi });
  }
  return out;
}
