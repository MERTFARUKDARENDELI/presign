import type { SquadsIxName } from "./constants";

/** Decoded Squads v4 structures. Amounts and u64 indexes are decimal strings (never bigint) so they serialize. */

export interface SquadsCompiledInstruction {
  programIdIndex: number;
  accountIndexes: number[];
  data: Uint8Array;
}

export interface SquadsAddressTableLookup {
  accountKey: string;
  writableIndexes: number[];
  readonlyIndexes: number[];
}

/** The transaction a vault will execute. Same shape whether it came from instruction args or an account. */
export interface SquadsMessage {
  numSigners: number;
  numWritableSigners: number;
  numWritableNonSigners: number;
  accountKeys: string[];
  instructions: SquadsCompiledInstruction[];
  addressTableLookups: SquadsAddressTableLookup[];
}

export type SquadsPermission = "Initiate" | "Vote" | "Execute";

export interface SquadsMember {
  key: string;
  permissions: SquadsPermission[];
}

export type ConfigAction =
  | { type: "AddMember"; member: SquadsMember }
  | { type: "RemoveMember"; member: string }
  | { type: "ChangeThreshold"; newThreshold: number }
  | { type: "SetTimeLock"; newTimeLock: number }
  | { type: "AddSpendingLimit"; createKey: string; vaultIndex: number; mint: string; amount: string; period: string; members: string[]; destinations: string[] }
  | { type: "RemoveSpendingLimit"; spendingLimit: string | null }
  | { type: "SetRentCollector"; newRentCollector: string | null }
  | { type: "SetConfigAuthority"; newConfigAuthority: string };

export type SquadsIxKind =
  | "create-vault-transaction"
  | "create-config-transaction"
  | "create-batch"
  | "create-proposal"
  | "activate-proposal"
  | "vote"
  | "execute"
  | "multisig-config"
  | "spending-limit-use"
  | "buffer"
  | "close"
  | "multisig-create"
  | "program-config";

export interface SquadsInstruction {
  name: SquadsIxName;
  kind: SquadsIxKind;
  /** Account name → address (null when it comes from an unresolved lookup table). */
  accounts: Record<string, string | null>;
  vote: "approve" | "reject" | "cancel" | null;
  /** proposalCreate only. */
  transactionIndex: string | null;
  vaultIndex: number | null;
  /** UNTRUSTED text chosen by whoever built the transaction. */
  memo: string | null;
  /** vaultTransactionCreate / batchAddTransaction: the transaction the vault will run. */
  message: SquadsMessage | null;
  /** configTransactionCreate and controlled-multisig instructions. */
  configActions: ConfigAction[];
  /** multisigCreateV2 / spendingLimitUse extras, flattened as strings. */
  extra: Record<string, string | null>;
}

export interface MultisigAccount {
  createKey: string;
  /** null = autonomous multisig (Pubkey::default). */
  configAuthority: string | null;
  threshold: number;
  timeLock: number;
  transactionIndex: string;
  staleTransactionIndex: string;
  rentCollector: string | null;
  members: SquadsMember[];
}

export type ProposalStatusName = "Draft" | "Active" | "Rejected" | "Approved" | "Executing" | "Executed" | "Cancelled";

export interface ProposalAccount {
  multisig: string;
  transactionIndex: string;
  status: ProposalStatusName;
  /** Unix seconds as a decimal string; null for Executing. */
  statusTimestamp: string | null;
  approved: string[];
  rejected: string[];
  cancelled: string[];
}

export interface VaultTransactionAccount {
  multisig: string;
  creator: string;
  index: string;
  vaultIndex: number;
  ephemeralSignerCount: number;
  message: SquadsMessage;
}

export interface BatchAccount {
  multisig: string;
  creator: string;
  index: string;
  vaultIndex: number;
  /** Number of transactions added to the batch. */
  size: number;
  /** Index of the last executed batch transaction (0 = none). */
  executedTransactionIndex: number;
}

export interface VaultBatchTransactionAccount {
  ephemeralSignerCount: number;
  message: SquadsMessage;
}

export interface ConfigTransactionAccount {
  multisig: string;
  creator: string;
  index: string;
  actions: ConfigAction[];
}

export interface TransactionBufferAccount {
  multisig: string;
  creator: string;
  vaultIndex: number;
  finalBufferHash: string;
  finalBufferSize: number;
  buffer: Uint8Array;
}
