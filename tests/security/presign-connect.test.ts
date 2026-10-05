import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { beforeEach, describe, expect, it } from "vitest";
import { POST as connectRoute } from "@/app/api/presign/connect/route";
import { POST as verifyRoute } from "@/app/api/presign/connect/verify/route";
import { POST as nonceRoute } from "@/app/api/presign/nonce/route";
import { GET as sessionRoute } from "@/app/api/presign/session/route";
import { AppError } from "@/lib/api/errors";
import { resetRateLimits } from "@/lib/api/rate-limit";
import { safeInternalPath } from "@/lib/presign/client";
import { createConnection, openConnection, validateReturnUrl } from "@/lib/presign/connection";
import { analyzeDomain } from "@/lib/presign/domain";
import { createOwnershipChallenge, verifiedWalletFrom, verifyOwnership } from "@/lib/presign/ownership";
import { resetReplayRegistry } from "@/lib/presign/replay";
import { sealToken } from "@/lib/presign/tokens";
import { ATTACKER, keypair, WALLET } from "../helpers/fixtures";

const W = WALLET.toBase58();
const OWNER = keypair(1); // === WALLET
const OTHER = keypair(2); // === ATTACKER
const SID = "session-aaaaaaaaaaaaaaaaaaaaaaaa";
const HOST = "presign.test";

function req(headers: Record<string, string> = {}, path = "/api/presign/connect") {
  return new Request(`https://${HOST}${path}`, { method: "POST", headers: { host: HOST, origin: `https://${HOST}`, "x-forwarded-proto": "https", ...headers } });
}
const reason = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as AppError).details?.reason ?? (e as AppError).code;
  }
  return null;
};
/** The same for an async call (ownership verification awaits the single-use store). */
const reasonOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as AppError).details?.reason ?? (e as AppError).code;
  }
  return null;
};

beforeEach(() => {
  resetReplayRegistry();
  resetRateLimits();
});

describe("domain analysis", () => {
  it("unknown domain with no pattern is UNKNOWN, never SAFE", () => {
    const d = analyzeDomain("https://some-new-dapp.io");
    expect(d.status).toBe("UNKNOWN");
    expect(d.score).toBeNull();
    expect(d.reputation).toBe("NOT_CONFIGURED");
  });

  it("a known ecosystem domain is only 'recognized' (LOW), not SAFE", () => {
    expect(analyzeDomain("https://jup.ag/swap").status).toBe("LOW");
  });

  it("flags look-alikes, punycode, raw IPs and non-https", () => {
    expect(analyzeDomain("https://phant0m.app").status).toBe("HIGH");
    expect(analyzeDomain("https://xn--phntom-3ya.app").findings.map((f) => f.code)).toContain("DOMAIN_PUNYCODE");
    expect(analyzeDomain("https://203.0.113.9").findings.map((f) => f.code)).toContain("DOMAIN_IP_HOST");
    expect(analyzeDomain("http://claim-airdrop.xyz").findings.map((f) => f.code)).toContain("DOMAIN_NOT_HTTPS");
    expect(analyzeDomain("http://localhost:3000").findings.map((f) => f.code)).toEqual(["DOMAIN_LOCAL_DEVELOPMENT"]);
  });

  it("malformed or missing origins are invalid", () => {
    for (const bad of ["", "not a url", "javascript:alert(1)", "example.com", "https://user:pass@", "https://exa mple.com"]) {
      const d = analyzeDomain(bad);
      expect(d.valid, bad).toBe(false);
      expect(d.status).not.toBe("SAFE");
    }
  });
});

describe("pre-connect context", () => {
  it("valid session + Presign origin; no target is NOT_PROVIDED, not safe", () => {
    const ctx = createConnection({}, req(), SID);
    const byId = Object.fromEntries(ctx.checks.map((c) => [c.id, c.status]));
    expect(byId["presign-origin"]).toBe("PASS");
    expect(byId.https).toBe("PASS");
    expect(byId["target-domain"]).toBe("NOT_PROVIDED");
    expect(ctx.allChecksPassed).toBe(false);
    expect(ctx.request.targetOrigin).toBeUndefined();
  });

  it("a target dApp is normalized and analyzed; the return URL must stay on its origin", () => {
    const ctx = createConnection({ target: "https://app.example.org/path?x=1", name: "Example‮ppa", returnUrl: "https://app.example.org/callback" }, req(), SID);
    expect(ctx.request.targetOrigin).toBe("https://app.example.org");
    expect(ctx.request.targetName).toBe("Exampleppa");
    expect(ctx.request.returnUrl).toBe("https://app.example.org/callback");
    expect(ctx.domain?.status).toBe("UNKNOWN");
  });

  it("suspicious target domain is a failed check", () => {
    const ctx = createConnection({ target: "https://phantom-wallet-claim.xyz" }, req(), SID);
    expect(ctx.checks.find((c) => c.id === "target-domain")?.status).toBe("FAIL");
  });

  it("malicious redirects are refused (other origin, scheme tricks, credentials, no target)", () => {
    expect(() => validateReturnUrl("https://evil.example/cb", "https://app.example.org")).toThrow(AppError);
    expect(() => validateReturnUrl("javascript:alert(1)", "https://app.example.org")).toThrow(AppError);
    expect(() => validateReturnUrl("https://app.example.org@evil.example/", "https://app.example.org")).toThrow(AppError);
    expect(() => validateReturnUrl("//evil.example", "https://app.example.org")).toThrow(AppError);
    expect(() => createConnection({ returnUrl: "https://app.example.org/cb" }, req(), SID)).toThrow(AppError);
    expect(() => createConnection({ target: "not a url" }, req(), SID)).toThrow(AppError);
  });

  it("a request from another site is blocked", () => {
    expect(reason(() => createConnection({}, req({ origin: "https://evil.example" }), SID))).toBe("SECURITY_BLOCK");
  });

  it("connection tokens: session-bound, expiring, tamper-evident", () => {
    const ctx = createConnection({ target: "https://app.example.org" }, req(), SID);
    expect(openConnection(ctx.connectionToken, SID).targetOrigin).toBe("https://app.example.org");
    expect(reason(() => openConnection(ctx.connectionToken, "session-bbbbbbbbbbbbbbbbbbbbbbbb"))).toBe("SESSION_MISMATCH");
    expect(reason(() => openConnection(ctx.connectionToken, null))).toBe("SESSION_MISMATCH");
    expect(reason(() => openConnection(ctx.connectionToken, SID, Date.now() + 11 * 60_000))).toBe("REQUEST_EXPIRED");
    const [body, mac] = ctx.connectionToken.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), d: { r: { ...ctx.request, targetOrigin: "https://evil.example" }, sid: SID } })).toString("base64url");
    expect(reason(() => openConnection(`${forged}.${mac}`, SID))).toBe("REQUEST_INVALID");
    // A genuine token of another kind cannot be replayed as a connection.
    expect(reason(() => openConnection(sealToken("analysis", { r: ctx.request, sid: SID }, 60_000), SID))).toBe("REQUEST_INVALID");
  });

  it("in-app return paths cannot become open redirects", () => {
    expect(safeInternalPath("/demo/sign")).toBe("/demo/sign");
    for (const bad of ["//evil.com", "https://evil.com", "/\\evil.com", "javascript:alert(1)", "/a?x=https://evil", null]) expect(safeInternalPath(bad)).toBe("/dashboard");
  });
});

describe("wallet ownership verification", () => {
  const signWith = (kp: typeof OWNER, message: string) => bs58.encode(ed25519.sign(new TextEncoder().encode(message), kp.secretKey.slice(0, 32)));

  it("valid nonce + matching signature verifies, then the nonce is spent", async () => {
    const ch = createOwnershipChallenge(W, HOST, SID);
    expect(ch.message).toContain("This signature proves wallet control.");
    expect(ch.message).toContain("It does not authorize a transfer.");
    expect(ch.message).toContain(`Wallet: ${W}`);
    const input = { walletAddress: W, message: ch.message, signature: signWith(OWNER, ch.message), nonceToken: ch.nonceToken };
    expect((await verifyOwnership(input, SID)).wallet).toBe(W);
    expect(await reasonOf(verifyOwnership(input, SID))).toBe("NONCE_REPLAYED");
  });

  it("invalid, expired and other-session nonces are refused", async () => {
    const ch = createOwnershipChallenge(W, HOST, SID);
    const input = { walletAddress: W, message: ch.message, signature: signWith(OWNER, ch.message), nonceToken: ch.nonceToken };
    expect(await reasonOf(verifyOwnership({ ...input, nonceToken: `${ch.nonceToken}x` }, SID))).toBe("NONCE_INVALID");
    expect(await reasonOf(verifyOwnership(input, SID, Date.now() + 6 * 60_000))).toBe("NONCE_EXPIRED");
    expect(await reasonOf(verifyOwnership(input, "session-bbbbbbbbbbbbbbbbbbbbbbbb"))).toBe("SESSION_MISMATCH");
  });

  it("a signature by another wallet, or for another message, is refused", async () => {
    const ch = createOwnershipChallenge(W, HOST, SID);
    expect(await reasonOf(verifyOwnership({ walletAddress: W, message: ch.message, signature: signWith(OTHER, ch.message), nonceToken: ch.nonceToken }, SID))).toBe("INVALID_SIGNATURE");
    const changed = ch.message.replace("It does not authorize a transfer.", "It authorizes a transfer.");
    expect(await reasonOf(verifyOwnership({ walletAddress: W, message: changed, signature: signWith(OWNER, changed), nonceToken: ch.nonceToken }, SID))).toBe("MESSAGE_MISMATCH");
    expect(await reasonOf(verifyOwnership({ walletAddress: ATTACKER.toBase58(), message: ch.message, signature: signWith(OTHER, ch.message), nonceToken: ch.nonceToken }, SID))).toBe("WALLET_MISMATCH");
  });

  it("the verified-wallet seal is bound to its session", () => {
    const token = sealToken("wallet", { w: W, sid: SID, vat: new Date().toISOString() }, 60_000);
    expect(verifiedWalletFrom(token, SID)?.wallet).toBe(W);
    expect(verifiedWalletFrom(token, "session-bbbbbbbbbbbbbbbbbbbbbbbb")).toBeNull();
    expect(verifiedWalletFrom(`${token}x`, SID)).toBeNull();
  });
});

describe("routes", () => {
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    new Request(`https://${HOST}${path}`, { method: "POST", headers: { host: HOST, origin: `https://${HOST}`, "x-forwarded-proto": "https", "content-type": "application/json", "x-forwarded-for": `10.9.0.${Math.floor(Math.random() * 250)}`, ...headers }, body: JSON.stringify(body) });

  it("connect issues an HttpOnly, SameSite=Strict, Secure session cookie", async () => {
    const res = await connectRoute(post("/api/presign/connect", {}));
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^presign_sid=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Secure/);
  });

  it("connect refuses a cross-site caller and an open redirect", async () => {
    expect((await connectRoute(post("/api/presign/connect", {}, { origin: "https://evil.example" }))).status).toBe(409);
    expect((await connectRoute(post("/api/presign/connect", { target: "https://app.example.org", returnUrl: "https://evil.example/cb" }))).status).toBe(400);
  });

  it("full ownership round trip over HTTP; replay refused", async () => {
    const n = await nonceRoute(post("/api/presign/nonce", { walletAddress: W }));
    const sid = (n.headers.get("set-cookie") ?? "").match(/presign_sid=([^;]+)/)![1];
    const ch = (await n.json()).data;
    const body = { walletAddress: W, message: ch.message, signature: bs58.encode(ed25519.sign(new TextEncoder().encode(ch.message), OWNER.secretKey.slice(0, 32))), nonceToken: ch.nonceToken };
    const ok = await verifyRoute(post("/api/presign/connect/verify", body, { cookie: `presign_sid=${sid}` }));
    expect(ok.status).toBe(200);
    const walletCookie = (ok.headers.get("set-cookie") ?? "").match(/presign_wallet=([^;]+)/)![1];
    const s = await sessionRoute(new Request(`https://${HOST}/api/presign/session`, { headers: { cookie: `presign_sid=${sid}; presign_wallet=${walletCookie}`, "x-forwarded-for": "10.9.1.1" } }));
    expect((await s.json()).data.verified.wallet).toBe(W);
    const replay = await verifyRoute(post("/api/presign/connect/verify", body, { cookie: `presign_sid=${sid}` }));
    expect((await replay.json()).error.details.reason).toBe("NONCE_REPLAYED");
  });

  it("verification without the session cookie is refused", async () => {
    const ch = createOwnershipChallenge(W, HOST, SID);
    const res = await verifyRoute(post("/api/presign/connect/verify", { walletAddress: W, message: ch.message, signature: bs58.encode(ed25519.sign(new TextEncoder().encode(ch.message), OWNER.secretKey.slice(0, 32))), nonceToken: ch.nonceToken }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.details.reason).toBe("SESSION_MISMATCH");
  });
});
