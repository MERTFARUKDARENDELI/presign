import { bare, base64, byteCount, bytesFrom, copyRange, newBytes } from "./primordials";

/**
 * Byte helpers shared by the page hook and the extension. No dependencies:
 * the page hook runs inside arbitrary websites and must stay small. Every
 * function here only indexes typed arrays and primitive strings, with the
 * built-ins captured in ./primordials — a site that replaces btoa,
 * Uint8Array.from, Array.prototype methods or a typed array's `length` cannot
 * change what they return.
 */

export const bytesToBase64 = base64;

/** Background / review side only (the page hook never decodes base64). */
export function base64ToBytes(value: string): Uint8Array | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  try {
    const bin = atob(value);
    const out = newBytes(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_INDEX: Record<string, number> = bare({});
for (let i = 0; i < B58.length; i++) B58_INDEX[B58[i]] = i;

export function base58ToBytes(value: string): Uint8Array | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 20_000) return null;
  const n = value.length;
  // Little-endian digits of the number; log(58) / log(256) < 0.733.
  const digits = newBytes(((n * 733) / 1000 | 0) + 1);
  let size = 0;
  for (let i = 0; i < n; i++) {
    let carry = B58_INDEX[value[i]];
    if (carry === undefined) return null;
    for (let j = 0; j < size; j++) {
      carry += digits[j] * 58;
      digits[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      digits[size++] = carry & 0xff;
      carry >>= 8;
    }
  }
  // Each leading "1" is a leading zero byte.
  let zeros = 0;
  while (zeros < n && value[zeros] === "1") zeros++;
  const out = newBytes(zeros + size);
  for (let i = 0; i < size; i++) out[zeros + i] = digits[size - 1 - i];
  return out;
}

/**
 * A private copy of the bytes in `value`. The site keeps its own array and can
 * change it at any time after the call, so a review must never rely on it.
 */
export const copyBytes = bytesFrom;

/** The bytes in `value`, as a private copy (typed arrays, DataView, ArrayBuffer, byte arrays). */
export const toBytes = bytesFrom;

/** True when `bytes` ends with `suffix` (an off-chain message: wallet-built preamble, then the reviewed text). */
export function endsWithBytes(bytes: Uint8Array, suffix: Uint8Array): boolean {
  const n = byteCount(bytes);
  const m = byteCount(suffix);
  if (n < m) return false;
  for (let i = 0; i < m; i++) if (bytes[n - m + i] !== suffix[i]) return false;
  return true;
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  const n = byteCount(a);
  if (n !== byteCount(b)) return false;
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Solana compact-u16 ("shortvec") at `offset`. */
export function readShortVec(bytes: Uint8Array, offset: number): { value: number; size: number } | null {
  let value = 0;
  for (let size = 1; size <= 3; size++) {
    const b = bytes[offset + size - 1];
    if (b === undefined) return null;
    value |= (b & 0x7f) << (7 * (size - 1));
    if ((b & 0x80) === 0) return { value, size };
  }
  return null;
}

/** Signature section of a legacy / v0 transaction: [shortvec n][n × 64 bytes], followed by the message. */
function signatureSection(tx: Uint8Array): { count: number; countSize: number; messageStart: number } | null {
  const n = readShortVec(tx, 0);
  if (!n || n.value === 0 || n.value > 32) return null;
  const messageStart = n.size + 64 * n.value;
  if (messageStart + 4 > byteCount(tx)) return null;
  // The message header repeats the signer count: legacy [n, ...], v0 [0x80, n, ...].
  const first = tx[messageStart];
  const required = first === 0x80 ? tx[messageStart + 1] : first;
  return required === n.value ? { count: n.value, countSize: n.size, messageStart } : null;
}

/** The message part of a serialized legacy / v0 transaction (what the signatures cover), or null. */
export function transactionMessage(tx: Uint8Array): Uint8Array | null {
  const sec = signatureSection(tx);
  return sec ? copyRange(tx, sec.messageStart, byteCount(tx)) : null;
}

/** True when `bytes` is a whole serialized legacy / v0 transaction (signature slots included). */
export function isSerializedTransaction(bytes: Uint8Array): boolean {
  return signatureSection(bytes) !== null;
}

/**
 * Some wallet APIs carry only the transaction MESSAGE. Wrap it with empty
 * signature slots so it can be analyzed as a transaction; null when the bytes
 * look like neither form.
 */
export function asTransactionBytes(bytes: Uint8Array): Uint8Array | null {
  if (isSerializedTransaction(bytes)) return bytes;
  const n = byteCount(bytes);
  const required = bytes[0] === 0x80 ? bytes[1] : bytes[0];
  if (!required || required > 32 || n < 4) return null;
  // [shortvec required] (one byte below 128) + required × 64 zero bytes + the message.
  const start = 1 + 64 * required;
  const out = newBytes(start + n);
  out[0] = required;
  for (let i = 0; i < n; i++) out[start + i] = bytes[i];
  return isSerializedTransaction(out) ? out : null;
}

/**
 * Identity of a request independent of its signatures: the transaction message
 * for a transaction (signature slots excluded), the raw bytes for a message.
 */
export function requestKey(type: "TRANSACTION" | "MESSAGE", bytes: Uint8Array): string {
  if (type === "MESSAGE") return `m:${base64(bytes)}`;
  const sec = signatureSection(bytes);
  return `t:${base64(sec ? copyRange(bytes, sec.messageStart, byteCount(bytes)) : bytes)}`;
}

/**
 * A wallet may add signatures, nothing else. True when `signed` is `original`
 * with only bytes inside the signature slots changed — any change to the
 * message (instructions, accounts, fee payer, blockhash) returns false.
 */
export function onlySignaturesChanged(original: Uint8Array, signed: Uint8Array): boolean {
  const sec = signatureSection(original);
  const n = byteCount(original);
  if (!sec || byteCount(signed) !== n) return false;
  for (let i = 0; i < n; i++) {
    if (original[i] === signed[i]) continue;
    if (i < sec.countSize || i >= sec.messageStart) return false;
  }
  return true;
}
