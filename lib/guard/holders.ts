import "server-only";
import bs58 from "bs58";
import { logger } from "@/lib/api/logger";
import { TtlCache } from "@/lib/cache";
import type { PrivilegedAction } from "@/lib/multisig/types";
import { rpcCall } from "@/lib/solana/client";
import { decodeGuardAccount } from "./codec";
import { GUARD_ACCOUNT_DISCRIMINATOR, guardProgramId, guardSignerPda } from "./constants";

/**
 * Handing an authority to a Presign Guard whose proposer is this multisig's
 * vault keeps it under the multisig's control — with a delay and a veto —
 * instead of moving it outside. Guards are found by their proposer, so a
 * guard proposed by anyone else stays "outside".
 */

/** Offset of `proposer` in a Guard account: discriminator (8) + create_key (32). */
export const GUARD_PROPOSER_OFFSET = 40;

export interface GuardHolder {
  guard: string;
  signer: string;
  delaySeconds: number;
  guardians: number;
}

const cache = new TtlCache<GuardHolder[]>(60_000, 500);

export function clearGuardHolderCache(): void {
  cache.clear();
}

/** Guards whose proposer is `proposer`; null when they could not be listed. */
export async function guardsProposedBy(proposer: string): Promise<GuardHolder[] | null> {
  const programId = guardProgramId();
  if (!programId) return [];
  try {
    return await cache.getOrLoad(proposer, async () => {
      const res = await rpcCall<Array<{ pubkey: string; account: { data: [string, string] } }>>("getProgramAccounts", [
        programId,
        {
          encoding: "base64",
          commitment: "confirmed",
          filters: [{ memcmp: { offset: 0, bytes: bs58.encode(Buffer.from(GUARD_ACCOUNT_DISCRIMINATOR.Guard, "hex")) } }, { memcmp: { offset: GUARD_PROPOSER_OFFSET, bytes: proposer } }],
        },
      ]);
      const out: GuardHolder[] = [];
      for (const a of res.result ?? []) {
        try {
          const g = decodeGuardAccount(Uint8Array.from(Buffer.from(a.account.data[0], "base64")));
          if (g.proposer === proposer) out.push({ guard: a.pubkey, signer: guardSignerPda(programId, a.pubkey), delaySeconds: g.delaySeconds, guardians: g.guardians.length });
        } catch {
          // Not a readable Guard account: ignore it.
        }
      }
      return out;
    });
  } catch (error) {
    logger.warn("guard.holders_unavailable", { error: error instanceof Error ? error.name : "unknown" });
    return null;
  }
}

/** Re-labels authority changes to a guard proposed by one of `proposers` as control "guard". */
export async function markGuardHolders(actions: PrivilegedAction[], proposers: string[]): Promise<PrivilegedAction[]> {
  if (!guardProgramId() || !proposers.length || !actions.some((a) => a.control === "outside" && a.newAuthority)) return actions;
  const bySigner = new Map<string, GuardHolder>();
  for (const p of new Set(proposers)) {
    for (const g of (await guardsProposedBy(p)) ?? []) bySigner.set(g.signer, g);
  }
  if (!bySigner.size) return actions;
  return actions.map((a) => {
    const g = a.control === "outside" && a.newAuthority ? bySigner.get(a.newAuthority) : undefined;
    return g ? { ...a, control: "guard" as const, guard: { address: g.guard, delaySeconds: g.delaySeconds, guardians: g.guardians } } : a;
  });
}
