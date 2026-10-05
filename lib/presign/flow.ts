/**
 * State machine of the secure connect + pre-sign flow. The UI may only move
 * along these edges; every security-relevant step is ALSO enforced on the
 * server (sealed, session-bound tokens), so editing client state cannot skip
 * the analysis, the decision or the exact-payload check.
 */

export const FLOW_STATES = [
  "IDLE",
  "PRE_CONNECT_CHECK",
  "PRE_CONNECT_VERIFIED",
  "WALLET_CONNECTING",
  "WALLET_CONNECTED",
  "OWNERSHIP_VERIFICATION",
  "WALLET_VERIFIED",
  "WAITING_FOR_SIGN_REQUEST",
  "REQUEST_RECEIVED",
  "DECODING",
  "SIMULATING",
  "RISK_ANALYSIS",
  "SECURITY_REVIEW",
  "USER_APPROVAL",
  "OPTIONAL_RISK_OVERRIDE",
  "WALLET_SIGNING",
  "SIGNED",
  "OPTIONAL_SUBMISSION",
  "DASHBOARD",
  // failures
  "CONNECT_CANCELLED",
  "SIGN_REQUEST_INVALID",
  "REQUEST_EXPIRED",
  "PAYLOAD_MISMATCH",
  "SIMULATION_UNAVAILABLE",
  "SIMULATION_FAILED",
  "SIGN_REJECTED",
  "RPC_ERROR",
  "AI_UNAVAILABLE",
  "TECHNICAL_VALIDATION_FAILED",
] as const;

export type FlowState = (typeof FLOW_STATES)[number];

const FAILURES: FlowState[] = ["CONNECT_CANCELLED", "SIGN_REQUEST_INVALID", "REQUEST_EXPIRED", "PAYLOAD_MISMATCH", "SIMULATION_UNAVAILABLE", "SIMULATION_FAILED", "SIGN_REJECTED", "RPC_ERROR", "AI_UNAVAILABLE", "TECHNICAL_VALIDATION_FAILED"];
const ANALYSIS_FAILURES: FlowState[] = ["SIGN_REQUEST_INVALID", "REQUEST_EXPIRED", "SIMULATION_UNAVAILABLE", "SIMULATION_FAILED", "RPC_ERROR", "TECHNICAL_VALIDATION_FAILED"];

const EDGES: Record<FlowState, FlowState[]> = {
  IDLE: ["PRE_CONNECT_CHECK", "WAITING_FOR_SIGN_REQUEST"],
  PRE_CONNECT_CHECK: ["PRE_CONNECT_VERIFIED", "CONNECT_CANCELLED", "SIGN_REQUEST_INVALID", "REQUEST_EXPIRED", "RPC_ERROR"],
  PRE_CONNECT_VERIFIED: ["WALLET_CONNECTING", "CONNECT_CANCELLED"],
  WALLET_CONNECTING: ["WALLET_CONNECTED", "CONNECT_CANCELLED"],
  WALLET_CONNECTED: ["OWNERSHIP_VERIFICATION", "CONNECT_CANCELLED"],
  OWNERSHIP_VERIFICATION: ["WALLET_VERIFIED", "CONNECT_CANCELLED", "REQUEST_EXPIRED", "SIGN_REJECTED", "TECHNICAL_VALIDATION_FAILED"],
  WALLET_VERIFIED: ["WAITING_FOR_SIGN_REQUEST", "DASHBOARD"],
  WAITING_FOR_SIGN_REQUEST: ["REQUEST_RECEIVED", "DASHBOARD"],
  REQUEST_RECEIVED: ["DECODING", ...ANALYSIS_FAILURES],
  DECODING: ["SIMULATING", "RISK_ANALYSIS", ...ANALYSIS_FAILURES],
  SIMULATING: ["RISK_ANALYSIS", ...ANALYSIS_FAILURES],
  RISK_ANALYSIS: ["SECURITY_REVIEW", ...ANALYSIS_FAILURES],
  SECURITY_REVIEW: ["USER_APPROVAL", "WAITING_FOR_SIGN_REQUEST", "AI_UNAVAILABLE"],
  USER_APPROVAL: ["OPTIONAL_RISK_OVERRIDE", "WALLET_SIGNING", "WAITING_FOR_SIGN_REQUEST", "PAYLOAD_MISMATCH", "REQUEST_EXPIRED", "TECHNICAL_VALIDATION_FAILED"],
  OPTIONAL_RISK_OVERRIDE: ["WALLET_SIGNING", "USER_APPROVAL", "WAITING_FOR_SIGN_REQUEST", "PAYLOAD_MISMATCH", "REQUEST_EXPIRED", "TECHNICAL_VALIDATION_FAILED"],
  WALLET_SIGNING: ["SIGNED", "SIGN_REJECTED", "PAYLOAD_MISMATCH", "TECHNICAL_VALIDATION_FAILED"],
  SIGNED: ["OPTIONAL_SUBMISSION", "WAITING_FOR_SIGN_REQUEST", "DASHBOARD"],
  OPTIONAL_SUBMISSION: ["WAITING_FOR_SIGN_REQUEST", "DASHBOARD", "RPC_ERROR", "PAYLOAD_MISMATCH"],
  DASHBOARD: ["WAITING_FOR_SIGN_REQUEST", "PRE_CONNECT_CHECK"],
  CONNECT_CANCELLED: ["IDLE", "PRE_CONNECT_CHECK"],
  SIGN_REQUEST_INVALID: ["WAITING_FOR_SIGN_REQUEST"],
  REQUEST_EXPIRED: ["WAITING_FOR_SIGN_REQUEST", "PRE_CONNECT_CHECK", "IDLE"],
  PAYLOAD_MISMATCH: ["WAITING_FOR_SIGN_REQUEST"],
  SIMULATION_UNAVAILABLE: ["WAITING_FOR_SIGN_REQUEST"],
  SIMULATION_FAILED: ["WAITING_FOR_SIGN_REQUEST"],
  SIGN_REJECTED: ["WAITING_FOR_SIGN_REQUEST", "USER_APPROVAL", "OWNERSHIP_VERIFICATION", "IDLE"],
  RPC_ERROR: ["WAITING_FOR_SIGN_REQUEST", "PRE_CONNECT_CHECK", "IDLE"],
  AI_UNAVAILABLE: ["USER_APPROVAL"],
  TECHNICAL_VALIDATION_FAILED: ["WAITING_FOR_SIGN_REQUEST", "IDLE"],
};

export class FlowTransitionError extends Error {
  constructor(readonly from: FlowState, readonly to: FlowState) {
    super(`Illegal flow transition ${from} → ${to}`);
  }
}

export function canTransition(from: FlowState, to: FlowState): boolean {
  return EDGES[from].includes(to);
}

export function transition(from: FlowState, to: FlowState): FlowState {
  if (!canTransition(from, to)) throw new FlowTransitionError(from, to);
  return to;
}

export function isFailure(state: FlowState): boolean {
  return FAILURES.includes(state);
}

/** The wallet signing API may only be called from these states. */
export function walletSigningAllowedFrom(state: FlowState): boolean {
  return canTransition(state, "WALLET_SIGNING");
}

export type WalletEvent =
  | { kind: "CONNECTED"; address: string }
  | { kind: "CONNECT_FAILED"; reason: string }
  | { kind: "DISCONNECTED" }
  | { kind: "ACCOUNT_CHANGED"; address: string };

const CONNECT_PHASE: FlowState[] = ["WALLET_CONNECTED", "OWNERSHIP_VERIFICATION", "WALLET_VERIFIED"];
const SIGNING_PHASE: FlowState[] = ["REQUEST_RECEIVED", "DECODING", "SIMULATING", "RISK_ANALYSIS", "SECURITY_REVIEW", "USER_APPROVAL", "OPTIONAL_RISK_OVERRIDE", "WALLET_SIGNING", "SIGNED", "OPTIONAL_SUBMISSION"];

/**
 * External wallet events. A verification or a review belongs to one wallet:
 * a disconnect or an account switch invalidates it instead of carrying it over.
 */
export function onWalletEvent(state: FlowState, ev: WalletEvent): FlowState {
  switch (ev.kind) {
    case "CONNECTED":
      return state === "WALLET_CONNECTING" ? "WALLET_CONNECTED" : state;
    case "CONNECT_FAILED":
      // The wallet refused or failed to connect: stay on the picker so the user can retry or pick another wallet.
      return state;
    case "DISCONNECTED":
      if (CONNECT_PHASE.includes(state)) return "WALLET_CONNECTING";
      if (SIGNING_PHASE.includes(state)) return "WAITING_FOR_SIGN_REQUEST";
      return state;
    case "ACCOUNT_CHANGED":
      if (state === "OWNERSHIP_VERIFICATION" || state === "WALLET_VERIFIED") return "WALLET_CONNECTED";
      if (SIGNING_PHASE.includes(state)) return "WAITING_FOR_SIGN_REQUEST";
      return state;
  }
}
