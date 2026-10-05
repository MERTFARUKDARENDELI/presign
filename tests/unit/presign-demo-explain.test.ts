import type Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { enrichWithAnchorIdl } from "@/lib/anchor/source";
import { PublicKey } from "@solana/web3.js";
import { buildDemoRequest, DEMO_UNUSABLE_DELEGATE } from "@/lib/presign/demo";
import { DEMO_SCENARIOS } from "@/lib/presign/demo-scenarios";
import { explainSigningFindings } from "@/lib/presign/explain";
import { analyzeSigning } from "@/lib/presign/signing";
import type { SigningFindings } from "@/lib/presign/types";
import { rpcCall } from "@/lib/solana/client";
import { resolveLookupTables, simulateTransaction } from "@/lib/transaction/simulate";
import { BLOCKHASH, WALLET } from "../helpers/fixtures";

vi.mock("@/lib/solana/client", async (importOriginal) => ({ ...(await importOriginal<object>()), rpcCall: vi.fn() }));
vi.mock("@/lib/transaction/simulate", async (importOriginal) => ({ ...(await importOriginal<object>()), simulateTransaction: vi.fn(), resolveLookupTables: vi.fn() }));
vi.mock("@/lib/anchor/source", async (importOriginal) => ({ ...(await importOriginal<object>()), enrichWithAnchorIdl: vi.fn() }));

const W = WALLET.toBase58();
const SID = "session-aaaaaaaaaaaaaaaaaaaaaaaa";

beforeEach(() => {
  vi.mocked(rpcCall).mockReset().mockImplementation(async (method: string) => ({ result: (method === "getLatestBlockhash" ? { value: { blockhash: BLOCKHASH } } : 2_039_280) as never, source: "PUBLIC_RPC" as const, fallbackUsed: false }));
  vi.mocked(resolveLookupTables).mockReset().mockResolvedValue(null);
  vi.mocked(enrichWithAnchorIdl).mockReset().mockResolvedValue([]);
  vi.mocked(simulateTransaction).mockReset().mockResolvedValue({
    effects: { source: "SIMULATION", success: true, error: null, logs: [], logsTruncated: false, unitsConsumed: 1, slot: 2, preStateSlot: 1, stale: false, blockhashValid: true, feeLamports: "5000", solChanges: [{ address: W, preLamports: "100000000", postLamports: "99995000", deltaLamports: "-5000" }], tokenChanges: [], accountChanges: [], notes: [] },
    tokenAccountOwners: {},
    tokenAccountMints: {},
    innerInstructions: null,
  });
});

describe("demo dApp requests go through the real pipeline", () => {
  const expected: Record<(typeof DEMO_SCENARIOS)[number], { level?: string; validation: string }> = {
    "safe-transaction": { level: "SAFE", validation: "VALID" },
    "medium-transaction": { level: "MEDIUM", validation: "VALID" },
    "high-transaction": { level: "HIGH", validation: "VALID" },
    "critical-transaction": { level: "CRITICAL", validation: "VALID" },
    "mismatch-transaction": { level: "HIGH", validation: "VALID" },
    "invalid-transaction": { validation: "INVALID" },
    "safe-message": { level: "SAFE", validation: "VALID" },
    "suspicious-message": { level: "HIGH", validation: "VALID" },
  };

  for (const scenario of DEMO_SCENARIOS) {
    it(`${scenario} → ${expected[scenario].level ?? "cannot verify"}`, async () => {
      const req = await buildDemoRequest(scenario, W, "presign.test");
      if (scenario === "mismatch-transaction") {
        // The simulation shows what the transaction really does: 0.002 SOL leaves, not the declared 0.0001.
        vi.mocked(simulateTransaction).mockResolvedValue({
          effects: { source: "SIMULATION", success: true, error: null, logs: [], logsTruncated: false, unitsConsumed: 1, slot: 2, preStateSlot: 1, stale: false, blockhashValid: true, feeLamports: "5000", solChanges: [{ address: W, preLamports: "100000000", postLamports: "97995000", deltaLamports: "-2005000" }, { address: DEMO_UNUSABLE_DELEGATE.toBase58(), preLamports: "0", postLamports: "2000000", deltaLamports: "2000000" }], tokenChanges: [], accountChanges: [], notes: [] },
          tokenAccountOwners: {}, tokenAccountMints: {}, innerInstructions: null,
        });
      }
      const r = await analyzeSigning({ type: req.type, payload: req.payload, payloadEncoding: req.payloadEncoding, walletAddress: W, domain: "https://presign.test", ...(req.expectedEffects ? { expectedEffects: req.expectedEffects } : {}) }, SID);
      if (scenario === "mismatch-transaction") expect(r.findings.signals.map((s) => s.code)).toContain("PRESIGN_SOL_EXCEEDS_DECLARED");
      expect(r.decision.technicalValidation).toBe(expected[scenario].validation);
      if (expected[scenario].level) expect(r.decision.risk.level).toBe(expected[scenario].level);
      if (expected[scenario].validation !== "VALID") expect(r.decision.userCanOverride).toBe(false);
    });
  }

  it("risky samples never touch an existing token account and delegate to an address without a key", async () => {
    const req = await buildDemoRequest("critical-transaction", W, "presign.test");
    const r = await analyzeSigning({ type: req.type, payload: req.payload, payloadEncoding: req.payloadEncoding, walletAddress: W }, SID);
    const tx = r.transaction as { decoded: { instructions: Array<{ type: string }> } };
    expect(tx.decoded.instructions[0].type).toBe("system:createWithSeed");
    expect(PublicKey.isOnCurve(DEMO_UNUSABLE_DELEGATE.toBytes())).toBe(false);
  });
});

describe("AI explanation layer", () => {
  const findings: SigningFindings = { type: "TRANSACTION", application: "x", domain: null, riskLevel: "CRITICAL", riskScore: 90, analysisStatus: "COMPLETE", technicalValidation: "VALID", signals: [{ code: "TX_UNLIMITED_APPROVAL", severity: "CRITICAL", title: "Unlimited token approval", description: "d" }], whatHappens: [], assetMovements: [], authorityChanges: [], programs: [], simulation: "", multisig: [] };
  const reply = (text: string, stop: Anthropic.Beta.BetaMessage["stop_reason"] = "end_turn") => async () => ({ content: [{ type: "text", text }], stop_reason: stop }) as unknown as Anthropic.Beta.BetaMessage;

  it("returns the model's explanation of the attested findings", async () => {
    const r = await explainSigningFindings(findings, { createMessage: reply("What you are signing: an unlimited approval. Presign recommends cancelling.") });
    expect(r.available).toBe(true);
  });

  it("drops an explanation that contradicts a CRITICAL verdict", async () => {
    const r = await explainSigningFindings(findings, { createMessage: reply("This looks safe to sign.") });
    expect(r).toMatchObject({ available: false, unavailableReason: "CONTRADICTED_VERDICT" });
  });

  it("a refusal is reported, not hidden", async () => {
    expect(await explainSigningFindings(findings, { createMessage: reply("", "refusal") })).toMatchObject({ available: false, unavailableReason: "REFUSED" });
  });

  it("without a key the deterministic findings stand alone", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    expect(await explainSigningFindings(findings)).toMatchObject({ available: false, unavailableReason: "NOT_CONFIGURED" });
    if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
  });
});
