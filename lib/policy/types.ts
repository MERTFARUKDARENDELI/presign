import type { TeamPolicy } from "./schema";

/** Result of checking a proposal, a transaction or a multisig's setup against a team policy. */

export type PolicyRule =
  | "scope"
  | "authorityHolders"
  | "requireGuardFor"
  | "guards"
  | "minTimeLockSeconds"
  | "minThreshold"
  | "allowedPrograms"
  | "allowedRecipients"
  | "outflowLimits"
  | "requireVerifiedUpgrades"
  | "forbidDurableNonce";

export const RULE_LABEL: Record<PolicyRule, string> = {
  scope: "Written for this multisig",
  authorityHolders: "Authorities go only to approved holders",
  requireGuardFor: "Critical actions go through Presign Guard",
  guards: "Only approved guards and delays",
  minTimeLockSeconds: "Minimum time lock",
  minThreshold: "Minimum threshold",
  allowedPrograms: "Only approved programs",
  allowedRecipients: "Funds go only to approved recipients",
  outflowLimits: "Outflow limits per proposal",
  requireVerifiedUpgrades: "Upgrades deploy a verified build",
  forbidDurableNonce: "No never-expiring signatures",
};

/** "violation": the rule is broken. "unverifiable": the data needed to check it is missing — never read as compliant. */
export type PolicyCheckStatus = "pass" | "violation" | "unverifiable" | "not-applicable";

export interface PolicyCheck {
  rule: PolicyRule;
  label: string;
  status: PolicyCheckStatus;
  /** Violations first, then what could not be checked. */
  findings: string[];
}

export interface PolicyReport {
  name: string;
  severity: TeamPolicy["severity"];
  status: "compliant" | "violation" | "unverifiable";
  checks: PolicyCheck[];
}
