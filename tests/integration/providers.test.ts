import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/api/errors";
import { RPC_CONCURRENCY, RPC_QUEUE_LIMIT, rpcCall, rpcSlotUsage } from "@/lib/solana/client";
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

describe(`at most ${RPC_CONCURRENCY} RPC requests in flight per provider (CLAUDE.md rule 2)`, () => {
  /** A fetch that answers after `ms`, counting requests in flight per host. */
  function slowFetch(ms: number, answer: (url: string) => Response | null = () => null) {
    const inFlight: Record<string, number> = {};
    const peak: Record<string, number> = {};
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const host = new URL(url).host;
      inFlight[host] = (inFlight[host] ?? 0) + 1;
      peak[host] = Math.max(peak[host] ?? 0, inFlight[host]);
      await new Promise((r) => setTimeout(r, ms));
      inFlight[host]--;
      const custom = answer(url);
      if (custom) return custom;
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: body.id }), { status: 200 });
    }));
    return peak;
  }

  it(`40 calls at once: never more than ${RPC_CONCURRENCY} at the provider, all answered, every slot freed`, async () => {
    vi.stubEnv("SOLANA_DISABLE_PUBLIC_FALLBACK", "true");
    const peak = slowFetch(5);
    const results = await Promise.all(Array.from({ length: 40 }, () => rpcCall<number>("getSlot", [], { retries: 0 })));
    expect(results).toHaveLength(40);
    expect(peak["mainnet.helius-rpc.com"]).toBe(RPC_CONCURRENCY);
    expect(rpcSlotUsage().helius).toEqual({ active: 0, waiting: 0 });
  });

  it("failed requests free their slots; Helius and the public fallback have slots of their own", async () => {
    const peak = slowFetch(3, (url) => (url.includes("helius") ? new Response("down", { status: 503 }) : null));
    const results = await Promise.all(Array.from({ length: 20 }, () => rpcCall<number>("getSlot", [], { retries: 0 })));
    expect(results.every((r) => r.fallbackUsed)).toBe(true);
    expect(peak["mainnet.helius-rpc.com"]).toBeLessThanOrEqual(RPC_CONCURRENCY);
    expect(peak["api.mainnet-beta.solana.com"]).toBeLessThanOrEqual(RPC_CONCURRENCY);
    expect(rpcSlotUsage()).toMatchObject({ helius: { active: 0, waiting: 0 }, fallback: { active: 0, waiting: 0 } });
  });

  it(`beyond ${RPC_QUEUE_LIMIT} waiting requests a call fails as unavailable instead of queueing without end`, async () => {
    vi.stubEnv("SOLANA_DISABLE_PUBLIC_FALLBACK", "true");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      await gate;
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: 1 }), { status: 200 });
    }));
    const queued = Array.from({ length: RPC_CONCURRENCY + RPC_QUEUE_LIMIT }, () => rpcCall("getSlot", [], { retries: 0 }));
    await Promise.resolve();
    await expect(rpcCall("getSlot", [], { retries: 0 })).rejects.toMatchObject({ code: "RPC_ERROR" });
    release();
    expect(await Promise.all(queued)).toHaveLength(RPC_CONCURRENCY + RPC_QUEUE_LIMIT);
    expect(rpcSlotUsage().helius).toEqual({ active: 0, waiting: 0 });
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
