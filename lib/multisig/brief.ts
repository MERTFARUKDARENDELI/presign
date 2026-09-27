import bs58 from "bs58";
import { describeInstruction } from "@/lib/transaction/explain";
import type { TransactionAnalysis } from "@/lib/transaction/types";
import type { AuthorityControl, PrivilegedAction, VaultPayload } from "./types";

/**
 * The Signer Brief: one screen that tells a multisig member what their
 * signature authorizes, built only from the analysis (no new facts). Shared
 * by the web UI, the API and alert channels.
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
}

export interface SignerBrief {
  headline: string;
  multisig: string | null;
  config: string | null;
  neverExpires: boolean;
  payloads: BriefPayload[];
  /** sha256 of the message bytes, hex and base58 (the form Ledger shows when blind signing). */
  messageHash: { hex: string; base58: string } | null;
}

const short = (a: string | null | undefined) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "unknown");

export const CONTROL_TEXT: Record<AuthorityControl, string> = {
  outside: "NOT controlled by this multisig",
  member: "a single member key",
  none: "nobody — removed permanently",
  multisig: "controlled by this multisig",
};

function headline(a: TransactionAnalysis): string {
  const ms = a.multisig!;
  const who = `multisig ${short(ms.multisig)}`;
  const names = new Set(ms.instructions.map((i) => i.name));
  const index = ms.proposals[0]?.transactionIndex ?? ms.payloads.find((p) => p.transactionIndex)?.transactionIndex ?? null;
  const proposal = index ? `proposal #${index}` : "a proposal";
  const creates = names.has("vaultTransactionCreate") || names.has("configTransactionCreate") || names.has("proposalCreate");
  const approves = names.has("proposalApprove");
  const executes = names.has("vaultTransactionExecute") || names.has("configTransactionExecute") || names.has("batchExecuteTransaction");
  const verbs = [creates && "create", approves && "approve", executes && "execute"].filter(Boolean) as string[];
  if (names.has("proposalReject")) return `You are voting NO on ${proposal} of ${who}.`;
  if (verbs.length === 0) return `This transaction changes ${who}.`;
  const tense = a.inputKind === "signature" ? "This transaction did" : "You are about to";
  return `${tense} ${verbs.join(" + ")} ${proposal} of ${who}.`;
}

function steps(p: VaultPayload): BriefStep[] {
  const all = p.decoded ? [...p.decoded.instructions, ...p.decoded.innerInstructions] : [];
  const byOrigin = new Map(p.privileged.map((x) => [x.origin, x]));
  if (all.length === 0) {
    return p.privileged.map((x) => ({
      text: `${x.programName}: ${x.action}${x.newAuthority !== undefined ? ` → ${x.newAuthority ? short(x.newAuthority) : "none"}` : ""}.`,
      privileged: { kind: x.kind, control: x.control, newAuthority: x.newAuthority },
    }));
  }
  return p.decoded!.instructions.filter((i) => !i.type.startsWith("computeBudget:")).map((i) => {
    const x = [...byOrigin.values()].find((v) => v.origin.endsWith(`instruction ${i.index}`) && v.programId === i.programId);
    return { text: describeInstruction(i), privileged: x ? { kind: x.kind, control: x.control, newAuthority: x.newAuthority } : null };
  });
}

export function buildSignerBrief(a: TransactionAnalysis): SignerBrief | null {
  const ms = a.multisig;
  if (!ms) return null;
  const acc = ms.account;
  const voters = acc?.members.filter((m) => m.permissions.includes("Vote")).length ?? 0;
  const payloads = ms.payloads.map((p) => ({
    label: p.source === "EXECUTION_CPI" ? "Observed during execution" : `${p.transactionIndex ? `Proposal #${p.transactionIndex}` : "Proposal"}${p.vault ? ` · vault ${short(p.vault)}` : ""}`,
    status: p.status,
    source: p.source,
    detail: p.detail,
    steps: steps(p),
  }));
  let messageHash: SignerBrief["messageHash"] = null;
  if (a.messageHash && /^[0-9a-f]{64}$/.test(a.messageHash)) {
    messageHash = { hex: a.messageHash, base58: bs58.encode(Uint8Array.from(a.messageHash.match(/../g)!.map((h) => parseInt(h, 16)))) };
  }
  return {
    headline: headline(a),
    multisig: ms.multisig,
    config: acc ? `${acc.threshold} of ${voters} voting members · time lock ${acc.timeLock === 0 ? "none" : `${acc.timeLock}s`}${acc.configAuthority ? ` · config authority ${short(acc.configAuthority)}` : ""}` : null,
    neverExpires: a.decoded.usesDurableNonce,
    payloads,
    messageHash,
  };
}
