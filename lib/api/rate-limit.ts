import { logger } from "./logger";
import { countHit, sharedStoreConfig } from "./shared-store";
import { trustedProxyHops } from "./trusted-proxy";

/**
 * Rate limiter keyed by client + route. With a shared store configured
 * (lib/api/shared-store.ts) the count is kept there, across every instance;
 * otherwise — or if the store does not answer — in this instance's memory as
 * a sliding window. Protects Helius/RugCheck/Anthropic quotas.
 *
 * Under memory pressure only the least recently seen clients are dropped, so
 * flooding the limiter with new keys cannot reset a client that is being limited.
 */

interface Bucket {
  hits: number[];
}

const buckets = new Map<string, Bucket>();
const MAX_KEYS = 10_000;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): RateLimitResult {
  const bucket = buckets.get(key) ?? { hits: [] };
  bucket.hits = bucket.hits.filter((t) => now - t < windowMs);
  // Most recently seen last (Map order); the oldest entries are dropped first.
  buckets.delete(key);
  buckets.set(key, bucket);
  while (buckets.size > MAX_KEYS) buckets.delete(buckets.keys().next().value!);

  if (bucket.hits.length >= limit) {
    const oldest = bucket.hits[0];
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000)),
    };
  }

  bucket.hits.push(now);
  return { allowed: true, remaining: limit - bucket.hits.length, retryAfterSeconds: 0 };
}

/** The shared count when a store is configured, this instance's otherwise. */
export async function checkRateLimitShared(key: string, limit: number, windowMs: number, now: number = Date.now()): Promise<RateLimitResult> {
  if (sharedStoreConfig()) {
    try {
      const { count, resetMs } = await countHit(`presign:rl:${key}`, windowMs, now);
      return count > limit
        ? { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil(resetMs / 1000)) }
        : { allowed: true, remaining: limit - count, retryAfterSeconds: 0 };
    } catch {
      logger.warn("shared_store.unavailable", { use: "rate-limit" });
    }
  }
  return checkRateLimit(key, limit, windowMs, now);
}

/**
 * The client's address. On Vercel the platform sets it itself (a client cannot
 * spoof those headers there). Behind PRESIGN_TRUSTED_PROXY_HOPS proxies, the
 * address the outermost trusted proxy appended to X-Forwarded-For (entries
 * before it are whatever the client sent). Otherwise nothing in the request
 * can be trusted, so every client shares one bucket.
 */
export function clientKey(request: Request): string {
  if (process.env.VERCEL) {
    const platform = request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip")?.trim();
    if (platform) return platform;
  }
  const hops = trustedProxyHops();
  if (hops > 0) {
    const chain = (request.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const ip = chain[chain.length - hops];
    if (ip) return ip;
  }
  return "direct";
}

export function resetRateLimits(): void {
  buckets.clear();
}
