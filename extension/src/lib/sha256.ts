import { byteCount, newBytes } from "./primordials";

/**
 * SHA-256 for the page hook (FIPS 180-4), synchronous and built only from
 * typed-array indexing, array literals and arithmetic — nothing a site could
 * replace. The hook hashes what it is about to hand the wallet and compares it
 * with the hash Presign's server approved; Web Crypto would not do here: it is
 * asynchronous (its promise would be read through `then`) and absent on
 * plain-HTTP pages.
 */

const U32 = Uint32Array;
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const HEX = "0123456789abcdef";

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

export function sha256(bytes: Uint8Array): Uint8Array {
  const n = byteCount(bytes);
  // Message, 0x80, zeros, then the bit length as 64-bit big-endian, to a multiple of 64 bytes.
  const padded = ((n + 72) >>> 6) << 6;
  const m = newBytes(padded);
  for (let i = 0; i < n; i++) m[i] = bytes[i];
  m[n] = 0x80;
  const hi = (n / 0x20000000) >>> 0;
  const lo = (n << 3) >>> 0;
  m[padded - 8] = hi >>> 24;
  m[padded - 7] = hi >>> 16;
  m[padded - 6] = hi >>> 8;
  m[padded - 5] = hi;
  m[padded - 4] = lo >>> 24;
  m[padded - 3] = lo >>> 16;
  m[padded - 2] = lo >>> 8;
  m[padded - 1] = lo;

  const w = new U32(64);
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  for (let off = 0; off < padded; off += 64) {
    for (let t = 0; t < 16; t++) {
      const j = off + 4 * t;
      w[t] = (m[j] << 24) | (m[j + 1] << 16) | (m[j + 2] << 8) | m[j + 3];
    }
    for (let t = 16; t < 64; t++) {
      const a = w[t - 15];
      const b = w[t - 2];
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[t] = w[t - 16] + s0 + w[t - 7] + s1;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let t = 0; t < 64; t++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + w[t]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  const out = newBytes(32);
  const hs = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (let i = 0; i < 8; i++) {
    out[4 * i] = hs[i] >>> 24;
    out[4 * i + 1] = hs[i] >>> 16;
    out[4 * i + 2] = hs[i] >>> 8;
    out[4 * i + 3] = hs[i];
  }
  return out;
}

/** Lower-case hex of the SHA-256, as Presign's server and the extension's background write it. */
export function sha256Hex(bytes: Uint8Array): string {
  const d = sha256(bytes);
  let s = "";
  for (let i = 0; i < 32; i++) s += HEX[d[i] >> 4] + HEX[d[i] & 15];
  return s;
}

/** A 64-character lower-case hex string. */
export function isHash(v: unknown): v is string {
  if (typeof v !== "string" || v.length !== 64) return false;
  for (let i = 0; i < 64; i++) {
    const c = v[i];
    if (!((c >= "0" && c <= "9") || (c >= "a" && c <= "f"))) return false;
  }
  return true;
}
