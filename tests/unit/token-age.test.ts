import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateTokenRisk, type TokenRuleInput } from "@/lib/security/rules/token";
import { rpcCall } from "@/lib/solana/client";
import { parseMintAccount } from "@/lib/solana/parsers";
import { ageFromObservation, combineTokenAge, describeAge, initializesMint, observationFromRugcheck, type TokenAge } from "@/lib/token/age";
import { clearTokenAgeCache, getOnchainTokenAgeObservation, TOKEN_AGE_MAX_PAGES } from "@/lib/token/age-source";
import { parseRugcheck } from "@/lib/token/rugcheck-types";
import { MINT, parsedMint, WALLET } from "../helpers/fixtures";

vi.mock("@/lib/solana/client", async (importOriginal) => ({ ...(await importOriginal<object>()), rpcCall: vi.fn() }));
const rpc = vi.mocked(rpcCall);

const M = MINT.toBase58();
const NOW = new Date("2026-09-25T12:00:00Z");
const nowUnix = Math.floor(NOW.getTime() / 1000);
const DAY = 86_400;

const known = (ageSeconds: number): TokenAge => ageFromObservation({ status: "KNOWN", firstSeenUnix: nowUnix - ageSeconds, source: "ONCHAIN_RPC", detail: "creation" }, "mainnet-beta", NOW);

describe("token age — pure derivation", () => {
  it("KNOWN age from a verified creation time", () => {
    const a = known(3 * DAY);
    expect(a).toMatchObject({ status: "KNOWN", ageSeconds: 3 * DAY, source: "ONCHAIN_RPC", cluster: "mainnet-beta" });
    expect(a.firstSeenAt).toBe(new Date((nowUnix - 3 * DAY) * 1000).toISOString());
    expect(describeAge(a)).toBe("3 d");
  });

  it("missing, zero, non-integer or future timestamps are UNAVAILABLE — never guessed", () => {
    for (const firstSeenUnix of [null, 0, -5, 1.5, nowUnix + 3_600]) {
      const a = ageFromObservation({ status: "KNOWN", firstSeenUnix, source: "ONCHAIN_RPC", detail: "x" }, "devnet", NOW);
      expect(a.status, String(firstSeenUnix)).toBe("UNAVAILABLE");
      expect(a.ageSeconds).toBeNull();
      expect(describeAge(a)).toBe("unavailable");
    }
  });

  it("RugCheck first-seen is only a lower bound; malformed dates are ignored", () => {
    expect(observationFromRugcheck("2026-09-01T00:00:00Z")).toMatchObject({ status: "LOWER_BOUND", source: "RUGCHECK" });
    expect(observationFromRugcheck("not a date")).toBeNull();
    expect(observationFromRugcheck(null)).toBeNull();
  });

  it("combine: exact on-chain creation wins; otherwise the oldest lower bound; otherwise UNAVAILABLE", () => {
    const creation = { status: "KNOWN" as const, firstSeenUnix: nowUnix - 2 * DAY, source: "ONCHAIN_RPC" as const, detail: "c" };
    const rug = observationFromRugcheck(new Date((nowUnix - 30 * DAY) * 1000).toISOString());
    expect(combineTokenAge([creation, rug], "mainnet-beta", NOW)).toMatchObject({ status: "KNOWN", ageSeconds: 2 * DAY });

    const onchainLower = { status: "LOWER_BOUND" as const, firstSeenUnix: nowUnix - 10 * DAY, source: "ONCHAIN_RPC" as const, detail: "l" };
    expect(combineTokenAge([onchainLower, rug], "mainnet-beta", NOW)).toMatchObject({ status: "LOWER_BOUND", ageSeconds: 30 * DAY, source: "RUGCHECK" });
    expect(describeAge(combineTokenAge([onchainLower], "mainnet-beta", NOW))).toBe("at least 10 d");

    const none = combineTokenAge([{ status: "UNAVAILABLE", firstSeenUnix: null, source: null, detail: "RPC down." }, null], "devnet", NOW);
    expect(none).toMatchObject({ status: "UNAVAILABLE", cluster: "devnet" });
    expect(none.detail).toContain("RPC down");
  });

  it("initializesMint accepts only a parsed initializeMint(2) for THIS mint (top-level or CPI)", () => {
    const ix = (program: string, type: string, mint: string) => ({ program, parsed: { type, info: { mint } } });
    expect(initializesMint({ transaction: { message: { instructions: [ix("spl-token", "initializeMint2", M)] } } }, M)).toBe(true);
    expect(initializesMint({ transaction: { message: { instructions: [] } }, meta: { innerInstructions: [{ instructions: [ix("spl-token-2022", "initializeMint", M)] }] } }, M)).toBe(true);
    expect(initializesMint({ transaction: { message: { instructions: [ix("spl-token", "initializeMint2", WALLET.toBase58())] } } }, M)).toBe(false);
    expect(initializesMint({ transaction: { message: { instructions: [ix("spl-token", "mintTo", M)] } } }, M)).toBe(false);
    expect(initializesMint({ transaction: { message: { instructions: [ix("spl-memo", "initializeMint2", M)] } } }, M)).toBe(false);
    expect(initializesMint(null, M)).toBe(false);
    expect(initializesMint({ garbage: true }, M)).toBe(false);
  });
});

describe("token age — on-chain source (RPC mocked)", () => {
  const sig = (n: number) => String(n % 10).repeat(88);
  const page = (count: number, oldestBlockTime: number | null, start = 0) =>
    Array.from({ length: count }, (_, i) => ({ signature: sig(start + i), slot: 1, blockTime: i === count - 1 ? oldestBlockTime : nowUnix }));

  beforeEach(() => {
    rpc.mockReset();
    clearTokenAgeCache();
  });
  afterEach(() => vi.unstubAllEnvs());

  function script(pages: unknown[][], creationTx: unknown = { transaction: { message: { instructions: [{ program: "spl-token", parsed: { type: "initializeMint2", info: { mint: M } } }] } } }) {
    let p = 0;
    rpc.mockImplementation((async (method: string) => {
      if (method === "getSignaturesForAddress") return { result: pages[Math.min(p++, pages.length - 1)], source: "HELIUS_RPC", fallbackUsed: false };
      if (method === "getTransaction") return { result: creationTx, source: "HELIUS_RPC", fallbackUsed: false };
      throw new Error(`unexpected ${method}`);
    }) as unknown as typeof rpcCall);
  }

  it("history exhausted + oldest tx initializes the mint → KNOWN", async () => {
    script([page(3, nowUnix - 5 * DAY)]);
    const o = await getOnchainTokenAgeObservation(M);
    expect(o).toMatchObject({ status: "KNOWN", firstSeenUnix: nowUnix - 5 * DAY, source: "ONCHAIN_RPC" });
    expect(rpc.mock.calls.filter(([m]) => m === "getTransaction")).toHaveLength(1);
  });

  it("history exhausted but oldest tx is not the creation (pruned RPC) → only a LOWER_BOUND", async () => {
    script([page(3, nowUnix - 5 * DAY)], { transaction: { message: { instructions: [] } } });
    expect((await getOnchainTokenAgeObservation(M)).status).toBe("LOWER_BOUND");
  });

  it("more history than the page budget → LOWER_BOUND without fetching a transaction", async () => {
    script([page(1_000, nowUnix - DAY), page(1_000, nowUnix - 2 * DAY, 1_000), page(1_000, nowUnix - 40 * DAY, 2_000)]);
    const o = await getOnchainTokenAgeObservation(M);
    expect(o).toMatchObject({ status: "LOWER_BOUND", firstSeenUnix: nowUnix - 40 * DAY });
    expect(rpc.mock.calls.filter(([m]) => m === "getSignaturesForAddress")).toHaveLength(TOKEN_AGE_MAX_PAGES);
    expect(rpc.mock.calls.some(([m]) => m === "getTransaction")).toBe(false);
    // pagination walks backwards with `before`
    expect(rpc.mock.calls[1][1]).toEqual([M, expect.objectContaining({ before: expect.any(String), limit: 1_000 })]);
  });

  it("malformed history, no history, missing block time and RPC errors → UNAVAILABLE", async () => {
    script([[{ signature: "short" }]]);
    expect((await getOnchainTokenAgeObservation(M)).status).toBe("UNAVAILABLE");
    clearTokenAgeCache();
    script([[]]);
    expect((await getOnchainTokenAgeObservation(M)).detail).toMatch(/No on-chain history/);
    clearTokenAgeCache();
    script([page(2, null)]);
    expect((await getOnchainTokenAgeObservation(M)).status).toBe("UNAVAILABLE");
    clearTokenAgeCache();
    rpc.mockRejectedValue(new Error("rpc down"));
    expect((await getOnchainTokenAgeObservation(M)).status).toBe("UNAVAILABLE");
  });

  it("caches per cluster: a devnet lookup never reuses the mainnet result", async () => {
    script([page(3, nowUnix - 5 * DAY)]);
    vi.stubEnv("SOLANA_CLUSTER", "mainnet-beta");
    await getOnchainTokenAgeObservation(M);
    await getOnchainTokenAgeObservation(M);
    const afterMainnet = rpc.mock.calls.length;
    expect(rpc.mock.calls.filter(([m]) => m === "getSignaturesForAddress")).toHaveLength(1); // second call cached
    vi.stubEnv("SOLANA_CLUSTER", "devnet");
    await getOnchainTokenAgeObservation(M);
    expect(rpc.mock.calls.length).toBeGreaterThan(afterMainnet);
  });
});

describe("token age → risk engine", () => {
  const mintInfo = (opts: Parameters<typeof parsedMint>[0] = {}) => parseMintAccount(M, parsedMint(opts))!;
  const rug = (liquidityUsd: number, holders: number) => ({ ok: true as const, data: parseRugcheck({ risks: [], markets: [{}], totalMarketLiquidity: liquidityUsd, totalHolders: holders, rugged: false }, "full")! });
  const evaluate = (over: Partial<TokenRuleInput>) =>
    evaluateTokenRisk({
      mintAddress: M, mint: mintInfo(), mintStatus: "OK", rugcheck: rug(1_000_000, 10_000), concentration: { top1Pct: 5, top10Pct: 30 },
      concentrationStatus: "OK", metadata: { name: "Fine", symbol: "FINE", source: "HELIUS_DAS" }, metadataStatus: "OK", now: NOW, ...over,
    });
  const codes = (r: ReturnType<typeof evaluate>) => r.signals.map((s) => s.code);

  it("an established token (known age ≥ 7 d) with no other signal stays SAFE and COMPLETE", () => {
    const r = evaluate({ age: known(400 * DAY) });
    expect(r.level).toBe("SAFE");
    expect(r.status).toBe("COMPLETE");
    expect(r.evidence.find((e) => e.id === `token:${M}:age`)?.observed).toContain("400 d");
  });

  it("age alone is weak evidence: < 1 day → MEDIUM, < 7 days → LOW, never HIGH/CRITICAL", () => {
    const veryNew = evaluate({ age: known(3_600) });
    expect(codes(veryNew)).toEqual(["TOKEN_VERY_NEW"]);
    expect(veryNew.level).toBe("MEDIUM");
    const newish = evaluate({ age: known(3 * DAY) });
    expect(codes(newish)).toEqual(["TOKEN_NEW"]);
    expect(newish.level).toBe("LOW");
  });

  it("new + an independent risk factor → HIGH combined signal citing both evidence ids (not CRITICAL)", () => {
    const r = evaluate({ age: known(3_600), mint: mintInfo({ mintAuthority: WALLET.toBase58() }), rugcheck: rug(500, 20) });
    const combo = r.signals.find((s) => s.code === "TOKEN_NEW_WITH_RISK_FACTORS")!;
    expect(combo.severity).toBe("HIGH");
    expect(combo.evidenceIds).toEqual(expect.arrayContaining([`token:${M}:age`, `token:${M}:mintAuthority`, `token:${M}:rugcheck.liquidity`, `token:${M}:rugcheck.holders`]));
    expect(r.level).toBe("HIGH");
  });

  it("an old token with the same factors gets no age-based escalation", () => {
    const r = evaluate({ age: known(400 * DAY), mint: mintInfo({ mintAuthority: WALLET.toBase58() }) });
    expect(codes(r)).not.toContain("TOKEN_NEW_WITH_RISK_FACTORS");
  });

  it("UNAVAILABLE age: evidence says so, no signal, analysis PARTIAL → UNKNOWN (not SAFE, not malicious)", () => {
    const r = evaluate({ age: combineTokenAge([], "mainnet-beta", NOW) });
    expect(r.signals).toEqual([]);
    expect(r.level).toBe("UNKNOWN");
    expect(r.status).toBe("PARTIAL");
    expect(r.evidence.find((e) => e.id === `token:${M}:age`)?.observed).toBe("unavailable");
    expect(r.sources).toContainEqual(expect.objectContaining({ status: "FAILED", detail: "Token age unavailable (mainnet-beta)" }));
  });

  it("an inconclusive lower bound (< 7 d) is not called new, and keeps the analysis PARTIAL", () => {
    const lower = ageFromObservation({ status: "LOWER_BOUND", firstSeenUnix: nowUnix - 2 * DAY, source: "RUGCHECK", detail: "rug" }, "mainnet-beta", NOW);
    const r = evaluate({ age: lower });
    expect(codes(r)).toEqual([]);
    expect(r.status).toBe("PARTIAL");
    expect(r.evidence.find((e) => e.id === `token:${M}:age`)?.source).toBe("RUGCHECK");
    // a lower bound past the threshold is conclusive
    const old = ageFromObservation({ status: "LOWER_BOUND", firstSeenUnix: nowUnix - 90 * DAY, source: "ONCHAIN_RPC", detail: "l" }, "mainnet-beta", NOW);
    expect(evaluate({ age: old }).status).toBe("COMPLETE");
  });

  it("wallet-scan reports (age not checked) are unchanged, with an explicit SKIPPED source", () => {
    const r = evaluate({});
    expect(r.level).toBe("SAFE");
    expect(r.sources).toContainEqual(expect.objectContaining({ status: "SKIPPED", detail: "Token age not checked in wallet scan (deep scan only)" }));
  });

  it("devnet: RugCheck unsupported, on-chain age still evaluated and labelled with the cluster", () => {
    const devAge = ageFromObservation({ status: "KNOWN", firstSeenUnix: nowUnix - 3_600, source: "ONCHAIN_RPC", detail: "c" }, "devnet", NOW);
    const r = evaluate({ age: devAge, rugcheck: { ok: false, reason: "UNSUPPORTED_CLUSTER" } });
    expect(codes(r)).toContain("TOKEN_VERY_NEW");
    expect(r.sources).toContainEqual(expect.objectContaining({ source: "RUGCHECK", status: "UNSUPPORTED" }));
    expect(r.sources).toContainEqual(expect.objectContaining({ detail: "Token age from mint creation (devnet)" }));
    expect(r.status).toBe("PARTIAL");
  });

  it("every signal references existing evidence ids", () => {
    const r = evaluate({ age: known(60), mint: mintInfo({ mintAuthority: WALLET.toBase58(), freezeAuthority: WALLET.toBase58() }), rugcheck: rug(10, 3), metadata: { name: "Claim at jup-claim.xyz", symbol: "X", source: "HELIUS_DAS" } });
    const ids = new Set(r.evidence.map((e) => e.id));
    expect(r.signals.length).toBeGreaterThan(3);
    for (const s of r.signals) {
      expect(s.evidenceIds.length).toBeGreaterThan(0);
      for (const id of s.evidenceIds) expect(ids.has(id), `${s.code} → ${id}`).toBe(true);
    }
  });
});
