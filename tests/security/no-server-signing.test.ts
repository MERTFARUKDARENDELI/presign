import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static guard: the server never holds keys and never signs for the user.
 * Signing exists only in the browser, through the connected wallet adapter.
 */
const ROOT = path.resolve(import.meta.dirname, "../..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const all = [...sourceFiles(path.join(ROOT, "lib")), ...sourceFiles(path.join(ROOT, "app")), ...sourceFiles(path.join(ROOT, "components"))];
const rel = (f: string) => path.relative(ROOT, f).replaceAll("\\", "/");
const isServer = (f: string, src: string) => rel(f).startsWith("app/api/") || /^import "server-only";/m.test(src);

// Anything that would let code produce a signature or load a private key.
const SIGNING = /\.(partialSign|sign)\(|signTransaction|signAllTransactions|signMessage|fromSecretKey|Keypair\.generate|secretKey|ed25519\.sign|nacl\.sign|bip39|mnemonicToSeed/;

describe("server never signs on the user's behalf", () => {
  it("has server modules to check", () => {
    expect(all.filter((f) => isServer(f, readFileSync(f, "utf8"))).length).toBeGreaterThan(10);
  });

  it("no server module (app/api or server-only) can sign or load a private key", () => {
    const offenders = all.filter((f) => {
      const src = readFileSync(f, "utf8");
      return isServer(f, src) && SIGNING.test(src);
    });
    expect(offenders.map(rel)).toEqual([]);
  });

  it("no module anywhere loads a secret key or generates a keypair", () => {
    const offenders = all.filter((f) => /fromSecretKey|Keypair\.generate|secretKey|mnemonicToSeed|bip39/.test(readFileSync(f, "utf8")));
    expect(offenders.map(rel)).toEqual([]);
  });

  it("deterministic keypairs are only used for demo public keys", () => {
    for (const f of all) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/Keypair\.fromSeed\((?:[^()]|\([^()]*\))*\)(\.\w+)?/g)) expect(m[1], rel(f)).toBe(".publicKey");
    }
  });

  it("wallet signing goes only through the connected wallet adapter in client components", () => {
    const signers = all.filter((f) => /signTransaction/.test(readFileSync(f, "utf8"))).map(rel).sort();
    expect(signers).toEqual(["components/cleanup/CleanupDialog.tsx", "components/transaction/SignPanel.tsx"]);
    for (const f of signers) expect(readFileSync(path.join(ROOT, f), "utf8")).toMatch(/^"use client";/);
  });
});
