import type { DigitalAsset } from "@/lib/solana/das";
import type { AnalysisStatus, DataSourceStatus } from "@/lib/security/types";
import type { TokenAccountState, TokenHolding } from "@/lib/token/types";

export interface Wallet {
  address: string;
  /** Raw lamports, decimal string. */
  lamports: string;
  tokenCount: number;
  lastScannedAt?: string;
}

/** Normalized on-chain wallet state. */
export interface WalletSnapshot {
  address: string;
  cluster: "mainnet-beta" | "devnet";
  lamports: string;
  /** Display string, e.g. "1.25". */
  sol: string;
  tokenAccounts: TokenAccountState[];
  holdings: TokenHolding[];
  /** NFTs / cNFTs from Helius DAS. Empty when DAS is unavailable (see sources). */
  assets: DigitalAsset[];
  assetsTruncated: boolean;
  status: AnalysisStatus;
  sources: DataSourceStatus[];
  fetchedAt: string;
}
