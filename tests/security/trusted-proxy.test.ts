import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as health } from "@/app/api/health/route";
import { canonicalOrigin } from "@/lib/api/trusted-proxy";
import { resetRateLimits } from "@/lib/api/rate-limit";
import { isSecureRequest, presignHost } from "@/lib/presign/tokens";
import { proxy } from "@/proxy";

afterEach(() => {
  vi.unstubAllEnvs();
  resetRateLimits();
});

const spoofed = () =>
  new Request("http://presign.internal:3000/api/presign/nonce", {
    headers: { host: "presign.internal:3000", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" },
  });

describe("forwarded headers count only from a trusted proxy", () => {
  it("without one, X-Forwarded-Host / -Proto are ignored: ownership messages name the real host", () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("PRESIGN_TRUSTED_PROXY_HOPS", "");
    expect(presignHost(spoofed())).toBe("presign.internal:3000");
    expect(isSecureRequest(spoofed())).toBe(false);
  });

  it("on Vercel, or behind declared proxies, they are used", () => {
    vi.stubEnv("VERCEL", "1");
    expect(presignHost(spoofed())).toBe("evil.example");
    expect(isSecureRequest(spoofed())).toBe(true);
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("PRESIGN_TRUSTED_PROXY_HOPS", "1");
    expect(presignHost(spoofed())).toBe("evil.example");
  });

  it("PRESIGN_CANONICAL_ORIGIN overrides every header", () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("PRESIGN_CANONICAL_ORIGIN", "https://presign-app.vercel.app");
    expect(presignHost(spoofed())).toBe("presign-app.vercel.app");
    expect(isSecureRequest(spoofed())).toBe(true);
  });

  it("a canonical origin that is not a bare http(s) origin is ignored", () => {
    for (const bad of ["presign-app.vercel.app", "javascript:alert(1)", "https://presign-app.vercel.app/path", "https://u:p@presign-app.vercel.app", "https://presign-app.vercel.app/?x=1"]) {
      vi.stubEnv("PRESIGN_CANONICAL_ORIGIN", bad);
      expect(canonicalOrigin()).toBeNull();
    }
  });
});

describe("canonical origin redirect (proxy.ts)", () => {
  it("a page requested on another host is redirected there with a 308, path and query kept", () => {
    vi.stubEnv("PRESIGN_CANONICAL_ORIGIN", "https://presign-app.vercel.app");
    const res = proxy(new NextRequest("https://solana-ai-defender.vercel.app/verify?input=abc", { headers: { host: "solana-ai-defender.vercel.app" } }));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://presign-app.vercel.app/verify?input=abc");
  });

  it("on the canonical host, or without a canonical origin, the page is served with its CSP", () => {
    vi.stubEnv("PRESIGN_CANONICAL_ORIGIN", "https://presign-app.vercel.app");
    const same = proxy(new NextRequest("https://presign-app.vercel.app/verify", { headers: { host: "presign-app.vercel.app" } }));
    expect(same.status).toBe(200);
    expect(same.headers.get("content-security-policy")).toMatch(/nonce-/);
    vi.stubEnv("PRESIGN_CANONICAL_ORIGIN", "");
    const other = proxy(new NextRequest("https://solana-ai-defender.vercel.app/verify", { headers: { host: "solana-ai-defender.vercel.app" } }));
    expect(other.status).toBe(200);
  });
});

describe("/api/health reports the proxy trust and canonical origin (no secrets)", () => {
  it("shows where client addresses come from", async () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("PRESIGN_TRUSTED_PROXY_HOPS", "");
    vi.stubEnv("PRESIGN_CANONICAL_ORIGIN", "https://presign-app.vercel.app");
    const body = (await (await health(new Request("http://localhost/api/health"))).json()) as { data: { proxyTrust: string; canonicalOrigin: string | null } };
    expect(body.data).toMatchObject({ proxyTrust: "none", canonicalOrigin: "https://presign-app.vercel.app" });
  });
});
