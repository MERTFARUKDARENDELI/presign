import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import {
  chatRequestSchema,
  cleanupPrepareSchema,
  isValidPublicKey,
  isValidSignature,
  transactionInputSchema,
  u64StringSchema,
  urlSchema,
} from "@/lib/validation/schemas";
import { USDC_MINT } from "@/lib/solana/constants";
import { WALLET } from "../helpers/fixtures";

describe("address validation", () => {
  it("accepts real 32-byte base58 keys", () => {
    expect(isValidPublicKey(USDC_MINT)).toBe(true);
    expect(isValidPublicKey(WALLET.toBase58())).toBe(true);
    expect(isValidPublicKey("11111111111111111111111111111111")).toBe(true);
  });

  it("rejects invalid wallets and mints", () => {
    expect(isValidPublicKey("")).toBe(false);
    expect(isValidPublicKey("0OIl" + "1".repeat(40))).toBe(false); // non-base58 chars
    expect(isValidPublicKey("1".repeat(45))).toBe(false);
    expect(isValidPublicKey("abc")).toBe(false);
    // base58 of the right length but decodes to wrong byte count
    expect(isValidPublicKey("z".repeat(44))).toBe(false);
    expect(isValidPublicKey("<script>alert(1)</script>")).toBe(false);
  });

  it("validates signatures as 64-byte base58", () => {
    const sig = bs58.encode(new Uint8Array(64).fill(7));
    expect(isValidSignature(sig)).toBe(true);
    expect(isValidSignature(USDC_MINT)).toBe(false);
    expect(isValidSignature("not-a-signature")).toBe(false);
  });
});

describe("schemas", () => {
  it("rejects oversized transaction input", () => {
    expect(transactionInputSchema.safeParse({ input: "A".repeat(5000) }).success).toBe(false);
    expect(transactionInputSchema.safeParse({ input: "" }).success).toBe(false);
  });

  it("enforces u64 bounds on numeric strings", () => {
    expect(u64StringSchema.safeParse("18446744073709551615").success).toBe(true);
    expect(u64StringSchema.safeParse("18446744073709551616").success).toBe(false);
    expect(u64StringSchema.safeParse("-1").success).toBe(false);
    expect(u64StringSchema.safeParse("1.5").success).toBe(false);
  });

  it("only accepts http(s) urls", () => {
    expect(urlSchema.safeParse("javascript:alert(1)").success).toBe(false);
    expect(urlSchema.safeParse("example.com").success).toBe(true);
    expect(urlSchema.safeParse("ftp://example.com").success).toBe(false);
  });

  it("validates cleanup requests", () => {
    expect(cleanupPrepareSchema.safeParse({ owner: WALLET.toBase58(), tokenAccount: USDC_MINT, action: "BURN_AND_CLOSE" }).success).toBe(true);
    expect(cleanupPrepareSchema.safeParse({ owner: WALLET.toBase58(), tokenAccount: USDC_MINT, action: "DRAIN" }).success).toBe(false);
    expect(cleanupPrepareSchema.safeParse({ owner: "bad", tokenAccount: USDC_MINT, action: "CLOSE" }).success).toBe(false);
  });

  it("bounds AI chat input", () => {
    expect(chatRequestSchema.safeParse({ messages: [] }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ messages: [{ role: "user", content: "x".repeat(5000) }] }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ messages: [{ role: "system", content: "hi" }] }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ messages: [{ role: "user", content: "Cüzdanımda riskli ne var?" }] }).success).toBe(true);
  });
});
