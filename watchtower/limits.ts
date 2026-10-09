import type { TargetKind } from "./store.ts";

/**
 * What one chat or one person can make Watchtower do. The bot is public:
 * anyone can message it or add it to a group. Every /watch adds a target
 * that is polled cycle after cycle, and every /check or /watch costs a Presign
 * inspection (several RPC calls). Without limits, one account could subscribe
 * thousands of real multisigs — lengthening every cycle and delaying the
 * alerts for the targets that matter — and spend the RPC quota.
 *
 * Targets configured in the environment (WATCH_MULTISIGS / WATCH_GUARDS) are
 * the operator's own: they do not count against these limits, and every cycle
 * polls them first.
 */
export const LIMITS = {
  /** Targets one chat can watch. */
  perChat: 20,
  /** Distinct targets watched through the bot (beyond the environment's). */
  botTargets: 500,
  /** Bot targets polled per cycle, in turns: a cycle's length stays bounded whatever people subscribe. */
  botPerCycle: 100,
  /** Inspections running at once (each one is a Presign API call that makes RPC calls; CLAUDE.md rule 2). */
  concurrency: 4,
  /** /check and /watch inspections per person per minute, and for everyone together. */
  perUserPerMinute: 6,
  allPerMinute: 60,
} as const;

export type Refusal = "user" | "all";

/** Sliding one-minute window: per key, and for all keys together. */
export function createRateLimiter(perKey: number = LIMITS.perUserPerMinute, total: number = LIMITS.allPerMinute, windowSeconds = 60) {
  const hits = new Map<string, number[]>();
  let all: number[] = [];
  return {
    /** Counts one use by `key` at `now` (seconds) and returns null, or says which limit refuses it. */
    take(key: string, now: number): Refusal | null {
      const since = now - windowSeconds;
      all = all.filter((t) => t > since);
      const mine = (hits.get(key) ?? []).filter((t) => t > since);
      // Keys with nothing in the window are forgotten, so the map holds only recent users.
      if (hits.size > 10_000) for (const [k, ts] of hits) if (!ts.some((t) => t > since)) hits.delete(k);
      if (mine.length >= perKey) {
        hits.set(key, mine);
        return "user";
      }
      if (all.length >= total) {
        hits.set(key, mine);
        return "all";
      }
      mine.push(now);
      all.push(now);
      hits.set(key, mine);
      return null;
    },
  };
}

export type RateLimiter = ReturnType<typeof createRateLimiter>;

export interface PollTarget {
  target: string;
  kind: TargetKind;
  /** Watched from the environment (the operator's own target). */
  env: boolean;
}

/**
 * The targets one cycle polls: every environment target, first; then at most
 * `botPerCycle` bot targets, continuing where the previous cycle stopped (in
 * the store's stable order), so every bot target gets its turn and a cycle
 * never grows with the number of subscriptions.
 */
export function cycleTargets(all: readonly PollTarget[], cursor: number, botPerCycle: number = LIMITS.botPerCycle): { batch: PollTarget[]; nextCursor: number } {
  const env = all.filter((t) => t.env);
  const bot = all.filter((t) => !t.env);
  if (bot.length <= botPerCycle) return { batch: [...env, ...bot], nextCursor: 0 };
  const start = ((cursor % bot.length) + bot.length) % bot.length;
  const turn: PollTarget[] = [];
  for (let i = 0; i < botPerCycle; i++) turn.push(bot[(start + i) % bot.length]);
  return { batch: [...env, ...turn], nextCursor: (start + botPerCycle) % bot.length };
}

/**
 * Runs `work` for every item, at most `concurrency` at a time, in order of
 * start. A failing item is reported to `onError` and does not stop the others.
 */
export async function runLimited<T>(items: readonly T[], concurrency: number, work: (item: T) => Promise<void>, onError: (item: T, error: unknown) => void = () => undefined): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      try {
        await work(item);
      } catch (error) {
        onError(item, error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}
