import "server-only";
import { AppError, isAppError } from "@/lib/api/errors";
import { logger, maskAddress } from "@/lib/api/logger";
import { combineStatuses, type AnalysisStatus, type DataSourceStatus } from "@/lib/security/types";
import { formatLamports } from "@/lib/token/amount";
import { isValidPublicKey } from "@/lib/validation/schemas";
import type { WalletSnapshot } from "@/lib/wallet/types";
import { rpcCall } from "./client";
import { getCluster, isHeliusConfigured } from "./config";
import type { DigitalAsset } from "./das";
import { getAssetsByOwner, getTokenAccounts, getTokenMetadataBatch, groupTokenBalances } from "./tokens";

export { isValidSolanaAddress } from "@/lib/validation/schemas";

interface GetBalanceResponse {
  context: { slot: number };
  value: number;
}

/** SOL balance in raw lamports (decimal string). */
export async function getSolBalance(walletAddress: string): Promise<{ lamports: string; source: DataSourceStatus["source"] }> {
  const res = await rpcCall<GetBalanceResponse>("getBalance", [walletAddress, { commitment: "confirmed" }]);
  const value = res.result?.value;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AppError("RPC_ERROR", "RPC returned an invalid balance.");
  }
  return { lamports: BigInt(value).toString(), source: res.source };
}

/**
 * Collects normalized wallet data. Core balances are required; enhanced data
 * (metadata, NFTs/cNFTs) degrades gracefully and is reflected in `status`.
 */
export async function getWalletData(walletAddress: string): Promise<WalletSnapshot> {
  if (!isValidPublicKey(walletAddress)) {
    throw new AppError("INVALID_WALLET", "Invalid Solana wallet address.");
  }

  const [balance, tokenResult] = await Promise.all([
    getSolBalance(walletAddress),
    getTokenAccounts(walletAddress),
  ]);

  const sources: DataSourceStatus[] = [
    { source: balance.source, status: "OK", detail: "SOL balance and token accounts" },
  ];
  const statuses: AnalysisStatus[] = [tokenResult.malformed > 0 ? "PARTIAL" : "COMPLETE"];
  if (tokenResult.malformed > 0) {
    sources.push({ source: tokenResult.source, status: "FAILED", detail: `${tokenResult.malformed} malformed token account(s) ignored` });
  }

  const holdings = groupTokenBalances(tokenResult.accounts);
  let assets: DigitalAsset[] = [];
  let assetsTruncated = false;

  if (!isHeliusConfigured()) {
    sources.push({ source: "HELIUS_DAS", status: "NOT_CONFIGURED", detail: "Token metadata and NFT/cNFT data unavailable" });
    statuses.push("PARTIAL");
  } else {
    const [meta, owned] = await Promise.allSettled([
      holdings.length ? getTokenMetadataBatch(holdings.map((h) => h.mint)) : Promise.resolve(new Map()),
      getAssetsByOwner(walletAddress),
    ]);

    if (meta.status === "fulfilled") {
      for (const h of holdings) h.metadata = meta.value.get(h.mint) ?? null;
      sources.push({ source: "HELIUS_DAS", status: "OK", detail: "Token metadata" });
    } else {
      statuses.push("PARTIAL");
      sources.push({ source: "HELIUS_DAS", status: "FAILED", detail: "Token metadata unavailable" });
      logger.warn("wallet.metadata_failed", { wallet: maskAddress(walletAddress), code: isAppError(meta.reason) ? meta.reason.code : "UNKNOWN" });
    }

    if (owned.status === "fulfilled") {
      assets = owned.value.assets;
      assetsTruncated = owned.value.truncated;
      if (assetsTruncated || owned.value.malformed > 0) statuses.push("PARTIAL");
      sources.push({
        source: "HELIUS_DAS",
        status: "OK",
        detail: `NFT/cNFT assets${owned.value.failedPages ? ` (partial: ${owned.value.failedPages} page(s) failed — oversized spam metadata or provider error)` : assetsTruncated ? " (truncated at scan limit)" : ""}`,
      });
    } else {
      statuses.push("PARTIAL");
      sources.push({ source: "HELIUS_DAS", status: "FAILED", detail: "NFT/cNFT assets unavailable" });
    }
  }

  logger.info("wallet.scan", {
    wallet: maskAddress(walletAddress),
    tokenAccounts: tokenResult.accounts.length,
    assets: assets.length,
    fallback: tokenResult.fallbackUsed,
  });

  return {
    address: walletAddress,
    cluster: getCluster(),
    lamports: balance.lamports,
    sol: formatLamports(balance.lamports),
    tokenAccounts: tokenResult.accounts,
    holdings,
    assets,
    assetsTruncated,
    status: combineStatuses(statuses),
    sources,
    fetchedAt: new Date().toISOString(),
  };
}
