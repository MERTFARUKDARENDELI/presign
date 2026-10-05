"use client";

import { BadgeCheck, CircleHelp, History, ShieldQuestion } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Address, RiskBadge, StatusBadge } from "@/components/security/badges";
import { fetchSession, loadEvents, type PresignEvent } from "@/lib/presign/client";
import type { PresignSession } from "@/lib/presign/types";
import type { WalletSecurityScan } from "@/lib/wallet/scan-core";

/**
 * Connection status for the wallet dashboard: who is connected, whether
 * ownership was verified in this session, the wallet's current risk from the
 * read-only scan, and this session's Presign security decisions.
 */
export function PresignConnectionCard({ wallet, scan }: { wallet: string; scan: WalletSecurityScan | null }) {
  const [session, setSession] = useState<PresignSession | null>(null);
  const [events, setEvents] = useState<PresignEvent[]>([]);

  useEffect(() => {
    let cancelled = false;
    const loadSession = () => fetchSession().then((s) => !cancelled && setSession(s)).catch(() => !cancelled && setSession(null));
    const loadEv = () => setEvents(loadEvents());
    void loadSession();
    loadEv();
    window.addEventListener("presign-session", loadSession);
    window.addEventListener("presign-events", loadEv);
    return () => {
      cancelled = true;
      window.removeEventListener("presign-session", loadSession);
      window.removeEventListener("presign-events", loadEv);
    };
  }, [wallet]);

  const verified = session?.verified?.wallet === wallet ? session.verified : null;
  const risk = scan && scan.snapshot.address === wallet ? scan.walletRisk : null;

  return (
    <section className="grid gap-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 md:grid-cols-[1fr_1fr_1.4fr]" aria-label="Presign connection">
      <div className="space-y-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Wallet</h3>
        <Address value={wallet} n={6} className="text-sm text-zinc-100" />
        <h3 className="pt-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Connection</h3>
        {session === null ? (
          <p className="flex items-center gap-1.5 text-sm text-zinc-400"><CircleHelp className="size-4" aria-hidden /> Checking…</p>
        ) : verified ? (
          <p className="flex items-center gap-1.5 text-sm text-emerald-300"><BadgeCheck className="size-4" aria-hidden /> Verified <span className="text-xs text-zinc-500">since {new Date(verified.verifiedAt).toLocaleTimeString()}</span></p>
        ) : (
          <p className="flex flex-wrap items-center gap-1.5 text-sm text-amber-200"><ShieldQuestion className="size-4" aria-hidden /> Not verified · <Link href="/connect?next=/dashboard" className="underline">verify ownership</Link></p>
        )}
      </div>
      <div className="space-y-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Current wallet risk</h3>
        {risk ? (
          <div className="flex flex-wrap items-center gap-2"><RiskBadge level={risk.level} /> <StatusBadge status={risk.status} /></div>
        ) : (
          <p className="text-sm text-zinc-500">Scanning… (read-only, public address only)</p>
        )}
        <h3 className="pt-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Security status</h3>
        <p className="text-sm text-zinc-300">{verified ? "Signing requests can go through Presign's pre-sign review." : "Verify ownership to use Presign's pre-sign review."} <Link href="/demo/sign" className="text-violet-300 underline">Try it</Link></p>
      </div>
      <div className="space-y-1">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500"><History className="size-3.5" aria-hidden /> Recent security events (this tab)</h3>
        {events.length === 0 ? (
          <p className="text-sm text-zinc-500">No Presign decisions in this session yet.</p>
        ) : (
          <ul className="max-h-36 space-y-1 overflow-auto text-xs">
            {events.slice(0, 8).map((e) => (
              <li key={`${e.at}-${e.kind}`} className="flex gap-2"><span className="shrink-0 font-mono text-zinc-500">{new Date(e.at).toLocaleTimeString()}</span><span className="text-zinc-300">{e.detail}</span></li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
