import type { ScheduledActions } from "@/lib/guard/types";
import type { MultisigAnalysis, PrivilegedAction } from "@/lib/multisig/types";
import type { MultisigAccount } from "@/lib/squads/types";
import { formatLamports } from "@/lib/token/amount";
import { buildAssessment } from "../engine";
import type { RiskAssessment, RiskSignal } from "../risk";
import type { AnalysisStatus, DataSourceStatus, Evidence } from "../types";

export type EvFn = (e: Omit<Evidence, "id">) => string;

/**
 * Deterministic rules for Squads multisigs, evaluated from the signer's point
 * of view: what does this signature (or proposal) authorize, can it be used
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

/** Payload signals already covered with better context by the privileged-action rules, or not meaningful for a vault. */
const PAYLOAD_SIGNALS_SKIPPED = /^(TX_(MINT_AUTHORITY_CHANGE|UPGRADE_AUTHORITY_CHANGE|TOKEN_ACCOUNT_OWNER_CHANGE|WALLET_OWNER_REASSIGN|CLOSE_AUTHORITY_CHANGE|NONCE_AUTHORITY_CHANGE|DURABLE_NONCE|UNKNOWN_PROGRAM|SIMULATION_FAILED|RENT_DEPOSIT))/;

const AUTHORITY_LABEL: Record<PrivilegedAction["kind"], string> = {
  "program-upgrade": "program code",
  "upgrade-authority": "upgrade authority",
  "program-close": "program",
  "token-authority": "token authority",
  "account-reassign": "account owner",
  "admin-transfer": "admin",
  "admin-action": "admin setting",
};

export function actionEvidence(p: PrivilegedAction, ev: EvFn): string {
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

const ONE_LOWER: Record<RiskSignal["severity"], RiskSignal["severity"]> = { CRITICAL: "HIGH", HIGH: "MEDIUM", MEDIUM: "LOW", LOW: "LOW" };

export function formatDelay(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} day(s)`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hour(s)`;
  if (seconds % 60 === 0) return `${seconds / 60} minute(s)`;
  return `${seconds} second(s)`;
}

/**
 * One signal per privileged action. Scheduled through a verified Guard, the
 * severity drops one level (the delay and single-guardian veto are a real
 * window to stop it) and the description says so; the finding never disappears.
 */
export function privilegedSignal(p: PrivilegedAction, i: number, ev: EvFn, membersKnown: boolean, extraEvidence: string[], guard: { delaySeconds: number; guardians: number; key: string } | null = null, scope: string | null = null): RiskSignal {
  const id = actionEvidence(p, ev);
  const what = `${p.programName} ${p.action}`;
  let s: Omit<RiskSignal, "evidenceIds"> & { evidence: string[] };
  if (p.newAuthority !== undefined && p.control === "outside") {
    // Membership is only claimed when the multisig account was actually loaded.
    const notWhat = membersKnown ? "this multisig, one of its vaults, or a member" : "this multisig or one of its vaults (membership could not be checked)";
    s = { code: `MS_AUTHORITY_LEAVES_MULTISIG:${i}`, title: `${cap(AUTHORITY_LABEL[p.kind])} moves outside the multisig`, description: `${what} makes ${p.newAuthority} the new ${AUTHORITY_LABEL[p.kind]}. That address is not ${notWhat}: after execution the multisig no longer controls it.`, severity: "CRITICAL", evidence: [id, ...extraEvidence] };
  } else if (p.newAuthority !== undefined && p.control === "member") {
    s = { code: `MS_AUTHORITY_TO_SINGLE_KEY:${i}`, title: `${cap(AUTHORITY_LABEL[p.kind])} handed to a single member key`, description: `${what} gives ${short(p.newAuthority)} — one member — sole control. Afterwards that one key can act without a vote.`, severity: "HIGH", evidence: [id] };
  } else if (p.newAuthority !== undefined && p.control === "guard" && p.guard) {
    s = { code: `MS_AUTHORITY_TO_GUARD:${i}`, title: `${cap(AUTHORITY_LABEL[p.kind])} moves to Presign Guard`, description: `${what} hands the ${AUTHORITY_LABEL[p.kind]} to Presign Guard ${short(p.guard.address)}, whose proposer is this multisig's vault. From then on it can only be used through an action scheduled by the multisig, after a ${formatDelay(p.guard.delaySeconds)} delay, and any one of ${p.guard.guardians} guardian(s) can veto it.`, severity: "LOW", evidence: [id] };
  } else if (p.newAuthority !== undefined && p.control === "none") {
    s = { code: `MS_AUTHORITY_REMOVED:${i}`, title: `${cap(AUTHORITY_LABEL[p.kind])} removed permanently`, description: `${what} removes the ${AUTHORITY_LABEL[p.kind]} entirely. This cannot be undone.`, severity: "HIGH", evidence: [id] };
  } else if (p.newAuthority !== undefined) {
    s = { code: `MS_AUTHORITY_INTERNAL:${i}`, title: `${cap(AUTHORITY_LABEL[p.kind])} moves within the multisig`, description: `${what} moves the ${AUTHORITY_LABEL[p.kind]} to ${short(p.newAuthority)}, an address controlled by this multisig.`, severity: "LOW", evidence: [id] };
  } else if (p.kind === "program-upgrade") {
    s = { code: `MS_PROGRAM_UPGRADE:${i}`, title: "Program code is replaced", description: `Upgrades program ${short(p.target)} with new code. Verify the buffer matches a reviewed, verifiable build before approving.`, severity: "HIGH", evidence: [id] };
  } else if (p.kind === "program-close" || p.kind === "account-reassign") {
    s = { code: `MS_${p.kind === "program-close" ? "PROGRAM_CLOSE" : "ACCOUNT_REASSIGN"}:${i}`, title: p.kind === "program-close" ? "Program or buffer is closed" : "Account ownership is reassigned", description: `${what} on ${short(p.target)}.`, severity: "HIGH", evidence: [id] };
  } else if (p.kind === "admin-transfer") {
    s = { code: `MS_ADMIN_CHANGE_UNKNOWN_TARGET:${i}`, title: "Admin change with an unidentified new holder", description: `${what} looks like an authority change, but the new holder could not be identified from the IDL. Verify it manually.`, severity: "HIGH", evidence: [id] };
  } else {
    s = { code: `MS_ADMIN_ACTION:${i}`, title: "Administrative action", description: `${what} changes protocol settings. Confirm the values with the proposer.`, severity: "MEDIUM", evidence: [id] };
  }
  // `scope` keeps codes of scheduled actions apart from immediate ones (the engine de-duplicates by code).
  if (!guard) return { code: scope ? `${s.code}:${scope}` : s.code, title: s.title, description: s.description, severity: s.severity, evidenceIds: s.evidence };
  return {
    code: `GUARD_${s.code.replace(/:\d+$/, "")}:${guard.key}:${i}`,
    title: `Scheduled: ${s.title.charAt(0).toLowerCase()}${s.title.slice(1)}`,
    description: `${s.description} It is scheduled through Presign Guard: it runs no earlier than ${formatDelay(guard.delaySeconds)} after this proposal executes, and any one of ${guard.guardians} guardian(s) can veto it before then.`,
    severity: ONE_LOWER[s.severity],
    evidenceIds: [...new Set([...s.evidence, ...extraEvidence])],
  };
}

/**
 * A scheduled change of the guard's own configuration, compared with the
 * current one. Weakening the guard (new proposer, fewer guardians, shorter
 * delay) is the first thing an attacker holding the proposer would schedule.
 */
export function guardConfigSignals(s: ScheduledActions, ev: EvFn, scope: string, extraEvidence: string[] = [], controlled: ReadonlySet<string> = new Set()): RiskSignal[] {
  const out: RiskSignal[] = [];
  for (const ix of s.decoded.instructions) {
    if (ix.type !== "guard:updateConfig") continue;
    const next = { proposer: ix.info.proposer ?? "", guardians: (ix.info.guardians ?? "").split(", ").filter(Boolean), delaySeconds: Number(ix.info.delaySeconds ?? 0) };
    const id = ev({ source: "TRANSACTION_DECODER", label: `${s.origin}: guard configuration change (instruction ${ix.index})`, observed: `proposer ${next.proposer}; ${next.guardians.length} guardian(s): ${next.guardians.join(", ")}; delay ${next.delaySeconds}s`, condition: "new configuration, compared with the guard's current one" });
    const evidenceIds = [id, ...extraEvidence];
    const code = (c: string) => `${c}:${scope}:${ix.index}`;
    const cur = s.guardAccount;
    if (!cur) {
      out.push({ code: code("GUARD_CONFIG_CHANGE"), title: "Guard configuration change", description: "The guard's current configuration could not be loaded, so this change cannot be compared with it. Check the new proposer, guardians and delay yourself.", severity: "MEDIUM", evidenceIds });
      continue;
    }
    const issues: string[] = [];
    let severity: RiskSignal["severity"] = "LOW";
    const raise = (to: RiskSignal["severity"]) => { if (["LOW", "MEDIUM", "HIGH", "CRITICAL"].indexOf(to) > ["LOW", "MEDIUM", "HIGH", "CRITICAL"].indexOf(severity)) severity = to; };
    if (next.proposer !== cur.proposer) {
      const internal = controlled.has(next.proposer);
      issues.push(internal ? `the proposer moves to ${short(next.proposer)}, another address of this multisig` : `the proposer changes to ${next.proposer}, which could then schedule anything`);
      raise(internal ? "MEDIUM" : "CRITICAL");
    }
    const removed = cur.guardians.filter((g) => !next.guardians.includes(g));
    if (removed.length === cur.guardians.length) {
      issues.push("every current guardian is replaced");
      raise("CRITICAL");
    } else if (removed.length) {
      issues.push(`${removed.length} guardian(s) removed (${removed.map((g) => short(g)).join(", ")})`);
      raise("HIGH");
    }
    if (next.delaySeconds < cur.delaySeconds) {
      issues.push(`the delay shrinks from ${formatDelay(cur.delaySeconds)} to ${formatDelay(next.delaySeconds)}`);
      raise("HIGH");
    }
    out.push(
      issues.length
        ? { code: code("GUARD_CONFIG_WEAKENED"), title: "Guard protection is weakened", description: `This change: ${issues.join("; ")}. Weakening the guard is the first step of a takeover through it — veto unless the whole team intended it.`, severity, evidenceIds }
        : { code: code("GUARD_CONFIG_CHANGE"), title: "Guard configuration change", description: `Nothing is weakened: ${next.guardians.length} guardian(s), delay ${formatDelay(next.delaySeconds)}, same proposer.`, severity: "LOW", evidenceIds },
    );
  }
  return out;
}

function configEvidence(ms: { multisig: string | null }, account: MultisigAccount, ev: EvFn): string {
  const voters = account.members.filter((m) => m.permissions.includes("Vote")).length;
  return ev({ source: "SQUADS_ACCOUNT", label: `Multisig ${short(ms.multisig)} configuration`, observed: `threshold ${account.threshold} of ${voters} voting member(s), time lock ${account.timeLock}s, config authority ${account.configAuthority ?? "none (autonomous)"}`, condition: "current on-chain state" });
}

export interface MultisigRuleInput {
  ms: MultisigAnalysis;
  /** The member this analysis is for (perspective wallet), when known. */
  signer: string | null;
  /** Durable nonce of the analyzed transaction; null when it has none or there is no transaction (proposal inspection). */
  nonce: { nonce: string | null; authority: string | null } | null;
}

export function multisigSignals(input: MultisigRuleInput, ev: EvFn, signals: RiskSignal[], statuses: AnalysisStatus[], sources: DataSourceStatus[]) {
  const { ms, signer, nonce } = input;
  const account = ms.account;

  sources.push({ source: "SQUADS_ACCOUNT", status: ms.accountStatus === "OK" ? "OK" : ms.accountStatus === "NOT_FOUND" ? "SKIPPED" : "FAILED", detail: ms.accountStatus === "OK" ? `Multisig ${short(ms.multisig)}: ${account?.threshold} of ${account?.members.length}, time lock ${account?.timeLock}s` : ms.accountStatus === "NOT_FOUND" ? "Multisig account not found on this cluster" : "Multisig account could not be loaded" });
  if (ms.accountStatus !== "OK") statuses.push("PARTIAL");
  if (ms.malformed.length) {
    statuses.push("PARTIAL");
    ev({ source: "TRANSACTION_DECODER", label: "Squads instructions not decodable", observed: ms.malformed.join(", "), condition: "unknown or malformed Squads instruction data" });
  }

  const squadsIxEvidence = ms.instructions.length
    ? ev({ source: "TRANSACTION_DECODER", label: `Squads multisig ${short(ms.multisig)}`, observed: ms.instructions.map((i) => `#${i.index} ${i.name}${i.vote ? ` (${i.vote})` : ""}`).join(", "), condition: "multisig actions authorized by this signature" })
    : ev({ source: "SQUADS_ACCOUNT", label: `Squads multisig ${short(ms.multisig)}`, observed: ms.proposals.map((p) => `proposal #${p.transactionIndex ?? "?"} (${p.account?.status ?? p.status})`).join(", ") || "proposal", condition: "proposal loaded from chain" });

  // 1. Durable nonce + governance action: the signature can be held and replayed at any later time.
  const governance = ms.instructions.filter((i) => GOVERNANCE_KINDS.has(i.kind) || i.vote === "approve");
  if (nonce && governance.length > 0) {
    const nonceId = ev({ source: "TRANSACTION_DECODER", label: "Instruction #0 AdvanceNonceAccount", observed: `nonce ${nonce.nonce ?? "?"}, authority ${nonce.authority ?? "?"}`, condition: "durable nonce: the signed transaction does not expire" });
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
  for (const [i, p] of privileged.entries()) signals.push(privilegedSignal(p, i, ev, account !== null, [squadsIxEvidence]));

  // Program upgrades: is the new code a build anyone verified?
  for (const p of ms.payloads) {
    for (const [k, u] of (p.upgrades ?? []).entries()) {
      const codeId = ev({ source: "ONCHAIN_RPC", label: `Upgrade of program ${short(u.program)}: new code in buffer ${short(u.buffer)}`, observed: u.bufferHash ? `sha256 ${u.bufferHash}` : u.bufferStatus.toLowerCase().replace("_", " "), condition: "solana-verify hash of the buffer's executable bytes" });
      const reg = u.registry;
      const regId = ev({ source: "VERIFIED_BUILDS", label: `Verified-builds registry: program ${short(u.program)}`, observed: reg ? `${reg.verified ? "verified" : "not verified"}${reg.repo ? `; ${reg.repo}` : ""}${reg.executableHash ? `; verified build ${reg.executableHash}` : ""}` : "unavailable", condition: "external registry, not proof of safety" });
      const scope = `${u.program ?? "?"}:${k}`;
      if (u.matchesVerifiedBuild) {
        signals.push({ code: `UPGRADE_MATCHES_VERIFIED_BUILD:${scope}`, title: "New code matches a verified build", description: `The code this upgrade deploys hashes exactly to the registry's verified build${reg?.repo ? ` of ${reg.repo}` : ""}. Review what changed in that commit.`, severity: "LOW", evidenceIds: [codeId, regId] });
      } else if (u.bufferStatus !== "OK") {
        signals.push({ code: `UPGRADE_CODE_UNAVAILABLE:${scope}`, title: "New program code could not be read", description: "The buffer holding the new code could not be loaded, so the upgrade cannot be verified. Do not approve an upgrade you cannot check.", severity: "HIGH", evidenceIds: [codeId] });
      } else {
        signals.push({ code: `UPGRADE_UNVERIFIED_CODE:${scope}`, title: "New code is not a verified build", description: `The new code (sha256 ${u.bufferHash!.slice(0, 16)}…) matches no build in the verified-builds registry. Build the release commit with \`solana-verify build\` and compare the hash before approving.`, severity: "MEDIUM", evidenceIds: [codeId, regId] });
      }
    }
  }

  // Actions scheduled through Presign Guard: they wait the guard's delay and any one guardian can veto them.
  for (const [n, s] of ms.payloads.flatMap((p) => p.scheduled ?? []).entries()) {
    const g = s.guardAccount;
    const gid = ev({
      source: g ? "ONCHAIN_RPC" : "TRANSACTION_DECODER",
      label: `${s.origin}: Presign Guard ${short(s.guard)}`,
      observed: g ? `${s.decoded.instructions.length} scheduled instruction(s); delay ${g.delaySeconds}s; ${g.guardians.length} guardian(s) can veto` : `${s.decoded.instructions.length} scheduled instruction(s); guard account ${s.guardStatus.toLowerCase().replace("_", " ")}`,
      condition: g ? "guard configuration read from chain" : "delay and veto could not be verified",
    });
    if (g) {
      signals.push({ code: `GUARD_SCHEDULED:${s.guard}:${n}`, title: "Scheduled through Presign Guard", description: `The instructions below do not run when this proposal executes: they wait ${formatDelay(g.delaySeconds)}, and any one of ${g.guardians.length} guardian(s) can veto them before then.`, severity: "LOW", evidenceIds: [gid] });
      if (g.delaySeconds < 3600) signals.push({ code: `GUARD_SHORT_DELAY:${s.guard}`, title: "Guard delay under one hour", description: `A ${formatDelay(g.delaySeconds)} delay leaves little time to notice and veto.`, severity: "MEDIUM", evidenceIds: [gid] });
      if (g.guardians.length === 1) signals.push({ code: `GUARD_SINGLE_GUARDIAN:${s.guard}`, title: "Only one guardian can veto", description: "If that one key is unavailable or compromised, nobody can stop a scheduled action.", severity: "MEDIUM", evidenceIds: [gid] });
    } else {
      signals.push({ code: `GUARD_UNVERIFIED:${s.guard}`, title: "Guard could not be verified", description: "The proposal schedules through an account that could not be loaded as a Presign Guard, so the delay and veto are not confirmed.", severity: "MEDIUM", evidenceIds: [gid] });
      statuses.push("PARTIAL");
    }
    for (const [i, p] of s.privileged.entries()) signals.push(privilegedSignal(p, i, ev, account !== null, [gid], g ? { delaySeconds: g.delaySeconds, guardians: g.guardians.length, key: `${s.guard}:${n}` } : null, `scheduled:${s.guard}:${n}`));
    signals.push(...guardConfigSignals(s, ev, `${s.guard}:${n}`, [gid], new Set(ms.controlled)));
  }

  // Asset movements out of the vault: from the payload's simulation when it ran, otherwise from the decoded instructions.
  let movesAssets = false;
  for (const p of ms.payloads) {
    if (!p.decoded || !p.vault) continue;
    const simulated = p.effects?.success === true && p.risk;
    if (simulated) {
      for (const s of p.risk!.signals) {
        if (PAYLOAD_SIGNALS_SKIPPED.test(s.code) || s.severity === "LOW") continue;
        movesAssets = true;
        const ids = s.evidenceIds.flatMap((eid) => {
          const e = p.risk!.evidence.find((x) => x.id === eid);
          return e ? [ev({ source: e.source, label: `Vault ${short(p.vault)} — ${e.label}`, observed: e.observed, condition: e.condition })] : [];
        });
        if (ids.length) signals.push({ code: `VAULT_${s.code}:${p.transaction ?? p.vault}`, title: `Vault: ${s.title}`, description: `If the proposal executes: ${s.description.replace(/your wallet/gi, "the vault").replace(/\byour\b/gi, "the vault's")}`, severity: s.severity, evidenceIds: ids });
      }
      continue;
    }
    const controlled = new Set(ms.controlled);
    const sol = p.decoded.solTransfers.filter((t) => t.from === p.vault && !controlled.has(t.to));
    const tokens = p.decoded.tokenTransfers.filter((t) => t.authority === p.vault);
    if (sol.length || tokens.length) {
      movesAssets = true;
      const parts = [...sol.map((t) => `${formatLamports(t.lamports)} SOL → ${t.to}`), ...tokens.map((t) => `${t.amountRaw} raw of ${t.mint ?? "unknown mint"} → token account ${t.destination}`)];
      const id = ev({ source: "TRANSACTION_DECODER", label: `Transfers from vault ${short(p.vault)}`, observed: parts.join("; ").slice(0, 400), condition: "assets leave the multisig vault" });
      signals.push({ code: `MS_VAULT_OUTFLOW:${p.transaction ?? p.vault}`, title: "Assets leave the multisig vault", description: "The proposal transfers funds out of the vault. Confirm each recipient and amount with the proposer through a separate channel.", severity: "MEDIUM", evidenceIds: [id] });
    }
  }

  // 3. Payload completeness: approving something that cannot be seen is never "no risk".
  for (const p of ms.payloads) {
    if (p.source === "EXECUTION_CPI") continue;
    if (p.foreignSigners?.length) {
      const id = ev({ source: "TRANSACTION_DECODER", label: `Proposal #${p.transactionIndex ?? "?"} required signers`, observed: p.foreignSigners.join(", "), condition: "not the vault or one of this transaction's ephemeral signers" });
      signals.push({ code: `MS_FOREIGN_SIGNER:${p.transaction ?? "?"}`, title: "Proposal needs a signature the multisig cannot give", description: `The vault transaction requires ${p.foreignSigners.map(short).join(", ")} to sign. The multisig can only sign for its vault and ephemeral signers, so it will fail at execution — or it is not what it appears to be.`, severity: "MEDIUM", evidenceIds: [id] });
    }
    if (p.status !== "DECODED") {
      statuses.push(p.status === "UNAVAILABLE" ? "INSUFFICIENT_DATA" : "PARTIAL");
      const id = ev({ source: "TRANSACTION_DECODER", label: `Proposal contents (${p.source.toLowerCase().replace(/_/g, " ")})`, observed: p.status, condition: p.detail ?? "not fully decoded" });
      if (p.status === "UNAVAILABLE" || p.status === "MALFORMED") {
        signals.push({ code: `MS_PAYLOAD_UNVERIFIED:${p.transaction ?? "?"}`, title: "Proposal contents could not be verified", description: "You would be authorizing a vault transaction whose instructions could not be loaded and decoded. Do not approve what you cannot see.", severity: "HIGH", evidenceIds: [id] });
      } else {
        signals.push({ code: `MS_PAYLOAD_PARTIAL:${p.transaction ?? "?"}`, title: "Part of the proposal could not be decoded", description: "Some instructions of the proposal are not decoded; their effect is unknown.", severity: "LOW", evidenceIds: [id] });
      }
    }
    if (p.decoded && p.effects === null) {
      statuses.push("PARTIAL");
      ev({ source: "SIMULATION", label: `Proposal #${p.transactionIndex ?? "?"} simulation`, observed: p.simulationNote ?? "not run", condition: "vault asset movements are known only from decoded instructions" });
    } else if (p.effects && !p.effects.success) {
      statuses.push("PARTIAL");
      ev({ source: "SIMULATION", label: `Proposal #${p.transactionIndex ?? "?"} simulation`, observed: p.effects.error ?? "failed", condition: "the proposal would fail if executed now; balance changes unknown" });
    }
  }

  // 4. Multisig configuration at the time of analysis.
  if (account) {
    const voters = account.members.filter((m) => m.permissions.includes("Vote")).length;
    let accEvidence: string | null = null;
    const accId = () => (accEvidence ??= configEvidence(ms, account, ev));
    // Moving an authority to an address the multisig controls (or to its own guard) is not what a missing time lock makes dangerous.
    const protective = (p: PrivilegedAction) => p.newAuthority !== undefined && (p.control === "multisig" || p.control === "guard");
    const dangerous = privileged.some((p) => p.kind !== "admin-action" && !protective(p)) || signals.some((s) => s.code === "MS_DURABLE_NONCE_GOVERNANCE");
    if (account.timeLock === 0 && (privileged.length > 0 || governance.length > 0 || movesAssets)) {
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
      if (!voting || !pr.account || !signer) continue;
      const already = pr.account.approved.filter((k) => k !== signer).length;
      if (already + 1 >= account.threshold) {
        const id = ev({ source: "SQUADS_ACCOUNT", label: `Proposal ${short(pr.address)} approvals`, observed: `${already} of ${account.threshold} before your vote`, condition: "your approval reaches the threshold" });
        signals.push({ code: `MS_FINAL_APPROVAL:${pr.address}`, title: "Your approval is the deciding one", description: `After your signature the proposal has ${already + 1} of ${account.threshold} approvals and can be executed${account.timeLock === 0 ? " immediately" : ` after ${account.timeLock}s`}.`, severity: "MEDIUM", evidenceIds: [id] });
      }
    }
  }

  // 5. Configuration changes proposed or executed.
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

function reduceStatuses(statuses: AnalysisStatus[]): AnalysisStatus {
  if (statuses.includes("UNAVAILABLE") || statuses.includes("INSUFFICIENT_DATA")) return "INSUFFICIENT_DATA";
  return statuses.every((s) => s === "COMPLETE") ? "COMPLETE" : "PARTIAL";
}

function evidenceSink(prefix: string) {
  const evidence: Evidence[] = [];
  let n = 0;
  const ev: EvFn = (e) => {
    const id = `${prefix}:e${++n}`;
    evidence.push({ id, ...e });
    return id;
  };
  return { evidence, ev };
}

/** Risk of a proposal inspected on its own (no transaction to sign yet). */
export function evaluateProposalRisk(ms: MultisigAnalysis, signer: string | null = null, now?: Date): RiskAssessment {
  const { evidence, ev } = evidenceSink("proposal");
  const signals: RiskSignal[] = [];
  const statuses: AnalysisStatus[] = ["COMPLETE"];
  const sources: DataSourceStatus[] = [];
  multisigSignals({ ms, signer, nonce: null }, ev, signals, statuses, sources);
  if (ms.payloads.length === 0 && ms.configActions.length === 0) statuses.push("INSUFFICIENT_DATA");
  return buildAssessment({ category: "proposal", signals, evidence, sources, status: reduceStatuses(statuses), now });
}

/** Standing configuration risks of a multisig, independent of any proposal. */
export function evaluateMultisigPosture(multisig: string, account: MultisigAccount | null, now?: Date): RiskAssessment {
  const { evidence, ev } = evidenceSink("posture");
  const signals: RiskSignal[] = [];
  if (!account) {
    return buildAssessment({ category: "multisig", signals, evidence, sources: [{ source: "SQUADS_ACCOUNT", status: "FAILED", detail: "Multisig account could not be loaded" }], status: "UNAVAILABLE", now });
  }
  const id = configEvidence({ multisig }, account, ev);
  const voters = account.members.filter((m) => m.permissions.includes("Vote")).length;
  const executors = account.members.filter((m) => m.permissions.includes("Execute")).length;
  if (account.members.length === 1 || (account.threshold === 1 && voters > 1)) {
    signals.push({ code: "POSTURE_SINGLE_SIGNATURE", title: "One signature is enough", description: account.members.length === 1 ? "The multisig has a single member: it is a single key with extra steps." : `Any one of ${voters} voting members can pass a proposal alone.`, severity: "HIGH", evidenceIds: [id] });
  } else if (voters > 0 && account.threshold * 100 < voters * MULTISIG_THRESHOLDS.minorityPct) {
    signals.push({ code: "POSTURE_MINORITY_THRESHOLD", title: "A minority of members can execute", description: `${account.threshold} of ${voters} voting members are enough to pass any proposal.`, severity: "MEDIUM", evidenceIds: [id] });
  }
  if (account.timeLock === 0) {
    signals.push({ code: "POSTURE_NO_TIME_LOCK", title: "No time lock", description: "Approved proposals can execute immediately. A time lock gives members and monitoring a window to catch a malicious proposal before it runs.", severity: "MEDIUM", evidenceIds: [id] });
  }
  if (account.configAuthority) {
    signals.push({ code: "POSTURE_CONTROLLED", title: "Configuration controlled by a single key", description: `Config authority ${account.configAuthority} can change members, threshold and time lock without a vote.`, severity: "HIGH", evidenceIds: [id] });
  }
  if (executors === 0) {
    signals.push({ code: "POSTURE_NO_EXECUTOR", title: "No member can execute", description: "No member has the Execute permission; approved proposals cannot run.", severity: "LOW", evidenceIds: [id] });
  }
  return buildAssessment({ category: "multisig", signals, evidence, sources: [{ source: "SQUADS_ACCOUNT", status: "OK", detail: `${account.members.length} member(s)` }], status: "COMPLETE", now });
}
