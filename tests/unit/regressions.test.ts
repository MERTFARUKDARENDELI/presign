import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateTokenRisk } from "@/lib/security/rules/token";
import { evaluateWalletRisk } from "@/lib/security/rules/wallet";
import { masterEditionPda } from "@/lib/solana/metaplex";
import { parseMintAccount, parseTokenAccount } from "@/lib/solana/parsers";
import { rpcCall } from "@/lib/solana/client";
import { getAssetsByOwner } from "@/lib/solana/tokens";
import { getRugcheckReport } from "@/lib/token/rugcheck";
import { parseRugcheck } from "@/lib/token/rugcheck-types";
import { buildDemoTransaction, buildDemoWalletScan } from "@/lib/demo/scenario";
import { ATTACKER, MINT, parsedMint, parsedTokenAccount, WALLET } from "../helpers/fixtures";

const mint = MINT.toBase58();

describe("regression: Metaplex NFTs are not flagged for edition-held authorities", () => {
  it("does not raise freeze/mint authority signals when both are the derived Master Edition PDA", () => {
    const edition = masterEditionPda(mint);
    const m = parseMintAccount(mint, parsedMint({ decimals: 0, supply: "1", mintAuthority: edition, freezeAuthority: edition }))!;
    const r = evaluateTokenRisk({ mintAddress: mint, mint: m, mintStatus: "OK", rugcheck: null, concentration: null, concentrationStatus: "SKIPPED", metadata: null, metadataStatus: "SKIPPED" });
    expect(r.signals.map((s) => s.code)).not.toContain("TOKEN_FREEZE_AUTHORITY_ACTIVE");
    expect(r.evidence.some((e) => e.label.includes("Master Edition"))).toBe(true);
  });

  it("still flags an NFT-shaped mint whose freeze authority is an arbitrary address", () => {
    const m = parseMintAccount(mint, parsedMint({ decimals: 0, supply: "1", freezeAuthority: ATTACKER.toBase58() }))!;
    const r = evaluateTokenRisk({ mintAddress: mint, mint: m, mintStatus: "OK", rugcheck: null, concentration: null, concentrationStatus: "SKIPPED", metadata: null, metadataStatus: "SKIPPED" });
    expect(r.signals.map((s) => s.code)).toContain("TOKEN_FREEZE_AUTHORITY_ACTIVE");
  });

  it("excludes frozen pNFT accounts from the wallet frozen-account signal", () => {
    const acc = parseTokenAccount("acc", parsedTokenAccount({ amount: "1", decimals: 0, state: "frozen" }))!;
    const base = { wallet: WALLET.toBase58(), tokenAccounts: [acc], tokenRisks: [], assetRisks: [], snapshotStatus: "COMPLETE" as const, sources: [], unanalyzedTokens: 0 };
    expect(evaluateWalletRisk(base).signals.map((s) => s.code)).toContain("WALLET_FROZEN_ACCOUNTS");
    expect(evaluateWalletRisk({ ...base, standardNftMints: new Set([mint]) }).signals.map((s) => s.code)).not.toContain("WALLET_FROZEN_ACCOUNTS");
  });
});

describe("regression: RugCheck zero values without market data are unknown, not 'very low'", () => {
  it("does not flag liquidity when RugCheck has no markets (e.g. USDC) and keeps analysis PARTIAL", () => {
    const rc = parseRugcheck({ risks: [], totalMarketLiquidity: 0, totalHolders: 0, markets: null, rugged: false }, "full")!;
    expect(rc.liquidityUsd).toBeNull();
    expect(rc.totalHolders).toBeNull();
    const m = parseMintAccount(mint, parsedMint({}))!;
    const r = evaluateTokenRisk({ mintAddress: mint, mint: m, mintStatus: "OK", rugcheck: { ok: true, data: rc }, concentration: { top1Pct: 1, top10Pct: 5 }, concentrationStatus: "OK", metadata: null, metadataStatus: "SKIPPED" });
    expect(r.signals.map((s) => s.code)).not.toContain("TOKEN_LIQUIDITY_VERY_LOW");
    expect(r.signals.map((s) => s.code)).not.toContain("TOKEN_FEW_HOLDERS");
    expect(r.status).toBe("PARTIAL");
    expect(r.level).toBe("UNKNOWN");
  });
});

describe("regression: DAS is paged to stay under the provider response cap", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("requests small pages and marks the result truncated at the page budget", async () => {
    vi.stubEnv("HELIUS_API_KEY", "k");
    const limits: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      limits.push(body.params.limit);
      const items = Array.from({ length: body.params.limit }, (_, i) => ({ id: MINT.toBase58(), interface: "V1_NFT", compression: { compressed: true }, content: { metadata: { name: `n${i}` } } }));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { total: items.length, items } }), { status: 200 });
    }));
    const r = await getAssetsByOwner(WALLET.toBase58());
    expect(Math.max(...limits)).toBeLessThanOrEqual(50);
    expect(r.truncated).toBe(true);
    expect(r.assets.length).toBe(200);
  });
});

describe("demo mode determinism", () => {
  it("produces identical output on every build and labels everything DEMO", () => {
    const a = JSON.stringify(buildDemoWalletScan());
    const b = JSON.stringify(buildDemoWalletScan());
    expect(a).toBe(b);
    const scan = buildDemoWalletScan();
    expect(scan.demo).toBe(true);
    const all = [scan.walletRisk, ...scan.tokens.map((t) => t.report!.risk), ...scan.assets.map((x) => x.risk)];
    expect(all.every((r) => r.evidence.every((e) => e.source === "DEMO"))).toBe(true);
    expect(buildDemoTransaction().analysis.demo).toBe(true);
    expect(buildDemoTransaction().analysis.effects?.source).toBe("DEMO");
  });

  it("shows the 50 USDC outflow and critical approval in the demo transaction", () => {
    const { analysis } = buildDemoTransaction();
    expect(analysis.risk.level).toBe("CRITICAL");
    const out = analysis.effects!.tokenChanges.find((c) => c.deltaRaw === "-50000000");
    expect(out).toBeDefined();
  });
});

describe("regression: RugCheck (mainnet-only) is never queried on devnet", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns UNSUPPORTED_CLUSTER without a network call, so a same-address mainnet report is never attributed", async () => {
    vi.stubEnv("SOLANA_CLUSTER", "devnet");
    const f = vi.fn(async () => new Response(JSON.stringify({ rugged: true, risks: [] })));
    vi.stubGlobal("fetch", f);
    expect(await getRugcheckReport(mint, "full")).toEqual({ ok: false, reason: "UNSUPPORTED_CLUSTER" });
    expect(f).not.toHaveBeenCalled();
  });

  it("reports RugCheck as UNSUPPORTED (not FAILED) and keeps the analysis PARTIAL", () => {
    const m = parseMintAccount(mint, parsedMint({}))!;
    const r = evaluateTokenRisk({ mintAddress: mint, mint: m, mintStatus: "OK", rugcheck: { ok: false, reason: "UNSUPPORTED_CLUSTER" }, concentration: { top1Pct: 1, top10Pct: 5 }, concentrationStatus: "OK", metadata: null, metadataStatus: "SKIPPED" });
    expect(r.sources.find((s) => s.source === "RUGCHECK")).toMatchObject({ status: "UNSUPPORTED" });
    expect(r.status).toBe("PARTIAL");
    expect(r.level).not.toBe("SAFE");
  });
});

describe("regression: a rate limit gets a real pause before the retry", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("waits at least a second after HTTP 429, then succeeds on the same provider", async () => {
    vi.useFakeTimers();
    vi.stubEnv("HELIUS_API_KEY", "k");
    vi.stubEnv("SOLANA_DISABLE_PUBLIC_FALLBACK", "true");
    const calls: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push(Date.now());
      const id = JSON.parse(String(init?.body)).id;
      return calls.length === 1 ? new Response("{}", { status: 429 }) : new Response(JSON.stringify({ jsonrpc: "2.0", id, result: 42 }), { status: 200 });
    }));
    const pending = rpcCall<number>("getSlot", [], { retries: 1 });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toMatchObject({ result: 42, fallbackUsed: false });
    expect(calls).toHaveLength(2);
    expect(calls[1] - calls[0]).toBeGreaterThanOrEqual(1_000);
  });
});

describe("regression: CLAUDE.md rule 3 — a reported $0 liquidity is unknown even when RugCheck lists markets", () => {
  const evaluate = (totalMarketLiquidity: number, totalHolders = 5_000) => {
    const rc = parseRugcheck({ risks: [], markets: [{}], totalMarketLiquidity, totalHolders, rugged: false }, "full")!;
    const m = parseMintAccount(mint, parsedMint({}))!;
    return { rc, r: evaluateTokenRisk({ mintAddress: mint, mint: m, mintStatus: "OK", rugcheck: { ok: true, data: rc }, concentration: { top1Pct: 1, top10Pct: 5 }, concentrationStatus: "OK", metadata: null, metadataStatus: "SKIPPED" }) };
  };
  const codes = (r: ReturnType<typeof evaluateTokenRisk>) => r.signals.map((x) => x.code);

  it("$0 with markets listed: no liquidity signal, PARTIAL and UNKNOWN, and the evidence says it was treated as unknown", () => {
    const { rc, r } = evaluate(0);
    expect(rc.liquidityUsd).toBeNull();
    expect(rc.liquidityReportedZero).toBe(true);
    expect(codes(r)).not.toContain("TOKEN_LIQUIDITY_VERY_LOW");
    expect(codes(r)).not.toContain("TOKEN_LIQUIDITY_LOW");
    expect(r.status).toBe("PARTIAL");
    expect(r.level).toBe("UNKNOWN");
    expect(r.evidence.some((e) => String(e.observed).includes("treated as unknown"))).toBe(true);
    expect(JSON.stringify(r)).toContain("RugCheck reports $0 liquidity");
  });

  it("a positive amount below the threshold is still very low liquidity (HIGH)", () => {
    const { rc, r } = evaluate(120);
    expect(rc.liquidityUsd).toBe(120);
    expect(rc.liquidityReportedZero).toBe(false);
    expect(r.signals.find((x) => x.code === "TOKEN_LIQUIDITY_VERY_LOW")?.severity).toBe("HIGH");
  });

  it("the other liquidity cases: not reported, no markets and negative are unknown; only a positive amount is rated", () => {
    const rate = (raw: Record<string, unknown>) => {
      const rc = parseRugcheck({ risks: [], totalHolders: 5_000, rugged: false, ...raw }, "full")!;
      const r = evaluateTokenRisk({ mintAddress: mint, mint: parseMintAccount(mint, parsedMint({}))!, mintStatus: "OK", rugcheck: { ok: true, data: rc }, concentration: { top1Pct: 1, top10Pct: 5 }, concentrationStatus: "OK", metadata: null, metadataStatus: "SKIPPED" });
      return [rc.liquidityUsd, rc.liquidityReportedZero, r.status, codes(r).includes("TOKEN_LIQUIDITY_VERY_LOW")];
    };
    // Markets listed, liquidity not reported: unknown, and not "reported $0" either.
    expect(rate({ markets: [{}], totalMarketLiquidity: null })).toEqual([null, false, "PARTIAL", false]);
    expect(rate({ markets: [{}] })).toEqual([null, false, "PARTIAL", false]);
    // No markets: a $0 there is no reading at all.
    expect(rate({ markets: null, totalMarketLiquidity: 0 })).toEqual([null, false, "PARTIAL", false]);
    // A negative amount is malformed data, not low liquidity.
    expect(rate({ markets: [{}], totalMarketLiquidity: -5 })).toEqual([null, false, "PARTIAL", false]);
    // A positive amount under $1 is still very low liquidity.
    expect(rate({ markets: [{}], totalMarketLiquidity: 0.5 })[3]).toBe(true);
  });

  it("0 holders with markets listed is unknown, not 'very few holders'", () => {
    const { rc, r } = evaluate(1_000_000, 0);
    expect(rc.totalHolders).toBeNull();
    expect(codes(r)).not.toContain("TOKEN_FEW_HOLDERS");
    expect(r.status).toBe("PARTIAL");
  });
});
