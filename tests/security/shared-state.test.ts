import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAppError } from "@/lib/api/errors";
import { withApi } from "@/lib/api/handler";
import { checkRateLimit, clientKey, resetRateLimits } from "@/lib/api/rate-limit";
import { consumeOnce, resetReplayRegistry } from "@/lib/presign/replay";

const STORE = "https://presign-test.upstash.io";

beforeEach(() => {
  resetReplayRegistry();
  resetRateLimits();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("single use survives pressure (no wipe of live entries)", () => {
  it("when the registry is full of live entries it refuses new work, and spent tokens stay spent", async () => {
    const now = 1_000_000;
    const exp = now + 120_000;
    expect(await consumeOnce("approve", "spent", exp, now)).toBe(true);
    // Up to the capacity of 50,000 live entries ("spent" is one of them).
    for (let i = 0; i < 49_999; i++) await consumeOnce("approve", `filler-${i}`, exp, now);
    let error: unknown;
    try {
      await consumeOnce("approve", "new-request", exp, now);
    } catch (e) {
      error = e;
    }
    expect(isAppError(error) && error.code).toBe("RATE_LIMITED");
    // The old behavior cleared everything here, which made "spent" usable again.
    expect(await consumeOnce("approve", "spent", exp, now)).toBe(false);
    // Once entries expire there is room again.
    expect(await consumeOnce("approve", "later", exp + 200_000, exp + 1)).toBe(true);
  });
});

describe("rate limiter evicts the least recently used clients, not everyone", () => {
  it("a client that is being limited stays limited while thousands of other keys come and go", () => {
    const now = 5_000_000;
    for (let i = 0; i < 3; i++) checkRateLimit("route:abuser", 3, 60_000, now);
    expect(checkRateLimit("route:abuser", 3, 60_000, now).allowed).toBe(false);
    for (let i = 0; i < 10_050; i++) {
      checkRateLimit(`route:other-${i}`, 3, 60_000, now);
      if (i % 1_000 === 0) checkRateLimit("route:abuser", 3, 60_000, now);
    }
    expect(checkRateLimit("route:abuser", 3, 60_000, now).allowed).toBe(false);
  });
});

describe("shared store (Upstash Redis REST / Vercel KV) when configured", () => {
  const configure = () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", STORE);
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
  };

  it("single use is claimed with SET NX PX on the shared store, so every instance sees it", async () => {
    configure();
    const taken = new Set<string>();
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const cmd = JSON.parse(String(init.body)) as string[];
      expect(url).toBe(STORE);
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
      expect(cmd.slice(0, 1).concat(cmd.slice(3, 5))).toEqual(["SET", "NX", "PX"]);
      const first = !taken.has(cmd[1]);
      taken.add(cmd[1]);
      return new Response(JSON.stringify({ result: first ? "OK" : null }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const now = Date.now();
    expect(await consumeOnce("submit", "rid-1", now + 60_000, now)).toBe(true);
    resetReplayRegistry(); // another instance: no local memory of it
    expect(await consumeOnce("submit", "rid-1", now + 60_000, now)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("if the store does not answer, single use falls back to this instance's memory", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    const now = Date.now();
    expect(await consumeOnce("own", "n-1", now + 60_000, now)).toBe(true);
    expect(await consumeOnce("own", "n-1", now + 60_000, now)).toBe(false);
  });

  it("route limits are counted on the shared store", async () => {
    configure();
    let count = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      expect(url).toBe(`${STORE}/pipeline`);
      count++;
      return new Response(JSON.stringify([{ result: count }, { result: 1 }]));
    }));
    const route = withApi({ name: "shared-test", limit: 2, windowMs: 60_000 }, async () => new Response("ok"));
    const req = () => new Request("https://presign-app.vercel.app/api/x", { headers: { "x-forwarded-for": "1.2.3.4" } });
    expect((await route(req())).status).toBe(200);
    expect((await route(req())).status).toBe(200);
    const blocked = await route(req());
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});

describe("client address", () => {
  it("on Vercel, the platform's own address header wins over a client-supplied X-Forwarded-For", () => {
    vi.stubEnv("VERCEL", "1");
    const r = new Request("https://presign-app.vercel.app/api/x", { headers: { "x-forwarded-for": "6.6.6.6", "x-vercel-forwarded-for": "1.2.3.4", "x-real-ip": "1.2.3.4" } });
    expect(clientKey(r)).toBe("1.2.3.4");
  });

  it("behind declared proxies, the address the outermost trusted proxy appended; the client's own entries are ignored", () => {
    vi.stubEnv("VERCEL", "");
    const r = new Request("http://localhost/api/x", { headers: { "x-forwarded-for": "6.6.6.6, 9.9.9.9, 10.0.0.1" } });
    vi.stubEnv("PRESIGN_TRUSTED_PROXY_HOPS", "1");
    expect(clientKey(r)).toBe("10.0.0.1");
    vi.stubEnv("PRESIGN_TRUSTED_PROXY_HOPS", "2");
    expect(clientKey(r)).toBe("9.9.9.9");
  });

  it("without a trusted proxy, X-Forwarded-For and X-Real-IP are client-controlled: everyone shares one bucket", () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("PRESIGN_TRUSTED_PROXY_HOPS", "");
    expect(clientKey(new Request("http://localhost/api/x", { headers: { "x-forwarded-for": "9.9.9.9", "x-real-ip": "8.8.8.8" } }))).toBe("direct");
    expect(clientKey(new Request("http://localhost/api/x", { headers: { "x-forwarded-for": "7.7.7.7" } }))).toBe("direct");
  });
});
