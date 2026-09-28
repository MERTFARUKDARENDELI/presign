import type { ActionAccountData, GuardAccountData } from "@/lib/guard/codec";
import type { ScheduledActions } from "@/lib/guard/types";
import { buildAssessment } from "../engine";
import type { RiskAssessment, RiskSignal } from "../risk";
import type { AnalysisStatus, Evidence } from "../types";
import { formatDelay, privilegedSignal, type EvFn } from "./multisig";

/**
 * Rules for Presign Guard itself: how strong a guard's setup is, and what a
 * scheduled action will do. For a pending action the reader is a guardian
 * deciding whether to veto, so severities are not lowered for the delay.
 */

const short = (a: string | null | undefined) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "unknown");

function sink(prefix: string) {
  const evidence: Evidence[] = [];
  let n = 0;
  const ev: EvFn = (e) => {
    const id = `${prefix}:e${++n}`;
    evidence.push({ id, ...e });
    return id;
  };
  return { evidence, ev };
}

export function evaluateGuardPosture(guard: string, g: GuardAccountData, now?: Date): RiskAssessment {
  const { evidence, ev } = sink("guard");
  const signals: RiskSignal[] = [];
  const id = ev({ source: "ONCHAIN_RPC", label: `Presign Guard ${short(guard)} configuration`, observed: `delay ${g.delaySeconds}s, ${g.guardians.length} guardian(s), proposer ${g.proposer}`, condition: "current on-chain state" });
  if (g.guardians.length === 1) signals.push({ code: "GUARD_SINGLE_GUARDIAN", title: "Only one guardian can veto", description: "If that key is unavailable or compromised, nobody can stop a scheduled action. Add each multisig member, or an independent security key.", severity: "MEDIUM", evidenceIds: [id] });
  if (g.delaySeconds < 3600) signals.push({ code: "GUARD_SHORT_DELAY", title: "Delay under one hour", description: `${formatDelay(g.delaySeconds)} is little time to notice and veto. 24 hours or more is recommended for admin and upgrade authorities.`, severity: "MEDIUM", evidenceIds: [id] });
  if (g.guardians.includes(g.proposer)) signals.push({ code: "GUARD_PROPOSER_IS_GUARDIAN", title: "The proposer is also a guardian", description: "The key that schedules can also veto; use independent keys for the two roles.", severity: "LOW", evidenceIds: [id] });
  return buildAssessment({ category: "multisig", signals, evidence, sources: [{ source: "ONCHAIN_RPC", status: "OK", detail: "Guard account" }], status: "COMPLETE", now });
}

export function evaluateGuardAction(s: ScheduledActions, action: ActionAccountData, nowSeconds: bigint, now?: Date): RiskAssessment {
  const { evidence, ev } = sink("action");
  const signals: RiskSignal[] = [];
  const statuses: AnalysisStatus[] = ["COMPLETE"];
  const eta = BigInt(action.eta);
  const statusId = ev({ source: "ONCHAIN_RPC", label: `Action #${action.index}`, observed: `${action.status}; eta ${new Date(Number(eta) * 1000).toISOString()}${action.vetoedBy ? `; vetoed by ${action.vetoedBy}` : ""}`, condition: "action account read from chain" });

  if (action.status === "Pending") {
    for (const [i, p] of s.privileged.entries()) signals.push(privilegedSignal(p, i, ev, false, [statusId]));
    if (nowSeconds < eta) {
      signals.push({ code: "GUARD_ACTION_PENDING", title: "Waiting — can still be vetoed", description: `Runs after ${new Date(Number(eta) * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC unless a guardian vetoes it. Any one guardian can veto now.`, severity: "LOW", evidenceIds: [statusId] });
    } else {
      signals.push({ code: "GUARD_ACTION_EXECUTABLE", title: "Delay has passed — anyone can execute it now", description: "The review window is over. A guardian can still veto it until someone executes it.", severity: "MEDIUM", evidenceIds: [statusId] });
    }
  }
  if (!s.guardAccount) {
    statuses.push("PARTIAL");
    ev({ source: "ONCHAIN_RPC", label: `Guard ${short(s.guard)}`, observed: s.guardStatus, condition: "guard account could not be loaded" });
  }
  if (s.decoded.undecodedInstructions.length) {
    statuses.push("PARTIAL");
    const id = ev({ source: "TRANSACTION_DECODER", label: "Scheduled instructions not decoded", observed: s.decoded.undecodedInstructions.map((i) => `#${i}`).join(", "), condition: "their effect is unknown" });
    if (action.status === "Pending") signals.push({ code: "GUARD_ACTION_UNDECODED", title: "Part of the action could not be decoded", description: "Some scheduled instructions could not be decoded; their effect is unknown. Do not let what you cannot read execute.", severity: "HIGH", evidenceIds: [id] });
  }
  const status: AnalysisStatus = statuses.every((x) => x === "COMPLETE") ? "COMPLETE" : "PARTIAL";
  return buildAssessment({ category: "proposal", signals, evidence, sources: [{ source: "ONCHAIN_RPC", status: s.guardAccount ? "OK" : "FAILED", detail: "Guard and action accounts" }], status, now });
}
