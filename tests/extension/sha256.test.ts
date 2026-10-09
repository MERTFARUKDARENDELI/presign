import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isHash, sha256Hex } from "@/extension/src/lib/sha256";

describe("the page hook's SHA-256", () => {
  it("matches Node's SHA-256 at every padding boundary and on long input", () => {
    for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 1232, 6144, 70_000]) {
      const b = new Uint8Array(randomBytes(n));
      expect(sha256Hex(b), `length ${n}`).toBe(createHash("sha256").update(b).digest("hex"));
    }
  });

  it("matches the FIPS 180-4 examples", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(new TextEncoder().encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("recognizes only a lower-case 64-character hex hash", () => {
    expect(isHash("ab".repeat(32))).toBe(true);
    for (const v of ["AB".repeat(32), "ab".repeat(31), `${"ab".repeat(31)}zz`, 42, null, undefined]) expect(isHash(v)).toBe(false);
  });
});
