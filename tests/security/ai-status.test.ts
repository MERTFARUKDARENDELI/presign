import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSecurityAgent } from "@/lib/ai/agent";
import { AI_DIAGNOSTIC_TTL_MS, diagnoseAi, getAiStatus, isAiVerified, recordAiFailure, recordAiSuccess, resetAiStatus } from "@/lib/ai/status";
import { buildDemoTransaction, buildDemoWalletScan } from "@/lib/demo/scenario";
import type { SecurityDataProvider } from "@/lib/ai/tools";
import { GET as health } from "@/app/api/health/route";

// A syntactically plausible, fake key. It must never appear in any output.
const FAKE_KEY = `sk-ant-test-${"x".repeat(40)}`;

const apiError = (status: number) => Anthropic.APIError.generate(status, { type: "error", error: { type: "api_error", message: "provider error" } }, "provider error", new Headers());

function demoProvider(): SecurityDataProvider {
  const scan = buildDemoWalletScan();
  return { mode: "demo", wallet: scan.snapshot.address, getWalletScan: async () => scan, analyzeToken: async () => scan.tokens[0].report!, analyzeTransaction: async () => buildDemoTransaction().analysis, inspect: async () => { throw new Error("not in demo"); } };
}

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const f = vi.fn(impl);
  vi.stubGlobal("fetch", f);
  return f;
}

const healthRequest = () => new Request("http://localhost/api/health", { headers: { "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 250)}` } });

beforeEach(() => resetAiStatus());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetAiStatus();
});

describe("AI status — a present key is not 'ready'", () => {
  it("distinguishes not configured, malformed, and present-but-unverified keys", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(getAiStatus()).toBe("NOT_CONFIGURED");
    vi.stubEnv("ANTHROPIC_API_KEY", "not-a-real-key");
    expect(getAiStatus()).toBe("INVALID_KEY");
    vi.stubEnv("ANTHROPIC_API_KEY", FAKE_KEY);
    expect(getAiStatus()).toBe("CONFIGURED");
    expect(isAiVerified("CONFIGURED")).toBe(false);
  });

  it("derives READY / INVALID_KEY / UNAVAILABLE from real provider outcomes; INVALID_KEY is sticky", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", FAKE_KEY);
    recordAiSuccess();
    expect(getAiStatus()).toBe("READY");
    recordAiFailure(apiError(500));
    expect(getAiStatus()).toBe("UNAVAILABLE");
    recordAiFailure(apiError(401));
    expect(getAiStatus()).toBe("INVALID_KEY");
  });

  it("/api/health never calls the provider and never returns the key", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", FAKE_KEY);
    const f = stubFetch(async () => new Response("{}"));
    const res = await health(healthRequest());
    const text = await res.text();
    expect(f).not.toHaveBeenCalled();
    expect(text).not.toContain(FAKE_KEY);
    expect(text).not.toContain("sk-");
    expect(JSON.parse(text).data.ai).toBe("CONFIGURED");
  });

  it("/api/health reports an invalid key after the provider rejected it", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", FAKE_KEY);
    recordAiFailure(apiError(401));
    expect(JSON.parse(await (await health(healthRequest())).text()).data.ai).toBe("INVALID_KEY");
  });
});

describe("AI diagnostic — on demand, cached, no tokens", () => {
  it("makes no network call without a key or with a known-invalid key", async () => {
    const f = stubFetch(async () => new Response("{}"));
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect((await diagnoseAi()).status).toBe("NOT_CONFIGURED");
    vi.stubEnv("ANTHROPIC_API_KEY", "bad");
    expect((await diagnoseAi()).status).toBe("INVALID_KEY");
    expect(f).not.toHaveBeenCalled();
  });

  it("marks a rejected key INVALID_KEY and never re-sends it", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", FAKE_KEY);
    const f = stubFetch(async () => new Response("unauthorized", { status: 401 }));
    const d = await diagnoseAi();
    expect(d).toMatchObject({ status: "INVALID_KEY", cached: false });
    expect(JSON.stringify(d)).not.toContain(FAKE_KEY);
    await diagnoseAi(Date.now() + AI_DIAGNOSTIC_TTL_MS * 2);
    expect(f).toHaveBeenCalledTimes(1);
    // Only the model-list endpoint is used (authenticates without generating tokens).
    expect(String(f.mock.calls[0][0])).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/models/);
    expect(f.mock.calls[0][1]?.method).toBe("GET");
  });

  it("marks an accepted key READY, caches the result and dedupes concurrent checks", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", FAKE_KEY);
    const f = stubFetch(async () => new Response("{}", { status: 200 }));
    const now = Date.now();
    const [a, b] = await Promise.all([diagnoseAi(now), diagnoseAi(now)]);
    expect(a.status).toBe("READY");
    expect(b.status).toBe("READY");
    expect((await diagnoseAi(now + 1_000)).cached).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    await diagnoseAi(now + AI_DIAGNOSTIC_TTL_MS + 1);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("reports UNAVAILABLE (not ready) on network failure or provider outage", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", FAKE_KEY);
    stubFetch(async () => {
      throw new TypeError("fetch failed");
    });
    expect((await diagnoseAi()).status).toBe("UNAVAILABLE");
    resetAiStatus();
    stubFetch(async () => new Response("overloaded", { status: 503 }));
    expect((await diagnoseAi()).status).toBe("UNAVAILABLE");
  });
});

describe("deterministic fallback keeps working", () => {
  it("an invalid key yields the deterministic summary without contacting the provider", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", FAKE_KEY);
    recordAiFailure(apiError(401));
    const f = stubFetch(async () => {
      throw new Error("provider must not be called");
    });
    const r = await runSecurityAgent([{ role: "user", content: "What is risky?" }], demoProvider());
    expect(r).toMatchObject({ available: false, unavailableReason: "INVALID_KEY" });
    expect(r.deterministicFallback).toMatch(/Wallet risk:/);
    expect(f).not.toHaveBeenCalled();
  });
});
