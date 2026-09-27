import "server-only";
import { z } from "zod";
import { classifyTimelineEntry, type TimelineEvent } from "@/lib/security/timeline";
import { rpcCall } from "./client";

export interface SignatureInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
  failed: boolean;
  /** UNTRUSTED memo text, truncated. */
  memo: string | null;
  /** Deterministic classification from status + memo (no extra RPC). */
  event: TimelineEvent;
}

const sigSchema = z.object({
  signature: z.string().min(64).max(90),
  slot: z.number().int().nonnegative(),
  blockTime: z.number().int().nullable().optional(),
  err: z.unknown().optional(),
  memo: z.string().nullable().optional(),
});

export async function getTransactionHistory(
  address: string,
  limit = 25,
): Promise<{ items: SignatureInfo[]; malformed: number; source: "HELIUS_RPC" | "PUBLIC_RPC" }> {
  const res = await rpcCall<unknown[]>("getSignaturesForAddress", [
    address,
    { limit: Math.min(Math.max(limit, 1), 100), commitment: "confirmed" },
  ]);
  const items: SignatureInfo[] = [];
  let malformed = 0;
  for (const raw of Array.isArray(res.result) ? res.result : []) {
    const r = sigSchema.safeParse(raw);
    if (!r.success) {
      malformed++;
      continue;
    }
    const failed = r.data.err !== null && r.data.err !== undefined;
    const memo = r.data.memo ? r.data.memo.slice(0, 200) : null;
    items.push({
      signature: r.data.signature,
      slot: r.data.slot,
      blockTime: r.data.blockTime ?? null,
      failed,
      memo,
      event: classifyTimelineEntry({ failed, memo }),
    });
  }
  return { items, malformed, source: res.source };
}
