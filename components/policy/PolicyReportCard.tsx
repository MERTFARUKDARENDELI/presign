import { Check, CircleHelp, Minus, X } from "lucide-react";
import type { PolicyCheckStatus, PolicyReport } from "@/lib/policy/types";
import { cn } from "@/lib/utils";

const ICON: Record<PolicyCheckStatus, { Icon: typeof Check; cls: string; label: string }> = {
  pass: { Icon: Check, cls: "text-emerald-300", label: "passes" },
  violation: { Icon: X, cls: "text-red-300", label: "broken" },
  unverifiable: { Icon: CircleHelp, cls: "text-amber-300", label: "could not be checked" },
  "not-applicable": { Icon: Minus, cls: "text-zinc-600", label: "does not apply here" },
};

const HEADLINE: Record<PolicyReport["status"], { text: string; cls: string }> = {
  compliant: { text: "Complies with your team policy", cls: "border-emerald-500/40 text-emerald-200" },
  violation: { text: "Breaks your team policy", cls: "border-red-500/50 text-red-200" },
  unverifiable: { text: "Could not be fully checked against your team policy", cls: "border-amber-500/40 text-amber-200" },
};

export function PolicyReportCard({ report }: { report: PolicyReport }) {
  const head = HEADLINE[report.status];
  return (
    <section aria-label="Team policy" className={cn("rounded-2xl border bg-zinc-900/50 p-5", head.cls.split(" ")[0])}>
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <h2 className={cn("text-lg font-semibold", head.cls.split(" ")[1])}>{head.text}</h2>
        <span className="text-xs text-zinc-500">policy “{report.name}” · violations count as {report.severity}</span>
      </div>
      <ul className="space-y-1.5 text-sm">
        {report.checks.map((c) => {
          const { Icon, cls, label } = ICON[c.status];
          return (
            <li key={c.rule} className="rounded-md bg-zinc-950 px-3 py-2">
              <div className="flex items-center gap-2">
                <Icon className={cn("size-4 shrink-0", cls)} aria-label={label} />
                <span className={c.status === "not-applicable" ? "text-zinc-500" : "text-zinc-200"}>{c.label}</span>
              </div>
              {c.findings.length > 0 && (
                <ul className="mt-1 space-y-0.5 pl-6 text-xs text-zinc-400">
                  {c.findings.map((f) => <li key={f} className="[overflow-wrap:anywhere]">{f}</li>)}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
