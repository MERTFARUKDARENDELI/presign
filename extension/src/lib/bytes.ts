/**
 * Byte helpers shared by the page hook and the extension. No dependencies:
 * the page hook runs inside arbitrary websites and must stay small.
 */

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(value: string): Uint8Array | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  try {
    const bin = atob(value);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58ToBytes(value: string): Uint8Array | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 20_000) return null;
  const bytes: number[] = [0];
  for (const ch of value) {
    let carry = B58.indexOf(ch);
    if (carry < 0) return null;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of value) {
    if (ch !== "1") break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

export function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value) && value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) return Uint8Array.from(value as number[]);
  return null;
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
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

function shortVec(n: number): number[] {
  const out: number[] = [];
  let v = n;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      out.push(b);
      return out;
    }
    out.push(b | 0x80);
  }
}

/** Signature section of a legacy / v0 transaction: [shortvec n][n × 64 bytes], followed by the message. */
function signatureSection(tx: Uint8Array): { count: number; messageStart: number } | null {
  const n = readShortVec(tx, 0);
  if (!n || n.value === 0 || n.value > 32) return null;
  const messageStart = n.size + 64 * n.value;
  if (messageStart + 4 > tx.length) return null;
  // The message header repeats the signer count: legacy [n, ...], v0 [0x80, n, ...].
  const first = tx[messageStart];
  const required = first === 0x80 ? tx[messageStart + 1] : first;
  return required === n.value ? { count: n.value, messageStart } : null;
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
  const required = bytes[0] === 0x80 ? bytes[1] : bytes[0];
  if (!required || required > 32 || bytes.length < 4) return null;
  const out = Uint8Array.from([...shortVec(required), ...new Array(64 * required).fill(0), ...bytes]);
  return isSerializedTransaction(out) ? out : null;
}

/**
 * Identity of a request independent of its signatures: the transaction message
 * for a transaction (signature slots excluded), the raw bytes for a message.
 */
export function requestKey(type: "TRANSACTION" | "MESSAGE", bytes: Uint8Array): string {
  if (type === "MESSAGE") return `m:${bytesToBase64(bytes)}`;
  const sec = signatureSection(bytes);
  return `t:${bytesToBase64(sec ? bytes.subarray(sec.messageStart) : bytes)}`;
}

/**
 * A wallet may add signatures, nothing else. True when `signed` is `original`
 * with only bytes inside the signature slots changed — any change to the
 * message (instructions, accounts, fee payer, blockhash) returns false.
 */
export function onlySignaturesChanged(original: Uint8Array, signed: Uint8Array): boolean {
  const sec = signatureSection(original);
  if (!sec || signed.length !== original.length) return false;
  for (let i = 0; i < original.length; i++) {
    if (original[i] === signed[i]) continue;
    if (i < readShortVec(original, 0)!.size || i >= sec.messageStart) return false;
  }
  return true;
}
