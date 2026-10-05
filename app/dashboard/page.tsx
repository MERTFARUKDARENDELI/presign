"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { RefreshCw, ScanSearch } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { SecurityTimeline } from "@/components/dashboard/SecurityTimeline";
import { PresignConnectionCard } from "@/components/presign/PresignConnectionCard";
import { WalletDashboard } from "@/components/dashboard/WalletDashboard";
import { api, ApiClientError } from "@/lib/client/api";
import { isValidPublicKey } from "@/lib/validation/schemas";
import type { WalletSecurityScan } from "@/lib/wallet/scan-core";

interface ScanRequest {
  address: string;
  id: number;
}

interface ScanResult {
  id: number;
  scan: WalletSecurityScan | null;
  error: string | null;
}

export default function DashboardPage() {
  const { publicKey } = useWallet();
  const connected = publicKey?.toBase58() ?? null;
  const [address, setAddress] = useState("");
  const [request, setRequest] = useState<ScanRequest | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [lastScan, setLastScan] = useState<WalletSecurityScan | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const [prevConnected, setPrevConnected] = useState<string | null>(null);

  function scan(addr: string) {
    if (!isValidPublicKey(addr)) {
      setInputError("Enter a valid Solana address.");
      return;
    }
    setInputError(null);
    setRequest((r) => ({ address: addr, id: (r?.id ?? 0) + 1 }));
  }

  // Auto-scan when a wallet connects (state adjusted during render, not in an effect).
  if (connected !== prevConnected) {
    setPrevConnected(connected);
    if (connected) {
      setAddress(connected);
      setInputError(null);
      setRequest((r) => ({ address: connected, id: (r?.id ?? 0) + 1 }));
    }
  }

  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    api<WalletSecurityScan>(`/api/wallet/scan?address=${encodeURIComponent(request.address)}`)
      .then((s) => {
        if (cancelled) return;
        setResult({ id: request.id, scan: s, error: null });
        setLastScan(s);
      })
      .catch((e) => !cancelled && setResult({ id: request.id, scan: null, error: e instanceof ApiClientError ? e.message : "Scan failed." }));
    return () => {
      cancelled = true;
    };
  }, [request]);

  const loading = request !== null && result?.id !== request.id;
  const error = !loading ? (result?.error ?? inputError) : inputError;
  // Never show a previous wallet's results under a new request.
  const shown = lastScan && (!request || lastScan.snapshot.address === request.address) ? lastScan : null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Wallet Scan</h2>
        <p className="text-sm text-zinc-400">Connect your wallet (public address only) or paste any address to scan it read-only.</p>
      </div>

      {connected && <PresignConnectionCard wallet={connected} scan={shown} />}

      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          scan(address.trim());
        }}
      >
        <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Solana wallet address" className="border-zinc-800 bg-zinc-900 font-mono" spellCheck={false} autoComplete="off" />
        <Button type="submit" disabled={loading}>
          {loading ? <RefreshCw className="animate-spin" /> : <ScanSearch />} {shown ? "Rescan" : "Scan"}
        </Button>
      </form>

      {error && <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">{error}</div>}

      {loading && !shown && (
        <div className="space-y-3">
          <Skeleton className="h-32 w-full" />
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-20" />)}</div>
          <Skeleton className="h-64 w-full" />
        </div>
      )}

      {!loading && !shown && !error && (
        <div className="rounded-xl border border-dashed border-zinc-800 p-10 text-center text-sm text-zinc-500">
          No wallet scanned yet. Connect a wallet or enter an address — or open <a href="/demo" className="text-fuchsia-300 underline">Demo Mode</a>.
        </div>
      )}

      {shown && (
        <div className={loading ? "pointer-events-none opacity-60" : undefined} aria-busy={loading}>
          <WalletDashboard
            scan={shown}
            mode={{ kind: "live", connectedWallet: connected, onChanged: () => scan(shown.snapshot.address) }}
            extra={
              <section className="space-y-3">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Recent transactions</h3>
                <SecurityTimeline key={shown.snapshot.address} address={shown.snapshot.address} />
              </section>
            }
          />
        </div>
      )}
    </div>
  );
}
