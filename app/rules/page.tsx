import type { Metadata } from "next";
import { RISK_STYLES } from "@/components/security/badges";
import { BRAND } from "@/lib/brand";
import type { RiskLevel } from "@/lib/security/risk";
import { FAMILY_INFO, RULE_CATALOG, type RuleFamily } from "@/lib/security/catalog";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Rule catalog · Presign",
  description: "Every deterministic rule behind Presign's verdicts: what triggers it and how severe it is.",
};

const FAMILIES = Object.keys(FAMILY_INFO) as RuleFamily[];

/** Chip color from the highest level named in the severity text. */
function levelOf(severity: string): RiskLevel | null {
  return (["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const).find((l) => severity.includes(l)) ?? null;
}

export default function RulesPage() {
  return (
    <div className="max-w-5xl space-y-10">
      <header className="max-w-3xl">
        <h2 className="text-3xl font-bold">Rule catalog</h2>
        <p className="mt-3 text-zinc-400">
          {BRAND.name}&apos;s verdicts come from these {RULE_CATALOG.length} rules — no model decides. Every signal cites its evidence (instruction, account, IDL field or simulation), the
          verdict is the highest severity found, and missing data can never produce &quot;no risk&quot;. The <span className="font-mono">code</span> is what the API, MCP tools and Watchtower
          return; a suffix (instruction index, mint, account) is added when a rule fires more than once.
        </p>
        <nav aria-label="Rule families" className="mt-4 flex flex-wrap gap-2 text-sm">
          {FAMILIES.map((f) => (
            <a key={f} href={`#${f}`} className="rounded-md border border-zinc-800 px-2 py-1 text-zinc-300 hover:bg-zinc-900">
              {FAMILY_INFO[f].title} <span className="text-zinc-500">{RULE_CATALOG.filter((r) => r.family === f).length}</span>
            </a>
          ))}
        </nav>
      </header>

      {FAMILIES.map((f) => (
        <section key={f} id={f} aria-labelledby={`${f}-h`} className="scroll-mt-6 space-y-3">
          <div>
            <h3 id={`${f}-h`} className="text-xl font-semibold">{FAMILY_INFO[f].title}</h3>
            <p className="text-sm text-zinc-400">{FAMILY_INFO[f].about}</p>
          </div>
          <ul className="divide-y divide-zinc-800 rounded-xl border border-zinc-800">
            {RULE_CATALOG.filter((r) => r.family === f).map((r) => {
              const level = levelOf(r.severity);
              return (
                <li key={r.code} className="grid gap-1 p-3 sm:grid-cols-[minmax(0,18rem)_minmax(0,1fr)] sm:gap-4">
                  <div className="space-y-1">
                    <p className="font-mono text-xs text-zinc-100 [overflow-wrap:anywhere]">{r.code}</p>
                    <span className={cn("inline-block rounded border px-1.5 text-[11px]", level ? RISK_STYLES[level].chip : "border-zinc-700 text-zinc-400")}>{r.severity}</span>
                  </div>
                  <p className="text-sm text-zinc-300">{r.when}</p>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <p className="text-xs text-zinc-500">
        The gate for automated signers follows the verdict: CRITICAL or HIGH → block; MEDIUM, unrated or incomplete → require human review; otherwise no known risk. Token and wallet-scanner
        rules are listed in the source (<span className="font-mono">lib/security/rules</span>).
      </p>
    </div>
  );
}
