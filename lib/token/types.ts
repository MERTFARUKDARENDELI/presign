/**
 * Internal normalized token models. External provider shapes (RPC jsonParsed,
 * Helius DAS, RugCheck) are converted into these and never reach the UI raw.
 * All u64 values are decimal strings.
 */

export type TokenProgramKind = "spl-token" | "token-2022";

export interface TokenAccountState {
  address: string;
  mint: string;
  owner: string;
  program: TokenProgramKind;
  amountRaw: string;
  decimals: number;
  uiAmount: string;
  state: "initialized" | "frozen" | "uninitialized";
  delegate: string | null;
  delegatedAmountRaw: string | null;
  closeAuthority: string | null;
  isNative: boolean;
  /** Lamports held by the account (rent). Null when not provided by the source. */
  lamports: string | null;
  /** Token-2022 account extension names. */
  extensions: string[];
}

export interface MintExtensions {
  permanentDelegate: string | null;
  transferFeeBasisPoints: number | null;
  transferHookProgramId: string | null;
  nonTransferable: boolean;
  defaultAccountState: string | null;
  mintCloseAuthority: string | null;
  pausable: boolean;
  paused: boolean;
}

export interface MintInfo {
  address: string;
  program: TokenProgramKind;
  decimals: number;
  supplyRaw: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  isInitialized: boolean;
  extensionNames: string[];
  extensions: MintExtensions;
  /** Token-2022 on-chain metadata extension, if present (UNTRUSTED text). */
  onchainMetadata: { name?: string; symbol?: string; uri?: string } | null;
}

export interface TokenMetadata {
  name?: string;
  symbol?: string;
  description?: string;
  image?: string;
  uri?: string;
  source: "HELIUS_DAS" | "TOKEN_2022_EXTENSION";
}

export interface TokenHolding {
  mint: string;
  program: TokenProgramKind;
  decimals: number;
  amountRaw: string;
  uiAmount: string;
  accounts: TokenAccountState[];
  metadata: TokenMetadata | null;
}

/** Backwards-compatible simple token shape. */
export interface Token {
  address: string;
  name: string;
  symbol: string;
  balance: string;
  decimals: number;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
}
