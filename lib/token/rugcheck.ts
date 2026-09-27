import "server-only";
import { logger } from "@/lib/api/logger";
import { TtlCache } from "@/lib/cache";
import { getCluster } from "@/lib/solana/config";
import { parseRugcheck, type RugcheckResult } from "./rugcheck-types";

/**
 * RugCheck client. RugCheck is an EXTERNAL opinion source — its findings are
 * shown as provider signals, never as on-chain facts. Failures degrade the
 * analysis to PARTIAL; they never imply safety.
 * RugCheck indexes mainnet only. On other clusters it is never queried: a
 * devnet mint can share its address with an unrelated mainnet token, and that
 * token's report must not be attributed to it.
 */

const BASE_URL = "https://api.rugcheck.xyz/v1";

export { parseRugcheck } from "./rugcheck-types";
export type { RugcheckData, RugcheckResult, RugcheckRisk } from "./rugcheck-types";

const cache = new TtlCache<RugcheckResult>(5 * 60_000);

async function fetchReport(mint: string, detail: "summary" | "full"): Promise<RugcheckResult> {
  const path = detail === "full" ? "report" : "report/summary";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/tokens/${mint}/${path}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(detail === "full" ? 15_000 : 8_000),
        cache: "no-store",
      });
      if (res.status === 404 || res.status === 400) return { ok: false, reason: "NOT_FOUND" };
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        continue;
      }
      if (!res.ok) return { ok: false, reason: "UNAVAILABLE" };
      const data = parseRugcheck(await res.json(), detail);
      return data ? { ok: true, data } : { ok: false, reason: "MALFORMED" };
    } catch {
      // timeout / network — retry once
    }
  }
  logger.warn("rugcheck.unavailable", { detail });
  return { ok: false, reason: "UNAVAILABLE" };
}

export async function getRugcheckReport(mint: string, detail: "summary" | "full" = "summary"): Promise<RugcheckResult> {
  if (process.env.RUGCHECK_DISABLED === "true") return { ok: false, reason: "UNAVAILABLE" };
  if (getCluster() !== "mainnet-beta") return { ok: false, reason: "UNSUPPORTED_CLUSTER" };
  const key = `${detail}:${mint}`;
  const result = await cache.getOrLoad(key, () => fetchReport(mint, detail));
  if (!result.ok && result.reason === "UNAVAILABLE") {
    // do not keep transient failures cached for the full TTL
    cache.set(key, result, Date.now() - 5 * 60_000 + 15_000);
  }
  return result;
}
