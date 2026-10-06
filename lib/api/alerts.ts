/**
 * Optional operator alerts: errors and a few operational warnings are posted
 * to PRESIGN_ALERT_WEBHOOK_URL (a Slack- or Discord-compatible incoming
 * webhook, https only), at most once per event per 10 minutes per instance,
 * with a count of what was held back. An alert carries the event name, route,
 * error code and a redacted, truncated error message: never request bodies,
 * keys or headers. Without the variable nothing is sent.
 */

/** Warnings worth waking someone for; every error-level event alerts too. */
export const ALERT_EVENTS = new Set(["api.upstream_error", "shared_store.unavailable", "presign.ai_contradiction_dropped"]);
export const ALERT_INTERVAL_MS = 10 * 60_000;

const lastSent = new Map<string, { at: number; held: number }>();
const pending = new Set<Promise<unknown>>();

export function alertWebhook(): string | null {
  const value = process.env.PRESIGN_ALERT_WEBHOOK_URL?.trim();
  if (!value) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/** Called by the logger with already-redacted fields. */
export function queueAlert(level: string, event: string, fields: Record<string, unknown> | undefined, now: number = Date.now()): void {
  if (level !== "error" && !ALERT_EVENTS.has(event)) return;
  const url = alertWebhook();
  if (!url || typeof fetch !== "function") return;
  const previous = lastSent.get(event);
  if (previous && now - previous.at < ALERT_INTERVAL_MS) {
    previous.held++;
    return;
  }
  lastSent.set(event, { at: now, held: 0 });
  const text = (v: unknown) => (typeof v === "string" && v ? v.slice(0, 200) : null);
  const error = fields?.error && typeof fields.error === "object" ? (fields.error as { message?: unknown }) : null;
  const line = [
    `Presign ${level.toUpperCase()}: ${event}`,
    text(fields?.route) && `route ${text(fields?.route)}`,
    text(fields?.code) && `code ${text(fields?.code)}`,
    text(error?.message) && `error: ${text(error?.message)}`,
    previous?.held ? `(${previous.held} more held back since the last alert)` : null,
    text(process.env.VERCEL_URL) && `deployment ${text(process.env.VERCEL_URL)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const sent = fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: line, content: line.slice(0, 1990) }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => undefined);
  pending.add(sent);
  void sent.finally(() => pending.delete(sent));
}

/**
 * Waits (briefly) for alerts still in flight. A serverless function may stop
 * once it has answered, so the API error path calls this before answering.
 */
export async function flushAlerts(timeoutMs = 2_000): Promise<void> {
  if (pending.size === 0) return;
  await Promise.race([Promise.allSettled([...pending]), new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
}

export function resetAlerts(): void {
  lastSent.clear();
  pending.clear();
}
