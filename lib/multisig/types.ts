import type { Gate } from "@/lib/agent/gate";
import type { RiskAssessment, RiskVerdict } from "@/lib/security/risk";
import type { SignerBrief } from "./brief";
import type { AnalysisStatus } from "@/lib/security/types";
import type { ConfigAction, MultisigAccount, ProposalAccount, ProposalStatusName } from "@/lib/squads/types";
import type { DecodedTransaction, TransactionEffects } from "@/lib/transaction/types";

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
  /** Simulation of the vault executing this payload now (fee paid by an executing member). */
  effects?: TransactionEffects | null;
  effectsStatus?: AnalysisStatus;
  /** Address that paid the fee in the simulation (not part of the proposal). */
  simulatedFeePayer?: string | null;
  /** Why the payload could not be simulated, when it was not. */
  simulationNote?: string | null;
  /** Required signers the multisig cannot sign for (neither the vault nor this transaction's ephemeral signers). */
  foreignSigners?: string[];
  /** Deterministic risk of the payload from the vault's perspective (asset outflows, approvals). */
  risk?: RiskAssessment | null;
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

/** Proposal inspection and multisig overview results (see lib/multisig/inspect.ts). */

export interface ProposalInspection {
  multisig: string;
  transactionIndex: string;
  proposalAddress: string;
  transactionAddress: string;
  transactionKind: "vault" | "config" | "missing";
  stale: boolean;
  analysis: MultisigAnalysis;
  risk: RiskAssessment;
  /** Plain-language proposal brief. */
  brief: SignerBrief | null;
  /** Deterministic action for automated signers. */
  gate: Gate;
  cluster: "mainnet-beta" | "devnet";
  inspectedAt: string;
}

export interface ProposalSummary {
  transactionIndex: string;
  proposalAddress: string;
  transactionAddress: string;
  status: ProposalStatusName | "NO_PROPOSAL" | "NOT_FOUND" | "UNREADABLE";
  statusTimestamp: string | null;
  approvals: number;
  rejections: number;
  stale: boolean;
  /** Set for pending proposals, which are fully inspected. */
  verdict: RiskVerdict | null;
  topSignal: string | null;
}

export interface MultisigOverview {
  multisig: string;
  account: MultisigAccount | null;
  accountStatus: MultisigAnalysis["accountStatus"];
  vaults: string[];
  posture: RiskAssessment;
  proposals: ProposalSummary[];
  /** Pending proposals beyond the inspection cap are listed without a verdict. */
  inspectedLimit: number;
  cluster: "mainnet-beta" | "devnet";
  inspectedAt: string;
}

export type InspectResult = { kind: "proposal"; inspection: ProposalInspection } | { kind: "multisig"; overview: MultisigOverview };
