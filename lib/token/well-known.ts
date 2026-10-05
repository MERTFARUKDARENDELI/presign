import { USDC_MINT, USDT_MINT, WSOL_MINT } from "@/lib/solana/constants";

/**
 * Canonical mints of widely held tokens, by symbol. A different mint that
 * presents itself with one of these symbols (or names) is impersonating it —
 * the "fake USDC" pattern used in honeypot swaps and address-poisoning dust.
 * Devnet mints of the same issuer are included so the devnet deployment does
 * not flag the real test tokens. Pure data — safe for client and server.
 */
export const WELL_KNOWN_TOKENS: Record<string, string[]> = {
  USDC: [USDC_MINT, "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"],
  USDT: [USDT_MINT],
  SOL: [WSOL_MINT],
  WSOL: [WSOL_MINT],
  PYUSD: ["2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo"],
  JUP: ["JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"],
  BONK: ["DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"],
  JTO: ["jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL"],
  PYTH: ["HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3"],
  RAY: ["4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R"],
  WIF: ["EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm"],
  MSOL: ["mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So"],
  JITOSOL: ["J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"],
  BSOL: ["bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1"],
};

/** Full names that are as recognizable as the symbol. */
const WELL_KNOWN_NAMES: Record<string, string> = {
  "USD COIN": "USDC",
  "TETHER USD": "USDT",
  "WRAPPED SOL": "SOL",
  "PAYPAL USD": "PYUSD",
};

/** Cyrillic / Greek letters that render like Latin capitals ("USDС" with a Cyrillic С). */
const CONFUSABLES: Record<string, string> = {
  "А": "A", "В": "B", "С": "C", "Е": "E", "Н": "H", "І": "I", "Ј": "J", "К": "K", "М": "M", "О": "O", "Р": "P", "Ѕ": "S", "Т": "T", "Х": "X", "У": "Y",
  "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N", "Ο": "O", "Ρ": "P", "Τ": "T", "Υ": "Y", "Χ": "X",
};

const INVISIBLE = /[­​-‏⁠-⁤﻿]/g;
const fold = (s: string) => [...s.normalize("NFKC").toUpperCase()].map((ch) => CONFUSABLES[ch] ?? ch).join("").replace(INVISIBLE, "");

/** Upper-cased, compatibility-normalized, confusables folded, "$" / spaces / invisible characters removed. */
export function normalizeTokenLabel(label: string): string {
  return fold(label).replace(/[\s$]/g, "");
}

/** The well-known symbol this mint claims without being it, or null. */
export function impersonatedToken(mint: string, symbol: string | null | undefined, name: string | null | undefined): string | null {
  const sym = symbol ? normalizeTokenLabel(symbol) : "";
  const byName = name ? WELL_KNOWN_NAMES[fold(name).trim().replace(/\s+/g, " ")] : undefined;
  for (const claimed of [sym, byName]) {
    if (claimed && WELL_KNOWN_TOKENS[claimed] && !WELL_KNOWN_TOKENS[claimed].includes(mint)) return claimed;
  }
  return null;
}
