import { AlertOctagon, AlertTriangle, CheckCircle2, HelpCircle, Info, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RiskVerdict } from "@/lib/security/risk";
import type { AnalysisStatus } from "@/lib/security/types";

export const RISK_STYLES: Record<RiskVerdict, { chip: string; ring: string; text: string; label: string }> = {
  CRITICAL: { chip: "bg-red-500/15 text-red-300 border-red-500/40", ring: "ring-red-500/40", text: "text-red-300", label: "Critical" },
  HIGH: { chip: "bg-orange-500/15 text-orange-300 border-orange-500/40", ring: "ring-orange-500/40", text: "text-orange-300", label: "High" },
  MEDIUM: { chip: "bg-amber-500/15 text-amber-200 border-amber-500/40", ring: "ring-amber-500/30", text: "text-amber-200", label: "Medium" },
  LOW: { chip: "bg-sky-500/15 text-sky-300 border-sky-500/40", ring: "ring-sky-500/30", text: "text-sky-300", label: "Low" },
  SAFE: { chip: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40", ring: "ring-emerald-500/30", text: "text-emerald-300", label: "No risk found" },
  UNKNOWN: { chip: "bg-zinc-500/15 text-zinc-300 border-zinc-500/40", ring: "ring-zinc-500/30", text: "text-zinc-300", label: "Unrated" },
};

const RISK_ICON: Record<RiskVerdict, typeof Info> = {
  CRITICAL: AlertOctagon,
  HIGH: ShieldAlert,
  MEDIUM: AlertTriangle,
  LOW: Info,
  SAFE: CheckCircle2,
  UNKNOWN: HelpCircle,
};

export function RiskBadge({ level, className }: { level: RiskVerdict; className?: string }) {
  const Icon = RISK_ICON[level];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide", RISK_STYLES[level].chip, className)}>
      <Icon className="size-3.5" aria-hidden />
      {level === "UNKNOWN" || level === "SAFE" ? RISK_STYLES[level].label : level}
    </span>
  );
}

const STATUS_STYLES: Record<AnalysisStatus, string> = {
  COMPLETE: "text-emerald-300 border-emerald-500/30",
  PARTIAL: "text-amber-200 border-amber-500/30",
  INSUFFICIENT_DATA: "text-orange-300 border-orange-500/30",
  UNAVAILABLE: "text-red-300 border-red-500/30",
};

const STATUS_HELP: Record<AnalysisStatus, string> = {
  COMPLETE: "All required checks completed.",
  PARTIAL: "Some data sources were unavailable or skipped — additional risks may exist.",
  INSUFFICIENT_DATA: "Critical data was missing. This is NOT a safe result.",
  UNAVAILABLE: "Analysis could not be performed.",
};

export function StatusBadge({ status, className }: { status: AnalysisStatus; className?: string }) {
  return (
    <span title={STATUS_HELP[status]} className={cn("inline-flex items-center rounded-md border bg-transparent px-2 py-0.5 text-[11px] font-medium tracking-wide", STATUS_STYLES[status], className)}>
      {status.replace("_", " ")}
    </span>
  );
}

export function statusHelp(status: AnalysisStatus): string {
  return STATUS_HELP[status];
}

export function DemoBadge({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-md border border-fuchsia-500/50 bg-fuchsia-500/15 px-2 py-0.5 text-[11px] font-bold tracking-widest text-fuchsia-200", className)}>
      DEMO MODE
    </span>
  );
}

export function shortAddr(a: string | null | undefined, n = 4): string {
  if (!a) return "—";
  return a.length > n * 2 + 1 ? `${a.slice(0, n)}…${a.slice(-n)}` : a;
}

export function Address({ value, n = 4, className }: { value: string | null | undefined; n?: number; className?: string }) {
  return (
    <span className={cn("font-mono text-xs", className)} title={value ?? undefined}>
      {shortAddr(value, n)}
    </span>
  );
}
