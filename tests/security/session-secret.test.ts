import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as health } from "@/app/api/health/route";
import { isAppError } from "@/lib/api/errors";
import { resetRateLimits } from "@/lib/api/rate-limit";
import { openToken, sealToken, sessionKey } from "@/lib/presign/tokens";

const SECRET_A = "a".repeat(40);
const SECRET_B = "b".repeat(40);

afterEach(() => {
  vi.unstubAllEnvs();
  resetRateLimits();
});

describe("session tokens in production need their own secret", () => {
  it("without PRESIGN_SESSION_SECRET, production refuses to seal tokens (no key derived from a third-party API key)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PRESIGN_SESSION_SECRET", "");
    vi.stubEnv("HELIUS_API_KEY", "helius-key-that-must-not-become-the-session-key");
    let error: unknown;
    try {
      sealToken("connect", { x: 1 }, 60_000);
    } catch (e) {
      error = e;
    }
    expect(isAppError(error) && error.code).toBe("NOT_CONFIGURED");
  });

  it("a secret shorter than 32 characters is not accepted in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PRESIGN_SESSION_SECRET", "short");
    expect(() => sessionKey()).toThrow(/PRESIGN_SESSION_SECRET/);
  });

  it("with a secret, tokens seal and open, and the key source says so", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PRESIGN_SESSION_SECRET", SECRET_A);
    expect(sessionKey().source).toBe("configured");
    const t = sealToken("connect", { x: 1 }, 60_000);
    expect(openToken<{ x: number }>("connect", t)).toMatchObject({ ok: true, data: { x: 1 } });
  });

  it("rotation: a token sealed with the previous secret still opens while PRESIGN_SESSION_SECRET_PREVIOUS is set, and no longer after", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PRESIGN_SESSION_SECRET", SECRET_A);
    const old = sealToken("approval", { rid: "r" }, 60_000);
    vi.stubEnv("PRESIGN_SESSION_SECRET", SECRET_B);
    vi.stubEnv("PRESIGN_SESSION_SECRET_PREVIOUS", SECRET_A);
    expect(openToken("approval", old)).toMatchObject({ ok: true });
    // New tokens are sealed with the new secret only.
    const fresh = sealToken("approval", { rid: "s" }, 60_000);
    vi.stubEnv("PRESIGN_SESSION_SECRET_PREVIOUS", "");
    expect(openToken("approval", old)).toEqual({ ok: false, reason: "BAD_SEAL" });
    expect(openToken("approval", fresh)).toMatchObject({ ok: true });
  });

  it("development keeps working without a secret", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PRESIGN_SESSION_SECRET", "");
    const t = sealToken("connect", { x: 2 }, 60_000);
    expect(openToken("connect", t)).toMatchObject({ ok: true });
  });

  it("/api/health says whether the secret is configured (a boolean, never the value)", async () => {
    vi.stubEnv("PRESIGN_SESSION_SECRET", SECRET_A);
    const on = await (await health(new Request("http://x/api/health"))).json();
    expect(on.data.presignSessionSecret).toBe(true);
    expect(JSON.stringify(on)).not.toContain(SECRET_A);
    vi.stubEnv("PRESIGN_SESSION_SECRET", "");
    const off = await (await health(new Request("http://x/api/health"))).json();
    expect(off.data.presignSessionSecret).toBe(false);
  });
});
