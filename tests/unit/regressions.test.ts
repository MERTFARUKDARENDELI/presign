import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateTokenRisk } from "@/lib/security/rules/token";
import { evaluateWalletRisk } from "@/lib/security/rules/wallet";
import { masterEditionPda } from "@/lib/solana/metaplex";
import { parseMintAccount, parseTokenAccount } from "@/lib/solana/parsers";
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
