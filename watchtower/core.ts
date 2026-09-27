import type { MultisigOverview, ProposalInspection } from "../lib/multisig/types.ts";

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
