import "server-only";
import type { VersionedTransaction } from "@solana/web3.js";
import { logger } from "@/lib/api/logger";
import { hex } from "@/lib/squads/borsh";
import { SQUADS_ACCOUNT_DISCRIMINATOR, SQUADS_BATCH_LIMIT, SQUADS_V4_PROGRAM_ID } from "@/lib/squads/constants";
import {
  decodeBatchAccount,
  decodeConfigTransactionAccount,
  decodeMultisigAccount,
  decodeProposalAccount,
  decodeSquadsInstruction,
  decodeTransactionBufferAccount,
  decodeVaultBatchTransactionAccount,
  decodeVaultTransactionAccount,
  parseTransactionMessage,
} from "@/lib/squads/decode";
import { batchTransactionPda, controlledAddresses, transactionPda, vaultPda } from "@/lib/squads/pda";
import type { BatchAccount, MultisigAccount, SquadsInstruction } from "@/lib/squads/types";
import type { DecodedTransaction } from "@/lib/transaction/types";
import { fetchSquadsAccount, fetchSquadsAccounts, type SquadsFetch } from "./chain";
import { buildVaultPayload, type PayloadContext } from "./payload";
import { markGuardHolders } from "@/lib/guard/holders";
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

async function batchPayloads(batch: BatchAccount, ctx: Omit<PayloadContext, "label">, only: string | null = null): Promise<VaultPayload[]> {
  const vault = vaultPda(batch.multisig, batch.vaultIndex);
  const indexes = Array.from({ length: Math.min(batch.size, SQUADS_BATCH_LIMIT) }, (_, i) => i + 1);
  const addrs = indexes.map((i) => batchTransactionPda(batch.multisig, batch.index, i));
  const wanted = only ? addrs.filter((a) => a === only) : addrs;
  const fetched = await fetchSquadsAccounts(only && wanted.length === 0 ? [only] : wanted);
  const out: VaultPayload[] = [];
  for (const addr of fetched.keys()) {
    const n = addrs.indexOf(addr) + 1 || null;
    const label = `batch #${batch.index}${n ? `.${n}` : ""}`;
    const base = { source: "TRANSACTION_ACCOUNT" as const, transaction: addr, transactionIndex: `${batch.index}${n ? `.${n}` : ""}`, vaultIndex: batch.vaultIndex, vault };
    const f = fetched.get(addr)!;
    try {
      if (f.status !== "OK") throw new Error("missing");
      const bt = decodeVaultBatchTransactionAccount(f.data);
      out.push(await buildVaultPayload(base, bt.message, { ...ctx, label: `${label}, ` }, bt.ephemeralSignerCount));
    } catch {
      out.push({ ...base, status: f.status === "OK" ? "MALFORMED" : "UNAVAILABLE", detail: f.status === "OK" ? "A batch transaction could not be decoded." : "A batch transaction account does not exist (not added yet, or closed after execution).", decoded: null, privileged: [] });
    }
  }
  if (!only && batch.size > SQUADS_BATCH_LIMIT) {
    out.push({ source: "TRANSACTION_ACCOUNT", transaction: null, transactionIndex: batch.index, vaultIndex: batch.vaultIndex, vault, status: "PARTIAL", detail: `Only the first ${SQUADS_BATCH_LIMIT} of ${batch.size} batch transactions were inspected.`, decoded: null, privileged: [] });
  }
  return out;
}

/**
 * Payloads stored at a proposal's transaction address: a VaultTransaction, a
 * Batch (each of its transactions), a single VaultBatchTransaction (needs its
 * batch for the vault), or a ConfigTransaction (actions go to `configActions`).
 */
export async function payloadsFromTransactionAccount(
  txAddr: string,
  transactionIndex: string | null,
  acc: SquadsFetch,
  ctx: Omit<PayloadContext, "label">,
  configActions: MultisigAnalysis["configActions"],
  batchHint: string | null = null,
): Promise<VaultPayload[]> {
  const empty: VaultPayload = { source: "TRANSACTION_ACCOUNT", transaction: txAddr, transactionIndex, vaultIndex: null, vault: null, status: "UNAVAILABLE", detail: null, decoded: null, privileged: [] };
  if (acc.status !== "OK") {
    return [{ ...empty, detail: acc.status === "NOT_FOUND" ? "The proposal's transaction account does not exist (not created yet, or already closed after execution)." : "The proposal's transaction account could not be loaded." }];
  }
  const disc = acc.data.length >= 8 ? hex(acc.data.subarray(0, 8)) : "";
  try {
    switch (disc) {
      case SQUADS_ACCOUNT_DISCRIMINATOR.VaultTransaction: {
        const vt = decodeVaultTransactionAccount(acc.data);
        const vault = vaultPda(vt.multisig, vt.vaultIndex);
        return [await buildVaultPayload({ source: "TRANSACTION_ACCOUNT", transaction: txAddr, transactionIndex: vt.index, vaultIndex: vt.vaultIndex, vault }, vt.message, { ...ctx, label: `proposal #${vt.index}, ` }, vt.ephemeralSignerCount)];
      }
      case SQUADS_ACCOUNT_DISCRIMINATOR.Batch:
        return await batchPayloads(decodeBatchAccount(acc.data), ctx);
      case SQUADS_ACCOUNT_DISCRIMINATOR.VaultBatchTransaction: {
        const b = batchHint ? await fetchSquadsAccount(batchHint) : null;
        if (b?.status !== "OK") return [{ ...empty, detail: "The batch this transaction belongs to could not be loaded." }];
        return await batchPayloads(decodeBatchAccount(b.data), ctx, txAddr);
      }
      case SQUADS_ACCOUNT_DISCRIMINATOR.ConfigTransaction: {
        const ct = decodeConfigTransactionAccount(acc.data);
        for (const action of ct.actions) configActions.push({ origin: `config transaction #${ct.index}`, action });
        return [];
      }
    }
  } catch {
    // falls through to MALFORMED
  }
  return [{ ...empty, status: "MALFORMED", detail: "The proposal's transaction account could not be decoded." }];
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
  const toLoad = new Map<string, { transactionIndex: string | null; batch: string | null }>();
  for (const { ix } of squads) {
    if (!multisig || !["vote", "execute", "activate-proposal"].includes(ix.kind)) continue;
    const proposal = out.proposals.find((p) => p.address === ix.accounts.proposal);
    const txAddr = ix.accounts.transaction ?? (proposal?.transactionIndex ? transactionPda(multisig, proposal.transactionIndex) : null);
    if (txAddr && !payloadFor.has(txAddr)) toLoad.set(txAddr, { transactionIndex: proposal?.transactionIndex ?? null, batch: ix.accounts.batch ?? null });
  }
  for (const [txAddr, meta] of toLoad) {
    out.payloads.push(...(await payloadsFromTransactionAccount(txAddr, meta.transactionIndex, await fetchSquadsAccount(txAddr), ctx, out.configActions, meta.batch)));
  }

  // Already-executed or simulated execution: the vault's calls appear as CPIs of the execute instruction.
  const execIdx = new Set(squads.filter((s) => s.ix.kind === "execute").map((s) => s.index));
  const cpi = await markGuardHolders(
    findPrivilegedActions(decoded, "", ctx.controlled, ctx.members, (i) => i.parentIndex !== undefined && execIdx.has(i.parentIndex) && i.programId !== SQUADS_V4_PROGRAM_ID),
    // The executing vault is among the transaction's accounts.
    decoded.accounts.map((a) => a.address).filter((a): a is string => a !== null && ctx.controlled.has(a)),
  );
  if (cpi.length) {
    out.payloads.push({ source: "EXECUTION_CPI", transaction: null, transactionIndex: null, vaultIndex: null, vault: null, status: "DECODED", detail: decoded.innerInstructionsSource === "EXECUTED" ? "Observed in the executed transaction record." : "Observed in simulation.", decoded: null, privileged: cpi });
  }
  return out;
}
