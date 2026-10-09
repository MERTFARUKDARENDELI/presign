import { z } from "zod";

/** RugCheck response types and pure parser (no network). */

export interface RugcheckRisk {
  name: string;
  description: string;
  level: "danger" | "warn" | "info" | "unknown";
}

export interface RugcheckData {
  risks: RugcheckRisk[];
  scoreNormalised: number | null;
  lpLockedPct: number | null;
  /** Only from the full report, with markets listed, and above $0 (CLAUDE.md rule 3: $0 is unknown, never "very low"). */
  liquidityUsd: number | null;
  /** The full report listed markets but put their liquidity at $0: unknown, and shown as such. */
  liquidityReportedZero?: boolean;
  totalHolders: number | null;
  rugged: boolean | null;
  topHolderPct: number | null;
  firstSeenAt: string | null;
  detail: "summary" | "full";
}

export type RugcheckResult =
  | { ok: true; data: RugcheckData }
  | { ok: false; reason: "NOT_FOUND" | "UNAVAILABLE" | "MALFORMED" | "UNSUPPORTED_CLUSTER" };

const riskSchema = z.object({
  name: z.string().max(200),
  description: z.string().max(500).optional().default(""),
  level: z.string().optional(),
});

const summarySchema = z.object({
  risks: z.array(riskSchema).nullable().optional(),
  score_normalised: z.number().nullable().optional(),
  lpLockedPct: z.number().nullable().optional(),
});

const fullSchema = summarySchema.extend({
  totalMarketLiquidity: z.number().nullable().optional(),
  totalHolders: z.number().nullable().optional(),
  rugged: z.boolean().nullable().optional(),
  detectedAt: z.string().nullable().optional(),
  topHolders: z.array(z.object({ pct: z.number().optional() }).passthrough()).nullable().optional(),
  markets: z.array(z.unknown()).nullable().optional(),
});

function normalizeLevel(level: string | undefined): RugcheckRisk["level"] {
  return level === "danger" || level === "warn" || level === "info" ? level : "unknown";
}

export function parseRugcheck(raw: unknown, detail: "summary" | "full"): RugcheckData | null {
  const parsed = (detail === "full" ? fullSchema : summarySchema).safeParse(raw);
  if (!parsed.success) return null;
  const d = parsed.data as z.infer<typeof fullSchema>;
  // RugCheck reports 0 liquidity / 0 holders when it has NO market data for a
  // token (e.g. USDC), and can report $0 for markets it lists but has no data
  // for. CLAUDE.md rule 3: zero is then "unknown" (INSUFFICIENT_DATA), never
  // "very low" (HIGH). Only a positive amount is evidence of low liquidity.
  const hasMarkets = Array.isArray(d.markets) && d.markets.length > 0;
  const liquidity = typeof d.totalMarketLiquidity === "number" ? d.totalMarketLiquidity : null;
  const holders = typeof d.totalHolders === "number" && d.totalHolders > 0 ? d.totalHolders : null;
  return {
    risks: (d.risks ?? []).slice(0, 30).map((r) => ({
      name: r.name,
      description: r.description,
      level: normalizeLevel(r.level),
    })),
    scoreNormalised: d.score_normalised ?? null,
    lpLockedPct: d.lpLockedPct ?? null,
    liquidityUsd: detail === "full" && hasMarkets && liquidity !== null && liquidity > 0 ? liquidity : null,
    liquidityReportedZero: detail === "full" && hasMarkets && liquidity === 0,
    totalHolders: detail === "full" ? holders : null,
    rugged: detail === "full" ? (d.rugged ?? null) : null,
    topHolderPct: detail === "full" ? (d.topHolders?.[0]?.pct ?? null) : null,
    firstSeenAt: detail === "full" ? (d.detectedAt ?? null) : null,
    detail,
  };
}
