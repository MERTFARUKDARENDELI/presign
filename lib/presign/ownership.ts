import "server-only";
import { ed25519 } from "@noble/curves/ed25519.js";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { AppError } from "@/lib/api/errors";
import { consumeOnce } from "./replay";
import { cookieHeader, openToken, randomId, sealToken, SESSION_TTL_S, WALLET_COOKIE } from "./tokens";
import type { OwnershipChallenge, VerifiedWallet } from "./types";

/**
 * Wallet ownership verification: server nonce → clear message → the wallet
 * signs the message → the server verifies the ed25519 signature → the nonce
 * is spent. The message says in plain words that it proves control and
 * authorizes nothing; it is never a transaction.
 */

export const OWNERSHIP_TTL_MS = 5 * 60_000;
export const VERIFIED_TTL_MS = SESSION_TTL_S * 1000;

interface SealedChallenge {
  w: string;
  n: string;
  dom: string;
  sid: string;
  iss: string;
  exp: string;
}

interface SealedWallet {
  w: string;
  sid: string;
  vat: string;
}

export function ownershipMessage(p: { domain: string; wallet: string; nonce: string; issuedAt: string; expiresAt: string }): string {
  return [
    "PRESIGN WALLET VERIFICATION",
    "",
    `Domain: ${p.domain}`,
    `Wallet: ${p.wallet}`,
    `Nonce: ${p.nonce}`,
    `Issued: ${p.issuedAt}`,
    `Expires: ${p.expiresAt}`,
    "",
    "This signature proves wallet control.",
    "It does not authorize a transfer.",
  ].join("\n");
}

export function createOwnershipChallenge(wallet: string, domain: string, sid: string, now: number = Date.now()): OwnershipChallenge {
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + OWNERSHIP_TTL_MS).toISOString();
  const nonce = randomId(16);
  const sealed: SealedChallenge = { w: wallet, n: nonce, dom: domain, sid, iss: issuedAt, exp: expiresAt };
  return {
    message: ownershipMessage({ domain, wallet, nonce, issuedAt, expiresAt }),
    nonceToken: sealToken("own", sealed, OWNERSHIP_TTL_MS, now),
    issuedAt,
    expiresAt,
  };
}

function decodeSignature(signature: string): Uint8Array {
  const s = signature.trim();
  try {
    const b = bs58.decode(s);
    if (b.length === 64) return b;
  } catch {
    // try base64
  }
  try {
    const b = Uint8Array.from(Buffer.from(s, "base64"));
    if (b.length === 64) return b;
  } catch {
    // fall through
  }
  throw new AppError("INVALID_INPUT", "The wallet signature is malformed.", { reason: "INVALID_SIGNATURE" });
}

/**
 * Verifies an ownership signature. Every failure is explicit: expired or
 * forged nonce, other session, other wallet, changed message, replay, or a
 * signature that does not verify for this wallet.
 */
export function verifyOwnership(
  input: { walletAddress: string; message: string; signature: string; nonceToken: string },
  sid: string | null,
  now: number = Date.now(),
): VerifiedWallet {
  const opened = openToken<SealedChallenge>("own", input.nonceToken, now);
  if (!opened.ok) {
    throw new AppError("SECURITY_BLOCK", opened.reason === "EXPIRED" ? "The verification request expired. Request a new one." : "The verification nonce is invalid.", { reason: opened.reason === "EXPIRED" ? "NONCE_EXPIRED" : "NONCE_INVALID" });
  }
  const c = opened.data;
  if (!sid || c.sid !== sid) throw new AppError("SECURITY_BLOCK", "This verification belongs to another browser session.", { reason: "SESSION_MISMATCH" });
  if (c.w !== input.walletAddress) throw new AppError("SECURITY_BLOCK", "The verification was issued for another wallet.", { reason: "WALLET_MISMATCH" });
  const expected = ownershipMessage({ domain: c.dom, wallet: c.w, nonce: c.n, issuedAt: c.iss, expiresAt: c.exp });
  if (input.message !== expected) throw new AppError("SECURITY_BLOCK", "The signed message is not the one Presign issued.", { reason: "MESSAGE_MISMATCH" });

  let valid = false;
  try {
    valid = ed25519.verify(decodeSignature(input.signature), new TextEncoder().encode(expected), new PublicKey(c.w).toBytes());
  } catch (error) {
    if (error instanceof AppError) throw error;
    valid = false;
  }
  if (!valid) throw new AppError("SECURITY_BLOCK", "The signature does not match this wallet.", { reason: "INVALID_SIGNATURE" });
  if (!consumeOnce("own", c.n, opened.exp, now)) throw new AppError("SECURITY_BLOCK", "This verification was already used.", { reason: "NONCE_REPLAYED" });

  return { wallet: c.w, verifiedAt: new Date(now).toISOString(), expiresAt: new Date(now + VERIFIED_TTL_MS).toISOString() };
}

export function walletCookie(request: Request, verified: VerifiedWallet, sid: string, now: number = Date.now()): string {
  const token = sealToken<SealedWallet>("wallet", { w: verified.wallet, sid, vat: verified.verifiedAt }, VERIFIED_TTL_MS, now);
  return cookieHeader(request, WALLET_COOKIE, token, SESSION_TTL_S);
}

/** The wallet verified in this browser session, if any (seal valid, not expired, same session). */
export function verifiedWalletFrom(token: string | null, sid: string | null, now: number = Date.now()): VerifiedWallet | null {
  if (!token || !sid) return null;
  const opened = openToken<SealedWallet>("wallet", token, now);
  if (!opened.ok || opened.data.sid !== sid) return null;
  return { wallet: opened.data.w, verifiedAt: opened.data.vat, expiresAt: new Date(opened.exp).toISOString() };
}
