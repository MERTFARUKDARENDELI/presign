import { PublicKey } from "@solana/web3.js";

/**
 * Minimal bounds-checked Borsh reader for on-chain account and instruction
 * data. Every read checks the remaining length and throws on truncation, so
 * malformed or hostile bytes are rejected instead of being half-decoded.
 */

/** Upper bound for any length prefix: a Solana transaction or account can never hold more. */
const MAX_LEN = 10 * 1024 * 1024;

export class BorshReader {
  private offset = 0;

  constructor(private readonly data: Uint8Array) {}

  get remaining(): number {
    return this.data.length - this.offset;
  }

  get position(): number {
    return this.offset;
  }

  private take(n: number): Uint8Array {
    if (n < 0 || n > this.remaining) throw new RangeError(`Truncated data: need ${n} byte(s) at ${this.offset}, have ${this.remaining}`);
    const out = this.data.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  private view(n: number): DataView {
    const b = this.take(n);
    return new DataView(b.buffer, b.byteOffset, b.byteLength);
  }

  skip(n: number): void {
    this.take(n);
  }

  u8(): number {
    return this.take(1)[0];
  }

  bool(): boolean {
    const v = this.u8();
    if (v > 1) throw new RangeError(`Invalid bool ${v}`);
    return v === 1;
  }

  u16(): number {
    return this.view(2).getUint16(0, true);
  }

  u32(): number {
    return this.view(4).getUint32(0, true);
  }

  u64(): bigint {
    return this.view(8).getBigUint64(0, true);
  }

  i64(): bigint {
    return this.view(8).getBigInt64(0, true);
  }

  u128(): bigint {
    const lo = this.u64();
    const hi = this.u64();
    return (hi << 64n) | lo;
  }

  i128(): bigint {
    const v = this.u128();
    return v >= 1n << 127n ? v - (1n << 128n) : v;
  }

  pubkey(): string {
    return new PublicKey(this.take(32)).toBase58();
  }

  fixed(n: number): Uint8Array {
    return this.take(n);
  }

  /** Borsh `Vec<u8>` / `bytes`: u32 length prefix. */
  bytes(): Uint8Array {
    return this.take(this.len(this.u32()));
  }

  string(): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(this.bytes());
  }

  option<T>(read: () => T): T | null {
    return this.bool() ? read() : null;
  }

  /** Borsh `Vec<T>`: u32 length prefix. */
  vec<T>(read: () => T): T[] {
    const n = this.len(this.u32());
    return Array.from({ length: n }, read);
  }

  /** Length-checked count: rejects lengths that cannot fit the remaining bytes (≥ 1 byte per item). */
  len(n: number): number {
    if (n > MAX_LEN || n > this.remaining) throw new RangeError(`Implausible length ${n} at ${this.offset}`);
    return n;
  }

  /** Throws when unread bytes remain — used where a layout must consume the input exactly. */
  end(): void {
    if (this.remaining !== 0) throw new RangeError(`${this.remaining} trailing byte(s)`);
  }
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
