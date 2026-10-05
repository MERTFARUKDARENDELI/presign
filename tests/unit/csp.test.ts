import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { buildCsp, newNonce } from "@/lib/security/csp";
import { config, proxy } from "@/proxy";
import nextConfig from "@/next.config";

const directive = (csp: string, name: string) => csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? "";

describe("Content Security Policy", () => {
  it("scripts run only with this request's nonce: no inline script, no eval in production, no other host", () => {
    const csp = buildCsp("abc123", false);
    const scripts = directive(csp, "script-src");
    expect(scripts).toContain("'nonce-abc123'");
    expect(scripts).toContain("'strict-dynamic'");
    expect(scripts).not.toMatch(/unsafe-inline|unsafe-eval|https?:|\*/);
    expect(directive(csp, "default-src")).toBe("default-src 'self'");
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
    expect(directive(csp, "base-uri")).toBe("base-uri 'self'");
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(buildCsp("abc123", true), "script-src")).toContain("'unsafe-eval'");
  });

  it("the page may talk only to itself and the public Solana RPC the wallet adapter uses", () => {
    expect(directive(buildCsp("n", false), "connect-src")).toBe("connect-src 'self' https://api.mainnet-beta.solana.com https://api.devnet.solana.com wss://api.mainnet-beta.solana.com wss://api.devnet.solana.com ws://localhost:*");
  });

  it("every page response gets a fresh nonce, also handed to Next.js on the request", async () => {
    const a = proxy(new NextRequest("https://presign-app.vercel.app/verify"));
    const b = proxy(new NextRequest("https://presign-app.vercel.app/verify"));
    const ca = a.headers.get("content-security-policy")!;
    const cb = b.headers.get("content-security-policy")!;
    const nonceOf = (csp: string) => /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
    expect(nonceOf(ca)).toBeTruthy();
    expect(nonceOf(ca)).not.toBe(nonceOf(cb));
    expect(a.headers.get("x-middleware-request-content-security-policy")).toBe(ca);
    expect(newNonce()).toMatch(/^[A-Za-z0-9+/]{22,}={0,2}$/);
  });

  it("API routes, static files and prefetches are not run through the proxy; no second CSP is set elsewhere", async () => {
    const m = config.matcher[0];
    expect(m.source).toContain("(?!api|_next/static|_next/image|favicon.ico");
    expect(m.missing).toEqual(expect.arrayContaining([{ type: "header", key: "next-router-prefetch" }]));
    // A static CSP header would be enforced next to the nonce one and block every script.
    const headers = (await nextConfig.headers!()).flatMap((h) => h.headers.map((x) => x.key.toLowerCase()));
    expect(headers).not.toContain("content-security-policy");
    expect(headers).toEqual(expect.arrayContaining(["x-frame-options", "x-content-type-options", "referrer-policy", "permissions-policy"]));
  });
});
