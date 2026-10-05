import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RULE_CATALOG } from "@/lib/security/catalog";

/** Rule codes written literally in the signer-facing rule sources (dynamic prefixes are catalogued as patterns). */
function codesIn(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const out = new Set<string>();
  for (const m of src.matchAll(/code: [`"]([A-Z][A-Z0-9_]*[A-Z0-9])(?=[:`"])/g)) out.add(m[1]);
  // privilegedSignal builds MS_PROGRAM_CLOSE / MS_ACCOUNT_REASSIGN from a ternary.
  for (const m of src.matchAll(/"(PROGRAM_CLOSE|ACCOUNT_REASSIGN)"/g)) out.add(`MS_${m[1]}`);
  return [...out];
}

describe("rule catalog", () => {
  const catalogued = new Set(RULE_CATALOG.map((r) => r.code));

  it("documents every rule the multisig, guard, upgrade and transaction engines can emit", () => {
    const emitted = ["lib/security/rules/multisig.ts", "lib/security/rules/guard.ts", "lib/security/rules/transaction.ts", "lib/security/rules/transaction-extra.ts", "lib/presign/message.ts", "lib/presign/domain.ts", "lib/presign/context-rules.ts", "lib/presign/received-tokens.ts", "lib/presign/recipient-history.ts"].flatMap(codesIn);
    expect(emitted.length).toBeGreaterThan(60);
    expect(emitted.filter((c) => !catalogued.has(c))).toEqual([]);
  });

  it("has no duplicate or stale entries", () => {
    expect(catalogued.size).toBe(RULE_CATALOG.length);
    const sources = ["lib/security/rules/multisig.ts", "lib/security/rules/guard.ts", "lib/security/rules/transaction.ts", "lib/security/rules/transaction-extra.ts", "lib/presign/message.ts", "lib/presign/domain.ts", "lib/presign/context-rules.ts", "lib/presign/received-tokens.ts", "lib/presign/recipient-history.ts"].map((f) => readFileSync(f, "utf8")).join("\n");
    const literal = RULE_CATALOG.filter((r) => !/[*<]/.test(r.code)).map((r) => r.code);
    expect(literal.filter((c) => !sources.includes(c.replace(/^MS_(PROGRAM_CLOSE|ACCOUNT_REASSIGN)$/, "$1")))).toEqual([]);
  });
});
