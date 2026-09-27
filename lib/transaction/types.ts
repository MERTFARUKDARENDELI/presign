import type { RiskAssessment } from "@/lib/security/risk";
import type { AnalysisStatus } from "@/lib/security/types";

/** All lamport/token amounts are raw u64 decimal strings. */

export type TxInputKind = "signature" | "serialized-base64" | "serialized-base58" | "demo";

export interface DecodedAccountMeta {
  index: number;
  /** null when the key comes from an address lookup table that could not be resolved. */
  address: string | null;
  signer: boolean;
  writable: boolean;
  source: "static" | "lookup";
}

export interface InstructionAccountRef {
  name: string;
  address: string | null;
  signer: boolean;
  writable: boolean;
}

export interface DecodedInstruction {
  index: number;
  programId: string;
  programName: string;
  programTrust: "core" | "known" | "unknown";
  /** e.g. "system:transfer", "token:transferChecked", "unknown". */
  type: string;
  parsed: boolean;
  accounts: InstructionAccountRef[];
  /** Decoded fields; values serialized as strings. Memo text is UNTRUSTED. */
  info: Record<string, string | null>;
  dataLength: number;
  /** For inner (CPI) instructions: index of the top-level instruction that invoked it. */
  parentIndex?: number;
  stackHeight?: number | null;
}

export interface SolTransfer {
  instruction: number;
  /** True when performed by a program via CPI (inner instruction of `instruction`). */
  cpi?: boolean;
  from: string;
  to: string;
  lamports: string;
}

export interface TokenTransfer {
  instruction: number;
  /** True when performed by a program via CPI (inner instruction of `instruction`). */
  cpi?: boolean;
  program: "spl-token" | "token-2022";
  source: string;
  destination: string;
  authority: string;
  amountRaw: string;
  /** Known only for *Checked instructions; otherwise resolved from account state. */
  mint: string | null;
  decimals: number | null;
}

export interface TokenApproval {
  instruction: number;
  /** True when performed by a program via CPI (inner instruction of `instruction`). */
  cpi?: boolean;
  account: string;
  delegate: string;
  owner: string;
  amountRaw: string;
  unlimited: boolean;
}

export interface AuthorityChange {
  instruction: number;
  /** True when performed by a program via CPI (inner instruction of `instruction`). */
  cpi?: boolean;
  kind: "token-authority" | "system-assign";
  account: string;
  authorityType: string;
  currentAuthority: string | null;
  newAuthority: string | null;
}

export interface AccountClose {
  instruction: number;
  /** True when performed by a program via CPI (inner instruction of `instruction`). */
  cpi?: boolean;
  account: string;
  destination: string;
  authority: string;
}

/**
 * v1 messages carry the compute budget in the message itself instead of
 * ComputeBudget instructions. Unset fields are null; never inferred.
 */
export interface TransactionConfigV1 {
  computeUnitLimit: number | null;
  heapSize: number | null;
  loadedAccountsDataSizeLimit: number | null;
  /** TOTAL priority fee in lamports (not micro-lamports per CU). */
  priorityFeeLamports: string | null;
}

export interface DecodedTransaction {
  version: "legacy" | 0 | 1;
  /** v1 only; null for legacy and v0. */
  transactionConfig: TransactionConfigV1 | null;
  feePayer: string;
  signers: string[];
  signaturesPresent: number;
  recentBlockhash: string;
  accounts: DecodedAccountMeta[];
  instructions: DecodedInstruction[];
  programs: Array<{ programId: string; name: string; trust: "core" | "known" | "unknown" }>;
  solTransfers: SolTransfer[];
  tokenTransfers: TokenTransfer[];
  approvals: TokenApproval[];
  authorityChanges: AuthorityChange[];
  closes: AccountClose[];
  usesDurableNonce: boolean;
  lookupTablesResolved: boolean;
  /** Instructions whose program is recognized but whose data could not be decoded. */
  undecodedInstructions: number[];
  /** CPI instructions, when known from simulation or the executed transaction record. */
  innerInstructions: DecodedInstruction[];
  innerInstructionsSource: "SIMULATION" | "EXECUTED" | "NONE";
}

export interface SolBalanceChange {
  address: string;
  preLamports: string;
  postLamports: string;
  deltaLamports: string;
}

export interface TokenBalanceChange {
  tokenAccount: string;
  owner: string | null;
  mint: string;
  decimals: number;
  preRaw: string;
  postRaw: string;
  deltaRaw: string;
}

export interface AccountStateChange {
  address: string;
  ownerBefore: string | null;
  ownerAfter: string | null;
  created: boolean;
  closed: boolean;
  /** Token account delegate change (parsed accounts only). */
  delegateBefore?: string | null;
  delegateAfter?: string | null;
  /** Token account authority change (parsed accounts only). */
  tokenOwnerBefore?: string | null;
  tokenOwnerAfter?: string | null;
}

export interface TransactionEffects {
  /** SIMULATION = pre-sign simulation, EXECUTED = on-chain result of a past tx. */
  source: "SIMULATION" | "EXECUTED" | "DEMO";
  success: boolean;
  error: string | null;
  logs: string[];
  logsTruncated: boolean;
  unitsConsumed: number | null;
  slot: number | null;
  /** Slot of the pre-state snapshot used for diffs (simulation only). */
  preStateSlot: number | null;
  stale: boolean;
  /** Whether the transaction's own blockhash is still valid (simulation only). */
  blockhashValid: boolean | null;
  feeLamports: string | null;
  solChanges: SolBalanceChange[];
  tokenChanges: TokenBalanceChange[];
  accountChanges: AccountStateChange[];
  notes: string[];
}

export interface TransactionAnalysis {
  inputKind: TxInputKind;
  signature: string | null;
  /** sha256 of the analyzed message bytes (serialized inputs) — lets the client prove it signs exactly what was analyzed. */
  messageHash: string | null;
  cluster: "mainnet-beta" | "devnet";
  perspectiveWallet: string;
  perspectiveSource: "provided" | "fee-payer";
  decoded: DecodedTransaction;
  effects: TransactionEffects | null;
  effectsStatus: AnalysisStatus;
  risk: RiskAssessment;
  demo: boolean;
}

/** Backwards-compatible summary shape. */
export interface Transaction {
  signature: string;
  walletAddress: string;
  blockTime?: number | null;
  status: "success" | "failed" | "unknown";
  instructions: string[];
  balanceChanges: BalanceChange[];
}

export interface BalanceChange {
  asset: string;
  amountRaw: string;
  direction: "in" | "out";
}
