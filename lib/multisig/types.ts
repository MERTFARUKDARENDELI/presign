import type { ConfigAction, MultisigAccount, ProposalAccount } from "@/lib/squads/types";
import type { DecodedTransaction } from "@/lib/transaction/types";

/** Serializable result of analyzing the Squads multisig side of a transaction. */

export type PrivilegedKind =
  | "program-upgrade"
  | "upgrade-authority"
  | "program-close"
  | "token-authority"
  | "account-reassign"
  | "admin-transfer"
  | "admin-action";

/** Who controls an authority after the change. */
export type AuthorityControl = "multisig" | "member" | "outside" | "none";

export interface PrivilegedAction {
  kind: PrivilegedKind;
  /** Human-readable location, e.g. "proposal #12, instruction 0" or "executed CPI of instruction 2". */
  origin: string;
  programId: string;
  programName: string;
  /** e.g. "updateAdmin", "setAuthority(MintTokens)", "upgrade". */
  action: string;
  target: string | null;
  /** undefined = not an authority change; null = authority removed (irreversible). */
  newAuthority?: string | null;
  control: AuthorityControl | null;
  /** Argument or account the new authority was read from (evidence). */
  authorityField: string | null;
  source: "TRANSACTION_DECODER" | "ANCHOR_IDL";
}

export interface VaultPayload {
  source: "INSTRUCTION" | "TRANSACTION_ACCOUNT" | "BUFFER_ACCOUNT" | "EXECUTION_CPI";
  /** VaultTransaction PDA, when known. */
  transaction: string | null;
  transactionIndex: string | null;
  vaultIndex: number | null;
  vault: string | null;
  status: "DECODED" | "PARTIAL" | "UNAVAILABLE" | "MALFORMED";
  detail: string | null;
  decoded: DecodedTransaction | null;
  privileged: PrivilegedAction[];
}

export interface MultisigInstructionRef {
  /** Index in the analyzed transaction's top-level instructions. */
  index: number;
  name: string;
  kind: string;
  vote: "approve" | "reject" | "cancel" | null;
  proposal: string | null;
  transactionIndex: string | null;
  member: string | null;
}

export interface ProposalRef {
  address: string;
  transactionIndex: string | null;
  status: "OK" | "CREATED_IN_THIS_TX" | "NOT_FOUND" | "FAILED";
  account: ProposalAccount | null;
}

export interface MultisigAnalysis {
  programId: string;
  multisig: string | null;
  account: MultisigAccount | null;
  accountStatus: "OK" | "NOT_FOUND" | "FAILED";
  instructions: MultisigInstructionRef[];
  proposals: ProposalRef[];
  payloads: VaultPayload[];
  configActions: Array<{ origin: string; action: ConfigAction }>;
  /** Multisig PDA and its first vault PDAs — addresses the multisig controls by construction. */
  controlled: string[];
  /** Instructions that could not be decoded (malformed Squads data). */
  malformed: number[];
}
