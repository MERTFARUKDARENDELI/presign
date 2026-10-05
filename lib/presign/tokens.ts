import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Sealed, session-bound tokens for the secure connect and pre-sign flow.
 *
 * A token is `base64url(JSON payload).base64url(HMAC-SHA256)`; the MAC covers
 * the token kind, so a token of one kind can never be replayed as another.
 * Tokens are tamper-evident, not secret: they carry no keys and no PII beyond
 * a public wallet address. Single use is enforced separately (replay.ts).
 */

export type TokenKind = "connect" | "own" | "wallet" | "analysis" | "findings" | "approval";

export type OpenFailure = "MALFORMED" | "BAD_SEAL" | "WRONG_KIND" | "EXPIRED";

interface Envelope<T> {
  k: TokenKind;
  iat: number;
  exp: number;
  d: T;
}

export type KeySource = "configured" | "derived" | "ephemeral";

const LABEL = "presign-session-key-v1";
const g = globalThis as { __presignEphemeralKey?: Buffer };

/**
 * Key: PRESIGN_SESSION_SECRET when set (≥ 32 chars). Otherwise derived with
 * HMAC from an existing server-only secret, so a deployment works without an
 * extra variable. Without either (local dev), a per-process random key.
 */
export function sessionKey(): { key: Buffer; source: KeySource } {
  const explicit = process.env.PRESIGN_SESSION_SECRET;
  if (explicit && explicit.length >= 32) return { key: createHash("sha256").update(explicit).digest(), source: "configured" };
  const base = process.env.HELIUS_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (base && base.trim()) return { key: createHmac("sha256", base.trim()).update(LABEL).digest(), source: "derived" };
  g.__presignEphemeralKey ??= randomBytes(32);
  return { key: g.__presignEphemeralKey, source: "ephemeral" };
}

const b64url = (buf: Buffer) => buf.toString("base64url");

function mac(kind: TokenKind, body: string): Buffer {
  return createHmac("sha256", sessionKey().key).update(`presign:v1:${kind}:${body}`).digest();
}

export function sealToken<T>(kind: TokenKind, data: T, ttlMs: number, now: number = Date.now()): string {
  const env: Envelope<T> = { k: kind, iat: now, exp: now + ttlMs, d: data };
  const body = b64url(Buffer.from(JSON.stringify(env), "utf8"));
  return `${body}.${b64url(mac(kind, body))}`;
}

export function openToken<T>(kind: TokenKind, token: unknown, now: number = Date.now()): { ok: true; data: T; iat: number; exp: number } | { ok: false; reason: OpenFailure } {
  if (typeof token !== "string" || token.length > 8_000) return { ok: false, reason: "MALFORMED" };
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "MALFORMED" };
  const [body, seal] = parts;
  let given: Buffer;
  try {
    given = Buffer.from(seal, "base64url");
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
  const expected = mac(kind, body);
  // The kind is inside the MAC, so a genuine token of another kind also fails here.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "BAD_SEAL" };
  let env: Envelope<T>;
  try {
    env = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Envelope<T>;
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
  if (env.k !== kind) return { ok: false, reason: "WRONG_KIND" };
  if (typeof env.exp !== "number" || now > env.exp) return { ok: false, reason: "EXPIRED" };
  return { ok: true, data: env.d, iat: env.iat, exp: env.exp };
}

export function randomId(bytes = 16): string {
  return b64url(randomBytes(bytes));
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Deterministic JSON (sorted keys) so hashes of structured findings are stable. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

// ---------- Session cookies ----------

export const SESSION_COOKIE = "presign_sid";
export const WALLET_COOKIE = "presign_wallet";
export const SESSION_TTL_S = 12 * 60 * 60;

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim()) || null;
  }
  return null;
}

/** The session id must be the server-issued random value: 22+ url-safe chars. */
export function sessionIdFrom(request: Request): string | null {
  const sid = readCookie(request, SESSION_COOKIE);
  return sid && /^[A-Za-z0-9_-]{22,64}$/.test(sid) ? sid : null;
}

export function isSecureRequest(request: Request): boolean {
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (proto) return proto === "https";
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function cookieHeader(request: Request, name: string, value: string, maxAgeS: number): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAgeS}`];
  if (isSecureRequest(request)) parts.push("Secure");
  return parts.join("; ");
}

/** Existing session id, or a new one plus the Set-Cookie header that issues it. */
export function ensureSession(request: Request): { sid: string; setCookie: string | null } {
  const existing = sessionIdFrom(request);
  if (existing) return { sid: existing, setCookie: null };
  const sid = randomId(24);
  return { sid, setCookie: cookieHeader(request, SESSION_COOKIE, sid, SESSION_TTL_S) };
}

/** The host this Presign instance is served on (used in ownership messages). */
export function presignHost(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwarded || request.headers.get("host") || "";
  if (host && /^[a-z0-9.-]+(:\d{1,5})?$/i.test(host)) return host.toLowerCase();
  try {
    return new URL(request.url).host.toLowerCase();
  } catch {
    return "presign";
  }
}
