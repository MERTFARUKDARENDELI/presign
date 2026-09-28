import { guardProgramId } from "@/lib/guard/constants";

/** Well-known Solana program ids. Pure constants — safe for client and server. */

export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const MEMO_V1_PROGRAM_ID = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";
export const BPF_LOADER_UPGRADEABLE_ID = "BPFLoaderUpgradeab1e11111111111111111111111";
export const BUBBLEGUM_PROGRAM_ID = "BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY";
export const ADDRESS_LOOKUP_TABLE_PROGRAM_ID = "AddressLookupTab1e1111111111111111111111111";
export const STAKE_PROGRAM_ID = "Stake11111111111111111111111111111111111111";
export const VOTE_PROGRAM_ID = "Vote111111111111111111111111111111111111111";

export const TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]);

export const LAMPORTS_PER_SOL = 1_000_000_000n;
/** Default base fee per signature. */
export const BASE_FEE_LAMPORTS_PER_SIGNATURE = 5_000n;

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export type ProgramTrust = "core" | "known" | "unknown";

export interface KnownProgram {
  name: string;
  trust: ProgramTrust;
}

/**
 * Programs whose identity is known. "known" is identity only — it is not a
 * safety endorsement; an unknown program is not automatically malicious.
 */
export const KNOWN_PROGRAMS: Record<string, KnownProgram> = {
  [SYSTEM_PROGRAM_ID]: { name: "System Program", trust: "core" },
  [TOKEN_PROGRAM_ID]: { name: "SPL Token", trust: "core" },
  [TOKEN_2022_PROGRAM_ID]: { name: "SPL Token-2022", trust: "core" },
  [ASSOCIATED_TOKEN_PROGRAM_ID]: { name: "Associated Token Account", trust: "core" },
  [COMPUTE_BUDGET_PROGRAM_ID]: { name: "Compute Budget", trust: "core" },
  [MEMO_PROGRAM_ID]: { name: "Memo", trust: "core" },
  [MEMO_V1_PROGRAM_ID]: { name: "Memo (v1)", trust: "core" },
  [ADDRESS_LOOKUP_TABLE_PROGRAM_ID]: { name: "Address Lookup Table", trust: "core" },
  [STAKE_PROGRAM_ID]: { name: "Stake Program", trust: "core" },
  [VOTE_PROGRAM_ID]: { name: "Vote Program", trust: "core" },
  [BPF_LOADER_UPGRADEABLE_ID]: { name: "BPF Upgradeable Loader", trust: "core" },
  [BUBBLEGUM_PROGRAM_ID]: { name: "Metaplex Bubblegum (cNFT)", trust: "known" },
  SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf: { name: "Squads Multisig v4", trust: "known" },
  dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH: { name: "Drift Protocol v2", trust: "known" },
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: { name: "Metaplex Token Metadata", trust: "known" },
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: { name: "Jupiter Aggregator v6", trust: "known" },
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: { name: "Orca Whirlpools", trust: "known" },
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": { name: "Raydium AMM v4", trust: "known" },
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: { name: "Raydium CLMM", trust: "known" },
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: { name: "Meteora DLMM", trust: "known" },
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": { name: "Pump.fun", trust: "known" },
};

export function programInfo(programId: string): KnownProgram {
  if (programId && programId === guardProgramId()) return { name: "Presign Guard", trust: "known" };
  return KNOWN_PROGRAMS[programId] ?? { name: "Unknown program", trust: "unknown" };
}
