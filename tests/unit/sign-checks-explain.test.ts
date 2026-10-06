import { describe, expect, it } from "vitest";
import { buildDemoTransaction } from "@/lib/demo/scenario";
import { transactionIssues } from "@/lib/presign/decision";
import { explainTransaction } from "@/lib/transaction/explain";
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

/** The server-side checks every signing path goes through (/transaction included), as issue codes. */
const codes = (a: TransactionAnalysis, w: string = a.perspectiveWallet!) => transactionIssues(a, w).map((i) => `${i.kind}:${i.code}`);

describe("server-side sign checks (transactionIssues)", () => {
  it("a fresh, successfully simulated analysis of the exact bytes has no issue", () => {
    expect(codes(liveAnalysis())).toEqual([]);
  });

  it("an expired blockhash is invalid", () => {
    expect(codes(liveAnalysis({ effects: { blockhashValid: false } }))).toContain("INVALID:BLOCKHASH_EXPIRED");
  });

  it("a failed simulation cannot be verified", () => {
    expect(codes(liveAnalysis({ effects: { success: false, error: "InstructionError" } }))).toContain("UNVERIFIABLE:SIMULATION_FAILED");
  });

  it("no simulation, a stale one, or one that is not a pre-sign simulation cannot be verified", () => {
    expect(codes(liveAnalysis({ effects: null }))).toContain("UNVERIFIABLE:SIMULATION_UNAVAILABLE");
    expect(codes(liveAnalysis({ effects: { stale: true } }))).toContain("UNVERIFIABLE:SIMULATION_STALE");
    expect(codes(liveAnalysis({ effects: { source: "EXECUTED" } }))).toContain("UNVERIFIABLE:SIMULATION_UNAVAILABLE");
  });

  it("an analysis not bound to the exact bytes is invalid", () => {
    expect(codes(liveAnalysis({ analysis: { messageHash: null } }))).toContain("INVALID:NO_PAYLOAD_HASH");
  });

  it("a wallet that is not a required signer, or another wallet's perspective, is invalid", () => {
    const other = "11111111111111111111111111111111";
    expect(codes(liveAnalysis(), other)).toEqual(expect.arrayContaining(["INVALID:WALLET_NOT_SIGNER", "INVALID:PERSPECTIVE_MISMATCH"]));
  });

  it("demo data and executed signatures are invalid; incomplete risk cannot be verified", () => {
    expect(codes(liveAnalysis({ analysis: { demo: true } }))).toContain("INVALID:DEMO_TRANSACTION");
    expect(codes(liveAnalysis({ analysis: { inputKind: "signature" } }))).toContain("INVALID:ALREADY_EXECUTED");
    const base = liveAnalysis();
    expect(codes({ ...base, risk: { ...base.risk, status: "INSUFFICIENT_DATA" } })).toContain("UNVERIFIABLE:RISK_INCOMPLETE");
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
