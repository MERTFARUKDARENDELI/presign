import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * What Presign must not claim (audit of 2026-10-09, "WHAT WE MUST NOT CLAIM").
 * Every user-facing surface tracked in the repository — the READMEs, the
 * extension's popup and manifest, the app's pages and components, the docs —
 * is scanned for the claims that are not true, so the product's own words
 * cannot drift back into them. Each pattern says why it is not true.
 */
const NOT_TRUE: Array<[RegExp, string]> = [
  [/\bevery (solana )?(wallet )?signing request\b[^.\n]{0,40}\breviewed\b/i, "a site written for a particular wallet can still reach it through the wallet's own page code"],
  [/\b(all|every) (signing )?requests? (go|goes|pass|passes) through presign\b/i, "a site written for a particular wallet can still reach it through the wallet's own page code"],
  [/(?<!\b(not|never|cannot|can't) )\bguarantees? that\b|\bguaranteed (safe|safety|secure|protection)\b/i, "results are evidence-based signals, not guarantees"],
  [/\b(tested|verified|works|exercised|proven) (end to end )?with (phantom|solflare|backpack)\b/i, "not yet exercised with a real wallet extension"],
  [/\b(is|are|now) production[- ]ready\b/i, "production configuration and end-to-end runs are not verified"],
  [/\b(is|been|was|independently|externally|fully|third[- ]party) audited\b/i, "only internal reviews so far; Presign Guard is unaudited"],
  [/\bno known vulnerabilit/i, "npm audit reports advisories in the dependency tree"],
  [/\b(blocks?|stops?|prevents?) (all|every|any) (dangerous|malicious|risky|harmful|drain)/i, "for a person Presign advises and the user decides; only the automated gate blocks"],
  [/\bpresign (blocks|stops|prevents) (dangerous|malicious|risky|harmful)\b/i, "for a person Presign advises and the user decides; only the automated gate blocks"],
  [/\bAI (verifies|decides|determines|guarantees)\b/i, "the verdict comes from deterministic rules; the AI only explains"],
  [/\breal[- ]time (alerts?|warnings?|protection)\b|\binstant (alerts?|warnings?)\b/i, "Watchtower polls; its alerts can be delayed"],
  [/\b(cannot|can't|can not) be bypassed\b|\bimpossible to bypass\b|\bbulletproof\b|\b100% (safe|secure|protection|protected)\b/i, "the hook can be bypassed through a wallet's own page code"],
  [/\b(you are|you're|keeps you|stay) (safe|protected)\b/i, "Presign shows evidence; it does not make a signature safe"],
];

const SURFACES = /^(README\.md|extension\/README\.md|extension\/popup\.html|extension\/manifest\.json|app\/.*\.tsx|components\/.*\.tsx|lib\/brand\.ts|docs\/.*\.md)$/;

function trackedSurfaces(): string[] {
  const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n");
  return files.filter((f) => SURFACES.test(f));
}

describe("Presign's own words make none of the claims the audit ruled out", () => {
  it("scans every tracked user-facing surface", () => {
    const files = trackedSurfaces();
    expect(files.length).toBeGreaterThan(40);
    expect(files).toEqual(expect.arrayContaining(["README.md", "extension/popup.html", "app/docs/page.tsx"]));
  });

  it("no surface claims what is not true", () => {
    const found: string[] = [];
    for (const file of trackedSurfaces()) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const [pattern, why] of NOT_TRUE) {
          const m = line.match(pattern);
          if (m) found.push(`${file}:${i + 1}: "${m[0]}" — ${why}`);
        }
      });
    }
    expect(found).toEqual([]);
  });

  it("the patterns catch the claims they are about", () => {
    const claims = [
      "Every Solana signing request is reviewed by Presign before your wallet opens.",
      "Presign guarantees that your wallet signs exactly what you reviewed.",
      "Tested with Phantom, Solflare and Backpack.",
      "Presign is production-ready.",
      "The extension has been audited.",
      "Presign blocks dangerous transactions.",
      "The AI verifies every transaction.",
      "Watchtower sends real-time alerts.",
      "The review cannot be bypassed.",
      "With Presign you are safe.",
    ];
    for (const c of claims) expect(NOT_TRUE.some(([p]) => p.test(c)), c).toBe(true);
    // …and leave the true, careful wording alone.
    for (const ok of ["Results are evidence-based signals, not guarantees.", "Not yet tried with a real wallet extension.", "Presign Guard is unaudited.", "AI explains, never decides.", "No risk signal was raised by the completed checks. This is not a guarantee of safety.", "It does not guarantee that anything is safe."]) {
      expect(NOT_TRUE.some(([p]) => p.test(ok)), ok).toBe(false);
    }
  });
});
