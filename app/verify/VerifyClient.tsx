"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { FileSearch, Loader2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { GuardActionReport, GuardOverviewView } from "@/components/guard/GuardViews";
import { MultisigOverview } from "@/components/multisig/MultisigOverview";
import { ProposalReport } from "@/components/multisig/ProposalReport";
import { api, ApiClientError } from "@/lib/client/api";
import type { InspectResult } from "@/lib/multisig/types";
import { isValidPublicKey } from "@/lib/validation/schemas";

/** Real, public mainnet examples (read-only). */
const EXAMPLES = [
  { label: "Drift exploit — proposal #7 (admin takeover)", q: "2LW6PSEjp81xSEttWwXDB6Etb1eKdhYPbFEojYbyhx88 #7" },
  { label: "Drift Security Council multisig", q: "2LW6PSEjp81xSEttWwXDB6Etb1eKdhYPbFEojYbyhx88" },
];

export default function VerifyClient() {
  const params = useSearchParams();
  const router = useRouter();
  const { publicKey } = useWallet();
  const initial = params.get("q") ?? "";
  const initialSigner = params.get("signer") ?? "";
  const [input, setInput] = useState(initial);
  const [signer, setSigner] = useState(initialSigner);
  const [inputError, setInputError] = useState<string | null>(null);
  const [request, setRequest] = useState<{ q: string; signer: string; id: number } | null>(initial ? { q: initial, signer: initialSigner, id: 1 } : null);
  const [result, setResult] = useState<{ id: number; data: InspectResult | null; error: string | null } | null>(null);

  const connected = publicKey?.toBase58() ?? null;
  const [prevConnected, setPrevConnected] = useState<string | null>(null);
  if (connected !== prevConnected) {
    setPrevConnected(connected);
    if (connected && !signer) setSigner(connected);
  }

  function run(q: string, s: string) {
    if (!q.trim()) return;
    if (s.trim() && !isValidPublicKey(s.trim())) {
      setInputError("Your member address is not a valid Solana address.");
      return;
    }
    setInputError(null);
    setInput(q);
    const next = new URLSearchParams({ q: q.trim(), ...(s.trim() ? { signer: s.trim() } : {}) });
    router.replace(`/verify?${next.toString()}`, { scroll: false });
    setRequest((r) => ({ q: q.trim(), signer: s.trim(), id: (r?.id ?? 0) + 1 }));
  }

  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    api<InspectResult>("/api/multisig/inspect", { json: { input: request.q, signer: request.signer || undefined } })
      .then((data) => !cancelled && setResult({ id: request.id, data, error: null }))
      .catch((e) => !cancelled && setResult({ id: request.id, data: null, error: e instanceof ApiClientError ? e.message : "Inspection failed." }));
    return () => {
      cancelled = true;
    };
  }, [request]);

  const loading = request !== null && result?.id !== request.id;
  const data = !loading ? (result?.data ?? null) : null;
  const error = inputError ?? (!loading ? (result?.error ?? null) : null);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Verify a multisig proposal</h2>
        <p className="mt-1 max-w-3xl text-sm text-zinc-400">
          Paste a Squads link, a proposal or multisig address, or <span className="font-mono text-zinc-300">&lt;multisig&gt; #&lt;number&gt;</span>. Presign loads the proposal from chain, decodes every instruction the vault would run,
          simulates it, and tells you who controls what afterwards — before you approve.
        </p>
      </div>

      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          run(input, signer);
        }}
      >
        <Input value={input} onChange={(e) => setInput(e.target.value)} maxLength={500} spellCheck={false} placeholder="https://app.squads.so/…  or  <multisig address> #12" className="h-11 border-zinc-800 bg-zinc-900 font-mono text-xs" aria-label="Squads link or address" />
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input value={signer} onChange={(e) => setSigner(e.target.value)} placeholder="Your member address (optional)" className="border-zinc-800 bg-zinc-900 font-mono text-xs" spellCheck={false} aria-label="Your member address" />
          <Button type="submit" disabled={loading || !input.trim()}>
            {loading ? <Loader2 className="animate-spin" /> : <FileSearch />} Verify
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          <span>Try a real example:</span>
          {EXAMPLES.map((x) => (
            <button key={x.q} type="button" onClick={() => run(x.q, signer)} className="rounded-md border border-zinc-800 px-2 py-1 text-zinc-300 hover:bg-zinc-900">
              {x.label}
            </button>
          ))}
        </div>
      </form>

      {error && <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">{error}</div>}
      {loading && (
        <div className="space-y-3" aria-live="polite">
          <p className="text-sm text-zinc-400">Loading from chain → decoding → simulating → checking who controls what…</p>
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-60 w-full" />
        </div>
      )}
      {data?.kind === "proposal" && <ProposalReport inspection={data.inspection} />}
      {data?.kind === "multisig" && <MultisigOverview overview={data.overview} onInspect={(index) => run(`${data.overview.multisig} #${index}`, signer)} />}
      {data?.kind === "guard" && <GuardOverviewView overview={data.overview} onInspect={(address) => run(address, signer)} />}
      {data?.kind === "guard-action" && <GuardActionReport inspection={data.inspection} onChanged={() => run(data.inspection.address, signer)} />}
      {!data && !loading && !error && (
        <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
          Nothing inspected yet. Read-only: Presign never asks for keys and never signs.
        </div>
      )}
    </div>
  );
}
