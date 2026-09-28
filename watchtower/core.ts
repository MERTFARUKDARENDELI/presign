import type { GuardActionInspection, GuardOverview } from "../lib/guard/types.ts";
import type { InspectResult, MultisigOverview, ProposalInspection } from "../lib/multisig/types.ts";

/**
 * Watchtower core: decides which proposal changes deserve an alert and
 * formats the alert. Pure functions — no network, no clock, no secrets — so
 * the runner (watchtower/main.ts) stays thin and this logic stays tested.
 */

export interface WatchState {
  /** multisig → proposal index → last seen status. */
  proposals: Record<string, Record<string, string>>;
  /** multisig → last seen setup verdict (config changes show up here). */
  posture: Record<string, string>;
}

export type WatchEvent =
  | { kind: "new-proposal"; multisig: string; index: string; status: string }
  | { kind: "status-change"; multisig: string; index: string; from: string; to: string }
  | { kind: "posture-change"; multisig: string; from: string; to: string };

const PENDING = new Set(["Draft", "Active", "Approved"]);
const NOTIFY_STATUSES = new Set(["Approved", "Executed", "Rejected", "Cancelled"]);

export function emptyState(): WatchState {
  return { proposals: {}, posture: {} };
}

/**
 * Compares an overview with what was seen before. The first observation of a
 * multisig only records a baseline (no alert storm on start), unless
 * `alertExisting` asks to report proposals that are already pending.
 */
export function diffOverview(state: WatchState, o: MultisigOverview, alertExisting = false): { events: WatchEvent[]; next: WatchState } {
  const seen = state.proposals[o.multisig];
  const firstRun = seen === undefined;
  const current: Record<string, string> = {};
  const events: WatchEvent[] = [];
  for (const p of o.proposals) {
    if (p.status === "NOT_FOUND" || p.status === "UNREADABLE") continue;
    current[p.transactionIndex] = p.status;
    const before = seen?.[p.transactionIndex];
    if (before === undefined) {
      if (firstRun ? alertExisting && PENDING.has(p.status) && !p.stale : true) events.push({ kind: "new-proposal", multisig: o.multisig, index: p.transactionIndex, status: p.status });
    } else if (before !== p.status && NOTIFY_STATUSES.has(p.status)) {
      events.push({ kind: "status-change", multisig: o.multisig, index: p.transactionIndex, from: before, to: p.status });
    }
  }
  const postureBefore = state.posture[o.multisig];
  if (postureBefore !== undefined && postureBefore !== o.posture.level) {
    events.push({ kind: "posture-change", multisig: o.multisig, from: postureBefore, to: o.posture.level });
  }
  return {
    events,
    next: { proposals: { ...state.proposals, [o.multisig]: { ...seen, ...current } }, posture: { ...state.posture, [o.multisig]: o.posture.level } },
  };
}

const VERDICT_ICON: Record<string, string> = { CRITICAL: "🛑", HIGH: "🔶", MEDIUM: "⚠️", LOW: "🔹", SAFE: "✅", UNKNOWN: "❔" };

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export interface Alert {
  /** Plain text (Slack/Discord/console). */
  text: string;
  /** Telegram HTML. */
  html: string;
}

export function verifyLink(baseUrl: string, multisig: string, index?: string): string {
  const q = index ? `${multisig} #${index}` : multisig;
  return `${baseUrl.replace(/\/$/, "")}/verify?q=${encodeURIComponent(q)}`;
}

/** Formats one event. `inspection` is the full proposal inspection for new proposals, when it could be loaded. */
export function formatAlert(event: WatchEvent, baseUrl: string, inspection: ProposalInspection | null = null): Alert {
  const lines: string[] = [];
  const html: string[] = [];
  const link = verifyLink(baseUrl, event.multisig, event.kind === "posture-change" ? undefined : event.index);

  if (event.kind === "posture-change") {
    lines.push(`Multisig ${short(event.multisig)} setup risk changed: ${event.from} → ${event.to}`);
    html.push(`<b>Multisig ${short(event.multisig)}</b> setup risk changed: ${escapeHtml(event.from)} → <b>${escapeHtml(event.to)}</b>`);
  } else if (event.kind === "status-change") {
    lines.push(`Proposal #${event.index} of multisig ${short(event.multisig)}: ${event.from} → ${event.to}`);
    html.push(`Proposal <b>#${escapeHtml(event.index)}</b> of multisig ${short(event.multisig)}: ${escapeHtml(event.from)} → <b>${escapeHtml(event.to)}</b>`);
  } else {
    const level = inspection?.risk.level ?? "UNKNOWN";
    const icon = VERDICT_ICON[level] ?? "❔";
    lines.push(`${icon} New proposal #${event.index} on multisig ${short(event.multisig)} — ${level}`);
    html.push(`${icon} <b>New proposal #${escapeHtml(event.index)}</b> on multisig ${short(event.multisig)} — <b>${escapeHtml(level)}</b>`);
    if (!inspection) {
      lines.push("The proposal could not be inspected. Do not approve it before verifying it.");
      html.push("The proposal could not be inspected. Do not approve it before verifying it.");
    } else {
      for (const p of inspection.analysis.payloads) {
        for (const x of p.privileged.filter((y) => y.newAuthority !== undefined).slice(0, 3)) {
          const who = x.newAuthority ? short(x.newAuthority) : "nobody";
          const control = x.control === "outside" ? "NOT controlled by the multisig" : x.control === "member" ? "a single member" : x.control === "none" ? "removed" : "the multisig";
          lines.push(`• ${x.programName} ${x.action} → ${who} (${control})`);
          html.push(`• ${escapeHtml(x.programName)} <code>${escapeHtml(x.action)}</code> → <code>${who}</code> (${control})`);
        }
      }
      for (const s of inspection.risk.signals.slice(0, 3)) {
        lines.push(`• ${s.severity}: ${s.title}`);
        html.push(`• <b>${escapeHtml(s.severity)}</b>: ${escapeHtml(s.title)}`);
      }
      const policy = inspection.policy;
      if (policy) {
        const broken = policy.checks.filter((c) => c.status === "violation").map((c) => c.label);
        const unknown = policy.checks.filter((c) => c.status === "unverifiable").map((c) => c.label);
        const text = broken.length ? `BROKEN — ${broken.join("; ")}` : unknown.length ? `not fully checkable — ${unknown.join("; ")}` : "complies";
        lines.push(`Team policy "${policy.name}": ${text}`);
        html.push(`Team policy "${escapeHtml(policy.name)}": ${broken.length ? "<b>BROKEN</b>" : unknown.length ? "<i>not fully checkable</i>" : "complies"}${broken.length || unknown.length ? ` — ${escapeHtml((broken.length ? broken : unknown).join("; "))}` : ""}`);
      }
      if (inspection.risk.status !== "COMPLETE") {
        lines.push(`Analysis ${inspection.risk.status}: some checks could not run.`);
        html.push(`<i>Analysis ${escapeHtml(inspection.risk.status)}: some checks could not run.</i>`);
      }
    }
  }
  lines.push(`Verify before signing: ${link}`);
  html.push(`<a href="${escapeHtml(link)}">Verify before signing</a>`);
  return { text: lines.join("\n"), html: html.join("\n") };
}

// ---------------------------------------------------------------- Presign Guard

export type GuardWatchEvent =
  | { kind: "guard-action"; guard: string; action: string; index: string; status: string; eta: string; memo: string }
  | { kind: "guard-action-status"; guard: string; action: string; index: string; from: string; to: string };

/** Same baseline rule as proposals: the first sight of a guard records state; later changes alert. */
export function diffGuard(state: WatchState, o: GuardOverview, alertExisting = false): { events: GuardWatchEvent[]; next: WatchState } {
  const seen = state.proposals[o.guard];
  const firstRun = seen === undefined;
  const current: Record<string, string> = {};
  const events: GuardWatchEvent[] = [];
  for (const a of o.actions) {
    current[a.index] = a.status;
    const before = seen?.[a.index];
    if (before === undefined) {
      if (firstRun ? alertExisting && a.status === "Pending" : true) events.push({ kind: "guard-action", guard: o.guard, action: a.address, index: a.index, status: a.status, eta: a.eta, memo: a.memo });
    } else if (before !== a.status) {
      events.push({ kind: "guard-action-status", guard: o.guard, action: a.address, index: a.index, from: before, to: a.status });
    }
  }
  return { events, next: { proposals: { ...state.proposals, [o.guard]: { ...seen, ...current } }, posture: { ...state.posture, [o.guard]: o.posture.level } } };
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "now";
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${Math.max(m, 1)}m`;
}

const controlText = (c: string | null) => (c === "outside" ? "NOT controlled by the multisig or guard" : c === "member" ? "a single key" : c === "none" ? "removed" : "the multisig / guard");

/** `nowSeconds` is passed in so formatting stays pure. */
export function formatGuardAlert(event: GuardWatchEvent, baseUrl: string, nowSeconds: number, inspection: GuardActionInspection | null = null): Alert {
  const link = verifyLink(baseUrl, event.action);
  if (event.kind === "guard-action-status") {
    const text = `Guard ${short(event.guard)} action #${event.index}: ${event.from} → ${event.to}\nDetails: ${link}`;
    return { text, html: `Guard ${short(event.guard)} action <b>#${escapeHtml(event.index)}</b>: ${escapeHtml(event.from)} → <b>${escapeHtml(event.to)}</b>\n<a href="${escapeHtml(link)}">Details</a>` };
  }
  const level = inspection?.risk.level ?? "UNKNOWN";
  const icon = VERDICT_ICON[level] ?? "❔";
  const left = formatDuration(Number(event.eta) - nowSeconds);
  const lines = [`${icon} Guard ${short(event.guard)} scheduled action #${event.index} — ${level}`, `Executes in ${left} unless a guardian vetoes.`];
  const html = [`${icon} Guard ${short(event.guard)} scheduled action <b>#${escapeHtml(event.index)}</b> — <b>${escapeHtml(level)}</b>`, `Executes in <b>${left}</b> unless a guardian vetoes.`];
  if (event.memo) {
    lines.push(`Memo (untrusted): ${event.memo}`);
    html.push(`<i>Memo (untrusted): ${escapeHtml(event.memo)}</i>`);
  }
  for (const x of inspection?.scheduled.privileged.filter((y) => y.newAuthority !== undefined).slice(0, 3) ?? []) {
    const who = x.newAuthority ? short(x.newAuthority) : "nobody";
    lines.push(`• ${x.programName} ${x.action} → ${who} (${controlText(x.control)})`);
    html.push(`• ${escapeHtml(x.programName)} <code>${escapeHtml(x.action)}</code> → <code>${who}</code> (${controlText(x.control)})`);
  }
  if (!inspection) {
    lines.push("The action could not be inspected. Treat it as unverified.");
    html.push("The action could not be inspected. Treat it as unverified.");
  }
  lines.push(`Review or veto: ${link}`);
  html.push(`<a href="${escapeHtml(link)}">Review or veto</a>`);
  return { text: lines.join("\n"), html: html.join("\n") };
}

// ---------------------------------------------------------------- bot commands

export type BotCommand = { cmd: "watch" | "unwatch" | "check"; arg: string } | { cmd: "list" | "help" } | null;

/** "/watch@PresignBot <addr>" → { cmd: "watch", arg }. Anything that is not a known command is null. */
export function parseCommand(text: string): BotCommand {
  const m = /^\/([a-z]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const arg = (m[2] ?? "").trim().slice(0, 500);
  switch (m[1]) {
    case "watch":
    case "unwatch":
    case "check":
      return arg ? { cmd: m[1], arg } : { cmd: "help" };
    case "list":
      return { cmd: "list" };
    case "start":
    case "help":
      return { cmd: "help" };
    default:
      return null;
  }
}

export const HELP_TEXT = [
  "<b>Presign Watchtower</b> — every new multisig proposal, explained before anyone signs.",
  "",
  "/watch &lt;multisig or guard address, or Squads link&gt; — alert this chat about new proposals",
  "/unwatch &lt;address&gt; — stop",
  "/list — what this chat watches",
  "/check &lt;Squads link, proposal, or &lt;multisig&gt; #&lt;n&gt;&gt; — one-off brief",
  "",
  "Read-only: Presign never asks for keys and never signs.",
].join("\n");

/** One-message summary of any inspection result, for /check and /watch replies (Telegram HTML). */
export function formatInspectSummary(r: InspectResult, baseUrl: string, nowSeconds: number): string {
  if (r.kind === "proposal") {
    const i = r.inspection;
    const lines = [`${VERDICT_ICON[i.risk.level] ?? "❔"} <b>${escapeHtml(i.risk.level)}</b> · ${escapeHtml(i.brief?.headline ?? `Proposal #${i.transactionIndex}`)}`];
    for (const s of i.risk.signals.slice(0, 4)) lines.push(`• <b>${escapeHtml(s.severity)}</b>: ${escapeHtml(s.title)}`);
    lines.push(`<a href="${escapeHtml(verifyLink(baseUrl, i.multisig, i.transactionIndex))}">Full brief</a>`);
    return lines.join("\n");
  }
  if (r.kind === "multisig") {
    const o = r.overview;
    const pending = o.proposals.filter((p) => PENDING.has(p.status) && !p.stale);
    const lines = [`Multisig ${short(o.multisig)} — setup <b>${escapeHtml(o.posture.level)}</b>${o.account ? ` · ${o.account.threshold} of ${o.account.members.length} · time lock ${o.account.timeLock === 0 ? "none" : `${o.account.timeLock}s`}` : ""}`];
    for (const s of o.posture.signals.slice(0, 3)) lines.push(`• ${escapeHtml(s.title)}`);
    lines.push(`${pending.length} pending proposal(s)${pending.length ? `: ${pending.map((p) => `#${p.transactionIndex} ${p.verdict ?? "?"}`).join(", ")}` : ""}`);
    lines.push(`<a href="${escapeHtml(verifyLink(baseUrl, o.multisig))}">Open</a>`);
    return lines.join("\n");
  }
  if (r.kind === "guard") {
    const g = r.overview;
    const pending = g.actions.filter((a) => a.status === "Pending");
    return [`Presign Guard ${short(g.guard)} — delay ${formatDuration(g.account.delaySeconds)}, ${g.account.guardians.length} guardian(s)`, `${pending.length} pending action(s)`, `<a href="${escapeHtml(verifyLink(baseUrl, g.guard))}">Open</a>`].join("\n");
  }
  const a = r.inspection;
  return [
    `${VERDICT_ICON[a.risk.level] ?? "❔"} Guard action #${escapeHtml(a.action.index)} — <b>${escapeHtml(a.risk.level)}</b> · ${escapeHtml(a.action.status)}`,
    a.action.status === "Pending" ? `Executes in ${formatDuration(Number(a.action.eta) - nowSeconds)} unless vetoed.` : "",
    `<a href="${escapeHtml(verifyLink(baseUrl, a.address))}">Details</a>`,
  ].filter(Boolean).join("\n");
}
