// The dependency gate: CI's `audit` job, and `npm run audit:gate` locally (no install needed; npm audit reads the lockfile).
// npm audit runs over the whole tree, production and development dependencies, and its findings are grouped by advisory.
// A high or critical advisory fails the gate unless scripts/audit-allowlist.json accepts that exact advisory with the
// package, where it comes from, its impact on Presign, the reason, a removal condition and a review date that has not
// passed. An entry that no current advisory matches fails too, so an exception cannot outlive its reason. Moderate and
// low advisories are listed, not blocking. If npm audit cannot answer (no registry), the gate fails: unknown is not clean.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BLOCKING = new Set(["high", "critical"]);
const REQUIRED = ["id", "package", "severity", "scope", "path", "impact", "reason", "removeWhen", "reviewBy"];

/** Advisories of an `npm audit --json` report, by id (GHSA-…): severity, title, affected packages and ranges. */
export function advisoriesOf(report) {
  const out = new Map();
  for (const vuln of Object.values(report?.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      if (typeof via !== "object" || !via?.url) continue;
      const id = String(via.url).split("/").pop();
      const a = out.get(id) ?? { id, severity: via.severity, title: via.title, packages: new Set(), ranges: new Set() };
      a.packages.add(via.name);
      a.ranges.add(`${via.name}@${via.range}`);
      out.set(id, a);
    }
  }
  return out;
}

/**
 * The decision. `all` and `prod` are `npm audit --json` reports for the whole tree and for production dependencies
 * only; `today` is YYYY-MM-DD. Returns what blocks, what the allowlist accepts, what is only noted, and list problems.
 */
export function gate({ all, prod, allowlist, today }) {
  const found = advisoriesOf(all);
  const inProd = advisoriesOf(prod);
  const entries = Array.isArray(allowlist?.advisories) ? allowlist.advisories : [];
  const result = { blocked: [], accepted: [], noted: [], problems: [] };
  const byId = new Map();
  for (const e of entries) {
    const missing = REQUIRED.filter((k) => typeof e?.[k] !== "string" || !e[k].trim());
    if (missing.length) result.problems.push(`allowlist entry ${e?.id ?? "(no id)"} lacks ${missing.join(", ")}`);
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(e.reviewBy)) result.problems.push(`allowlist entry ${e.id}: reviewBy must be YYYY-MM-DD`);
    else if (e.reviewBy < today) result.problems.push(`allowlist entry ${e.id} was due for review on ${e.reviewBy}: check it again, then move the date or remove it`);
    else byId.set(e.id, e);
    if (e?.id && !found.has(e.id)) result.problems.push(`allowlist entry ${e.id} matches no current advisory: remove it`);
  }
  for (const a of found.values()) {
    const scope = inProd.has(a.id) ? "production and development tree" : "development tree only";
    const line = { ...a, packages: [...a.packages], ranges: [...a.ranges], scope };
    const entry = byId.get(a.id);
    // An exception holds only for what it was written for: the same package, at the same severity.
    const stale = entry && (entry.severity !== a.severity ? `its severity is now ${a.severity}, the entry says ${entry.severity}` : !a.packages.has(packageName(entry.package)) ? `it is about ${[...a.packages].join(", ")}, the entry says ${entry.package}` : null);
    if (stale) result.problems.push(`allowlist entry ${a.id} no longer describes the advisory (${stale}): review it`);
    if (!BLOCKING.has(a.severity)) result.noted.push(line);
    else if (entry && !stale) result.accepted.push({ ...line, entry });
    else result.blocked.push(line);
  }
  return result;
}

/** "braces@3.0.3" → "braces", "@scope/name@1.0.0" → "@scope/name". */
const packageName = (spec) => /^(@?[^@]+)/.exec(String(spec))?.[1] ?? "";

function audit(args) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  let text;
  try {
    text = execFileSync(npm, ["audit", "--json", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, shell: process.platform === "win32", stdio: ["ignore", "pipe", "ignore"] });
  } catch (error) {
    text = error.stdout; // npm audit exits non-zero whenever it finds something
  }
  const report = JSON.parse(text || "{}");
  if (report.error || !report.metadata) throw new Error(`npm audit did not complete${report.error?.summary ? `: ${report.error.summary}` : ""}`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let code = 0;
  try {
    const all = audit([]);
    const r = gate({ all, prod: audit(["--omit=dev"]), allowlist: JSON.parse(readFileSync(path.join(here, "audit-allowlist.json"), "utf8")), today: new Date().toISOString().slice(0, 10) });
    console.log(`npm audit, whole tree: ${JSON.stringify(all.metadata.vulnerabilities)}`);
    for (const a of r.blocked) console.log(`BLOCK   ${a.id} ${a.severity} ${a.ranges.join(", ")} (${a.scope}) — ${a.title}`);
    for (const a of r.accepted) console.log(`ACCEPT  ${a.id} ${a.severity} ${a.ranges.join(", ")} (${a.scope}) — ${a.entry.reason} Review by ${a.entry.reviewBy}.`);
    for (const a of r.noted) console.log(`NOTE    ${a.id} ${a.severity} ${a.ranges.join(", ")} (${a.scope}) — ${a.title}`);
    for (const p of r.problems) console.log(`LIST    ${p}`);
    code = r.blocked.length || r.problems.length ? 1 : 0;
    console.log(code ? "\nDependency gate: FAILED (high or critical advisory without an accepted reason, or an allowlist problem)." : "\nDependency gate: passed.");
  } catch (error) {
    console.error(`Dependency gate: FAILED — ${error.message}`);
    code = 1;
  }
  process.exit(code);
}
