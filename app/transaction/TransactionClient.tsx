"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { Activity, Loader2 } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { AiChat } from "@/components/ai/AiChat";
import { SignPanel } from "@/components/transaction/SignPanel";
import { TransactionReport } from "@/components/transaction/TransactionReport";
import { api, ApiClientError } from "@/lib/client/api";
import type { TransactionAnalysis } from "@/lib/transaction/types";
import { isValidPublicKey } from "@/lib/validation/schemas";

export default function TransactionClient() {
  const params = useSearchParams();
  const { publicKey } = useWallet();
  const initialInput = params.get("input") ?? "";
  const initialWallet = params.get("wallet") ?? "";
  const [input, setInput] = useState(initialInput);
  const [wallet, setWallet] = useState(initialWallet);
  const [inputError, setInputError] = useState<string | null>(null);
  // A link like /transaction?input=<sig> analyzes immediately.
  const [request, setRequest] = useState<{ input: string; wallet: string; id: number } | null>(
    initialInput ? { input: initialInput, wallet: initialWallet, id: 1 } : null,
  );
  const [result, setResult] = useState<{ id: number; analysis: TransactionAnalysis | null; error: string | null } | null>(null);

  // Prefill the perspective wallet with the connected wallet (render-time adjustment).
  const connected = publicKey?.toBase58() ?? null;
  const [prevConnected, setPrevConnected] = useState<string | null>(null);
  if (connected !== prevConnected) {
    setPrevConnected(connected);
    if (connected && !wallet) setWallet(connected);
  }

  function analyze(tx: string, w: string) {
    if (!tx.trim()) return;
    if (w.trim() && !isValidPublicKey(w.trim())) {
      setInputError("Perspective wallet is not a valid address.");
      return;
    }
    setInputError(null);
    setRequest((r) => ({ input: tx.trim(), wallet: w.trim(), id: (r?.id ?? 0) + 1 }));
  }

  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    api<TransactionAnalysis>("/api/transaction/analyze", { json: { input: request.input, walletAddress: request.wallet || undefined } })
      .then((a) => !cancelled && setResult({ id: request.id, analysis: a, error: null }))
      .catch((e) => !cancelled && setResult({ id: request.id, analysis: null, error: e instanceof ApiClientError ? e.message : "Analysis failed." }));
    return () => {
      cancelled = true;
    };
  }, [request]);

  const loading = request !== null && result?.id !== request.id;
  const analysis = !loading ? (result?.analysis ?? null) : null;
  const error = inputError ?? (!loading ? (result?.error ?? null) : null);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Transaction Security</h2>
        <p className="text-sm text-zinc-400">
          Paste a transaction signature, or a serialized legacy or versioned (v0 / v1) transaction in base64 or base58. We decode it, simulate it against current chain state and
          explain what would happen — before you sign.
        </p>
      </div>

      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          analyze(input, wallet);
        }}
      >
        <Textarea value={input} onChange={(e) => setInput(e.target.value)} rows={5} maxLength={2000} spellCheck={false} placeholder="Signature or base64/base58 serialized transaction" className="border-zinc-800 bg-zinc-900 font-mono text-xs" />
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input value={wallet} onChange={(e) => setWallet(e.target.value)} placeholder="Your wallet (optional — defaults to the fee payer)" className="border-zinc-800 bg-zinc-900 font-mono text-xs" spellCheck={false} />
          <Button type="submit" disabled={loading || !input.trim()}>
            {loading ? <Loader2 className="animate-spin" /> : <Activity />} Analyze
          </Button>
        </div>
        <p className="text-xs text-zinc-500">Never paste a private key or seed phrase anywhere. A transaction does not contain your keys.</p>
      </form>

      {error && <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">{error}</div>}
      {loading && (
        <div className="space-y-3">
          <p className="text-sm text-zinc-400">Decoding → simulating → analyzing risk…</p>
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-60 w-full" />
        </div>
      )}
      {analysis && request && (
        <>
          <TransactionReport analysis={analysis} />
          <SignPanel key={`${request.id}`} analysis={analysis} input={request.input} />
          <div className="h-[420px]">
            <AiChat walletAddress={null} transactionInput={request.input} />
          </div>
        </>
      )}
      {!analysis && !loading && !error && (
        <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
          No transaction analyzed yet. Want an example? The <a href="/demo" className="text-fuchsia-300 underline">Demo</a> includes a suspicious transaction.
        </div>
      )}
    </div>
  );
}
