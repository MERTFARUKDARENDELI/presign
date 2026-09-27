/**
 * Token age from verifiable observations only. Pure: no network.
 *
 *  - KNOWN: the oldest on-chain transaction touching the mint was fetched and
 *    it initializes this mint (InitializeMint/InitializeMint2), so its block
 *    time is the creation time.
 *  - LOWER_BOUND: the token is at least this old. It comes from the oldest
 *    signature seen when history was not exhausted or could not be verified as
 *    the creation, or from RugCheck's first-seen time (mainnet only).
 *  - UNAVAILABLE: nothing verifiable. The age is never guessed.
 *
 * Age alone is weak evidence: a new token is not a scam, and an old one is not
 * safe. Rules therefore cap age-only signals at MEDIUM.
 */

export type TokenAgeStatus = "KNOWN" | "LOWER_BOUND" | "UNAVAILABLE";
export type TokenAgeSource = "ONCHAIN_RPC" | "RUGCHECK";

export interface TokenAge {
  status: TokenAgeStatus;
  /** ISO time of creation (KNOWN) or of the oldest verified observation (LOWER_BOUND). */
  firstSeenAt: string | null;
  /** Exact age (KNOWN) or minimum age (LOWER_BOUND), in whole seconds. */
  ageSeconds: number | null;
  source: TokenAgeSource | null;
  cluster: "mainnet-beta" | "devnet";
  detail: string;
}

/** Observation cached by the fetcher; age is derived from it at read time. */
export interface TokenAgeObservation {
  status: TokenAgeStatus;
  firstSeenUnix: number | null;
  source: TokenAgeSource | null;
  detail: string;
}

export const TOKEN_AGE_THRESHOLDS = {
  veryNewSeconds: 24 * 3_600,
  newSeconds: 7 * 24 * 3_600,
} as const;

export function unavailableAge(cluster: TokenAge["cluster"], detail: string): TokenAge {
  return { status: "UNAVAILABLE", firstSeenAt: null, ageSeconds: null, source: null, cluster, detail };
}

export function ageFromObservation(obs: TokenAgeObservation, cluster: TokenAge["cluster"], now: Date = new Date()): TokenAge {
  if (obs.status === "UNAVAILABLE" || obs.firstSeenUnix === null || !Number.isSafeInteger(obs.firstSeenUnix) || obs.firstSeenUnix <= 0) {
    return unavailableAge(cluster, obs.status === "UNAVAILABLE" ? obs.detail : "No usable timestamp.");
  }
  const nowUnix = Math.floor(now.getTime() / 1000);
  if (obs.firstSeenUnix > nowUnix + 300) return unavailableAge(cluster, "Timestamp is in the future; ignored.");
  return {
    status: obs.status,
    firstSeenAt: new Date(obs.firstSeenUnix * 1000).toISOString(),
    ageSeconds: Math.max(0, nowUnix - obs.firstSeenUnix),
    source: obs.source,
    cluster,
    detail: obs.detail,
  };
}

/** RugCheck's `detectedAt` is when RugCheck first saw the token — only a lower bound on age. */
export function observationFromRugcheck(firstSeenAt: string | null): TokenAgeObservation | null {
  if (!firstSeenAt) return null;
  const ms = Date.parse(firstSeenAt);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return { status: "LOWER_BOUND", firstSeenUnix: Math.floor(ms / 1000), source: "RUGCHECK", detail: "First seen by RugCheck (external); the token is at least this old." };
}

/**
 * Combines on-chain and provider observations. An exact on-chain creation time
 * wins; otherwise the OLDEST lower bound is used (every lower bound is valid, so
 * the larger one is the tighter one).
 */
export function combineTokenAge(observations: Array<TokenAgeObservation | null>, cluster: TokenAge["cluster"], now: Date = new Date()): TokenAge {
  const usable = observations
    .filter((o): o is TokenAgeObservation => o !== null && o.status !== "UNAVAILABLE")
    .map((o) => ageFromObservation(o, cluster, now))
    .filter((a) => a.status !== "UNAVAILABLE");
  const known = usable.find((a) => a.status === "KNOWN");
  if (known) return known;
  const lower = usable.sort((a, b) => (b.ageSeconds ?? 0) - (a.ageSeconds ?? 0))[0];
  if (lower) return lower;
  const reasons = observations.filter((o): o is TokenAgeObservation => o !== null).map((o) => o.detail);
  return unavailableAge(cluster, reasons.join(" ") || "Token age could not be determined.");
}

/** Whether a token of this age is conclusively older than the "new" threshold. */
export function isConclusivelyEstablished(age: TokenAge): boolean {
  return age.status !== "UNAVAILABLE" && age.ageSeconds !== null && age.ageSeconds >= TOKEN_AGE_THRESHOLDS.newSeconds;
}

export function formatAge(seconds: number): string {
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)} h`;
  return `${Math.floor(seconds / 86_400)} d`;
}

export function describeAge(age: TokenAge): string {
  if (age.status === "UNAVAILABLE" || age.ageSeconds === null) return "unavailable";
  return age.status === "KNOWN" ? formatAge(age.ageSeconds) : `at least ${formatAge(age.ageSeconds)}`;
}

/**
 * True if a jsonParsed transaction initializes `mint` (top-level or CPI).
 * Only the parsed SPL Token / Token-2022 initializeMint(2) shape is accepted.
 */
export function initializesMint(tx: unknown, mint: string): boolean {
  const t = tx as { transaction?: { message?: { instructions?: unknown[] } }; meta?: { innerInstructions?: Array<{ instructions?: unknown[] }> | null } } | null;
  const all = [
    ...(t?.transaction?.message?.instructions ?? []),
    ...(t?.meta?.innerInstructions ?? []).flatMap((g) => (Array.isArray(g?.instructions) ? g.instructions : [])),
  ];
  return all.some((ix) => {
    const i = ix as { program?: unknown; parsed?: { type?: unknown; info?: { mint?: unknown } } } | null;
    return (
      (i?.program === "spl-token" || i?.program === "spl-token-2022") &&
      (i.parsed?.type === "initializeMint" || i.parsed?.type === "initializeMint2") &&
      i.parsed?.info?.mint === mint
    );
  });
}
