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
  /** Only present when the full report was fetched. */
  liquidityUsd: number | null;
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
  // token (e.g. USDC). Zero is then "unknown", never "very low".
  const hasMarkets = Array.isArray(d.markets) && d.markets.length > 0;
  const holders = typeof d.totalHolders === "number" && d.totalHolders > 0 ? d.totalHolders : null;
  return {
    risks: (d.risks ?? []).slice(0, 30).map((r) => ({
      name: r.name,
      description: r.description,
      level: normalizeLevel(r.level),
    })),
    scoreNormalised: d.score_normalised ?? null,
    lpLockedPct: d.lpLockedPct ?? null,
    liquidityUsd: detail === "full" && hasMarkets ? (d.totalMarketLiquidity ?? null) : null,
    totalHolders: detail === "full" ? holders : null,
    rugged: detail === "full" ? (d.rugged ?? null) : null,
    topHolderPct: detail === "full" ? (d.topHolders?.[0]?.pct ?? null) : null,
    firstSeenAt: detail === "full" ? (d.detectedAt ?? null) : null,
    detail,
  };
}
