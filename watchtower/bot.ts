import type { InspectResult } from "../lib/multisig/types.ts";
import { diffGuard, diffOverview, escapeHtml, formatInspectSummary, HELP_TEXT, parseCommand } from "./core.ts";
import { LIMITS, type RateLimiter } from "./limits.ts";
import type { WatchStore } from "./store.ts";

/**
 * Telegram command handling for Watchtower. Dependencies are injected so the
 * logic is testable without Telegram or the network. In group chats only
 * administrators can change what the group watches; anyone can /check.
 * Limits (./limits.ts): targets per chat and in all, and inspections per
 * person and for everyone per minute — the bot is public, and every /check
 * and /watch costs a Presign inspection.
 */

export interface BotDeps {
  store: WatchStore;
  inspect: (input: string) => Promise<InspectResult>;
  isAdmin: (chat: string, user: string) => Promise<boolean>;
  baseUrl: string;
  /** Seconds. */
  now: () => number;
  /** Inspections (/check, /watch) per person and for everyone together. */
  limiter: RateLimiter;
}

export interface IncomingMessage {
  chat: string;
  chatType: "private" | "group" | "supergroup" | "channel";
  user: string;
  text: string;
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/** Returns the reply (Telegram HTML) for one message, or null when it is not a command for us. */
export async function handleMessage(msg: IncomingMessage, deps: BotDeps): Promise<string | null> {
  const command = parseCommand(msg.text);
  if (!command) return null;
  const needsAdmin = command.cmd === "watch" || command.cmd === "unwatch";
  if (needsAdmin && msg.chatType !== "private" && !(await deps.isAdmin(msg.chat, msg.user))) {
    return "Only group administrators can change what this group watches.";
  }
  if (command.cmd === "watch" && deps.store.countForChat(msg.chat) >= LIMITS.perChat) {
    return `This chat already watches ${LIMITS.perChat} targets, the most Watchtower follows for one chat. Use /unwatch for one first.`;
  }
  // Every /check and /watch costs a Presign inspection.
  if (command.cmd === "check" || command.cmd === "watch") {
    const refused = deps.limiter.take(msg.user, deps.now());
    if (refused === "user") return `You asked for ${LIMITS.perUserPerMinute} checks in the last minute, the most Watchtower runs for one person. Try again in a minute.`;
    if (refused === "all") return "Watchtower is busy. Try again in a minute.";
  }

  switch (command.cmd) {
    case "help":
      return HELP_TEXT;
    case "list": {
      const subs = deps.store.subscriptions(msg.chat);
      return subs.length ? ["This chat watches:", ...subs.map((s) => `• ${s.kind} <code>${s.target}</code>`)].join("\n") : "This chat watches nothing yet. Use /watch &lt;multisig address&gt;.";
    }
    case "unwatch": {
      const target = command.arg.split(/\s+/)[0];
      return deps.store.unsubscribe(msg.chat, target) ? `Stopped watching <code>${escapeHtml(target)}</code>.` : `This chat was not watching <code>${escapeHtml(target)}</code>.`;
    }
    case "check": {
      try {
        return formatInspectSummary(await deps.inspect(command.arg), deps.baseUrl, deps.now());
      } catch (error) {
        return `Could not inspect that: ${escapeHtml(error instanceof Error ? error.message : "unknown error")}`;
      }
    }
    case "watch": {
      let r: InspectResult;
      try {
        r = await deps.inspect(command.arg);
      } catch (error) {
        return `Could not load that: ${escapeHtml(error instanceof Error ? error.message : "unknown error")}`;
      }
      if (r.kind !== "multisig" && r.kind !== "guard") return "Send a multisig or guard address (or a Squads multisig link) to watch. For a single proposal use /check.";
      const target = r.kind === "multisig" ? r.overview.multisig : r.overview.guard;
      // A target nobody watches yet adds work to every cycle: within the bot's overall limit only.
      if (!deps.store.isWatched(target) && deps.store.botTargetCount() >= LIMITS.botTargets) {
        return "Watchtower is watching as many targets as it can right now, so it cannot add this one. Try again later.";
      }
      deps.store.subscribe(msg.chat, target, r.kind);
      // First sight records a baseline so existing proposals do not flood the chat.
      if (!deps.store.hasBaseline(target)) {
        const next = r.kind === "multisig" ? diffOverview(deps.store.state(), r.overview).next : diffGuard(deps.store.state(), r.overview).next;
        deps.store.saveTarget(target, next);
      }
      return [`Watching ${r.kind} <code>${short(target)}</code>. New ${r.kind === "multisig" ? "proposals" : "scheduled actions"} will be explained here.`, "", formatInspectSummary(r, deps.baseUrl, deps.now())].join("\n");
    }
  }
}
