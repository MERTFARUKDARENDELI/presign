/**
 * Presign Watchtower — watches Squads multisigs and Presign Guards through the
 * Presign API and explains every new proposal / scheduled action to the chats
 * that watch it (Telegram, Slack/Discord webhook, console). Teams onboard
 * themselves: add the bot to the signers' group and send /watch <multisig>.
 * Read-only: it never holds keys and never signs.
 *
 *   npm run watchtower               run continuously
 *   npm run watchtower -- --once     one cycle (cron / testing)
 *
 * Configuration (environment, or .env.local via npm run watchtower):
 *   PRESIGN_API_URL      Presign base URL (default http://localhost:3000)
 *   PRESIGN_PUBLIC_URL   base URL used in links (default PRESIGN_API_URL)
 *   TELEGRAM_BOT_TOKEN   enables the bot (/watch, /unwatch, /list, /check) and Telegram delivery
 *   TELEGRAM_CHAT_ID     chat that receives alerts for WATCH_* targets (optional)
 *   WATCH_MULTISIGS, WATCH_GUARDS   comma-separated targets watched from the environment (optional)
 *   ALERT_WEBHOOK_URL    Slack/Discord-compatible webhook for WATCH_* targets (optional)
 *   POLL_SECONDS         >= 10 (default 30)
 *   WATCH_DB             SQLite file (default .watchtower.db)
 *   ALERT_EXISTING=true  alert WATCH_* targets' already-pending items on first start
 *   PRESIGN_POLICY_FILE  team policy JSON (one policy, or an array keyed by `multisig`) checked on every proposal
 */
import type { InspectResult, ProposalInspection } from "../lib/multisig/types.ts";
import type { GuardActionInspection } from "../lib/guard/types.ts";
import { readFileSync } from "node:fs";
import { firstAddress, parsePolicyFile, policyFor, type PolicyJson } from "../lib/policy/file.ts";
import { handleMessage, type IncomingMessage } from "./bot.ts";
import { diffGuard, diffOverview, formatAlert, formatGuardAlert, type Alert } from "./core.ts";
import { WatchStore, type TargetKind } from "./store.ts";

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Pseudo chat for targets configured in the environment. */
const ENV_CHAT = "env";

function list(name: string): string[] {
  const items = (process.env[name] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const bad = items.filter((m) => !BASE58_ADDRESS.test(m));
  if (bad.length) throw new Error(`${name}: not a Solana address: ${bad.join(", ")}`);
  return items;
}

function policies(): PolicyJson[] {
  const path = process.env.PRESIGN_POLICY_FILE;
  if (!path) return [];
  try {
    return parsePolicyFile(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`PRESIGN_POLICY_FILE: ${error instanceof Error ? error.message : "unreadable"}`);
  }
}

function config() {
  const api = (process.env.PRESIGN_API_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const cfg = {
    api,
    publicUrl: (process.env.PRESIGN_PUBLIC_URL || api).replace(/\/$/, ""),
    pollMs: Math.max(10, Number(process.env.POLL_SECONDS ?? 30) || 30) * 1000,
    token: process.env.TELEGRAM_BOT_TOKEN || null,
    envChat: process.env.TELEGRAM_CHAT_ID || null,
    webhook: process.env.ALERT_WEBHOOK_URL || null,
    db: process.env.WATCH_DB || ".watchtower.db",
    alertExisting: process.env.ALERT_EXISTING === "true",
    once: process.argv.includes("--once"),
    multisigs: list("WATCH_MULTISIGS"),
    guards: list("WATCH_GUARDS"),
    policies: policies(),
  };
  if (!cfg.token && cfg.multisigs.length + cfg.guards.length === 0) throw new Error("Set TELEGRAM_BOT_TOKEN (self-service bot) and/or WATCH_MULTISIGS / WATCH_GUARDS.");
  return cfg;
}

type Config = ReturnType<typeof config>;

function log(event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
}

async function inspect(cfg: Config, input: string): Promise<InspectResult> {
  const policy = policyFor(cfg.policies, firstAddress(input)) ?? undefined;
  const res = await fetch(`${cfg.api}/api/multisig/inspect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input, policy }), signal: AbortSignal.timeout(90_000) });
  const body = (await res.json()) as { success: boolean; data: InspectResult | null; error: { code: string; message: string } | null };
  if (!res.ok || !body.success || !body.data) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  return body.data;
}

/** Telegram Bot API call. Never log the URL: it contains the bot token. */
async function telegram<T>(cfg: Config, method: string, body: object, timeoutMs = 15_000): Promise<T | null> {
  if (!cfg.token) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${cfg.token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const j = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!j.ok) log("telegram.error", { method, description: j.description ?? `HTTP ${res.status}` });
    return j.ok ? (j.result ?? null) : null;
  } catch (error) {
    log("telegram.unreachable", { method, error: error instanceof Error ? error.name : "unknown" });
    return null;
  }
}

async function sendTelegram(cfg: Config, chat: string, html: string) {
  await telegram(cfg, "sendMessage", { chat_id: chat, text: html, parse_mode: "HTML", disable_web_page_preview: true });
}

async function deliver(cfg: Config, chats: string[], alert: Alert) {
  console.log(`\n${alert.text}\n`);
  for (const chat of chats) {
    if (chat === ENV_CHAT) {
      if (cfg.envChat) await sendTelegram(cfg, cfg.envChat, alert.html);
      if (cfg.webhook) {
        const res = await fetch(cfg.webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: alert.text, content: alert.text.slice(0, 1990) }), signal: AbortSignal.timeout(15_000) }).catch(() => null);
        log("delivery.webhook", { ok: res?.ok ?? false, status: res?.status ?? null });
      }
    } else {
      await sendTelegram(cfg, chat, alert.html);
    }
  }
}

async function pollTarget(cfg: Config, store: WatchStore, target: string, kind: TargetKind) {
  let r: InspectResult;
  try {
    r = await inspect(cfg, target);
  } catch (error) {
    log("poll.failed", { target, error: error instanceof Error ? error.message : "unknown" });
    return;
  }
  const chats = store.chatsFor(target);
  const alertExisting = cfg.alertExisting && chats.includes(ENV_CHAT);
  const now = Math.floor(Date.now() / 1000);
  if (r.kind === "multisig") {
    const { events, next } = diffOverview(store.state(), r.overview, alertExisting);
    for (const event of events) {
      let inspection: ProposalInspection | null = null;
      if (event.kind === "new-proposal") {
        const d = await inspect(cfg, `${event.multisig} #${event.index}`).catch(() => null);
        inspection = d?.kind === "proposal" ? d.inspection : null;
      }
      await deliver(cfg, chats, formatAlert(event, cfg.publicUrl, inspection));
    }
    store.saveTarget(target, next);
    log("poll.ok", { target, kind, events: events.length });
  } else if (r.kind === "guard") {
    const { events, next } = diffGuard(store.state(), r.overview, alertExisting);
    for (const event of events) {
      let inspection: GuardActionInspection | null = null;
      if (event.kind === "guard-action") {
        const d = await inspect(cfg, event.action).catch(() => null);
        inspection = d?.kind === "guard-action" ? d.inspection : null;
      }
      await deliver(cfg, chats, formatGuardAlert(event, cfg.publicUrl, now, inspection));
    }
    store.saveTarget(target, next);
    log("poll.ok", { target, kind, events: events.length });
  } else {
    log("poll.unexpected_kind", { target, kind: r.kind });
  }
}

interface TgUpdate {
  update_id: number;
  message?: { text?: string; chat: { id: number; type: IncomingMessage["chatType"] }; from?: { id: number } };
}

async function pollBot(cfg: Config, store: WatchStore, waitSeconds: number) {
  const offset = Number(store.getMeta("telegram_offset") ?? 0);
  const updates = (await telegram<TgUpdate[]>(cfg, "getUpdates", { offset, timeout: waitSeconds, allowed_updates: ["message"] }, (waitSeconds + 10) * 1000)) ?? [];
  for (const u of updates) {
    store.setMeta("telegram_offset", String(u.update_id + 1));
    const m = u.message;
    if (!m?.text || !m.from) continue;
    const msg: IncomingMessage = { chat: String(m.chat.id), chatType: m.chat.type, user: String(m.from.id), text: m.text };
    const reply = await handleMessage(msg, {
      store,
      inspect: (input) => inspect(cfg, input),
      isAdmin: async (chat, user) => {
        const member = await telegram<{ status: string }>(cfg, "getChatMember", { chat_id: chat, user_id: Number(user) });
        return member?.status === "creator" || member?.status === "administrator";
      },
      baseUrl: cfg.publicUrl,
      now: () => Math.floor(Date.now() / 1000),
    });
    if (reply) await sendTelegram(cfg, msg.chat, reply);
    log("bot.command", { chatType: msg.chatType, handled: reply !== null });
  }
}

async function main() {
  const cfg = config();
  const store = new WatchStore(cfg.db);
  for (const m of cfg.multisigs) store.subscribe(ENV_CHAT, m, "multisig");
  for (const g of cfg.guards) store.subscribe(ENV_CHAT, g, "guard");
  log("watchtower.start", { api: cfg.api, pollSeconds: cfg.pollMs / 1000, bot: Boolean(cfg.token), envTargets: cfg.multisigs.length + cfg.guards.length, webhook: Boolean(cfg.webhook), policies: cfg.policies.length });

  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
    log("watchtower.stop");
  });
  let lastPoll = 0;
  do {
    if (Date.now() - lastPoll >= cfg.pollMs || cfg.once) {
      lastPoll = Date.now();
      for (const t of store.targets()) await pollTarget(cfg, store, t.target, t.kind);
    }
    if (cfg.once || stopping) break;
    // The bot's long poll doubles as the loop's wait; without a bot, sleep until the next poll.
    if (cfg.token) await pollBot(cfg, store, Math.min(25, Math.ceil(cfg.pollMs / 1000)));
    else await new Promise((r) => setTimeout(r, cfg.pollMs));
  } while (!stopping);
  if (cfg.token && cfg.once) await pollBot(cfg, store, 0);
  store.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
