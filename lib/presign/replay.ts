import "server-only";

/**
 * Single-use registry for nonces, approvals and submissions.
 *
 * In-memory and per instance (like the rate limiter). Every token is also
 * bound to the session, the wallet and a short expiry, so a replay could at
 * most re-present the same, already analyzed payload for the same wallet in
 * the same browser session. Configure a shared store to make this global.
 */

const used = new Map<string, number>();
const MAX_ENTRIES = 50_000;

function sweep(now: number) {
  if (used.size < MAX_ENTRIES) return;
  for (const [k, exp] of used) if (exp < now) used.delete(k);
  if (used.size >= MAX_ENTRIES) used.clear();
}

/** Marks `id` as used until `expiresAt`. Returns false when it was already used (replay). */
export function consumeOnce(scope: string, id: string, expiresAt: number, now: number = Date.now()): boolean {
  sweep(now);
  const key = `${scope}:${id}`;
  const prev = used.get(key);
  if (prev !== undefined && prev >= now) return false;
  used.set(key, Math.max(expiresAt, now + 1_000));
  return true;
}

export function resetReplayRegistry(): void {
  used.clear();
}
