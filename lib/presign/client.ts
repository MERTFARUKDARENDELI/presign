import { ed25519 } from "@noble/curves/ed25519.js";
import { PublicKey } from "@solana/web3.js";
import { api } from "@/lib/client/api";
import type { ConnectionContext, PresignSession } from "./types";

/**
 * Browser helpers for the secure connect / pre-sign flow. Nothing here is a
 * security boundary — the server re-checks everything — and nothing secret
 * is stored: the connection token is useless without the HttpOnly session cookie.
 */

const CONNECTION_KEY = "presign.connection.v1";
const EVENTS_KEY = "presign.events.v1";

export function fetchSession(): Promise<PresignSession> {
  return api<PresignSession>("/api/presign/session", { cache: "no-store" });
}

export function clearVerifiedSession(): Promise<PresignSession> {
  return api<PresignSession>("/api/presign/session", { method: "DELETE" });
}

/** ed25519 verification of a wallet's message signature (public key only). */
export function verifyMessageSignature(bytes: Uint8Array, signature: Uint8Array, wallet: string): boolean {
  try {
    return signature.length === 64 && ed25519.verify(signature, bytes, new PublicKey(wallet).toBytes());
  } catch {
    return false;
  }
}

/**
 * In-app return path after connecting (`?next=`). Only same-origin absolute
 * paths are accepted — never a URL, never protocol-relative — so it cannot be
 * turned into an open redirect.
 */
export function safeInternalPath(next: string | null | undefined, fallback = "/dashboard"): string {
  if (!next || next.length > 200) return fallback;
  if (!/^\/(?![/\\])[A-Za-z0-9/_\-.]*$/.test(next)) return fallback;
  return next;
}

export function storeConnection(ctx: ConnectionContext): void {
  try {
    sessionStorage.setItem(CONNECTION_KEY, JSON.stringify({ token: ctx.connectionToken, request: ctx.request, domain: ctx.domain }));
  } catch {
    // storage unavailable: the flow still works, the target context is just not carried over
  }
}

export interface StoredConnection {
  token: string;
  request: ConnectionContext["request"];
  domain: ConnectionContext["domain"];
}

export function loadConnection(): StoredConnection | null {
  try {
    const raw = sessionStorage.getItem(CONNECTION_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as StoredConnection;
    return Date.parse(c.request.expiresAt) > Date.now() ? c : null;
  } catch {
    return null;
  }
}

export interface PresignEvent {
  at: string;
  kind: "CONNECT_CHECK" | "WALLET_VERIFIED" | "REQUEST_ANALYZED" | "USER_CANCELLED" | "USER_SIGNED" | "USER_OVERRIDE" | "SIGN_BLOCKED" | "SUBMITTED";
  detail: string;
}

/** Per-tab log of this session's security decisions, shown on the wallet dashboard. */
export function recordEvent(kind: PresignEvent["kind"], detail: string): void {
  try {
    const list = loadEvents();
    list.unshift({ at: new Date().toISOString(), kind, detail: detail.slice(0, 200) });
    sessionStorage.setItem(EVENTS_KEY, JSON.stringify(list.slice(0, 25)));
    window.dispatchEvent(new Event("presign-events"));
  } catch {
    // ignore
  }
}

export function loadEvents(): PresignEvent[] {
  try {
    return JSON.parse(sessionStorage.getItem(EVENTS_KEY) ?? "[]") as PresignEvent[];
  } catch {
    return [];
  }
}
