import "server-only";
import { AppError } from "@/lib/api/errors";
import { logger } from "@/lib/api/logger";
import { claimOnce, sharedStoreConfig } from "@/lib/api/shared-store";

/**
 * Single-use registry for nonces, approvals and submissions.
 *
 * With a shared store configured (lib/api/shared-store.ts) a key is claimed
 * there, so single use holds across every server instance. Otherwise — or if
 * the store does not answer — it is held in this instance's memory. Every
 * token is also bound to the session, the wallet and a short expiry.
 *
 * Under pressure nothing live is ever dropped: expired entries are swept, and
 * if the registry is still full new work is refused (spent tokens stay spent).
 */

const used = new Map<string, number>();
const MAX_ENTRIES = 50_000;

function sweep(now: number) {
  if (used.size < MAX_ENTRIES) return;
  for (const [k, exp] of used) if (exp < now) used.delete(k);
}

function consumeLocally(key: string, expiresAt: number, now: number): boolean {
  sweep(now);
  const prev = used.get(key);
  if (prev !== undefined && prev >= now) return false;
  if (used.size >= MAX_ENTRIES) throw new AppError("RATE_LIMITED", "Too many security reviews are open on this server right now. Please retry in a minute.");
  used.set(key, Math.max(expiresAt, now + 1_000));
  return true;
}

/** Marks `id` as used until `expiresAt`. Resolves false when it was already used (replay). */
export async function consumeOnce(scope: string, id: string, expiresAt: number, now: number = Date.now()): Promise<boolean> {
  const key = `${scope}:${id}`;
  if (sharedStoreConfig()) {
    try {
      return await claimOnce(`presign:once:${key}`, Math.max(expiresAt, now + 1_000) - now);
    } catch {
      logger.warn("shared_store.unavailable", { use: "single-use" });
    }
  }
  return consumeLocally(key, expiresAt, now);
}

export function resetReplayRegistry(): void {
  used.clear();
}
