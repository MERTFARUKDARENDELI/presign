import { describe, expect, it } from "vitest";
import { toJson } from "@/lib/api/response";
import { redact, maskAddress } from "@/lib/api/logger";
import { checkRateLimit, resetRateLimits } from "@/lib/api/rate-limit";
import { buildAssessment, computeScore } from "@/lib/security/engine";
import { combineStatuses } from "@/lib/security/types";
import { formatLamports, formatRawAmount, sumRaw } from "@/lib/token/amount";

describe("amount serialization", () => {
  it("formats raw u64 amounts without precision loss", () => {
    expect(formatRawAmount("50000000", 6)).toBe("50");
    expect(formatRawAmount("18446744073709551615", 9)).toBe("18,446,744,073.709551615");
    expect(formatRawAmount("1", 9)).toBe("0.000000001");
    expect(formatRawAmount("123", 0)).toBe("123");
    expect(formatLamports("-5000")).toBe("-0.000005");
  });

  it("sums with bigint beyond Number.MAX_SAFE_INTEGER", () => {
    expect(sumRaw(["9007199254740993", "1"])).toBe("9007199254740994");
  });

  it("serializes bigint as string in API JSON", () => {
    expect(toJson({ lamports: 12345678901234567890n })).toBe('{"lamports":"12345678901234567890"}');
  });
});

describe("deterministic risk engine", () => {
  const ev = [{ id: "e1", source: "ONCHAIN_RPC" as const, label: "x", observed: true }];

  it("gives SAFE only when analysis is COMPLETE and no signal exists", () => {
    const a = buildAssessment({ category: "token", signals: [], evidence: [], sources: [], status: "COMPLETE" });
    expect(a.level).toBe("SAFE");
    expect(a.summary).toMatch(/not a guarantee/);
  });

  it.each(["PARTIAL", "INSUFFICIENT_DATA", "UNAVAILABLE"] as const)("never returns SAFE for %s data", (status) => {
    const a = buildAssessment({ category: "token", signals: [], evidence: [], sources: [], status });
    expect(a.level).toBe("UNKNOWN");
    expect(a.score).toBeNull();
  });

  it("takes the highest severity and is reproducible", () => {
    const input = {
      category: "token" as const,
      signals: [
        { code: "A", title: "a", description: "", severity: "LOW" as const, evidenceIds: ["e1"] },
        { code: "B", title: "b", description: "", severity: "CRITICAL" as const, evidenceIds: ["e1"] },
      ],
      evidence: ev,
      sources: [],
      status: "PARTIAL" as const,
      now: new Date(0),
    };
    const a = buildAssessment(input);
    expect(a.level).toBe("CRITICAL");
    expect(a.signals[0].code).toBe("B");
    expect(JSON.stringify(buildAssessment(input))).toBe(JSON.stringify(a));
    expect(computeScore(input.signals)).toBe(100);
  });

  it("refuses signals without evidence (AI/rules cannot invent facts)", () => {
    expect(() =>
      buildAssessment({ category: "token", signals: [{ code: "X", title: "", description: "", severity: "HIGH", evidenceIds: [] }], evidence: [], sources: [], status: "COMPLETE" }),
    ).toThrow(/no evidence/);
    expect(() =>
      buildAssessment({ category: "token", signals: [{ code: "X", title: "", description: "", severity: "HIGH", evidenceIds: ["missing"] }], evidence: ev, sources: [], status: "COMPLETE" }),
    ).toThrow(/missing evidence/);
  });

  it("combines analysis statuses conservatively", () => {
    expect(combineStatuses(["COMPLETE", "COMPLETE"])).toBe("COMPLETE");
    expect(combineStatuses(["COMPLETE", "INSUFFICIENT_DATA"])).toBe("PARTIAL");
    expect(combineStatuses(["INSUFFICIENT_DATA"])).toBe("INSUFFICIENT_DATA");
    expect(combineStatuses([])).toBe("INSUFFICIENT_DATA");
  });
});

describe("logging & rate limiting", () => {
  it("redacts secrets and api keys from logs", () => {
    const out = JSON.stringify(redact({ apiKey: "sk-123", url: "https://x/?api-key=SECRET123", seedPhrase: "a b c", nested: { privateKey: "k" } }));
    expect(out).not.toContain("sk-123");
    expect(out).not.toContain("SECRET123");
    expect(out).not.toContain("a b c");
    expect(out).not.toContain('"k"');
    expect(maskAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe("EPjF…Dt1v");
    const upstream = JSON.stringify(redact({ error: new Error("Incorrect API key provided: sk-ccabf***********e1ee. See docs") }));
    expect(upstream).not.toContain("ccabf");
    expect(upstream).not.toContain("e1ee");
  });

  it("limits requests per window", () => {
    resetRateLimits();
    const now = 1_000_000;
    expect(checkRateLimit("k", 2, 1000, now).allowed).toBe(true);
    expect(checkRateLimit("k", 2, 1000, now).allowed).toBe(true);
    const blocked = checkRateLimit("k", 2, 1000, now + 10);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(checkRateLimit("k", 2, 1000, now + 2000).allowed).toBe(true);
  });
});
