import "server-only";
import { gateFor } from "@/lib/agent/gate";
import { fetchGuardProgramAccount } from "@/lib/guard/analyze";
import { guardProgramId } from "@/lib/guard/constants";
import { guardAccountKind, inspectGuard, inspectGuardAction } from "@/lib/guard/inspect";
import { AppError } from "@/lib/api/errors";
import { buildSignerBrief } from "./brief";
import { logger } from "@/lib/api/logger";
import { evaluateMultisigPosture, evaluateProposalRisk } from "@/lib/security/rules/multisig";
import { getCluster } from "@/lib/solana/config";
import { SQUADS_ACCOUNT_DISCRIMINATOR, SQUADS_V4_PROGRAM_ID } from "@/lib/squads/constants";
import { hex } from "@/lib/squads/borsh";
import { decodeConfigTransactionAccount, decodeProposalAccount, decodeVaultTransactionAccount } from "@/lib/squads/decode";
import { controlledAddresses, proposalPda, transactionPda, vaultPda } from "@/lib/squads/pda";
import { feePayerCandidates, loadMultisigAccount, payloadsFromTransactionAccount, proposalRefFrom } from "./analyze";
import { fetchSquadsAccounts, type SquadsFetch } from "./chain";
import { loadProposalHistory } from "./history";
import { parseInspectInput } from "./input";
import { applyPolicy, evaluatePolicy, subjectFromAnalysis } from "@/lib/policy/evaluate";
import type { TeamPolicy } from "@/lib/policy/schema";
import type { InspectResult, MultisigAnalysis, MultisigOverview, ProposalHistory, ProposalInspection, ProposalSummary } from "./types";

export type { InspectResult, MultisigOverview, ProposalInspection, ProposalSummary };

/**
 * Proposal inspection without a transaction to sign: what a pending (or past)
 * Squads proposal would do, and the standing risks of a multisig's setup.
 * This is the view a signer needs *before* they open their wallet.
 */


/** Most recent proposals listed in an overview, and how many pending ones get a full inspection. */
export const OVERVIEW_LIMITS = { recent: 15, inspect: 5 } as const;
const PENDING: ReadonlySet<string> = new Set(["Draft", "Active", "Approved"]);

function discriminatorOf(f: SquadsFetch): string | null {
  return f.status === "OK" && f.data.length >= 8 ? hex(f.data.subarray(0, 8)) : null;
}

function checkPolicy(policy: TeamPolicy | null, analysis: MultisigAnalysis, history: ProposalHistory) {
  return policy ? evaluatePolicy(policy, subjectFromAnalysis(analysis, "proposal", false, history), { guardProgram: guardProgramId() }) : null;
}

export async function inspectProposal(multisig: string, index: string, signer: string | null = null, policy: TeamPolicy | null = null): Promise<ProposalInspection> {
  const loaded = await loadMultisigAccount(multisig);
  if (loaded.status === "NOT_FOUND") throw new AppError("ACCOUNT_NOT_FOUND", `No Squads multisig exists at this address on ${getCluster()}.`);
  const proposalAddress = proposalPda(multisig, index);
  const transactionAddress = transactionPda(multisig, index);
  const [fetched, history] = await Promise.all([fetchSquadsAccounts([proposalAddress, transactionAddress]), loadProposalHistory(proposalAddress)]);
  const txFetch = fetched.get(transactionAddress) ?? { status: "FAILED" as const };
  const controlled = controlledAddresses(multisig);
  const analysis: MultisigAnalysis = {
    programId: SQUADS_V4_PROGRAM_ID,
    multisig,
    account: loaded.account,
    accountStatus: loaded.status,
    instructions: [],
    proposals: [proposalRefFrom(proposalAddress, fetched.get(proposalAddress) ?? { status: "FAILED" })],
    payloads: [],
    configActions: [],
    controlled,
    malformed: [],
  };
  const ctx = { controlled: new Set(controlled), members: new Set(loaded.account?.members.map((m) => m.key) ?? []), feePayers: feePayerCandidates(loaded.account, signer ? [signer] : []) };
  analysis.payloads.push(...(await payloadsFromTransactionAccount(transactionAddress, index, txFetch, ctx, analysis.configActions)));
  const disc = discriminatorOf(txFetch);
  const transactionKind = disc === SQUADS_ACCOUNT_DISCRIMINATOR.VaultTransaction ? "vault" : disc === SQUADS_ACCOUNT_DISCRIMINATOR.Batch ? "batch" : disc === SQUADS_ACCOUNT_DISCRIMINATOR.ConfigTransaction ? "config" : "missing";
  const stale = loaded.account ? BigInt(index) <= BigInt(loaded.account.staleTransactionIndex) : false;
  const report = checkPolicy(policy, analysis, history);
  const base = evaluateProposalRisk(analysis, signer, history);
  const risk = report ? applyPolicy(base, report) : base;
  logger.info("multisig.inspected", { kind: transactionKind, risk: risk.level, status: risk.status, policy: report?.status ?? "none" });
  const brief = buildSignerBrief({ mode: "proposal", multisig: analysis, usesDurableNonce: false, messageHash: null, proposal: { transactionIndex: index, stale, transactionKind }, history });
  return { multisig, transactionIndex: index, proposalAddress, transactionAddress, transactionKind, stale, analysis, risk, brief, gate: gateFor(risk.level, risk.status), policy: report, history, cluster: getCluster(), inspectedAt: new Date().toISOString() };
}

export async function inspectMultisig(multisig: string, signer: string | null = null, policy: TeamPolicy | null = null): Promise<MultisigOverview> {
  const loaded = await loadMultisigAccount(multisig);
  if (loaded.status === "NOT_FOUND") throw new AppError("ACCOUNT_NOT_FOUND", `No Squads multisig exists at this address on ${getCluster()}.`);
  const account = loaded.account;
  const latest = account ? BigInt(account.transactionIndex) : 0n;
  const indexes: bigint[] = [];
  for (let i = latest; i >= 1n && indexes.length < OVERVIEW_LIMITS.recent; i--) indexes.push(i);
  const addrs = indexes.flatMap((i) => [proposalPda(multisig, i), transactionPda(multisig, i)]);
  const fetched = await fetchSquadsAccounts(addrs);

  const proposals: ProposalSummary[] = indexes.map((i) => {
    const proposalAddress = proposalPda(multisig, i);
    const transactionAddress = transactionPda(multisig, i);
    const pf = fetched.get(proposalAddress) ?? { status: "FAILED" as const };
    const tf = fetched.get(transactionAddress) ?? { status: "FAILED" as const };
    const base = { transactionIndex: i.toString(), proposalAddress, transactionAddress, stale: account ? i <= BigInt(account.staleTransactionIndex) : false, verdict: null, topSignal: null, signedInAdvance: null };
    if (pf.status === "OK") {
      try {
        const p = decodeProposalAccount(pf.data);
        return { ...base, status: p.status, statusTimestamp: p.statusTimestamp, approvals: p.approved.length, rejections: p.rejected.length };
      } catch {
        return { ...base, status: "UNREADABLE" as const, statusTimestamp: null, approvals: 0, rejections: 0 };
      }
    }
    const d = discriminatorOf(tf);
    const txExists = d === SQUADS_ACCOUNT_DISCRIMINATOR.VaultTransaction || d === SQUADS_ACCOUNT_DISCRIMINATOR.Batch || d === SQUADS_ACCOUNT_DISCRIMINATOR.ConfigTransaction;
    return { ...base, status: txExists ? ("NO_PROPOSAL" as const) : ("NOT_FOUND" as const), statusTimestamp: null, approvals: 0, rejections: 0 };
  });

  let inspected = 0;
  for (const p of proposals) {
    if (!PENDING.has(p.status) || p.stale || inspected >= OVERVIEW_LIMITS.inspect) continue;
    inspected++;
    try {
      const r = await inspectProposal(multisig, p.transactionIndex, signer, policy);
      p.verdict = r.risk.level;
      p.topSignal = r.risk.signals[0]?.title ?? null;
      p.signedInAdvance = r.history.status === "FAILED" ? null : r.history.nonceSigned.length;
    } catch {
      p.verdict = null;
    }
  }

  const report = policy ? evaluatePolicy(policy, { mode: "multisig", multisig, account, controlled: controlledAddresses(multisig), payloads: [], configActions: [], usesDurableNonce: false }, { guardProgram: guardProgramId() }) : null;
  const posture = evaluateMultisigPosture(multisig, account);
  return {
    multisig,
    account,
    accountStatus: loaded.status,
    vaults: [0, 1, 2, 3].map((i) => vaultPda(multisig, i)),
    posture: report ? applyPolicy(posture, report) : posture,
    policy: report,
    proposals,
    inspectedLimit: OVERVIEW_LIMITS.inspect,
    cluster: getCluster(),
    inspectedAt: new Date().toISOString(),
  };
}

/** Resolves free-form input to a proposal inspection or a multisig overview. */
export async function inspect(raw: string, signer: string | null = null, policy: TeamPolicy | null = null): Promise<InspectResult> {
  const parsed = parseInspectInput(raw);
  if (parsed.kind === "invalid") throw new AppError("INVALID_INPUT", parsed.reason);
  const fetched = await fetchSquadsAccounts(parsed.addresses);
  let sawForeign = false;
  // A proposal or transaction address is more specific than a multisig address (links carry both).
  const rank = (a: string) => (discriminatorOf(fetched.get(a) ?? { status: "FAILED" }) === SQUADS_ACCOUNT_DISCRIMINATOR.Multisig ? 1 : 0);
  for (const address of [...parsed.addresses].sort((a, b) => rank(a) - rank(b))) {
    const f = fetched.get(address) ?? { status: "FAILED" as const };
    if (f.status === "FAILED") throw new AppError("RPC_ERROR", "The account could not be loaded. Please retry.");
    // Presign Guard accounts: a guard (setup + scheduled actions) or one scheduled action.
    if (f.status === "WRONG_OWNER" && f.owner === guardProgramId()) {
      const g = await fetchGuardProgramAccount(address);
      const kind = g.status === "OK" ? guardAccountKind(g.data) : null;
      if (g.status === "OK" && kind === "guard") return { kind: "guard", overview: await inspectGuard(address) };
      if (g.status === "OK" && kind === "action") return { kind: "guard-action", inspection: await inspectGuardAction(address, g.data) };
    }
    if (f.status !== "OK") {
      sawForeign ||= f.status === "WRONG_OWNER";
      continue;
    }
    const disc = discriminatorOf(f);
    try {
      if (disc === SQUADS_ACCOUNT_DISCRIMINATOR.Multisig) {
        return parsed.index ? { kind: "proposal", inspection: await inspectProposal(address, parsed.index, signer, policy) } : { kind: "multisig", overview: await inspectMultisig(address, signer, policy) };
      }
      if (disc === SQUADS_ACCOUNT_DISCRIMINATOR.Proposal) {
        const p = decodeProposalAccount(f.data);
        return { kind: "proposal", inspection: await inspectProposal(p.multisig, p.transactionIndex, signer, policy) };
      }
      if (disc === SQUADS_ACCOUNT_DISCRIMINATOR.VaultTransaction) {
        const t = decodeVaultTransactionAccount(f.data);
        return { kind: "proposal", inspection: await inspectProposal(t.multisig, t.index, signer, policy) };
      }
      if (disc === SQUADS_ACCOUNT_DISCRIMINATOR.ConfigTransaction) {
        const t = decodeConfigTransactionAccount(f.data);
        return { kind: "proposal", inspection: await inspectProposal(t.multisig, t.index, signer, policy) };
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("INVALID_INPUT", "This Squads account could not be decoded.");
    }
  }
  throw new AppError(
    "ACCOUNT_NOT_FOUND",
    sawForeign
      ? "This address is not a Squads v4 multisig, proposal or transaction. If it is a vault, paste the multisig address instead."
      : `No Squads account was found for this input on ${getCluster()}.`,
  );
}
