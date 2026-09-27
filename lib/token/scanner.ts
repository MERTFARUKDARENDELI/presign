import "server-only";
import { isAppError } from "@/lib/api/errors";
import { logger } from "@/lib/api/logger";
import { computeConcentration, evaluateTokenRisk } from "@/lib/security/rules/token";
import { getParsedAccounts } from "@/lib/solana/accounts";
import { rpcCall } from "@/lib/solana/client";
import { getCluster, isHeliusConfigured } from "@/lib/solana/config";
import { parseMintAccount } from "@/lib/solana/parsers";
import { getTokenMetadata } from "@/lib/solana/tokens";
import { combineTokenAge, observationFromRugcheck, unavailableAge, type TokenAge } from "./age";
import { getOnchainTokenAgeObservation } from "./age-source";
import type { TokenSecurityReport } from "./report";
import { getRugcheckReport } from "./rugcheck";

export type { TokenSecurityReport } from "./report";
import type { MintInfo, TokenMetadata } from "./types";


async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

async function largestAccounts(mint: string): Promise<string[] | null> {
  try {
    const res = await rpcCall<{ value: Array<{ amount: string }> }>("getTokenLargestAccounts", [mint, { commitment: "confirmed" }]);
    const vals = Array.isArray(res.result?.value) ? res.result.value : [];
    const amounts = vals.map((v) => v.amount).filter((a) => typeof a === "string" && /^\d+$/.test(a));
    return amounts.length === vals.length ? amounts : null;
  } catch {
    return null;
  }
}

/** Deep single-token analysis: on-chain mint + RugCheck full + holder concentration + metadata + token age. */
export async function analyzeToken(mint: string): Promise<TokenSecurityReport> {
  let mintInfo: MintInfo | null = null;
  let mintStatus: "OK" | "NOT_FOUND" | "NOT_A_MINT" | "FAILED" = "FAILED";
  try {
    const { accounts } = await getParsedAccounts([mint]);
    const raw = accounts.get(mint) ?? null;
    mintInfo = raw ? parseMintAccount(mint, raw) : null;
    mintStatus = !raw ? "NOT_FOUND" : mintInfo ? "OK" : "NOT_A_MINT";
  } catch (error) {
    logger.warn("token.mint_fetch_failed", { code: isAppError(error) ? error.code : "UNKNOWN" });
  }

  const heliusOn = isHeliusConfigured();
  const [rugcheck, largest, metadata, onchainAge] = await Promise.all([
    getRugcheckReport(mint, "full"),
    mintInfo ? largestAccounts(mint) : Promise.resolve(null),
    heliusOn ? getTokenMetadata(mint).catch(() => undefined) : Promise.resolve(undefined),
    mintInfo ? getOnchainTokenAgeObservation(mint) : Promise.resolve(null),
  ]);
  const cluster = getCluster();
  // RugCheck is mainnet-only (UNSUPPORTED_CLUSTER elsewhere), so devnet age is on-chain only.
  const age: TokenAge = mintInfo
    ? combineTokenAge([onchainAge, rugcheck.ok ? observationFromRugcheck(rugcheck.data.firstSeenAt) : null], cluster)
    : unavailableAge(cluster, "Mint account unavailable.");

  const concentration = mintInfo && largest ? computeConcentration(largest, mintInfo.supplyRaw) : null;
  const risk = evaluateTokenRisk({
    mintAddress: mint,
    mint: mintInfo,
    mintStatus,
    rugcheck,
    concentration,
    concentrationStatus: !mintInfo ? "SKIPPED" : largest ? "OK" : "FAILED",
    metadata: metadata ?? null,
    metadataStatus: !heliusOn ? "NOT_CONFIGURED" : metadata === undefined ? "FAILED" : "OK",
    age,
  });

  return { mint, mintInfo, metadata: metadata ?? null, rugcheck: rugcheck.ok ? rugcheck.data : null, concentration, age, risk };
}

/**
 * Wallet-scan analysis for many mints: batched mint fetch + RugCheck summary
 * (no per-token holder scan to bound RPC/API cost). Results are PARTIAL by
 * design; the UI offers a deep scan per token.
 */
export async function analyzeTokensBatch(
  mints: string[],
  metadata: Map<string, TokenMetadata | null>,
  metadataStatus: "OK" | "FAILED" | "NOT_CONFIGURED",
): Promise<Map<string, TokenSecurityReport>> {
  const out = new Map<string, TokenSecurityReport>();
  if (mints.length === 0) return out;

  let accounts = new Map<string, unknown | null>();
  let fetchFailed = false;
  try {
    accounts = (await getParsedAccounts(mints)).accounts;
  } catch {
    fetchFailed = true;
  }

  const rug = await mapLimit(mints, 4, (m) => getRugcheckReport(m, "summary"));

  mints.forEach((mint, i) => {
    const raw = accounts.get(mint) ?? null;
    const mintInfo = raw ? parseMintAccount(mint, raw) : null;
    const meta = metadata.get(mint) ?? null;
    const risk = evaluateTokenRisk({
      mintAddress: mint,
      mint: mintInfo,
      mintStatus: fetchFailed ? "FAILED" : !raw ? "NOT_FOUND" : mintInfo ? "OK" : "NOT_A_MINT",
      rugcheck: rug[i],
      concentration: null,
      concentrationStatus: "SKIPPED",
      metadata: meta,
      metadataStatus: metadataStatus === "OK" && !meta ? "SKIPPED" : metadataStatus,
    });
    out.set(mint, { mint, mintInfo, metadata: meta, rugcheck: rug[i].ok ? rug[i].data : null, concentration: null, risk });
  });
  return out;
}
