import "server-only";
import { AppError } from "@/lib/api/errors";
import { analyzeDomain, isLoopbackHost } from "./domain";
import { isSecureRequest, openToken, presignHost, randomId, sealToken } from "./tokens";
import type { ConnectCheck, ConnectionContext, PresignConnectionRequest } from "./types";

/**
 * Pre-connect stage: builds and validates the context a wallet connection is
 * made in, BEFORE any wallet is opened.
 *
 * A normal website cannot see which third-party site a user intends to
 * connect to. The target dApp therefore only exists when it is supplied by an
 * integration (SDK, extension/provider, deep link, controlled demo) — when it
 * is not, it is reported as NOT_PROVIDED, never as safe.
 */

export const CONNECTION_TTL_MS = 10 * 60_000;
const MAX_NAME = 64;
// Control, zero-width and bidi characters never belong in a display name.
const UNSAFE_NAME = /[\u0000-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

export interface ConnectionInput {
  target?: string;
  name?: string;
  returnUrl?: string;
  walletType?: string;
}

interface SealedConnection {
  r: PresignConnectionRequest;
  sid: string;
}

export function cleanName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const cleaned = name.replace(UNSAFE_NAME, "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  return cleaned || undefined;
}

/**
 * The return URL is the integration's expected callback: it must be an https
 * URL on exactly the target's origin. Anything else (another host, another
 * scheme, credentials in the URL, protocol-relative tricks) is an open
 * redirect and is rejected.
 */
export function validateReturnUrl(returnUrl: string, targetOrigin: string): string {
  let url: URL;
  try {
    url = new URL(returnUrl);
  } catch {
    throw new AppError("INVALID_INPUT", "The return address is not a valid URL.");
  }
  if (url.username || url.password) throw new AppError("INVALID_INPUT", "The return address contains credentials; refusing to redirect.");
  if (url.origin !== targetOrigin) throw new AppError("INVALID_INPUT", "The return address is not on the application's own origin; refusing an open redirect.");
  if (url.protocol !== "https:" && !isLoopbackHost(url.hostname)) throw new AppError("INVALID_INPUT", "The return address must use https.");
  return url.toString();
}

function check(id: ConnectCheck["id"], label: string, status: ConnectCheck["status"], detail: string): ConnectCheck {
  return { id, label, status, detail };
}

export function createConnection(input: ConnectionInput, request: Request, sid: string, now: number = Date.now()): ConnectionContext {
  const checks: ConnectCheck[] = [];
  const host = presignHost(request);

  // The API is called by Presign's own page: a cross-site caller would send another Origin.
  const origin = request.headers.get("origin");
  let originOk = false;
  try {
    originOk = origin !== null && new URL(origin).host.toLowerCase() === host;
  } catch {
    originOk = false;
  }
  checks.push(
    originOk
      ? check("presign-origin", "Presign origin verified", "PASS", `Request comes from Presign's own page (${host}).`)
      : check("presign-origin", "Presign origin verified", origin === null ? "UNKNOWN" : "FAIL", origin === null ? "The browser did not send an Origin header; the caller cannot be confirmed." : "Request came from another site."),
  );
  if (origin !== null && !originOk) throw new AppError("SECURITY_BLOCK", "This connection request did not come from Presign's own page.");

  const secure = isSecureRequest(request);
  const localDev = isLoopbackHost(host.replace(/:\d+$/, ""));
  checks.push(
    secure
      ? check("https", "Secure HTTPS connection", "PASS", "Presign is served over HTTPS.")
      : check("https", "Secure HTTPS connection", localDev ? "WARN" : "FAIL", localDev ? "Local development over plain http." : "Presign is not being served over HTTPS."),
  );
  checks.push(check("session", "Session valid", "PASS", "A fresh, server-issued session is bound to this request."));

  const targetName = cleanName(input.name);
  let domain = null;
  let targetOrigin: string | undefined;
  let targetHostname: string | undefined;
  let returnUrl: string | undefined;

  if (input.target) {
    domain = analyzeDomain(input.target, new Date(now), { name: targetName });
    if (!domain.valid || !domain.origin) throw new AppError("INVALID_INPUT", domain.reasons[0] ?? "The application address is invalid.");
    targetOrigin = domain.origin;
    targetHostname = new URL(domain.origin).hostname;
    if (input.returnUrl) returnUrl = validateReturnUrl(input.returnUrl, targetOrigin);
  } else if (input.returnUrl) {
    throw new AppError("INVALID_INPUT", "A return address needs the application it belongs to.");
  }
  checks.push(check("request-structure", "Request structure valid", "PASS", returnUrl ? "Return address is on the application's own origin." : "No redirect requested."));

  if (!domain) {
    checks.push(check("target-domain", "No obvious phishing indicators", "NOT_PROVIDED", "Presign cannot verify a target application because no external dApp context was supplied."));
  } else {
    const st = domain.status;
    const status: ConnectCheck["status"] = st === "HIGH" || st === "CRITICAL" ? "FAIL" : st === "MEDIUM" ? "WARN" : st === "UNKNOWN" ? "UNKNOWN" : st === "LOW" && domain.findings.length ? "WARN" : "PASS";
    checks.push(check("target-domain", "No obvious phishing indicators", status, domain.reasons[0] ?? ""));
  }

  const request2: PresignConnectionRequest = {
    requestId: randomId(16),
    ...(targetOrigin ? { targetOrigin, targetHostname } : {}),
    ...(targetName ? { targetName } : {}),
    ...(input.walletType ? { walletType: input.walletType.slice(0, 32) } : {}),
    ...(returnUrl ? { returnUrl } : {}),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CONNECTION_TTL_MS).toISOString(),
    nonce: randomId(16),
  };
  checks.push(check("request-expiry", "Request not expired", "PASS", `Valid until ${request2.expiresAt}.`));

  const connectionToken = sealToken<SealedConnection>("connect", { r: request2, sid }, CONNECTION_TTL_MS, now);
  const allChecksPassed = checks.every((c) => c.status === "PASS");
  return { request: request2, connectionToken, checks, domain, allChecksPassed };
}

/** Reopens a connection token: valid seal, not expired, same session. */
export function openConnection(token: string, sid: string | null, now: number = Date.now()): PresignConnectionRequest {
  const opened = openToken<SealedConnection>("connect", token, now);
  if (!opened.ok) throw new AppError(opened.reason === "EXPIRED" ? "SECURITY_BLOCK" : "INVALID_INPUT", opened.reason === "EXPIRED" ? "This connection request has expired. Start again from the application." : "The connection request is invalid or was modified.", { reason: opened.reason === "EXPIRED" ? "REQUEST_EXPIRED" : "REQUEST_INVALID" });
  if (!sid || opened.data.sid !== sid) throw new AppError("SECURITY_BLOCK", "This connection request belongs to another browser session.", { reason: "SESSION_MISMATCH" });
  return opened.data.r;
}
