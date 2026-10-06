import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "@/lib/api/errors";
import { canonicalOrigin, forwardedHeadersTrusted } from "@/lib/api/trusted-proxy";

/**
 * Sealed, session-bound tokens for the secure connect and pre-sign flow.
 *
 * A token is `base64url(JSON payload).base64url(HMAC-SHA256)`; the MAC covers
 * the token kind, so a token of one kind can never be replayed as another.
 * Tokens are tamper-evident, not secret: they carry no keys and no PII beyond
 * a public wallet address. Single use is enforced separately (replay.ts).
 */

export type TokenKind = "connect" | "own" | "wallet" | "analysis" | "findings" | "approval" | "prepared";

export type OpenFailure = "MALFORMED" | "BAD_SEAL" | "WRONG_KIND" | "EXPIRED";

interface Envelope<T> {
  k: TokenKind;
  iat: number;
  exp: number;
  d: T;
}

export type KeySource = "configured" | "derived" | "ephemeral";

const LABEL = "presign-session-key-v1";
const MIN_SECRET = 32;
const g = globalThis as { __presignEphemeralKey?: Buffer };

const fromSecret = (secret: string) => createHash("sha256").update(secret).digest();

export function sessionSecretConfigured(): boolean {
  return (process.env.PRESIGN_SESSION_SECRET ?? "").length >= MIN_SECRET;
}

/**
 * Key: PRESIGN_SESSION_SECRET (≥ 32 characters). Production requires it — a
 * key derived from a third-party API key (Helius, Anthropic) would tie every
 * session to that key's exposure and rotation — so without it the secure
 * connect and pre-sign review refuse to run instead of guessing. Development
 * falls back to a key derived from a server-only secret, or a per-process key.
 */
export function sessionKey(): { key: Buffer; source: KeySource } {
  if (sessionSecretConfigured()) return { key: fromSecret(process.env.PRESIGN_SESSION_SECRET!), source: "configured" };
  if (process.env.NODE_ENV === "production") {
    throw new AppError("NOT_CONFIGURED", "Secure connect and the pre-sign review are not configured on this server (PRESIGN_SESSION_SECRET, at least 32 characters, is missing). Nothing was signed.");
  }
  const base = process.env.HELIUS_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (base && base.trim()) return { key: createHmac("sha256", base.trim()).update(LABEL).digest(), source: "derived" };
  g.__presignEphemeralKey ??= randomBytes(32);
  return { key: g.__presignEphemeralKey, source: "ephemeral" };
}

/** Keys a token may be sealed with: the current one, then PRESIGN_SESSION_SECRET_PREVIOUS during a rotation. */
function openingKeys(): Buffer[] {
  const previous = process.env.PRESIGN_SESSION_SECRET_PREVIOUS ?? "";
  return [sessionKey().key, ...(previous.length >= MIN_SECRET ? [fromSecret(previous)] : [])];
}

const b64url = (buf: Buffer) => buf.toString("base64url");

function mac(kind: TokenKind, body: string, key: Buffer = sessionKey().key): Buffer {
  return createHmac("sha256", key).update(`presign:v1:${kind}:${body}`).digest();
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
  // The kind is inside the MAC, so a genuine token of another kind also fails here.
  const sealedByUs = openingKeys().some((key) => {
    const expected = mac(kind, body, key);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!sealedByUs) return { ok: false, reason: "BAD_SEAL" };
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

const SESSION_ID = /^([A-Za-z0-9_-]{32}).([A-Za-z0-9_-]{22})$/;

function sessionMac(random: string, key: Buffer): Buffer {
  return createHmac("sha256", key).update(`presign:v1:sid:${random}`).digest().subarray(0, 16);
}

/** A new session id: 24 random bytes plus their MAC, so only ids this server issued are accepted. */
export function newSessionId(): string {
  const random = randomId(24);
  return `${random}.${b64url(sessionMac(random, sessionKey().key))}`;
}

/**
 * The session id from the cookie, only if this server issued it (MAC checked,
 * also with the previous secret during a rotation). A value made up by anyone
 * else — a forged or injected cookie — is no session. Without a configured key
 * there is no session either.
 */
export function sessionIdFrom(request: Request): string | null {
  const sid = readCookie(request, SESSION_COOKIE);
  const m = sid ? SESSION_ID.exec(sid) : null;
  if (!m) return null;
  try {
    const given = Buffer.from(m[2], "base64url");
    return openingKeys().some((key) => {
      const expected = sessionMac(m[1], key);
      return given.length === expected.length && timingSafeEqual(given, expected);
    })
      ? sid
      : null;
  } catch {
    return null;
  }
}

export function isSecureRequest(request: Request): boolean {
  const canonical = canonicalOrigin();
  if (canonical) return canonical.protocol === "https:";
  // X-Forwarded-Proto only from a trusted proxy (lib/api/trusted-proxy.ts).
  const proto = forwardedHeadersTrusted() ? request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() : undefined;
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
  const sid = newSessionId();
  return { sid, setCookie: cookieHeader(request, SESSION_COOKIE, sid, SESSION_TTL_S) };
}

/**
 * The host this Presign instance is served on (used in ownership messages):
 * PRESIGN_CANONICAL_ORIGIN when set, else X-Forwarded-Host from a trusted
 * proxy, else the Host header.
 */
export function presignHost(request: Request): string {
  const canonical = canonicalOrigin();
  if (canonical) return canonical.host;
  const forwarded = forwardedHeadersTrusted() ? request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() : undefined;
  const host = forwarded || request.headers.get("host") || "";
  if (host && /^[a-z0-9.-]+(:\d{1,5})?$/i.test(host)) return host.toLowerCase();
  try {
    return new URL(request.url).host.toLowerCase();
  } catch {
    return "presign";
  }
}
