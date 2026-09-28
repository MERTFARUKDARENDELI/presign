import type { InspectResult } from "../lib/multisig/types.ts";
import { diffGuard, diffOverview, escapeHtml, formatInspectSummary, HELP_TEXT, parseCommand } from "./core.ts";
import type { WatchStore } from "./store.ts";

/**
 * Telegram command handling for Watchtower. Dependencies are injected so the
 * logic is testable without Telegram or the network. In group chats only
 * administrators can change what the group watches; anyone can /check.
 */

export interface BotDeps {
  store: WatchStore;
  inspect: (input: string) => Promise<InspectResult>;
  isAdmin: (chat: string, user: string) => Promise<boolean>;
  baseUrl: string;
  now: () => number;
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
