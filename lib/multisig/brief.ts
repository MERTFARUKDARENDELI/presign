import bs58 from "bs58";
import { formatLamports, formatRawAmount } from "@/lib/token/amount";
import { describeInstruction } from "@/lib/transaction/explain";
import type { TransactionAnalysis } from "@/lib/transaction/types";
import type { AuthorityControl, MultisigAnalysis, PrivilegedAction, ProposalInspection, VaultPayload } from "./types";

/**
 * The Signer Brief: one screen that tells a multisig member what their
 * signature — or a pending proposal — authorizes, built only from the
 * analysis (no new facts). Shared by the web UI, the API and alert channels.
 */

export interface BriefStep {
  text: string;
  privileged: { kind: PrivilegedAction["kind"]; control: AuthorityControl | null; newAuthority?: string | null } | null;
}

export interface BriefPayload {
  label: string;
  status: VaultPayload["status"];
  source: VaultPayload["source"];
  detail: string | null;
  steps: BriefStep[];
  /** Vault balance changes from the simulation, as plain text. */
  vaultChanges: string[];
  simulation: string | null;
}

export interface SignerBrief {
  headline: string;
  multisig: string | null;
  config: string | null;
  neverExpires: boolean;
  payloads: BriefPayload[];
  /** sha256 of the message bytes, hex and base58 (the form hardware wallets show when blind signing). */
  messageHash: { hex: string; base58: string } | null;
}

export interface BriefSource {
  mode: "presign" | "executed" | "proposal";
  multisig: MultisigAnalysis | null;
  usesDurableNonce: boolean;
  messageHash: string | null;
  /** Proposal inspection only. */
  proposal?: Pick<ProposalInspection, "transactionIndex" | "stale" | "transactionKind"> | null;
}

const short = (a: string | null | undefined) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "unknown");

export const CONTROL_TEXT: Record<AuthorityControl, string> = {
  outside: "NOT controlled by this multisig",
  member: "a single member key",
  none: "nobody — removed permanently",
  multisig: "controlled by this multisig",
};

export function briefSourceFromAnalysis(a: TransactionAnalysis): BriefSource {
  return { mode: a.inputKind === "signature" ? "executed" : "presign", multisig: a.multisig, usesDurableNonce: a.decoded.usesDurableNonce, messageHash: a.messageHash };
}

export function briefSourceFromInspection(i: ProposalInspection): BriefSource {
  return { mode: "proposal", multisig: i.analysis, usesDurableNonce: false, messageHash: null, proposal: i };
}

function headline(src: BriefSource): string {
  const ms = src.multisig!;
  const who = `multisig ${short(ms.multisig)}`;
  if (src.mode === "proposal" && src.proposal) {
    const acc = ms.proposals[0]?.account;
    const threshold = ms.account?.threshold;
    const state = acc ? `${acc.status}${threshold ? ` · ${acc.approved.length} of ${threshold} approvals` : ""}` : "no proposal account";
    return `Proposal #${src.proposal.transactionIndex} of ${who} — ${state}${src.proposal.stale ? " · stale" : ""}.`;
  }
  const names = new Set(ms.instructions.map((i) => i.name));
  const index = ms.proposals[0]?.transactionIndex ?? ms.payloads.find((p) => p.transactionIndex)?.transactionIndex ?? null;
  const proposal = index ? `proposal #${index}` : "a proposal";
  const creates = names.has("vaultTransactionCreate") || names.has("configTransactionCreate") || names.has("proposalCreate");
  const approves = names.has("proposalApprove");
  const executes = names.has("vaultTransactionExecute") || names.has("configTransactionExecute") || names.has("batchExecuteTransaction");
  const verbs = [creates && "create", approves && "approve", executes && "execute"].filter(Boolean) as string[];
  if (names.has("proposalReject")) return `You are voting NO on ${proposal} of ${who}.`;
  if (verbs.length === 0) return `This transaction changes ${who}.`;
  const tense = src.mode === "executed" ? "This transaction did" : "You are about to";
  return `${tense} ${verbs.join(" + ")} ${proposal} of ${who}.`;
}

function steps(p: VaultPayload): BriefStep[] {
  if (!p.decoded) {
    return p.privileged.map((x) => ({
      text: `${x.programName}: ${x.action}${x.newAuthority !== undefined ? ` → ${x.newAuthority ? short(x.newAuthority) : "none"}` : ""}.`,
      privileged: { kind: x.kind, control: x.control, newAuthority: x.newAuthority },
    }));
  }
  return p.decoded.instructions.filter((i) => !i.type.startsWith("computeBudget:")).map((i) => {
    const x = p.privileged.find((v) => v.origin.endsWith(`instruction ${i.index}`) && v.programId === i.programId);
    return { text: describeInstruction(i), privileged: x ? { kind: x.kind, control: x.control, newAuthority: x.newAuthority } : null };
  });
}

function vaultChanges(p: VaultPayload): string[] {
  const e = p.effects;
  if (!e || !e.success || !p.vault) return [];
  const out: string[] = [];
  for (const c of e.solChanges.filter((x) => x.address === p.vault)) {
    const d = BigInt(c.deltaLamports);
    out.push(`Vault ${d < 0n ? "loses" : "receives"} ${formatLamports((d < 0n ? -d : d).toString())} SOL.`);
  }
  for (const c of e.tokenChanges.filter((x) => x.owner === p.vault)) {
    const d = BigInt(c.deltaRaw);
    out.push(`Vault ${d < 0n ? "sends" : "receives"} ${formatRawAmount((d < 0n ? -d : d).toString(), c.decimals)} of token ${short(c.mint)}.`);
  }
  for (const c of e.tokenChanges.filter((x) => x.owner !== p.vault && BigInt(x.deltaRaw) > 0n)) {
    out.push(`${short(c.owner)} receives ${formatRawAmount(c.deltaRaw, c.decimals)} of token ${short(c.mint)}.`);
  }
  if (out.length === 0) out.push("No balance change for the vault in the simulation.");
  return out;
}

function simulationText(p: VaultPayload): string | null {
  if (p.source === "EXECUTION_CPI") return null;
  if (p.simulationNote) return p.simulationNote;
  if (!p.effects) return null;
  return p.effects.success ? `Simulated as the vault executing it now (slot ${p.effects.slot ?? "?"}); the result can change before execution.` : `The simulation fails if executed now${p.effects.error ? ` (${p.effects.error.slice(0, 120)})` : ""}.`;
}

export function buildSignerBrief(src: BriefSource): SignerBrief | null {
  const ms = src.multisig;
  if (!ms) return null;
  const acc = ms.account;
  const voters = acc?.members.filter((m) => m.permissions.includes("Vote")).length ?? 0;
  const payloads = ms.payloads.map((p) => ({
    label: p.source === "EXECUTION_CPI" ? "Observed during execution" : `${p.transactionIndex ? `Proposal #${p.transactionIndex}` : "Proposal"}${p.vault ? ` · vault ${short(p.vault)}` : ""}`,
    status: p.status,
    source: p.source,
    detail: p.detail,
    steps: steps(p),
    vaultChanges: vaultChanges(p),
    simulation: simulationText(p),
  }));
  let messageHash: SignerBrief["messageHash"] = null;
  if (src.messageHash && /^[0-9a-f]{64}$/.test(src.messageHash)) {
    messageHash = { hex: src.messageHash, base58: bs58.encode(Uint8Array.from(src.messageHash.match(/../g)!.map((h) => parseInt(h, 16)))) };
  }
  return {
    headline: headline(src),
    multisig: ms.multisig,
    config: acc ? `${acc.threshold} of ${voters} voting members · time lock ${acc.timeLock === 0 ? "none" : `${acc.timeLock}s`}${acc.configAuthority ? ` · config authority ${short(acc.configAuthority)}` : ""}` : null,
    neverExpires: src.usesDurableNonce,
    payloads,
    messageHash,
  };
}
