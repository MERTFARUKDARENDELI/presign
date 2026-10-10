import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gate } from "@/scripts/audit-gate.mjs";

/**
 * The dependency gate CI runs (scripts/audit-gate.mjs): a high or critical advisory
 * blocks unless the allowlist accepts that exact advisory with its reasons and an
 * unexpired review date; a stale, expired or incomplete entry blocks as well.
 * No network: npm audit reports are built here in its JSON shape.
 */

const advisory = (id: string, name: string, severity: string, range = "<9.9.9") => ({ url: `https://github.com/advisories/${id}`, name, severity, range, title: `${name} advisory` });
const report = (...vias: Array<ReturnType<typeof advisory>>) => ({
  metadata: { vulnerabilities: {} },
  vulnerabilities: Object.fromEntries(vias.map((v) => [v.name, { name: v.name, severity: v.severity, via: [v, "some-parent"] }])),
});
const entry = (id: string, extra: Record<string, string> = {}) => ({
  id,
  package: "pkg@1.0.0",
  severity: "high",
  scope: "production and development tree",
  path: "a > b > pkg",
  impact: "what it can do here",
  reason: "no fixed release",
  removeWhen: "a fixed release exists",
  reviewBy: "2027-01-10",
  ...extra,
});
const TODAY = "2026-10-10";

describe("the dependency gate", () => {
  it("a high or critical advisory that is not on the allowlist blocks; moderate and low are only noted", () => {
    const all = report(advisory("GHSA-new1", "fresh", "critical"), advisory("GHSA-new2", "other", "high"), advisory("GHSA-mod1", "slow", "moderate"));
    const r = gate({ all, prod: all, allowlist: { advisories: [] }, today: TODAY });
    expect(r.blocked.map((a: { id: string }) => a.id).sort()).toEqual(["GHSA-new1", "GHSA-new2"]);
    expect(r.noted.map((a: { id: string }) => a.id)).toEqual(["GHSA-mod1"]);
    expect(r.accepted).toEqual([]);
  });

  it("an advisory the allowlist accepts with every reason passes, and says where it lives", () => {
    const all = report(advisory("GHSA-known", "braces", "high"));
    const r = gate({ all, prod: report(), allowlist: { advisories: [entry("GHSA-known", { package: "braces@3.0.3" })] }, today: TODAY });
    expect(r.blocked).toEqual([]);
    expect(r.problems).toEqual([]);
    expect(r.accepted).toMatchObject([{ id: "GHSA-known", scope: "development tree only" }]);
  });

  it("an exception is for one advisory id: another advisory of the same package still blocks", () => {
    const all = report(advisory("GHSA-known", "braces", "high"));
    all.vulnerabilities.braces.via.push(advisory("GHSA-second", "braces", "high"));
    const r = gate({ all, prod: all, allowlist: { advisories: [entry("GHSA-known", { package: "braces@3.0.3" })] }, today: TODAY });
    expect(r.blocked.map((a: { id: string }) => a.id)).toEqual(["GHSA-second"]);
  });

  it("an expired review date, a missing reason or a stale entry fails the gate", () => {
    const all = report(advisory("GHSA-a", "a", "high"), advisory("GHSA-b", "b", "high"));
    const expired = gate({ all, prod: all, allowlist: { advisories: [entry("GHSA-a", { package: "a@1.0.0", reviewBy: "2026-10-09" }), entry("GHSA-b", { package: "b@1.0.0" })] }, today: TODAY });
    expect(expired.blocked.map((a: { id: string }) => a.id)).toEqual(["GHSA-a"]);
    expect(expired.problems.join("\n")).toMatch(/GHSA-a was due for review/);

    const incomplete = gate({ all, prod: all, allowlist: { advisories: [entry("GHSA-a", { package: "a@1.0.0", reason: " " }), entry("GHSA-b", { package: "b@1.0.0" })] }, today: TODAY });
    expect(incomplete.blocked.map((a: { id: string }) => a.id)).toEqual(["GHSA-a"]);
    expect(incomplete.problems.join("\n")).toMatch(/GHSA-a lacks reason/);

    const stale = gate({ all, prod: all, allowlist: { advisories: [entry("GHSA-a", { package: "a@1.0.0" }), entry("GHSA-b", { package: "b@1.0.0" }), entry("GHSA-gone")] }, today: TODAY });
    expect(stale.blocked).toEqual([]);
    expect(stale.problems).toEqual(["allowlist entry GHSA-gone matches no current advisory: remove it"]);
  });

  it("an exception holds only for the package and severity it was written for", () => {
    const escalated = report(advisory("GHSA-known", "braces", "critical"));
    const r1 = gate({ all: escalated, prod: escalated, allowlist: { advisories: [entry("GHSA-known", { package: "braces@3.0.3" })] }, today: TODAY });
    expect(r1.blocked.map((a: { id: string }) => a.id)).toEqual(["GHSA-known"]);
    expect(r1.problems.join(" ")).toMatch(/severity is now critical, the entry says high/);

    const scoped = report(advisory("GHSA-sdk", "@scope/sdk", "high"));
    const ok = gate({ all: scoped, prod: scoped, allowlist: { advisories: [entry("GHSA-sdk", { package: "@scope/sdk@1.30.0" })] }, today: TODAY });
    expect([ok.accepted.length, ok.problems]).toEqual([1, []]);
    const other = gate({ all: scoped, prod: scoped, allowlist: { advisories: [entry("GHSA-sdk", { package: "left-pad@1.0.0" })] }, today: TODAY });
    expect(other.blocked).toHaveLength(1);
    expect(other.problems.join(" ")).toContain("it is about @scope/sdk, the entry says left-pad@1.0.0");
  });

  it("the committed allowlist gives every exception all its reasons and a future review date", () => {
    const list = JSON.parse(readFileSync("scripts/audit-allowlist.json", "utf8")) as { advisories: Array<Record<string, string>> };
    expect(list.advisories.length).toBeGreaterThan(0);
    for (const e of list.advisories) {
      expect(e.id).toMatch(/^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/);
      expect(["high", "critical"]).toContain(e.severity);
      for (const k of ["package", "scope", "path", "impact", "reason", "removeWhen"]) expect(e[k]?.trim().length ?? 0, `${e.id} ${k}`).toBeGreaterThan(5);
      expect(e.reviewBy > TODAY).toBe(true);
    }
  });
});
