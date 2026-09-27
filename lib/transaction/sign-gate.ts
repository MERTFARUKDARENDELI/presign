import { describeTransactionError } from "@/lib/cleanup/reclaim";
import type { TransactionAnalysis } from "./types";

/**
 * Decides whether the UI may offer "sign with your wallet" for an analyzed
 * transaction. Enforces the order Input → Decode → Simulation → Balance
 * changes → Risk → Explanation → Confirmation → Signing: without a fresh,
 * successful simulation of these exact bytes, from the signer's perspective,
 * signing is not offered. It never decides FOR the user — high risk only
 * raises the confirmation bar.
 */

export const MAX_ANALYSIS_AGE_MS = 120_000;
export const TYPED_CONFIRMATION_PHRASE = "I UNDERSTAND THE RISK";

export interface SignGate {
  allowed: boolean;
  blockers: string[];
  warnings: string[];
  requiresTypedConfirmation: boolean;
}

export function assessSignability(
  a: TransactionAnalysis,
  connectedWallet: string | null,
  localMessageHash: string | null,
  now: number = Date.now(),
): SignGate {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const e = a.effects;

  if (a.demo) blockers.push("Demo transactions can never be signed.");
  if (a.inputKind === "signature") blockers.push("This transaction was already executed on-chain; there is nothing to sign.");
  if (a.decoded.version === 1) blockers.push("v1 transactions can be analyzed but not signed in this app yet.");
  if (!connectedWallet) blockers.push("Connect the wallet that must sign this transaction.");
  else {
    if (!a.decoded.signers.includes(connectedWallet)) blockers.push("The connected wallet is not a required signer of this transaction.");
    if (a.perspectiveWallet !== connectedWallet) blockers.push("The analysis was done from another wallet's perspective. Re-analyze with your connected wallet.");
  }
  if (!a.messageHash || !localMessageHash || a.messageHash !== localMessageHash) {
    blockers.push("SECURITY BLOCK: the analysis does not correspond to the transaction bytes you would sign.");
  }
  if (!a.decoded.lookupTablesResolved) blockers.push("Address lookup tables could not be resolved; accounts are unknown.");
  if (!e || e.source !== "SIMULATION") blockers.push("No pre-sign simulation is available; signing requires a simulation.");
  else {
    if (!e.success) blockers.push(`Simulation failed${describeTransactionError(e.error) ? `: ${describeTransactionError(e.error)}` : ""}. The transaction would not succeed.`);
    if (e.stale) blockers.push("Simulation is stale. Re-analyze before signing.");
    if (e.blockhashValid === false && !a.decoded.usesDurableNonce) blockers.push("The transaction's blockhash has expired; the network would reject it. Ask the dApp for a new transaction.");
  }
  if (a.risk.status === "INSUFFICIENT_DATA" || a.risk.status === "UNAVAILABLE") blockers.push("Risk analysis is incomplete (insufficient data).");
  const age = now - Date.parse(a.risk.analyzedAt);
  if (!Number.isFinite(age) || age > MAX_ANALYSIS_AGE_MS) blockers.push("Analysis is older than 2 minutes. Re-analyze to simulate against current state.");

  if (a.risk.status === "PARTIAL") warnings.push("Analysis is PARTIAL — some checks could not run.");
  if (a.decoded.undecodedInstructions.length > 0) warnings.push("Some instructions could not be decoded; their effect is only visible through simulation.");
  if (a.decoded.usesDurableNonce) warnings.push("Durable nonce: once signed, this transaction can be submitted at any later time.");
  if (a.decoded.signers.length > 1) warnings.push("Other signers are required; your signature alone may not be enough.");

  return {
    allowed: blockers.length === 0,
    blockers,
    warnings,
    requiresTypedConfirmation: a.risk.level === "HIGH" || a.risk.level === "CRITICAL",
  };
}
