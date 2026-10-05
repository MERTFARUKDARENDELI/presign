import { CheckCircle2, CircleHelp, CircleMinus, CircleX, TriangleAlert } from "lucide-react";
import type { CheckStatus, ConnectCheck } from "@/lib/presign/types";
import { cn } from "@/lib/utils";

const STYLE: Record<CheckStatus, { icon: typeof CheckCircle2; className: string; word: string }> = {
  PASS: { icon: CheckCircle2, className: "text-emerald-300", word: "Passed" },
  WARN: { icon: TriangleAlert, className: "text-amber-200", word: "Warning" },
  FAIL: { icon: CircleX, className: "text-red-300", word: "Failed" },
  UNKNOWN: { icon: CircleHelp, className: "text-zinc-400", word: "Unknown" },
  NOT_PROVIDED: { icon: CircleMinus, className: "text-zinc-400", word: "Not provided" },
};

/** Check results with icon AND word, so status never relies on color alone. */
export function CheckList({ checks }: { checks: ConnectCheck[] }) {
  return (
    <ul className="space-y-2" aria-label="Connection checks">
      {checks.map((c) => {
        const s = STYLE[c.status];
        const Icon = s.icon;
        return (
          <li key={c.id} className="flex items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2">
            <Icon className={cn("mt-0.5 size-4 shrink-0", s.className)} aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="font-medium text-zinc-100">{c.label}</span>
                <span className={cn("text-xs font-semibold uppercase tracking-wide", s.className)}>{s.word}</span>
              </div>
              <p className="text-xs text-zinc-500">{c.detail}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function DomainStatusChip({ status }: { status: string }) {
  const tone =
    status === "CRITICAL" || status === "HIGH" ? "border-red-500/40 bg-red-500/10 text-red-300"
    : status === "MEDIUM" ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
    : status === "LOW" ? "border-sky-500/40 bg-sky-500/10 text-sky-300"
    : status === "SAFE" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
    : "border-zinc-600 bg-zinc-800/50 text-zinc-300";
  const label = status === "UNKNOWN" ? "Reputation unknown" : status === "LOW" ? "Low / recognized" : status;
  return <span className={cn("inline-flex rounded-md border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide", tone)}>{label}</span>;
}
