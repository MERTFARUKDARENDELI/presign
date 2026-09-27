import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/api/errors";
import { rpcCall } from "@/lib/solana/client";
import { getWalletData } from "@/lib/solana/wallet";
import { analyzeToken } from "@/lib/token/scanner";
import { MINT, parsedMint, parsedTokenAccount, WALLET } from "../helpers/fixtures";

type Handler = (url: string, body: { method: string; params: unknown }) => unknown;

function mockFetch(handler: Handler) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("rugcheck")) {
      const r = handler(url, { method: "rugcheck", params: null });
      if (r instanceof Response) return r;
      return new Response(JSON.stringify(r), { status: 200 });
    }
    const body = JSON.parse(String(init?.body));
    calls.push({ url, method: body.method });
    const r = handler(url, body);
    if (r instanceof Response) return r;
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: r }), { status: 200 });
  }));
  return calls;
}

beforeEach(() => {
  vi.stubEnv("HELIUS_API_KEY", "test-helius-key");
  vi.stubEnv("SOLANA_CLUSTER", "mainnet-beta");
  vi.stubEnv("SOLANA_DISABLE_PUBLIC_FALLBACK", "false");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("RPC resilience & capability-aware fallback", () => {
  it("falls back to public RPC for standard methods when Helius fails", async () => {
    const calls = mockFetch((url) => (url.includes("helius") ? new Response("down", { status: 503 }) : { value: 42 }));
    const res = await rpcCall<{ value: number }>("getBalance", ["x"], { retries: 0 });
    expect(res.result.value).toBe(42);
    expect(res.fallbackUsed).toBe(true);
    expect(res.source).toBe("PUBLIC_RPC");
    expect(calls.some((c) => c.url.includes("helius"))).toBe(true);
  });

  it("never falls back for Helius-only DAS methods", async () => {
    const calls = mockFetch((url) => (url.includes("helius") ? new Response("down", { status: 503 }) : { items: [] }));
    await expect(rpcCall("getAssetsByOwner", {}, { retries: 0 })).rejects.toBeInstanceOf(AppError);
    expect(calls.every((c) => c.url.includes("helius"))).toBe(true);
  });

  it("reports DAS as NOT_CONFIGURED without Helius instead of guessing", async () => {
    vi.stubEnv("HELIUS_API_KEY", "");
    mockFetch(() => ({}));
    await expect(rpcCall("getAsset", {})).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });

  it("does not retry/fallback deterministic RPC errors and never leaks the API key", async () => {
    const calls = mockFetch(() => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid param" } }), { status: 200 }));
    const err = await rpcCall("getBalance", ["bad"]).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(JSON.stringify({ m: err.message, d: err.details })).not.toContain("test-helius-key");
    expect(calls).toHaveLength(1);
  });

  it("treats malformed provider JSON as failure, not data", async () => {
    vi.stubEnv("SOLANA_DISABLE_PUBLIC_FALLBACK", "true");
    mockFetch(() => new Response("<html>", { status: 200 }));
    await expect(rpcCall("getBalance", ["x"], { retries: 0 })).rejects.toMatchObject({ code: "RPC_ERROR" });
  });
});

describe("wallet data pipeline (normalized, degraded gracefully)", () => {
  const W = WALLET.toBase58();

  it("normalizes balances as strings and reports PARTIAL when DAS fails", async () => {
    mockFetch((_url, body) => {
      switch (body.method) {
        case "getBalance":
          return { context: { slot: 1 }, value: 1_500_000_000 };
        case "getTokenAccountsByOwner":
          return { context: { slot: 1 }, value: [{ pubkey: "acc1", account: parsedTokenAccount({ amount: "18446744073709551615", decimals: 9 }) }, { pubkey: "bad", account: { junk: true } }] };
        default:
          return new Response("fail", { status: 500 });
      }
    });
    const w = await getWalletData(W);
    expect(w.lamports).toBe("1500000000");
    expect(w.sol).toBe("1.5");
    expect(w.holdings[0].amountRaw).toBe("36893488147419103230"); // two programs × u64 max, no precision loss
    expect(w.status).toBe("PARTIAL");
    expect(w.sources.some((s) => s.source === "HELIUS_DAS" && s.status === "FAILED")).toBe(true);
  });

  it("rejects invalid wallets before any RPC call", async () => {
    const calls = mockFetch(() => ({}));
    await expect(getWalletData("not-a-wallet")).rejects.toMatchObject({ code: "INVALID_WALLET" });
    expect(calls).toHaveLength(0);
  });
});

describe("token scanner integration", () => {
  it("continues with on-chain checks when RugCheck is down (PARTIAL, not SAFE)", async () => {
    vi.stubEnv("RUGCHECK_DISABLED", "false");
    mockFetch((url, body) => {
      if (url.includes("rugcheck")) return new Response("down", { status: 503 });
      if (body.method === "getMultipleAccounts") return { context: { slot: 5 }, value: [parsedMint({ freezeAuthority: WALLET.toBase58() })] };
      if (body.method === "getTokenLargestAccounts") return { context: { slot: 5 }, value: [{ amount: "10" }] };
      if (body.method === "getAssetBatch") return [];
      return null;
    });
    const r = await analyzeToken(MINT.toBase58());
    expect(r.risk.status).toBe("PARTIAL");
    expect(r.risk.level).toBe("HIGH");
    expect(r.risk.sources.find((s) => s.source === "RUGCHECK")?.status).toBe("FAILED");
  });

  it("returns INSUFFICIENT_DATA when the mint cannot be read", async () => {
    mockFetch((url) => (url.includes("rugcheck") ? new Response("", { status: 404 }) : new Response("down", { status: 503 })));
    const r = await analyzeToken(MINT.toBase58());
    expect(r.risk.status).toBe("INSUFFICIENT_DATA");
    expect(r.risk.level).toBe("UNKNOWN");
  }, 20_000);
});
