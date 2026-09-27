import type { MultisigAnalysis, PrivilegedAction } from "@/lib/multisig/types";
import { formatLamports } from "@/lib/token/amount";
import type { DecodedTransaction } from "@/lib/transaction/types";
import type { RiskSignal } from "../risk";
import type { AnalysisStatus, DataSourceStatus, Evidence } from "../types";

type EvFn = (e: Omit<Evidence, "id">) => string;

/**
 * Deterministic rules for Squads multisig transactions, evaluated from the
 * signer's point of view: what does my signature authorize, can it be used
 * later, and who controls the protocol afterwards. Every signal cites the
 * instruction, account or IDL field it is based on.
 */

export const MULTISIG_THRESHOLDS = {
  /** Threshold / voting members below this share (percent) is "minority control". */
  minorityPct: 50,
} as const;

const short = (a: string | null | undefined) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "unknown");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const GOVERNANCE_KINDS = new Set(["create-vault-transaction", "create-config-transaction", "create-proposal", "activate-proposal", "execute", "multisig-config"]);

const AUTHORITY_LABEL: Record<PrivilegedAction["kind"], string> = {
  "program-upgrade": "program code",
  "upgrade-authority": "upgrade authority",
  "program-close": "program",
  "token-authority": "token authority",
  "account-reassign": "account owner",
  "admin-transfer": "admin",
  "admin-action": "admin setting",
};

function actionEvidence(p: PrivilegedAction, ev: EvFn): string {
  const observed = p.newAuthority === undefined
    ? `${p.programName}.${p.action}${p.target ? ` on ${p.target}` : ""}`
    : `${p.programName}.${p.action} → new ${AUTHORITY_LABEL[p.kind]} ${p.newAuthority ?? "NONE (removed)"}`;
  return ev({
    source: p.source,
    label: `${p.origin}${p.authorityField ? ` (${p.authorityField})` : ""}`,
    observed,
    condition: p.source === "ANCHOR_IDL" ? "instruction and argument names from the program's own on-chain IDL (intent, not verified behavior)" : "decoded from instruction bytes",
  });
}

export interface MultisigRuleInput {
  ms: MultisigAnalysis;
  decoded: DecodedTransaction;
  /** The signer this analysis is for (perspective wallet). */
  signer: string;
}

export function multisigSignals(input: MultisigRuleInput, ev: EvFn, signals: RiskSignal[], statuses: AnalysisStatus[], sources: DataSourceStatus[]) {
  const { ms, decoded, signer } = input;
  const account = ms.account;

  sources.push({ source: "SQUADS_ACCOUNT", status: ms.accountStatus === "OK" ? "OK" : ms.accountStatus === "NOT_FOUND" ? "SKIPPED" : "FAILED", detail: ms.accountStatus === "OK" ? `Multisig ${short(ms.multisig)}: ${account?.threshold} of ${account?.members.length}, time lock ${account?.timeLock}s` : ms.accountStatus === "NOT_FOUND" ? "Multisig account not found on this cluster" : "Multisig account could not be loaded" });
  if (ms.accountStatus !== "OK") statuses.push("PARTIAL");
  if (ms.malformed.length) {
    statuses.push("PARTIAL");
    ev({ source: "TRANSACTION_DECODER", label: "Squads instructions not decodable", observed: ms.malformed.join(", "), condition: "unknown or malformed Squads instruction data" });
  }

  const squadsIxEvidence = ev({
    source: "TRANSACTION_DECODER",
    label: `Squads multisig ${short(ms.multisig)}`,
    observed: ms.instructions.map((i) => `#${i.index} ${i.name}${i.vote ? ` (${i.vote})` : ""}`).join(", "),
    condition: "multisig actions authorized by this signature",
  });

  // 1. Durable nonce + governance action: the signature can be held and replayed at any later time.
  const governance = ms.instructions.filter((i) => GOVERNANCE_KINDS.has(i.kind) || i.vote === "approve");
  if (decoded.usesDurableNonce && governance.length > 0) {
    const nonce = decoded.instructions[0];
    const nonceId = ev({ source: "TRANSACTION_DECODER", label: "Instruction #0 AdvanceNonceAccount", observed: `nonce ${nonce?.info.nonce ?? "?"}, authority ${nonce?.info.authority ?? "?"}`, condition: "durable nonce: the signed transaction does not expire" });
    signals.push({
      code: "MS_DURABLE_NONCE_GOVERNANCE",
      title: "Multisig approval that never expires",
      description: `This ${governance.map((g) => g.name).join(" + ")} is signed with a durable nonce. Once signed it stays valid until the nonce is advanced: whoever holds it can submit it days or weeks later, after circumstances change. Pre-signed durable-nonce approvals are how the Drift Security Council was taken over in April 2026.`,
      severity: "CRITICAL",
      evidenceIds: [nonceId, squadsIxEvidence],
    });
  }

  // 2. Payload: what the vault will do if this proposal executes.
  // The same action can be seen twice (proposal account + execution CPI); report it once.
  const seen = new Set<string>();
  const privileged = ms.payloads.flatMap((p) => p.privileged).filter((p) => {
    // CPI records carry no writable flags, so authority changes are matched on the new holder, not the target.
    const key = `${p.programId}|${p.action}|${p.newAuthority === undefined ? `target:${p.target}` : `to:${p.newAuthority}`}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  for (const [i, p] of privileged.entries()) {
    const id = actionEvidence(p, ev);
    const what = `${p.programName} ${p.action}`;
    if (p.newAuthority !== undefined) {
      if (p.control === "outside") {
        // Membership is only claimed when the multisig account was actually loaded.
        const notWhat = account ? "this multisig, one of its vaults, or a member" : "this multisig or one of its vaults (membership could not be checked)";
        signals.push({ code: `MS_AUTHORITY_LEAVES_MULTISIG:${i}`, title: `${cap(AUTHORITY_LABEL[p.kind])} moves outside the multisig`, description: `${what} makes ${p.newAuthority} the new ${AUTHORITY_LABEL[p.kind]}. That address is not ${notWhat}: after execution the multisig no longer controls it.`, severity: "CRITICAL", evidenceIds: [id, squadsIxEvidence] });
      } else if (p.control === "member") {
        signals.push({ code: `MS_AUTHORITY_TO_SINGLE_KEY:${i}`, title: `${cap(AUTHORITY_LABEL[p.kind])} handed to a single member key`, description: `${what} gives ${short(p.newAuthority)} — one member — sole control. Afterwards that one key can act without a vote.`, severity: "HIGH", evidenceIds: [id] });
      } else if (p.control === "none") {
        signals.push({ code: `MS_AUTHORITY_REMOVED:${i}`, title: `${cap(AUTHORITY_LABEL[p.kind])} removed permanently`, description: `${what} removes the ${AUTHORITY_LABEL[p.kind]} entirely. This cannot be undone.`, severity: "HIGH", evidenceIds: [id] });
      } else {
        signals.push({ code: `MS_AUTHORITY_INTERNAL:${i}`, title: `${cap(AUTHORITY_LABEL[p.kind])} moves within the multisig`, description: `${what} moves the ${AUTHORITY_LABEL[p.kind]} to ${short(p.newAuthority)}, an address controlled by this multisig.`, severity: "LOW", evidenceIds: [id] });
      }
    } else if (p.kind === "program-upgrade") {
      signals.push({ code: `MS_PROGRAM_UPGRADE:${i}`, title: "Program code is replaced", description: `Upgrades program ${short(p.target)} with new code. Verify the buffer matches a reviewed, verifiable build before approving.`, severity: "HIGH", evidenceIds: [id] });
    } else if (p.kind === "program-close" || p.kind === "account-reassign") {
      signals.push({ code: `MS_${p.kind === "program-close" ? "PROGRAM_CLOSE" : "ACCOUNT_REASSIGN"}:${i}`, title: p.kind === "program-close" ? "Program or buffer is closed" : "Account ownership is reassigned", description: `${what} on ${short(p.target)}.`, severity: "HIGH", evidenceIds: [id] });
    } else if (p.kind === "admin-transfer") {
      signals.push({ code: `MS_ADMIN_CHANGE_UNKNOWN_TARGET:${i}`, title: "Admin change with an unidentified new holder", description: `${what} looks like an authority change, but the new holder could not be identified from the IDL. Verify it manually.`, severity: "HIGH", evidenceIds: [id] });
    } else {
      signals.push({ code: `MS_ADMIN_ACTION:${i}`, title: "Administrative action", description: `${what} changes protocol settings. Confirm the values with the proposer.`, severity: "MEDIUM", evidenceIds: [id] });
    }
  }

  // Treasury movements out of the vault (decoded, not simulated).
  for (const p of ms.payloads) {
    if (!p.decoded || !p.vault) continue;
    const controlled = new Set(ms.controlled);
    const sol = p.decoded.solTransfers.filter((t) => t.from === p.vault && !controlled.has(t.to));
    const tokens = p.decoded.tokenTransfers.filter((t) => t.authority === p.vault);
    if (sol.length || tokens.length) {
      const parts = [...sol.map((t) => `${formatLamports(t.lamports)} SOL → ${t.to}`), ...tokens.map((t) => `${t.amountRaw} raw of ${t.mint ?? "unknown mint"} → token account ${t.destination}`)];
      const id = ev({ source: "TRANSACTION_DECODER", label: `Transfers from vault ${short(p.vault)}`, observed: parts.join("; ").slice(0, 400), condition: "assets leave the multisig vault" });
      signals.push({ code: `MS_VAULT_OUTFLOW:${p.transaction ?? p.vault}`, title: "Assets leave the multisig vault", description: "The proposal transfers funds out of the vault. Confirm each recipient and amount with the proposer through a separate channel.", severity: "MEDIUM", evidenceIds: [id] });
    }
  }

  // 3. Payload completeness: approving something that cannot be seen is never "no risk".
  for (const p of ms.payloads) {
    if (p.status === "DECODED") continue;
    statuses.push(p.status === "UNAVAILABLE" ? "INSUFFICIENT_DATA" : "PARTIAL");
    const id = ev({ source: p.source === "EXECUTION_CPI" ? "SIMULATION" : "TRANSACTION_DECODER", label: `Proposal contents (${p.source.toLowerCase().replace(/_/g, " ")})`, observed: p.status, condition: p.detail ?? "not fully decoded" });
    if (p.status === "UNAVAILABLE" || p.status === "MALFORMED") {
      signals.push({ code: `MS_PAYLOAD_UNVERIFIED:${p.transaction ?? "?"}`, title: "Proposal contents could not be verified", description: "You would be authorizing a vault transaction whose instructions could not be loaded and decoded. Do not approve what you cannot see.", severity: "HIGH", evidenceIds: [id] });
    } else {
      signals.push({ code: `MS_PAYLOAD_PARTIAL:${p.transaction ?? "?"}`, title: "Part of the proposal could not be decoded", description: "Some instructions of the proposal are not decoded; their effect is unknown.", severity: "LOW", evidenceIds: [id] });
    }
  }

  // 4. Multisig configuration at the time of analysis.
  if (account) {
    const voters = account.members.filter((m) => m.permissions.includes("Vote")).length;
    let accEvidence: string | null = null;
    const accId = () => (accEvidence ??= ev({ source: "SQUADS_ACCOUNT", label: `Multisig ${short(ms.multisig)} configuration`, observed: `threshold ${account.threshold} of ${voters} voting member(s), time lock ${account.timeLock}s, config authority ${account.configAuthority ?? "none (autonomous)"}`, condition: "current on-chain state" }));
    const dangerous = privileged.some((p) => p.kind !== "admin-action") || signals.some((s) => s.code === "MS_DURABLE_NONCE_GOVERNANCE");
    if (account.timeLock === 0 && (privileged.length > 0 || governance.length > 0)) {
      signals.push({ code: "MS_NO_TIME_LOCK", title: "No time lock", description: "Once the threshold is reached the proposal can execute immediately — nobody gets a window to notice and react.", severity: dangerous ? "HIGH" : "MEDIUM", evidenceIds: [accId()] });
    }
    if (voters > 0 && account.threshold * 100 < voters * MULTISIG_THRESHOLDS.minorityPct) {
      signals.push({ code: "MS_MINORITY_THRESHOLD", title: "A minority of members can execute", description: `${account.threshold} of ${voters} voting members are enough. Fewer compromised or deceived signers are needed to pass a proposal.`, severity: dangerous ? "MEDIUM" : "LOW", evidenceIds: [accId()] });
    }
    if (account.configAuthority) {
      signals.push({ code: "MS_CONTROLLED_MULTISIG", title: "Configuration controlled by a single key", description: `Config authority ${account.configAuthority} can change members, threshold and time lock without a vote.`, severity: "MEDIUM", evidenceIds: [accId()] });
    }

    // Your approval completes the threshold.
    for (const pr of ms.proposals) {
      const voting = ms.instructions.some((i) => i.vote === "approve" && i.proposal === pr.address && i.member === signer);
      if (!voting || !pr.account) continue;
      const already = pr.account.approved.filter((k) => k !== signer).length;
      if (already + 1 >= account.threshold) {
        const id = ev({ source: "SQUADS_ACCOUNT", label: `Proposal ${short(pr.address)} approvals`, observed: `${already} of ${account.threshold} before your vote`, condition: "your approval reaches the threshold" });
        signals.push({ code: `MS_FINAL_APPROVAL:${pr.address}`, title: "Your approval is the deciding one", description: `After your signature the proposal has ${already + 1} of ${account.threshold} approvals and can be executed${account.timeLock === 0 ? " immediately" : ` after ${account.timeLock}s`}.`, severity: "MEDIUM", evidenceIds: [id] });
      }
    }
  }

  // 5. Configuration changes proposed or executed by this transaction.
  for (const [i, { origin, action }] of ms.configActions.entries()) {
    const id = ev({ source: "TRANSACTION_DECODER", label: `Config change (${origin})`, observed: JSON.stringify(action).slice(0, 300), condition: "multisig membership, threshold or time lock changes" });
    const cur = account;
    switch (action.type) {
      case "ChangeThreshold": {
        const lowered = cur ? action.newThreshold < cur.threshold : null;
        const single = action.newThreshold === 1 && (cur?.members.length ?? 2) > 1;
        signals.push({ code: `MS_THRESHOLD_CHANGE:${i}`, title: single ? "Threshold set to a single signature" : lowered ? "Approval threshold lowered" : "Approval threshold changed", description: `New threshold ${action.newThreshold}${cur ? ` (currently ${cur.threshold})` : ""}.${single ? " One signer could then execute anything." : ""}`, severity: single ? "CRITICAL" : lowered === false ? "LOW" : "HIGH", evidenceIds: [id] });
        break;
      }
      case "SetTimeLock": {
        const reduced = cur ? action.newTimeLock < cur.timeLock : null;
        signals.push({ code: `MS_TIME_LOCK_CHANGE:${i}`, title: action.newTimeLock === 0 ? "Time lock removed" : reduced ? "Time lock shortened" : "Time lock changed", description: `New time lock ${action.newTimeLock}s${cur ? ` (currently ${cur.timeLock}s)` : ""}.`, severity: action.newTimeLock === 0 || reduced ? "HIGH" : "LOW", evidenceIds: [id] });
        break;
      }
      case "AddMember":
        signals.push({ code: `MS_MEMBER_ADDED:${i}`, title: "New member added", description: `${action.member.key} joins with ${action.member.permissions.join(", ") || "no"} permission(s). Verify this key belongs to who you think it does.`, severity: "MEDIUM", evidenceIds: [id] });
        break;
      case "RemoveMember":
        signals.push({ code: `MS_MEMBER_REMOVED:${i}`, title: "Member removed", description: `${action.member} loses their seat.`, severity: "MEDIUM", evidenceIds: [id] });
        break;
      case "SetConfigAuthority":
        signals.push({ code: `MS_CONFIG_AUTHORITY_SET:${i}`, title: "Single key gains control of the multisig", description: `${action.newConfigAuthority} could change members, threshold and time lock without any vote.`, severity: "CRITICAL", evidenceIds: [id] });
        break;
      case "AddSpendingLimit":
        signals.push({ code: `MS_SPENDING_LIMIT_ADDED:${i}`, title: "Spending limit added", description: `${action.members.length} member(s) may spend up to ${action.amount} (raw) of ${action.mint} per ${action.period} without a vote${action.destinations.length ? "" : ", to ANY destination"}.`, severity: action.destinations.length ? "LOW" : "MEDIUM", evidenceIds: [id] });
        break;
      case "RemoveSpendingLimit":
      case "SetRentCollector":
        signals.push({ code: `MS_CONFIG_MINOR:${i}`, title: action.type === "SetRentCollector" ? "Rent collector changed" : "Spending limit removed", description: "Minor configuration change.", severity: "LOW", evidenceIds: [id] });
        break;
    }
  }
}
