import "server-only";
import { isAppError } from "@/lib/api/errors";
import { WSOL_MINT } from "@/lib/solana/constants";
import { getTokenMetadataBatch } from "@/lib/solana/tokens";
import { formatRawAmount } from "@/lib/token/amount";
import { analyzeTokensBatch } from "@/lib/token/scanner";
import type { TokenMetadata } from "@/lib/token/types";
import type { TransactionAnalysis } from "@/lib/transaction/types";
import type { ContextFindings } from "./context-rules";

/**
 * What the wallet RECEIVES matters too: a swap into a honeypot token (freeze
 * authority, permanent delegate, paused, non-transferable, flagged by RugCheck,
 * or a fake copy of a popular token such as "USDC" on another mint)
 * loses what was paid for it even though the transaction itself is ordinary.
 * Each token the simulation credits to the wallet is scanned with the same
 * token rules as the token page; its HIGH/CRITICAL findings become signals of
 * the request. A scanner failure is reported (analysis becomes PARTIAL), never
 * read as "no risk".
 */

/** Bounds RPC / RugCheck cost per request; extra mints are reported as not scanned. */
export const MAX_RECEIVED_TOKENS_SCANNED = 5;

function big(v: string | null | undefined): bigint {
  try {
    return v ? BigInt(v) : 0n;
  } catch {
    return 0n;
  }
}

export async function receivedTokenSignals(a: TransactionAnalysis, wallet: string): Promise<ContextFindings> {
  const out: ContextFindings = { signals: [], evidence: [], sources: [] };
  const e = a.effects;
  if (!e || e.source !== "SIMULATION" || !e.success) return out;

  const received = new Map<string, { raw: bigint; decimals: number }>();
  for (const c of e.tokenChanges) {
    const d = big(c.deltaRaw);
    if (c.owner !== wallet || d <= 0n || c.mint === WSOL_MINT) continue;
    const cur = received.get(c.mint) ?? { raw: 0n, decimals: c.decimals };
    received.set(c.mint, { raw: cur.raw + d, decimals: c.decimals });
  }
  if (received.size === 0) return out;

  const mints = [...received.keys()].slice(0, MAX_RECEIVED_TOKENS_SCANNED);
  const skipped = received.size - mints.length;
  // Symbol / name (for the impersonation check) come from Helius DAS when configured.
  let metadata: Map<string, TokenMetadata | null> = new Map();
  let metadataStatus: "OK" | "FAILED" | "NOT_CONFIGURED" = "OK";
  try {
    metadata = await getTokenMetadataBatch(mints);
  } catch (error) {
    metadataStatus = isAppError(error) && error.code === "NOT_CONFIGURED" ? "NOT_CONFIGURED" : "FAILED";
  }
  let reports: Awaited<ReturnType<typeof analyzeTokensBatch>>;
  try {
    reports = await analyzeTokensBatch(mints, metadata, metadataStatus);
  } catch {
    out.sources!.push({ source: "ONCHAIN_RPC", status: "FAILED", detail: "received-token scan failed" });
    out.degraded = true;
    return out;
  }

  let n = 0;
  let unscanned = skipped;
  for (const mint of mints) {
    const report = reports.get(mint);
    if (!report || report.risk.status === "UNAVAILABLE" || report.risk.status === "INSUFFICIENT_DATA") {
      unscanned++;
      continue;
    }
    const serious = report.risk.signals.filter((s) => s.severity === "HIGH" || s.severity === "CRITICAL");
    if (serious.length === 0) continue;
    const { raw, decimals } = received.get(mint)!;
    const id = `presign-received-${++n}`;
    out.evidence.push({ id, source: "SIMULATION", label: `Token the wallet receives (${mint.slice(0, 4)}…${mint.slice(-4)})`, observed: `+${formatRawAmount(raw.toString(), decimals)}; ${serious.map((s) => s.code).join(", ")}`, condition: "received token has HIGH/CRITICAL token-rule findings" });
    out.signals.push({
      code: `PRESIGN_RECEIVED_RISKY_TOKEN:${mint}`,
      title: "You receive a risky token",
      description: `The token you would receive (${mint.slice(0, 4)}…${mint.slice(-4)}) has: ${serious.map((s) => s.title.toLowerCase()).join("; ")}. You may not be able to sell or keep it — what you pay for it can be lost.`,
      severity: "HIGH",
      evidenceIds: [id],
    });
  }
  out.sources!.push({ source: "ONCHAIN_RPC", status: unscanned === 0 ? "OK" : "FAILED", detail: `received tokens scanned: ${mints.length - (unscanned - skipped)}/${received.size}` });
  if (unscanned > 0) out.degraded = true;
  return out;
}
