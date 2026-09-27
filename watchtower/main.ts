/**
 * Presign Watchtower — polls Squads multisigs through the Presign API and
 * sends every new proposal's brief to all signers (Telegram, Slack/Discord
 * webhook, console). Read-only: it never holds keys and never signs.
 *
 *   node watchtower/main.ts            run continuously
 *   node watchtower/main.ts --once     one poll cycle (cron / testing)
 *
 * Configuration (environment):
 *   WATCH_MULTISIGS      comma-separated multisig addresses (required)
 *   PRESIGN_API_URL      Presign base URL (default http://localhost:3000)
 *   PRESIGN_PUBLIC_URL   base URL used in alert links (default PRESIGN_API_URL)
 *   POLL_SECONDS         poll interval, >= 10 (default 30)
 *   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID   Telegram delivery (optional)
 *   ALERT_WEBHOOK_URL    Slack/Discord-compatible incoming webhook (optional)
 *   WATCH_STATE_FILE     state file (default .watchtower-state.json)
 *   ALERT_EXISTING=true  also alert proposals already pending at first start
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { InspectResult, MultisigOverview, ProposalInspection } from "../lib/multisig/types.ts";
import { diffOverview, emptyState, formatAlert, type Alert, type WatchState } from "./core.ts";

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function config() {
  const multisigs = (process.env.WATCH_MULTISIGS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const bad = multisigs.filter((m) => !BASE58_ADDRESS.test(m));
  if (multisigs.length === 0) throw new Error("Set WATCH_MULTISIGS to one or more multisig addresses (comma-separated).");
  if (bad.length) throw new Error(`Not a Solana address: ${bad.join(", ")}`);
  const api = (process.env.PRESIGN_API_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const poll = Math.max(10, Number(process.env.POLL_SECONDS ?? 30) || 30);
  return {
    multisigs,
    api,
    publicUrl: (process.env.PRESIGN_PUBLIC_URL ?? api).replace(/\/$/, ""),
    pollMs: poll * 1000,
    telegram: process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID ? { token: process.env.TELEGRAM_BOT_TOKEN, chat: process.env.TELEGRAM_CHAT_ID } : null,
    webhook: process.env.ALERT_WEBHOOK_URL || null,
    stateFile: process.env.WATCH_STATE_FILE ?? ".watchtower-state.json",
    alertExisting: process.env.ALERT_EXISTING === "true",
    once: process.argv.includes("--once"),
  };
}

type Config = ReturnType<typeof config>;

function log(event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
}

async function inspect(cfg: Config, input: string): Promise<InspectResult> {
  const res = await fetch(`${cfg.api}/api/multisig/inspect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input }),
    signal: AbortSignal.timeout(90_000),
  });
  const body = (await res.json()) as { success: boolean; data: InspectResult | null; error: { code: string; message: string } | null };
  if (!res.ok || !body.success || !body.data) throw new Error(body.error ? `${body.error.code}: ${body.error.message}` : `HTTP ${res.status}`);
  return body.data;
}

async function deliver(cfg: Config, alert: Alert) {
  console.log(`\n${alert.text}\n`);
  if (cfg.telegram) {
    const res = await fetch(`https://api.telegram.org/bot${cfg.telegram.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.telegram.chat, text: alert.html, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    // Never log the URL: it contains the bot token.
    log("delivery.telegram", { ok: res?.ok ?? false, status: res?.status ?? null });
  }
  if (cfg.webhook) {
    const res = await fetch(cfg.webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: alert.text, content: alert.text.slice(0, 1990) }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    log("delivery.webhook", { ok: res?.ok ?? false, status: res?.status ?? null });
  }
}

function loadState(file: string): WatchState {
  if (!existsSync(file)) return emptyState();
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as WatchState;
    return s && typeof s === "object" && s.proposals && s.posture ? s : emptyState();
  } catch {
    log("state.unreadable", { file });
    return emptyState();
  }
}

function saveState(file: string, state: WatchState) {
  // Write-then-rename so a crash never leaves a half-written state file.
  writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${file}.tmp`, file);
}

async function cycle(cfg: Config, state: WatchState): Promise<WatchState> {
  let next = state;
  for (const multisig of cfg.multisigs) {
    let overview: MultisigOverview;
    try {
      const r = await inspect(cfg, multisig);
      if (r.kind !== "multisig") throw new Error("not a multisig");
      overview = r.overview;
    } catch (error) {
      log("poll.failed", { multisig, error: error instanceof Error ? error.message : "unknown" });
      continue;
    }
    const { events, next: after } = diffOverview(next, overview, cfg.alertExisting);
    log("poll.ok", { multisig, proposals: overview.proposals.length, events: events.length });
    for (const event of events) {
      let inspection: ProposalInspection | null = null;
      if (event.kind === "new-proposal") {
        try {
          const r = await inspect(cfg, `${multisig} #${event.index}`);
          inspection = r.kind === "proposal" ? r.inspection : null;
        } catch (error) {
          log("inspect.failed", { multisig, index: event.index, error: error instanceof Error ? error.message : "unknown" });
        }
      }
      await deliver(cfg, formatAlert(event, cfg.publicUrl, inspection));
    }
    next = after;
  }
  saveState(cfg.stateFile, next);
  return next;
}

async function main() {
  const cfg = config();
  log("watchtower.start", { multisigs: cfg.multisigs.length, api: cfg.api, pollSeconds: cfg.pollMs / 1000, telegram: Boolean(cfg.telegram), webhook: Boolean(cfg.webhook) });
  let state = loadState(cfg.stateFile);
  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
    log("watchtower.stop");
  });
  do {
    state = await cycle(cfg, state);
    if (cfg.once || stopping) break;
    await new Promise((r) => setTimeout(r, cfg.pollMs));
  } while (!stopping);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
