import "server-only";
import { rpcCall } from "@/lib/solana/client";
import { SQUADS_V4_PROGRAM_ID } from "@/lib/squads/constants";

/**
 * Read-only access to Squads state. Only accounts owned by the Squads program
 * are ever treated as Squads data; anything else is reported as such.
 */

export type SquadsFetch =
  | { status: "OK"; data: Uint8Array }
  | { status: "NOT_FOUND" }
  | { status: "FAILED" }
  | { status: "WRONG_OWNER"; owner: string };

type RawAccount = { data: [string, string]; owner: string } | null;

function toFetch(v: RawAccount): SquadsFetch {
  if (!v) return { status: "NOT_FOUND" };
  if (v.owner !== SQUADS_V4_PROGRAM_ID) return { status: "WRONG_OWNER", owner: v.owner };
  return { status: "OK", data: Uint8Array.from(Buffer.from(v.data[0], "base64")) };
}

export async function fetchSquadsAccount(address: string): Promise<SquadsFetch> {
  try {
    const res = await rpcCall<{ value: RawAccount }>("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }]);
    return toFetch(res.result?.value ?? null);
  } catch {
    return { status: "FAILED" };
  }
}

/** Batched getMultipleAccounts (base64), 100 per request; a failed batch marks its addresses FAILED. */
export async function fetchSquadsAccounts(addresses: string[]): Promise<Map<string, SquadsFetch>> {
  const out = new Map<string, SquadsFetch>();
  const unique = [...new Set(addresses)];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    try {
      const res = await rpcCall<{ value: RawAccount[] }>("getMultipleAccounts", [chunk, { encoding: "base64", commitment: "confirmed" }]);
      chunk.forEach((a, idx) => out.set(a, toFetch(res.result?.value?.[idx] ?? null)));
    } catch {
      for (const a of chunk) out.set(a, { status: "FAILED" });
    }
  }
  return out;
}
