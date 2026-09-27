import "server-only";
import { z } from "zod";
import { logger } from "@/lib/api/logger";
import { TtlCache } from "@/lib/cache";
import { rpcCall } from "@/lib/solana/client";
import { getCluster } from "@/lib/solana/config";
import { initializesMint, type TokenAgeObservation } from "./age";

/**
 * On-chain token age observation. Walks getSignaturesForAddress(mint) back at
 * most MAX_PAGES pages (bounded RPC cost). When history is exhausted, the
 * oldest transaction is fetched and must actually initialize this mint;
 * otherwise (pruned RPC history, a reused address) only a lower bound is
 * reported. Cached per cluster: a devnet mint never reuses a mainnet result.
 */

export const TOKEN_AGE_MAX_PAGES = 3;
const PAGE_LIMIT = 1_000;

const cache = new TtlCache<TokenAgeObservation>(30 * 60_000);

const sigSchema = z.object({ signature: z.string().min(64).max(90), blockTime: z.number().int().nullable().optional() });

async function observe(mint: string): Promise<TokenAgeObservation> {
  let before: string | undefined;
  let oldest: { signature: string; blockTime: number | null } | null = null;
  let exhausted = false;

  for (let page = 0; page < TOKEN_AGE_MAX_PAGES; page++) {
    const res = await rpcCall<unknown[]>("getSignaturesForAddress", [mint, { limit: PAGE_LIMIT, commitment: "confirmed", ...(before ? { before } : {}) }]);
    const rows = Array.isArray(res.result) ? res.result : null;
    if (!rows) return { status: "UNAVAILABLE", firstSeenUnix: null, source: null, detail: "Signature history response was malformed." };
    const parsed = rows.map((r) => sigSchema.safeParse(r));
    if (parsed.some((p) => !p.success)) return { status: "UNAVAILABLE", firstSeenUnix: null, source: null, detail: "Signature history contained malformed entries." };
    if (rows.length > 0) {
      const last = parsed[parsed.length - 1].data!;
      oldest = { signature: last.signature, blockTime: last.blockTime ?? null };
      before = last.signature;
    }
    if (rows.length < PAGE_LIMIT) {
      exhausted = true;
      break;
    }
  }

  if (!oldest) return { status: "UNAVAILABLE", firstSeenUnix: null, source: null, detail: "No on-chain history for this mint on this cluster." };
  if (oldest.blockTime === null) return { status: "UNAVAILABLE", firstSeenUnix: null, source: null, detail: "Oldest transaction has no block time." };

  if (!exhausted) {
    return { status: "LOWER_BOUND", firstSeenUnix: oldest.blockTime, source: "ONCHAIN_RPC", detail: `More than ${TOKEN_AGE_MAX_PAGES * PAGE_LIMIT} transactions; the token is at least as old as the oldest one checked.` };
  }

  let creation = false;
  try {
    const tx = await rpcCall<unknown>("getTransaction", [oldest.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
    creation = initializesMint(tx.result, mint);
  } catch {
    creation = false;
  }
  return creation
    ? { status: "KNOWN", firstSeenUnix: oldest.blockTime, source: "ONCHAIN_RPC", detail: "Block time of the transaction that initialized this mint." }
    : { status: "LOWER_BOUND", firstSeenUnix: oldest.blockTime, source: "ONCHAIN_RPC", detail: "Oldest available transaction does not initialize the mint (RPC history may be incomplete); the token is at least this old." };
}

export async function getOnchainTokenAgeObservation(mint: string): Promise<TokenAgeObservation> {
  const key = `${getCluster()}:${mint}`;
  try {
    const obs = await cache.getOrLoad(key, () => observe(mint));
    if (obs.status === "UNAVAILABLE") cache.set(key, obs, Date.now() - 30 * 60_000 + 60_000); // short TTL for failures
    return obs;
  } catch {
    logger.warn("token.age_unavailable", {});
    return { status: "UNAVAILABLE", firstSeenUnix: null, source: null, detail: "On-chain history could not be fetched." };
  }
}

/** Test hook. */
export function clearTokenAgeCache(): void {
  cache.clear();
}
