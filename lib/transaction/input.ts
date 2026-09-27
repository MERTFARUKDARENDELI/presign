import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { isBase64, isValidSignature } from "@/lib/validation/schemas";

/**
 * Classifies user-provided transaction input. Accepts a transaction signature
 * or a fully serialized (legacy, v0 or v1) transaction in base64/base58.
 * Anything else is rejected — nothing is guessed.
 */

export type ParsedTxInput =
  | { kind: "signature"; signature: string }
  | { kind: "serialized-base64" | "serialized-base58"; bytes: Uint8Array; transaction: VersionedTransaction }
  | { kind: "invalid"; reason: string };

export const MAX_TX_BYTES = 1232;

function tryDeserialize(bytes: Uint8Array): VersionedTransaction | null {
  if (bytes.length < 65 || bytes.length > MAX_TX_BYTES) return null;
  try {
    const tx = VersionedTransaction.deserialize(bytes);
    // Sanity: must have instructions and a fee payer.
    if (tx.message.staticAccountKeys.length === 0) return null;
    if (tx.message.header.numRequiredSignatures < 1) return null;
    if (tx.signatures.length !== tx.message.header.numRequiredSignatures) return null;
    return tx;
  } catch {
    return null;
  }
}

function base64ToBytes(value: string): Uint8Array {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function parseTransactionInput(raw: string): ParsedTxInput {
  const input = raw.trim();
  if (!input) return { kind: "invalid", reason: "Empty input." };

  if (isValidSignature(input)) return { kind: "signature", signature: input };

  if (isBase64(input)) {
    try {
      const bytes = base64ToBytes(input);
      const tx = tryDeserialize(bytes);
      if (tx) return { kind: "serialized-base64", bytes, transaction: tx };
    } catch {
      // fall through
    }
  }

  if (/^[1-9A-HJ-NP-Za-km-z]+$/.test(input)) {
    try {
      const bytes = bs58.decode(input);
      const tx = tryDeserialize(bytes);
      if (tx) return { kind: "serialized-base58", bytes, transaction: tx };
    } catch {
      // fall through
    }
  }

  return {
    kind: "invalid",
    reason: "Input is neither a transaction signature nor a valid serialized Solana transaction (legacy, v0 or v1).",
  };
}
