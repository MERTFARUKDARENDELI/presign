import { describe, expect, it } from "vitest";
import { buildDemoTransaction } from "@/lib/demo/scenario";
import { explainTransaction } from "@/lib/transaction/explain";
import { assessSignability, MAX_ANALYSIS_AGE_MS } from "@/lib/transaction/sign-gate";
import type { TransactionAnalysis, TransactionEffects } from "@/lib/transaction/types";

const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const HASH = "a".repeat(64);

/** The demo analysis re-labelled as a fresh, successfully simulated, signable live analysis. */
function liveAnalysis(patch: { effects?: Partial<TransactionEffects> | null; analysis?: Partial<TransactionAnalysis> } = {}): TransactionAnalysis {
  const base = buildDemoTransaction().analysis;
  const effects: TransactionEffects | null =
    patch.effects === null ? null : { ...base.effects!, source: "SIMULATION", success: true, error: null, stale: false, blockhashValid: true, slot: 123, ...patch.effects };
  return {
    ...base,
    demo: false,
    inputKind: "serialized-base64",
    messageHash: HASH,
    cluster: "mainnet-beta",
    effects,
    risk: { ...base.risk, status: "COMPLETE", analyzedAt: new Date(NOW - 1_000).toISOString() },
    ...patch.analysis,
  };
}

const wallet = (a: TransactionAnalysis) => a.perspectiveWallet;
const gate = (a: TransactionAnalysis, hash: string | null = HASH, w: string | null = wallet(a)) => assessSignability(a, w, hash, NOW);

describe("sign gate", () => {
  it("allows a fresh, successfully simulated analysis of the exact bytes (typed confirmation for HIGH/CRITICAL)", () => {
    const a = liveAnalysis();
    const g = gate(a);
    expect(g.blockers).toEqual([]);
    expect(g.allowed).toBe(true);
    expect(g.requiresTypedConfirmation).toBe(a.risk.level === "HIGH" || a.risk.level === "CRITICAL");
  });

  it("blocks an expired blockhash", () => {
    const g = gate(liveAnalysis({ effects: { blockhashValid: false } }));
    expect(g.allowed).toBe(false);
    expect(g.blockers.join(" ")).toMatch(/blockhash has expired/);
  });

  it("blocks a failed simulation", () => {
    const g = gate(liveAnalysis({ effects: { success: false, error: "InstructionError" } }));
    expect(g.allowed).toBe(false);
    expect(g.blockers.join(" ")).toMatch(/Simulation failed/);
  });

  it("blocks when no simulation exists, or it is stale, or it is not a pre-sign simulation", () => {
    expect(gate(liveAnalysis({ effects: null })).allowed).toBe(false);
    expect(gate(liveAnalysis({ effects: { stale: true } })).allowed).toBe(false);
    expect(gate(liveAnalysis({ effects: { source: "EXECUTED" } })).allowed).toBe(false);
  });

  it("blocks when the bytes to sign differ from the analyzed bytes (tampering)", () => {
    expect(gate(liveAnalysis(), "b".repeat(64)).blockers.join(" ")).toMatch(/SECURITY BLOCK/);
    expect(gate(liveAnalysis(), null).allowed).toBe(false);
  });

  it("blocks a wrong or missing signer", () => {
    const a = liveAnalysis();
    expect(gate(a, HASH, null).allowed).toBe(false);
    const g = gate(a, HASH, "11111111111111111111111111111111");
    expect(g.blockers.join(" ")).toMatch(/not a required signer/);
  });

  it("blocks demo data, executed signatures, incomplete risk and old analyses", () => {
    expect(gate(liveAnalysis({ analysis: { demo: true } })).allowed).toBe(false);
    expect(gate(liveAnalysis({ analysis: { inputKind: "signature" } })).allowed).toBe(false);
    const base = liveAnalysis();
    expect(gate({ ...base, risk: { ...base.risk, status: "INSUFFICIENT_DATA" } }).allowed).toBe(false);
    expect(gate({ ...base, risk: { ...base.risk, analyzedAt: new Date(NOW - MAX_ANALYSIS_AGE_MS - 1).toISOString() } }).allowed).toBe(false);
  });
});

describe("explainTransaction", () => {
  const demo = buildDemoTransaction().analysis;

  it("restates decoded instructions, asset movements and risk signals in plain language", () => {
    const x = explainTransaction(demo, { [demo.effects!.tokenChanges[0].mint]: "USDC" });
    expect(x.headline).toMatch(new RegExp(`^${demo.risk.level} risk: `));
    expect(x.whatHappens.join("\n")).toMatch(/Transfer 50 USDC/);
    expect(x.whatHappens.join("\n")).toMatch(/UNLIMITED amount/);
    expect(x.assetMovements).toContain("You send 50 USDC.");
    expect(x.assetMovements.join("\n")).toMatch(/\(unverified address\) receives 50 USDC/);
    expect(x.accountChanges.join("\n")).toMatch(/delegate becomes/);
    expect(x.whyRisky).toHaveLength(demo.risk.signals.length);
    expect(x.simulation).toMatch(/DEMO data/);
  });

  it("never gives a signing recommendation or a safety guarantee", () => {
    const x = explainTransaction(demo);
    expect(x.decisionNote).toMatch(/your decision/);
    const all = JSON.stringify(x);
    expect(all).not.toMatch(/safe to sign|you should sign|recommend(ed)? signing/i);
    const safe = explainTransaction({ ...demo, risk: { ...demo.risk, level: "SAFE", signals: [] } });
    expect(safe.headline).toMatch(/not a guarantee/);
  });

  it("describes failed and missing simulations honestly", () => {
    const failed = explainTransaction(liveAnalysis({ effects: { success: false, error: "InstructionError" } }));
    expect(failed.simulation).toMatch(/^Simulation failed/);
    const none = explainTransaction(liveAnalysis({ effects: null }));
    expect(none.simulation).toBe("Simulation could not be performed.");
    expect(none.assetMovements[0]).toMatch(/^Unknown/);
    const ok = explainTransaction(liveAnalysis());
    expect(ok.simulation).toMatch(/not a guarantee/);
  });

  it("flags incomplete analyses and unrated risk", () => {
    const x = explainTransaction({ ...demo, risk: { ...demo.risk, status: "PARTIAL", level: "UNKNOWN" } });
    expect(x.completeness).toMatch(/additional risks may exist/);
    expect(x.headline).toMatch(/could not be rated/);
  });
});
