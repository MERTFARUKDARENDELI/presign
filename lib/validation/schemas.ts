import bs58 from "bs58";
import { z } from "zod";

/**
 * Input validation for every API boundary. Nothing reaches RPC/providers/AI
 * without passing one of these schemas.
 */

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeBase58(value: string): Uint8Array | null {
  if (!BASE58.test(value)) return null;
  try {
    return bs58.decode(value);
  } catch {
    return null;
  }
}

/** Any 32-byte base58 public key (wallet, mint, token account, program, PDA). */
export function isValidPublicKey(value: string): boolean {
  if (value.length < 32 || value.length > 44) return false;
  return decodeBase58(value)?.length === 32;
}

/** Kept for backwards compatibility with the original wallet helper. */
export const isValidSolanaAddress = isValidPublicKey;

export function isValidSignature(value: string): boolean {
  if (value.length < 64 || value.length > 90) return false;
  return decodeBase58(value)?.length === 64;
}

export function isBase64(value: string): boolean {
  return value.length % 4 === 0 && BASE64.test(value);
}

export const publicKeySchema = z
  .string()
  .trim()
  .refine(isValidPublicKey, { message: "Invalid Solana address." });

export const walletAddressSchema = publicKeySchema;
export const mintAddressSchema = publicKeySchema;

export const signatureSchema = z
  .string()
  .trim()
  .refine(isValidSignature, { message: "Invalid transaction signature." });

/** Solana packets are ≤1232 bytes; base64 of that is ≤1644 chars. Allow slack for base58. */
export const MAX_TX_INPUT_LENGTH = 2_000;

export const transactionInputSchema = z.object({
  input: z.string().trim().min(1, "Transaction input is required.").max(MAX_TX_INPUT_LENGTH, "Transaction input is too large."),
  /** Wallet whose perspective is used for balance-change / outflow analysis. */
  walletAddress: publicKeySchema.optional(),
});

/** Squads proposal / multisig inspection: a link, an address, or "<multisig> #<index>". */
export const multisigInspectSchema = z.object({
  input: z.string().trim().min(1, "Paste a Squads link or address.").max(500, "Input is too long."),
  /** Member whose perspective is used (fee payer in simulation, "your vote" checks). */
  signer: publicKeySchema.optional(),
});

/** Unsigned veto / execute transaction for a Presign Guard action. */
export const guardPrepareSchema = z.object({
  kind: z.enum(["veto", "execute"]),
  action: publicKeySchema,
  signer: publicKeySchema,
});

/** Unsigned raw integer amount (u64) as a decimal string. */
export const u64StringSchema = z
  .string()
  .regex(/^\d{1,20}$/, "Amount must be an unsigned integer string.")
  .refine((v) => /^\d{1,20}$/.test(v) && BigInt(v) <= 18_446_744_073_709_551_615n, "Amount exceeds u64.");

export const cleanupActionSchema = z.enum(["BURN_AND_CLOSE", "CLOSE", "REVOKE"]);

export const cleanupPrepareSchema = z.object({
  owner: walletAddressSchema,
  tokenAccount: publicKeySchema,
  action: cleanupActionSchema,
});

export const cleanupIntentSchema = z.object({
  action: cleanupActionSchema,
  owner: walletAddressSchema,
  tokenAccount: publicKeySchema,
  mint: publicKeySchema,
  tokenProgram: publicKeySchema,
  amountRaw: u64StringSchema,
  decimals: z.number().int().min(0).max(255),
  destination: walletAddressSchema,
  cluster: z.enum(["mainnet-beta", "devnet"]),
  delegate: publicKeySchema.nullable().optional(),
});

export const submitSignedSchema = z.object({
  signedTransaction: z.string().trim().min(1).max(MAX_TX_INPUT_LENGTH).refine(isBase64, "Must be base64."),
  /** sha256 hex of the message bytes the user confirmed. */
  expectedMessageHash: z.string().regex(/^[0-9a-f]{64}$/),
  intent: cleanupIntentSchema,
});

export const signedTransactionSchema = z.object({
  signedTransaction: z.string().trim().min(1).max(MAX_TX_INPUT_LENGTH).refine(isBase64, "Must be base64."),
  expectedMessageHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** Present when the transaction was signed through Presign's pre-sign review: binds it to that approval. */
  approvalToken: z.string().min(20).max(8_000).optional(),
});

export const urlSchema = z
  .string()
  .trim()
  .max(2048)
  .transform((v, ctx) => {
    const candidate = /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`;
    try {
      const u = new URL(candidate);
      if (u.protocol !== "https:" && u.protocol !== "http:") {
        ctx.addIssue({ code: "custom", message: "Only http(s) URLs are supported." });
        return z.NEVER;
      }
      return u;
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid URL." });
      return z.NEVER;
    }
  });

export const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(4_000),
});

export const chatRequestSchema = z.object({
  messages: z.array(chatMessageSchema).min(1).max(20),
  walletAddress: walletAddressSchema.optional(),
  demo: z.boolean().optional(),
  /** Member address the /verify page inspected with (same perspective as the report). */
  signer: publicKeySchema.optional(),
});
