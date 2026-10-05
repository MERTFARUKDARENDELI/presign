import "server-only";
import { rpcCall } from "./client";

interface MultipleAccountsResult {
  context: { slot: number };
  value: Array<unknown | null>;
}

export interface ParsedAccountsResult {
  accounts: Map<string, unknown | null>;
  slot: number;
  source: "HELIUS_RPC" | "PUBLIC_RPC";
  fallbackUsed: boolean;
}

/** Batched getMultipleAccounts (jsonParsed), 100 keys per request. `minContextSlot` refuses state older than that slot. */
export async function getParsedAccounts(addresses: string[], options: { minContextSlot?: number } = {}): Promise<ParsedAccountsResult> {
  const unique = [...new Set(addresses)];
  const accounts = new Map<string, unknown | null>();
  let slot = 0;
  let source: ParsedAccountsResult["source"] = "HELIUS_RPC";
  let fallbackUsed = false;

  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const res = await rpcCall<MultipleAccountsResult>("getMultipleAccounts", [
      chunk,
      { encoding: "jsonParsed", commitment: "confirmed", ...(options.minContextSlot === undefined ? {} : { minContextSlot: options.minContextSlot }) },
    ]);
    slot = Math.max(slot, res.result.context?.slot ?? 0);
    source = res.source;
    fallbackUsed ||= res.fallbackUsed;
    chunk.forEach((addr, idx) => accounts.set(addr, res.result.value?.[idx] ?? null));
  }

  return { accounts, slot, source, fallbackUsed };
}

export async function getParsedAccount(address: string) {
  const res = await getParsedAccounts([address]);
  return { account: res.accounts.get(address) ?? null, slot: res.slot, source: res.source };
}
