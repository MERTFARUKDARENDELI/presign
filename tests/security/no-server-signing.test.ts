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

  it("the browser extension never creates a signature, loads a private key or talks to the network", () => {
    const ext = sourceFiles(path.join(ROOT, "extension", "src"));
    expect(ext.length).toBeGreaterThan(5);
    for (const f of ext) {
      const src = readFileSync(f, "utf8");
      // It only forwards the site's own request to the wallet's own method after the user's decision. It may CHECK a
      // wallet's signature with the account's public key (Web Crypto "verify"), never make one or hold a private key.
      expect(src, rel(f)).not.toMatch(/fromSecretKey|Keypair|secretKey|nacl|bip39|mnemonic|\.(partialSign|sign)\(|generateKey|pkcs8|"jwk"|\["sign"\]/);
      // Requests: none, except the background confirming an approval with the Presign server that issued it.
      expect(src, rel(f)).not.toMatch(/XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts/);
      const fetches = src.match(/\bfetch\(/g)?.length ?? 0;
      if (rel(f) === "extension/src/background.ts") expect(fetches, rel(f)).toBe(1);
      else if (rel(f) !== "extension/src/lib/approval.ts") expect(fetches, rel(f)).toBe(0);
    }
    // That one request goes only to an allowed Presign origin's confirmation endpoint, with no cookies and no redirects.
    const approval = readFileSync(path.join(ROOT, "extension", "src", "lib", "approval.ts"), "utf8");
    expect(approval).toMatch(/if \(!isAllowedPresignOrigin\(presignOrigin\)\) return/);
    expect(approval).toMatch(/deps\.fetch\(`\$\{presignOrigin\}\$\{CONFIRM_PATH\}`/);
    expect(approval).toMatch(/credentials: "omit"/);
    expect(approval).toMatch(/redirect: "error"/);
    expect(approval).not.toMatch(/(?<!deps\.)\bfetch\(/);
  });

  it("wallet signing goes only through the connected wallet adapter in client components", () => {
    const signers = all.filter((f) => /signTransaction/.test(readFileSync(f, "utf8"))).map(rel).sort();
    // Every new signing site is reviewed here: Guard veto / execute signs prepared bytes after a hash check;
    // the pre-sign review signs only after server approval of the exact payload hash (lib/presign/controller.ts),
    // and /transaction (SignPanel) signs through that same review.
    expect(signers).toEqual(["components/cleanup/CleanupDialog.tsx", "components/guard/GuardActionButtons.tsx", "components/presign/SigningReview.tsx"]);
    for (const f of signers) expect(readFileSync(path.join(ROOT, f), "utf8")).toMatch(/^"use client";/);
  });
});
