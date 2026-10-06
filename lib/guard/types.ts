import type { Gate } from "@/lib/agent/gate";
import type { PrivilegedAction } from "@/lib/multisig/types";
import type { RiskAssessment } from "@/lib/security/risk";
import type { DecodedTransaction } from "@/lib/transaction/types";
import type { ActionAccountData, ActionStatusName, GuardAccountData } from "./codec";

/** Instructions scheduled through Presign Guard, decoded and classified (they run later, after the delay). */
export interface ScheduledActions {
  guard: string;
  guardSigner: string;
  guardAccount: GuardAccountData | null;
  guardStatus: "OK" | "NOT_FOUND" | "FAILED";
  memo: string;
  /** Where the schedule was found, e.g. "proposal #7, instruction 0". */
  origin: string;
  decoded: DecodedTransaction;
  privileged: PrivilegedAction[];
}

export interface GuardActionSummary {
  address: string;
  index: string;
  status: ActionStatusName;
  scheduledAt: string;
  eta: string;
  memo: string;
  vetoedBy: string | null;
  instructions: number;
}

export interface GuardOverview {
  programId: string;
  guard: string;
  guardSigner: string;
  account: GuardAccountData;
  posture: RiskAssessment;
  actions: GuardActionSummary[];
  /**
   * Indexes (newest first, within the scanned range) of actions whose accounts no longer exist:
   * the program lets anyone close a finished action. Their outcome is only in the transaction history.
   */
  closedActions: string[];
  cluster: "mainnet-beta" | "devnet";
  inspectedAt: string;
}

export interface GuardActionInspection {
  programId: string;
  guard: string;
  guardSigner: string;
  guardAccount: GuardAccountData | null;
  address: string;
  action: ActionAccountData;
  scheduled: ScheduledActions;
  risk: RiskAssessment;
  gate: Gate;
  /** Unix seconds of the check; the UI counts down from `action.eta`. */
  now: string;
  cluster: "mainnet-beta" | "devnet";
  inspectedAt: string;
}
