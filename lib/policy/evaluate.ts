import { guardSignerPda } from "@/lib/guard/constants";
import type { MultisigAnalysis, PrivilegedAction, VaultPayload } from "@/lib/multisig/types";
import { buildAssessment } from "@/lib/security/engine";
import type { RiskAssessment, RiskSignal } from "@/lib/security/risk";
import { formatDelay } from "@/lib/security/rules/multisig";
import type { Evidence } from "@/lib/security/types";
import { programInfo, SYSTEM_PROGRAM_ID } from "@/lib/solana/constants";
import type { ConfigAction, MultisigAccount } from "@/lib/squads/types";
import { formatRawAmount } from "@/lib/token/amount";
import type { DecodedTransaction } from "@/lib/transaction/types";
import { PROGRAM_ALIASES, type TeamPolicy } from "./schema";
import { RULE_LABEL, type PolicyCheck, type PolicyReport, type PolicyRule } from "./types";

/**
 * Deterministic team-policy checks. Each configured rule yields one check:
 * pass, violation, or unverifiable when the data it needs is missing (a
 * payload that could not be decoded or simulated is never compliant by
 * default). Violations and unverifiable checks become risk signals, so the
 * verdict, the gate and every alert channel reflect the policy.
 */

export interface PolicySubject {
  mode: "proposal" | "transaction" | "multisig";
  multisig: string | null;
  account: MultisigAccount | null;
  /** Multisig PDA and vaults. */
  controlled: string[];
  payloads: VaultPayload[];
  configActions: Array<{ origin: string; action: ConfigAction }>;
  usesDurableNonce: boolean;
}

export interface PolicyContext {
  /** Presign Guard program of this deployment, to derive the signers of the policy's guards. */
  guardProgram: string | null;
}

export function subjectFromAnalysis(ms: MultisigAnalysis | null, mode: PolicySubject["mode"], usesDurableNonce = false): PolicySubject {
  return {
    mode,
    multisig: ms?.multisig ?? null,
    account: ms?.account ?? null,
    controlled: ms?.controlled ?? [],
    payloads: ms?.payloads ?? [],
    configActions: ms?.configActions ?? [],
    usesDurableNonce,
  };
}

const short = (a: string | null | undefined) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "unknown");
const delayText = (s: number) => (s === 0 ? "none" : formatDelay(s));

function payloadLabel(p: VaultPayload, i: number, total: number): string {
  const base = p.source === "EXECUTION_CPI" ? "Executed transaction" : p.transactionIndex ? `Proposal #${p.transactionIndex}` : "Proposal";
  return total > 1 ? `${base} (payload ${i + 1})` : base;
}

class Check {
  violations: string[] = [];
  unverifiable: string[] = [];
  applicable = false;
  constructor(readonly rule: PolicyRule) {}
  violate(s: string) {
    this.applicable = true;
    if (!this.violations.includes(s)) this.violations.push(s);
  }
  unknown(s: string) {
    this.applicable = true;
    if (!this.unverifiable.includes(s)) this.unverifiable.push(s);
  }
  done(): PolicyCheck {
    const status = this.violations.length ? "violation" : this.unverifiable.length ? "unverifiable" : this.applicable ? "pass" : "not-applicable";
    return { rule: this.rule, label: RULE_LABEL[this.rule], status, findings: [...this.violations, ...this.unverifiable] };
  }
}

/** Parses a decimal UI amount into raw units (extra fraction digits are dropped, which only makes the limit stricter). */
export function toRawUnits(amount: string, decimals: number): bigint {
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction.slice(0, decimals) || "0").padEnd(decimals, "0"));
}

function undecodedReason(p: VaultPayload): string | null {
  if (p.status === "UNAVAILABLE" || p.status === "MALFORMED" || !p.decoded) return "contents could not be loaded or decoded";
  if (p.status === "PARTIAL") return "some instructions could not be decoded";
  return null;
}

export function evaluatePolicy(policy: TeamPolicy, subject: PolicySubject, ctx: PolicyContext): PolicyReport {
  const checks: PolicyCheck[] = [];
  const controlled = new Set(subject.controlled);
  const payloads = subject.payloads;
  const labels = payloads.map((p, i) => payloadLabel(p, i, payloads.length));
  const hasContent = payloads.length > 0 || subject.configActions.length > 0;
  const guardSigners = new Set(ctx.guardProgram ? (policy.guards ?? []).map((g) => guardSignerPda(ctx.guardProgram!, g)) : []);
  const scheduled = payloads.flatMap((p) => p.scheduled ?? []);
  const immediate: PrivilegedAction[] = payloads.flatMap((p) => p.privileged);
  const allActions: PrivilegedAction[] = [...immediate, ...scheduled.flatMap((s) => s.privileged)];

  if (policy.multisig) {
    const c = new Check("scope");
    c.applicable = true;
    if (subject.multisig !== policy.multisig) c.violate(`Written for ${policy.multisig}, applied to ${subject.multisig ?? "a transaction without a multisig"}.`);
    checks.push(c.done());
  }

  if (policy.authorityHolders) {
    const c = new Check("authorityHolders");
    c.applicable = hasContent;
    const allowNone = policy.authorityHolders.includes("none");
    const allowed = new Set<string>([...controlled, ...guardSigners, ...policy.authorityHolders.filter((a) => a !== "none")]);
    payloads.forEach((p, i) => {
      const why = undecodedReason(p);
      if (why) c.unknown(`${labels[i]}: ${why}; an authority change could be hidden there.`);
    });
    for (const a of allActions) {
      if (a.newAuthority === undefined) {
        if (a.kind === "admin-transfer") c.unknown(`${a.origin}: ${a.programName} ${a.action} changes an authority, but the new holder could not be identified.`);
        continue;
      }
      if (a.newAuthority === null) {
        if (!allowNone) c.violate(`${a.origin}: ${a.programName} ${a.action} removes the authority permanently (the policy does not list "none").`);
      } else if (a.control !== "multisig" && a.control !== "guard" && !allowed.has(a.newAuthority)) {
        c.violate(`${a.origin}: ${a.programName} ${a.action} → ${a.newAuthority}, not an approved holder.`);
      }
    }
    for (const { origin, action } of subject.configActions) {
      if (action.type === "SetConfigAuthority" && action.newConfigAuthority !== SYSTEM_PROGRAM_ID && !allowed.has(action.newConfigAuthority)) {
        c.violate(`${origin}: config authority → ${action.newConfigAuthority}, not an approved holder.`);
      }
    }
    checks.push(c.done());
  }

  if (policy.requireGuardFor?.length) {
    const kinds = new Set<string>(policy.requireGuardFor);
    const c = new Check("requireGuardFor");
    c.applicable = hasContent;
    payloads.forEach((p, i) => {
      const why = undecodedReason(p);
      if (why) c.unknown(`${labels[i]}: ${why}; a critical action could be hidden there.`);
    });
    for (const a of immediate) {
      if (!kinds.has(a.kind)) continue;
      // Handing an authority to an approved guard is how protection starts.
      if (a.control === "guard" || (a.newAuthority && guardSigners.has(a.newAuthority))) continue;
      c.violate(`${a.origin}: ${a.programName} ${a.action} (${a.kind}) runs immediately instead of through Presign Guard.`);
    }
    checks.push(c.done());
  }

  if (policy.guards || policy.minGuardDelaySeconds !== undefined) {
    const c = new Check("guards");
    for (const s of scheduled) {
      c.applicable = true;
      if (policy.guards && !policy.guards.includes(s.guard)) c.violate(`${s.origin}: scheduled through guard ${s.guard}, which the policy does not list.`);
      if (s.guardStatus !== "OK" || !s.guardAccount) c.unknown(`${s.origin}: guard ${s.guard} could not be loaded, so its delay is unknown.`);
      else if (policy.minGuardDelaySeconds !== undefined && s.guardAccount.delaySeconds < policy.minGuardDelaySeconds) {
        c.violate(`${s.origin}: guard delay is ${delayText(s.guardAccount.delaySeconds)}; the policy requires at least ${delayText(policy.minGuardDelaySeconds)}.`);
      }
    }
    checks.push(c.done());
  }

  if (policy.minTimeLockSeconds !== undefined) {
    const min = policy.minTimeLockSeconds;
    const c = new Check("minTimeLockSeconds");
    c.applicable = true;
    if (!subject.account) c.unknown("The multisig account could not be loaded.");
    else if (subject.account.timeLock < min) c.violate(`The time lock is ${delayText(subject.account.timeLock)}; the policy requires at least ${delayText(min)}.`);
    for (const { origin, action } of subject.configActions) {
      if (action.type === "SetTimeLock" && action.newTimeLock < min) c.violate(`${origin}: sets the time lock to ${delayText(action.newTimeLock)}, below ${delayText(min)}.`);
    }
    checks.push(c.done());
  }

  if (policy.minThreshold !== undefined) {
    const min = policy.minThreshold;
    const c = new Check("minThreshold");
    c.applicable = true;
    if (!subject.account) c.unknown("The multisig account could not be loaded.");
    else if (subject.account.threshold < min) c.violate(`The threshold is ${subject.account.threshold}; the policy requires at least ${min}.`);
    for (const { origin, action } of subject.configActions) {
      if (action.type === "ChangeThreshold" && action.newThreshold < min) c.violate(`${origin}: sets the threshold to ${action.newThreshold}, below ${min}.`);
    }
    checks.push(c.done());
  }

  if (policy.allowedPrograms) {
    const allowed = new Set(policy.allowedPrograms.map((p) => PROGRAM_ALIASES[p] ?? p));
    // Using an approved guard requires calling its program.
    if (ctx.guardProgram && (policy.guards?.length || policy.requireGuardFor?.length)) allowed.add(ctx.guardProgram);
    const c = new Check("allowedPrograms");
    const scan = (decoded: DecodedTransaction, where: string) => {
      for (const ix of decoded.instructions) {
        if (!allowed.has(ix.programId)) c.violate(`${where}: calls ${programInfo(ix.programId).name} (${ix.programId}).`);
      }
    };
    payloads.forEach((p, i) => {
      if (!p.decoded) return c.unknown(`${labels[i]}: contents could not be loaded.`);
      c.applicable = true;
      scan(p.decoded, labels[i]);
    });
    for (const s of scheduled) scan(s.decoded, `${s.origin} (scheduled)`);
    checks.push(c.done());
  }

  if (policy.allowedRecipients) {
    const ok = new Set([...controlled, ...policy.allowedRecipients]);
    const c = new Check("allowedRecipients");
    const scan = (d: DecodedTransaction, where: string, own: Set<string>, owners: Map<string, string | null>) => {
      for (const t of d.solTransfers) {
        if (own.has(t.from) && !ok.has(t.to)) c.violate(`${where}: sends ${formatRawAmount(t.lamports, 9)} SOL to ${t.to}.`);
      }
      for (const t of d.tokenTransfers) {
        if (!own.has(t.authority) || ok.has(t.destination)) continue;
        const owner = owners.get(t.destination) ?? null;
        if (!owner) c.unknown(`${where}: sends tokens to account ${t.destination}, whose owner could not be resolved.`);
        else if (!ok.has(owner)) c.violate(`${where}: sends tokens${t.mint ? ` (${short(t.mint)})` : ""} to ${owner}.`);
      }
      for (const a of d.approvals) {
        if (own.has(a.owner) && !ok.has(a.delegate)) c.violate(`${where}: lets ${a.delegate} spend the vault's tokens${a.unlimited ? " (unlimited)" : ""}.`);
      }
      for (const x of d.closes) {
        if (own.has(x.authority) && !ok.has(x.destination)) c.violate(`${where}: closes ${short(x.account)} and sends its balance to ${x.destination}.`);
      }
    };
    payloads.forEach((p, i) => {
      if (!p.decoded) return c.unknown(`${labels[i]}: contents could not be loaded.`);
      c.applicable = true;
      if (p.status === "PARTIAL") c.unknown(`${labels[i]}: some instructions could not be decoded; they could move funds.`);
      const owners = new Map((p.effects?.tokenChanges ?? []).map((t) => [t.tokenAccount, t.owner] as const));
      scan(p.decoded, labels[i], controlled, owners);
    });
    for (const s of scheduled) scan(s.decoded, `${s.origin} (scheduled)`, new Set([...controlled, s.guardSigner, s.guard]), new Map());
    checks.push(c.done());
  }

  if (policy.outflowLimits && Object.keys(policy.outflowLimits).length) {
    const c = new Check("outflowLimits");
    const totals = new Map<string, { raw: bigint; decimals: number }>();
    const add = (key: string, raw: bigint, decimals: number) => {
      const t = totals.get(key) ?? { raw: 0n, decimals };
      totals.set(key, { raw: t.raw + raw, decimals });
    };
    payloads.forEach((p, i) => {
      if (!p.effects || !p.effects.success) return c.unknown(`${labels[i]}: not simulated successfully; outflows are unknown.`);
      c.applicable = true;
      for (const s of p.effects.solChanges) if (controlled.has(s.address)) add("SOL", -BigInt(s.deltaLamports), 9);
      for (const t of p.effects.tokenChanges) if (t.owner && controlled.has(t.owner)) add(t.mint, -BigInt(t.deltaRaw), t.decimals);
    });
    // Scheduled actions run later and are not simulated: count the transfers they would make.
    for (const s of scheduled) {
      const own = new Set([s.guardSigner, ...controlled]);
      for (const t of s.decoded.solTransfers) if (own.has(t.from)) add("SOL", BigInt(t.lamports), 9);
      for (const t of s.decoded.tokenTransfers) {
        if (!own.has(t.authority)) continue;
        if (t.mint && t.decimals !== null) add(t.mint, BigInt(t.amountRaw), t.decimals);
        else c.unknown(`${s.origin} (scheduled): a token transfer's mint is unknown until it executes.`);
      }
      if (s.decoded.solTransfers.length || s.decoded.tokenTransfers.length) c.applicable = true;
    }
    for (const [key, limit] of Object.entries(policy.outflowLimits)) {
      const t = totals.get(key);
      if (!t || t.raw <= 0n) continue;
      if (t.raw > toRawUnits(limit, t.decimals)) {
        c.violate(`Net outflow of ${formatRawAmount(t.raw, t.decimals)} ${key === "SOL" ? "SOL" : `of ${short(key)}`} exceeds the limit of ${limit}.`);
      }
    }
    checks.push(c.done());
  }

  if (policy.requireVerifiedUpgrades) {
    const c = new Check("requireVerifiedUpgrades");
    payloads.forEach((p, i) => {
      const upgrades = p.upgrades ?? [];
      for (const u of upgrades) {
        c.applicable = true;
        const program = u.program ?? "unknown program";
        if (u.matchesVerifiedBuild === true) continue;
        if (u.matchesVerifiedBuild === false) c.violate(`${labels[i]}: the new code for ${program} (${u.bufferHash?.slice(0, 12) ?? "unknown hash"}…) is not its verified build.`);
        else c.unknown(`${labels[i]}: the new code for ${program} could not be compared with a verified build.`);
      }
      if (!upgrades.length && p.privileged.some((a) => a.kind === "program-upgrade")) c.unknown(`${labels[i]}: a program upgrade could not be checked.`);
    });
    for (const s of scheduled) {
      if (s.privileged.some((a) => a.kind === "program-upgrade")) c.unknown(`${s.origin} (scheduled): the upgrade's code is checked when it can execute, not now.`);
    }
    checks.push(c.done());
  }

  if (policy.forbidDurableNonce) {
    const c = new Check("forbidDurableNonce");
    if (subject.mode === "transaction") {
      c.applicable = true;
      if (subject.usesDurableNonce) c.violate("This transaction uses a durable nonce: the signature does not expire and can be executed at any later time.");
    }
    checks.push(c.done());
  }

  const status = checks.some((c) => c.status === "violation") ? "violation" : checks.some((c) => c.status === "unverifiable") ? "unverifiable" : "compliant";
  return { name: policy.name, severity: policy.severity, status, checks };
}

const VIOLATION_TITLE: Record<PolicyRule, string> = {
  scope: "written for another multisig",
  authorityHolders: "authority to an unapproved holder",
  requireGuardFor: "critical action bypasses Presign Guard",
  guards: "unapproved guard or delay",
  minTimeLockSeconds: "time lock below the minimum",
  minThreshold: "threshold below the minimum",
  allowedPrograms: "unapproved program",
  allowedRecipients: "funds to an unapproved recipient",
  outflowLimits: "outflow above the limit",
  requireVerifiedUpgrades: "upgrade is not a verified build",
  forbidDurableNonce: "never-expiring signature",
};

function summarize(findings: string[]): string {
  const shown = findings.slice(0, 3).join(" ");
  return findings.length > 3 ? `${shown} …and ${findings.length - 3} more.` : shown;
}

/** One signal per broken rule (policy severity) and per rule that could not be checked (MEDIUM). */
export function policySignals(report: PolicyReport, ev: (e: Omit<Evidence, "id">) => string): RiskSignal[] {
  const signals: RiskSignal[] = [];
  for (const c of report.checks) {
    if (c.status !== "violation" && c.status !== "unverifiable") continue;
    const id = ev({ source: "TEAM_POLICY", label: `Team policy "${report.name}" — ${c.label}`, observed: c.findings.join(" "), condition: c.status === "violation" ? "rule broken" : "data needed to check the rule is missing" });
    signals.push(
      c.status === "violation"
        ? { code: `POLICY_${c.rule}`, title: `Team policy: ${VIOLATION_TITLE[c.rule]}`, description: summarize(c.findings), severity: report.severity, evidenceIds: [id] }
        : { code: `POLICY_UNVERIFIED_${c.rule}`, title: `Team policy not verifiable: ${c.label.charAt(0).toLowerCase()}${c.label.slice(1)}`, description: summarize(c.findings), severity: "MEDIUM", evidenceIds: [id] },
    );
  }
  return signals;
}

/** The assessment with the policy's signals added; level, score and gate follow from the combined signals. */
export function applyPolicy(risk: RiskAssessment, report: PolicyReport, now?: Date): RiskAssessment {
  const evidence: Evidence[] = [];
  let n = 0;
  const signals = policySignals(report, (e) => {
    const id = `policy:e${++n}`;
    evidence.push({ id, ...e });
    return id;
  });
  const violations = report.checks.filter((c) => c.status === "violation").length;
  return buildAssessment({
    category: risk.category,
    signals: [...risk.signals, ...signals],
    evidence: [...risk.evidence, ...evidence],
    sources: [...risk.sources, { source: "TEAM_POLICY", status: "OK", detail: `"${report.name}": ${violations ? `${violations} rule(s) broken` : report.status}` }],
    status: risk.status,
    now,
  });
}
