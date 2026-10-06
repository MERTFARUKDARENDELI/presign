"use client";

import { Loader2, Play } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TransactionReport } from "@/components/transaction/TransactionReport";
import { api, ApiClientError } from "@/lib/client/api";
import { DRIFT_EXPLOIT_TXS } from "@/lib/demo/drift";
import type { TransactionAnalysis } from "@/lib/transaction/types";
import { cn } from "@/lib/utils";

const LABELS = ["Member 1: create + approve (pre-signed)", "Member 2: approve + execute (pre-signed)"];

/** Runs the live analysis on the exact bytes each Security Council member signed. */
export function DriftReplay() {
  const [selected, setSelected] = useState(0);
  const [state, setState] = useState<{ index: number; analysis: TransactionAnalysis | null; error: string | null; loading: boolean } | null>(null);
  const cluster = process.env.NEXT_PUBLIC_SOLANA_CLUSTER === "devnet" ? "devnet" : "mainnet-beta";

  function run(index: number) {
    setSelected(index);
    setState({ index, analysis: null, error: null, loading: true });
    const tx = DRIFT_EXPLOIT_TXS[index];
    api<TransactionAnalysis>("/api/transaction/analyze", { json: { input: tx.unsignedBase64, walletAddress: tx.signer } })
      .then((analysis) => setState({ index, analysis, error: null, loading: false }))
      .catch((e) => setState({ index, analysis: null, error: e instanceof ApiClientError ? e.message : "Analysis failed.", loading: false }));
  }

  return (
    <div className="space-y-4">
      {cluster !== "mainnet-beta" && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100">
          This deployment is configured for {cluster}. The replay reads Drift&apos;s mainnet accounts, so the multisig, proposal and IDL lookups will be reported as unavailable here.
        </p>
      )}
      <div className="flex flex-col gap-2 sm:flex-row">
        {DRIFT_EXPLOIT_TXS.map((tx, i) => (
          <Button key={tx.signature} variant={selected === i && state ? "default" : "outline"} onClick={() => run(i)} disabled={state?.loading} className={cn("h-auto min-h-8 justify-start whitespace-normal py-1.5 text-left", selected !== i && "border-zinc-700")}>
            {state?.loading && state.index === i ? <Loader2 className="animate-spin" /> : <Play />} {LABELS[i]}
          </Button>
        ))}
      </div>
      {state?.loading && (
        <div className="space-y-3" aria-live="polite">
          <p className="text-sm text-zinc-400">Decoding the signed bytes → loading the multisig and Drift&apos;s IDL from chain → applying rules…</p>
          <Skeleton className="h-48 w-full" />
        </div>
      )}
      {state?.error && <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">{state.error}</div>}
      {state?.analysis && <TransactionReport analysis={state.analysis} />}
    </div>
  );
}
