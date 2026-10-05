import bs58 from "bs58";
import { parseTransactionInput } from "@/lib/transaction/input";
import { messageHashOfTx, sha256Hex } from "@/lib/wallet/signing";
import type { PayloadEncoding, SigningRequestType } from "./types";

/**
 * One payload codec for the browser AND the server, so both compute the same
 * bytes and the same hash. The hash covers what the wallet actually signs:
 * the serialized transaction MESSAGE (signatures excluded), or the message bytes.
 */

export const MAX_PAYLOAD_CHARS = 8_000;

function base64ToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  try {
    const bin = atob(value);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function base58ToBytes(value: string): Uint8Array | null {
  try {
    return bs58.decode(value);
  } catch {
    return null;
  }
}

export function decodePayload(type: SigningRequestType, payload: string, encoding?: PayloadEncoding): Uint8Array | null {
  if (typeof payload !== "string") return null;
  const p = payload.trim();
  if (!p || payload.length > MAX_PAYLOAD_CHARS) return null;
  if (type === "MESSAGE") {
    if (!encoding || encoding === "utf8") return new TextEncoder().encode(payload);
    return encoding === "base64" ? base64ToBytes(p) : base58ToBytes(p);
  }
  if (encoding === "utf8") return null;
  if (encoding === "base64") return base64ToBytes(p);
  if (encoding === "base58") return base58ToBytes(p);
  const parsed = parseTransactionInput(p);
  return parsed.kind === "serialized-base64" || parsed.kind === "serialized-base58" ? parsed.bytes : null;
}

export async function payloadHashOf(type: SigningRequestType, bytes: Uint8Array): Promise<string | null> {
  if (type === "MESSAGE") return sha256Hex(bytes);
  try {
    return await messageHashOfTx(bytes);
  } catch {
    return null;
  }
}
