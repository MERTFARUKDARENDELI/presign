"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, ApiClientError } from "@/lib/client/api";
import type { TimelineEvent } from "@/lib/security/timeline";
import type { SignatureInfo } from "@/lib/solana/history";
import { Skeleton } from "@/components/ui/skeleton";

const DOT: Record<TimelineEvent["kind"], string> = {
  PHISHING_MEMO: "bg-red-500",
  SUSPICIOUS_MEMO: "bg-amber-400",
  FAILED: "bg-red-900",
  MEMO: "bg-zinc-500",
  UNCLASSIFIED: "bg-zinc-600",
};
const TEXT: Record<TimelineEvent["kind"], string> = {
  PHISHING_MEMO: "text-red-300",
  SUSPICIOUS_MEMO: "text-amber-200",
  FAILED: "text-red-300",
  MEMO: "text-zinc-400",
  UNCLASSIFIED: "text-zinc-500",
};

/**
 * Recent on-chain activity (FAZ 15): real signatures, each one analyzable, with a
 * deterministic memo/status classification. Memo evidence is shown as plain text only.
 */
export function SecurityTimeline({ address }: { address: string }) {
  const [items, setItems] = useState<SignatureInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Rendered with key={address} by the parent, so state starts fresh per wallet.
  useEffect(() => {
    let cancelled = false;
    api<{ items: SignatureInfo[] }>(`/api/wallet/history?address=${encodeURIComponent(address)}&limit=15`)
      .then((r) => !cancelled && setItems(r.items))
      .catch((e) => !cancelled && setError(e instanceof ApiClientError ? e.message : "History unavailable."));
    return () => {
      cancelled = true;
    };
  }, [address]);

  if (error) return <p className="text-sm text-amber-200">Timeline unavailable: {error}</p>;
  if (!items) return <Skeleton className="h-24 w-full" />;
  if (items.length === 0) return <p className="text-sm text-zinc-500">No recent transactions.</p>;

  return (
    <ol className="relative space-y-2 border-l border-zinc-800 pl-4">
      {items.map((s) => (
        <li key={s.signature} className="text-sm">
          <span className={`absolute -left-1.5 mt-1.5 size-3 rounded-full ${DOT[s.event.kind]}`} />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-zinc-500">{s.blockTime ? new Date(s.blockTime * 1000).toLocaleString() : `slot ${s.slot}`}</span>
            <span className="font-mono text-xs text-zinc-300">{s.signature.slice(0, 10)}…</span>
            <span className={`text-xs ${TEXT[s.event.kind]}`}>{s.event.label}</span>
            <Link href={`/transaction?input=${s.signature}&wallet=${address}`} className="text-xs text-sky-300 hover:underline">Analyze</Link>
          </div>
          {s.event.evidence.length > 0 && (
            <p className="mt-0.5 break-all text-xs text-zinc-500">{s.event.evidence.join(" · ")}</p>
          )}
        </li>
      ))}
    </ol>
  );
}
