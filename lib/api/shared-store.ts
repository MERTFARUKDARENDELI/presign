import "server-only";

/**
 * Optional state shared by every server instance: Upstash Redis over its REST
 * API (what Vercel KV uses). Configure UPSTASH_REDIS_REST_URL and
 * UPSTASH_REDIS_REST_TOKEN (or Vercel's KV_REST_API_URL and KV_REST_API_TOKEN).
 * Without it — or when it does not answer — callers use their in-memory,
 * per-instance fallback (lib/presign/replay.ts, lib/api/rate-limit.ts).
 */

interface StoreConfig {
  url: string;
  token: string;
}

export function sharedStoreConfig(): StoreConfig | null {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token || !url.startsWith("https://")) return null;
  return { url: url.replace(/\/+$/, ""), token };
}

const TIMEOUT_MS = 1_500;

async function send(path: string, body: unknown): Promise<unknown> {
  const c = sharedStoreConfig();
  if (!c) throw new Error("shared store not configured");
  const res = await fetch(`${c.url}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`shared store HTTP ${res.status}`);
  return res.json();
}

/** SET key 1 NX PX ttl — true when this call claimed the key, false when it was already taken. */
export async function claimOnce(key: string, ttlMs: number): Promise<boolean> {
  const out = (await send("", ["SET", key, "1", "NX", "PX", String(Math.max(1, Math.ceil(ttlMs)))])) as { result?: unknown; error?: unknown };
  if (out?.error) throw new Error("shared store error");
  return out?.result === "OK";
}

/** One hit in the current fixed window: INCR, expiring with the window. */
export async function countHit(key: string, windowMs: number, now: number = Date.now()): Promise<{ count: number; resetMs: number }> {
  const window = Math.floor(now / windowMs);
  const k = `${key}:${window}`;
  const out = (await send("/pipeline", [["INCR", k], ["PEXPIRE", k, String(windowMs)]])) as Array<{ result?: unknown }>;
  const count = Number(Array.isArray(out) ? out[0]?.result : NaN);
  if (!Number.isFinite(count)) throw new Error("shared store error");
  return { count, resetMs: (window + 1) * windowMs - now };
}
