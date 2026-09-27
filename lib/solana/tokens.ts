import "server-only";
import { AppError } from "@/lib/api/errors";
import { formatRawAmount, sumRaw } from "@/lib/token/amount";
import type { TokenAccountState, TokenHolding, TokenMetadata } from "@/lib/token/types";
import { rpcCall } from "./client";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./constants";
import { parseDasAsset, type DigitalAsset } from "./das";
import { parseTokenAccount } from "./parsers";

interface TokenAccountsResponse {
  value: Array<{ pubkey: string; account: unknown }>;
}

export interface TokenAccountsResult {
  accounts: TokenAccountState[];
  /** Entries the provider returned that failed validation (never trusted). */
  malformed: number;
  source: "HELIUS_RPC" | "PUBLIC_RPC";
  fallbackUsed: boolean;
}

/** Fetch SPL Token and Token-2022 accounts owned by the wallet. */
export async function getTokenAccounts(walletAddress: string): Promise<TokenAccountsResult> {
  const results = await Promise.all(
    [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((programId) =>
      rpcCall<TokenAccountsResponse>("getTokenAccountsByOwner", [
        walletAddress,
        { programId },
        { encoding: "jsonParsed", commitment: "confirmed" },
      ]),
    ),
  );

  const accounts: TokenAccountState[] = [];
  let malformed = 0;
  for (const res of results) {
    for (const entry of res.result?.value ?? []) {
      const parsed = typeof entry?.pubkey === "string" ? parseTokenAccount(entry.pubkey, entry.account) : null;
      if (parsed && parsed.owner === walletAddress) accounts.push(parsed);
      else malformed++;
    }
  }

  return {
    accounts,
    malformed,
    source: results.some((r) => r.source === "PUBLIC_RPC") ? "PUBLIC_RPC" : "HELIUS_RPC",
    fallbackUsed: results.some((r) => r.fallbackUsed),
  };
}

/** Group accounts by mint, summing raw amounts with bigint precision. */
export function groupTokenBalances(accounts: TokenAccountState[]): TokenHolding[] {
  const byMint = new Map<string, TokenAccountState[]>();
  for (const account of accounts) {
    const list = byMint.get(account.mint) ?? [];
    list.push(account);
    byMint.set(account.mint, list);
  }

  return [...byMint.entries()].map(([mint, list]) => {
    const amountRaw = sumRaw(list.map((a) => a.amountRaw));
    return {
      mint,
      program: list[0].program,
      decimals: list[0].decimals,
      amountRaw,
      uiAmount: formatRawAmount(amountRaw, list[0].decimals),
      accounts: list,
      metadata: null,
    };
  });
}

function toMetadata(asset: DigitalAsset): TokenMetadata {
  return {
    name: asset.name ?? undefined,
    symbol: asset.symbol ?? undefined,
    description: asset.description ?? undefined,
    image: asset.image ?? undefined,
    uri: asset.jsonUri ?? undefined,
    source: "HELIUS_DAS",
  };
}

/** Batch metadata lookup via Helius DAS. Requires Helius (no public fallback). */
export async function getTokenMetadataBatch(mints: string[]): Promise<Map<string, TokenMetadata>> {
  const out = new Map<string, TokenMetadata>();
  for (let i = 0; i < mints.length; i += 100) {
    const ids = mints.slice(i, i + 100);
    const res = await rpcCall<unknown[]>("getAssetBatch", { ids }, { timeoutMs: 12_000 });
    for (const raw of Array.isArray(res.result) ? res.result : []) {
      const asset = parseDasAsset(raw);
      if (asset) out.set(asset.id, toMetadata(asset));
    }
  }
  return out;
}

export async function getTokenMetadata(mint: string): Promise<TokenMetadata | null> {
  const map = await getTokenMetadataBatch([mint]);
  return map.get(mint) ?? null;
}

interface AssetsByOwnerResponse {
  /** Number of items in THIS page (not the wallet total). */
  total?: number;
  items?: unknown[];
}

export const DAS_PAGE_SIZE = 25;
export const DAS_MAX_PAGES = 8;
const DAS_TIME_BUDGET_MS = 25_000;

/**
 * NFTs and compressed NFTs via Helius DAS (not available on public RPC).
 * Spam NFTs can carry multi-megabyte metadata (a few items exceed Helius'
 * 20 MB response cap), so pages are small and a failing page is skipped and
 * reported as `truncated` instead of failing the whole scan. Page count and
 * total time are bounded to control provider cost.
 */
export async function getAssetsByOwner(
  owner: string,
): Promise<{ assets: DigitalAsset[]; truncated: boolean; malformed: number; failedPages: number }> {
  const assets: DigitalAsset[] = [];
  let malformed = 0;
  let truncated = false;
  let failedPages = 0;
  let lastError: unknown = null;
  const deadline = Date.now() + DAS_TIME_BUDGET_MS;

  for (let page = 1; page <= DAS_MAX_PAGES; page++) {
    if (Date.now() > deadline) {
      truncated = true;
      break;
    }
    let items: unknown[];
    try {
      const res = await rpcCall<AssetsByOwnerResponse>(
        "getAssetsByOwner",
        { ownerAddress: owner, page, limit: DAS_PAGE_SIZE, displayOptions: { showFungible: false } },
        { timeoutMs: 12_000, retries: 0 },
      );
      items = Array.isArray(res.result?.items) ? res.result.items : [];
    } catch (error) {
      if (error instanceof AppError && error.code === "NOT_CONFIGURED") throw error;
      failedPages++;
      truncated = true;
      lastError = error;
      continue; // oversized/failed page: skip it, keep scanning
    }
    for (const raw of items) {
      const a = parseDasAsset(raw);
      if (a) assets.push(a);
      else malformed++;
    }
    if (items.length < DAS_PAGE_SIZE) break;
    if (page === DAS_MAX_PAGES) truncated = true;
  }

  if (assets.length === 0 && failedPages > 0) throw lastError;
  return { assets, truncated, malformed, failedPages };
}
