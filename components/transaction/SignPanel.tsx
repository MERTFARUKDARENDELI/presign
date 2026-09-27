"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { AlertOctagon, CheckCircle2, Loader2, PenLine, Send } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiClientError } from "@/lib/client/api";
import type { SendResult } from "@/lib/solana/send";
import { parseTransactionInput } from "@/lib/transaction/input";
import { assessSignability, TYPED_CONFIRMATION_PHRASE } from "@/lib/transaction/sign-gate";
import type { TransactionAnalysis } from "@/lib/transaction/types";
import { messageHashOfTx, signExactly } from "@/lib/wallet/signing";

type Phase =
  | { kind: "idle" }
  | { kind: "signing" }
  | { kind: "signed"; signed: Uint8Array }
  | { kind: "submitting"; signed: Uint8Array }
  | { kind: "done"; result: SendResult }
  | { kind: "blocked"; reason: string }
  | { kind: "error"; message: string };

function toB64(bytes: Uint8Array): string {
  let s = "";
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s);
}

/**
 * Final steps of the flow: User confirmation → Wallet signing → (separate,
 * explicit) submission. Only offered after decode + simulation + risk +
 * explanation of these exact bytes. The app never signs; the wallet does.
 */
export function SignPanel({ analysis, input }: { analysis: TransactionAnalysis; input: string }) {
  const { publicKey, signTransaction, wallet } = useWallet();
  const connected = publicKey?.toBase58() ?? null;
  const bytes = useMemo(() => {
    const parsed = parseTransactionInput(input);
    return parsed.kind === "serialized-base64" || parsed.kind === "serialized-base58" ? parsed.bytes : null;
  }, [input]);
  const [localHash, setLocalHash] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [ack, setAck] = useState(false);
  const [typed, setTyped] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    if (bytes) messageHashOfTx(bytes).then((h) => !cancelled && setLocalHash(h)).catch(() => !cancelled && setLocalHash(null));
    return () => {
      cancelled = true;
    };
  }, [bytes]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  if (analysis.inputKind === "signature" || analysis.demo) return null;

  const gate = assessSignability(analysis, connected, localHash, now);
  const typedOk = !gate.requiresTypedConfirmation || typed.trim().toUpperCase() === TYPED_CONFIRMATION_PHRASE;
  const canSign = gate.allowed && ack && typedOk && phase.kind === "idle" && !!bytes && !!signTransaction;

  async function sign() {
    if (!bytes || !analysis.messageHash || !connected || !signTransaction) return;
    setPhase({ kind: "signing" });
    const outcome = await signExactly({
      bytes,
      confirmedHash: analysis.messageHash,
      signer: connected,
      sign: signTransaction,
      supportedVersions: wallet?.adapter.supportedTransactionVersions ?? null,
    });
    if (!outcome.ok) setPhase(outcome.kind === "SECURITY_BLOCK" ? { kind: "blocked", reason: outcome.reason } : { kind: "error", message: outcome.reason });
    else setPhase({ kind: "signed", signed: outcome.signed });
  }

  async function submit(signed: Uint8Array) {
    if (!analysis.messageHash) return;
    setPhase({ kind: "submitting", signed });
    try {
      const result = await api<SendResult>("/api/transaction/submit", { json: { signedTransaction: toB64(signed), expectedMessageHash: analysis.messageHash } });
      setPhase({ kind: "done", result });
    } catch (e) {
      if (e instanceof ApiClientError && e.code === "SECURITY_BLOCK") setPhase({ kind: "blocked", reason: e.message });
      else setPhase({ kind: "error", message: e instanceof ApiClientError ? e.message : "Submission failed." });
    }
  }

  const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}${analysis.cluster === "devnet" ? "?cluster=devnet" : ""}`;

  return (
    <section className="space-y-3 rounded-xl border border-zinc-700 bg-zinc-900/60 p-4">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-300">Confirm &amp; sign (optional)</h3>
      <p className="text-xs text-zinc-500">
        Signing happens only in your wallet. We verify that the wallet signs exactly the analyzed bytes, and submission is a separate step. You can also stop here and not sign.
      </p>

      {!gate.allowed && (
        <div className="rounded-lg border border-zinc-700 p-3 text-sm text-zinc-300">
          <div className="mb-1 font-medium">Signing is not available:</div>
          <ul className="list-disc pl-5 text-zinc-400">{gate.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
        </div>
      )}
      {gate.warnings.length > 0 && <ul className="list-disc pl-5 text-xs text-amber-200/90">{gate.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}

      {gate.allowed && phase.kind === "idle" && (
        <div className="space-y-2">
          <label className="flex items-start gap-2 text-sm text-zinc-300">
            <input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            I reviewed the explanation, asset movements, programs and risk evidence above.
          </label>
          {gate.requiresTypedConfirmation && (
            <div className="space-y-1">
              <p className="text-xs text-orange-200">Risk is {analysis.risk.level}. Type <span className="font-mono">{TYPED_CONFIRMATION_PHRASE}</span> to continue.</p>
              <Input value={typed} onChange={(e) => setTyped(e.target.value)} className="border-zinc-700 bg-zinc-950 font-mono text-xs" autoComplete="off" spellCheck={false} />
            </div>
          )}
        </div>
      )}

      {phase.kind === "blocked" && (
        <div className="rounded-lg border border-red-500/50 bg-red-500/10 p-3 text-sm text-red-200">
          <div className="mb-1 flex items-center gap-2 font-bold"><AlertOctagon className="size-4" /> SECURITY BLOCK</div>
          {phase.reason}
        </div>
      )}
      {phase.kind === "error" && <p className="text-sm text-orange-200">{phase.message}</p>}

      {(phase.kind === "signed" || phase.kind === "submitting") && (
        <div className="space-y-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm">
          <p className="text-emerald-300">Signed by your wallet. Verified: same bytes as analyzed, valid signature. Nothing has been sent yet.</p>
          <p className="text-xs text-zinc-400">Submitting runs a fresh network preflight; the result can still differ from the simulation.</p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setPhase({ kind: "idle" })} disabled={phase.kind === "submitting"}>Discard</Button>
            <Button onClick={() => void submit(phase.signed)} disabled={phase.kind === "submitting"}>
              {phase.kind === "submitting" ? <Loader2 className="animate-spin" /> : <Send />} Submit transaction
            </Button>
          </div>
        </div>
      )}

      {phase.kind === "done" && (
        <div className="space-y-1 text-sm">
          <div className={phase.result.status === "confirmed" ? "flex items-center gap-2 text-emerald-300" : "text-amber-200"}>
            {phase.result.status === "confirmed" && <CheckCircle2 className="size-4" />} Transaction {phase.result.status}
            {phase.result.error ? `: ${phase.result.error}` : ""}
          </div>
          <a className="block break-all font-mono text-xs text-sky-300 underline" href={explorer(phase.result.signature)} target="_blank" rel="noreferrer">{phase.result.signature}</a>
        </div>
      )}

      {(phase.kind === "idle" || phase.kind === "signing") && (
        <div className="flex justify-end">
          <Button disabled={!canSign} onClick={() => void sign()}>
            {phase.kind === "signing" ? <><Loader2 className="animate-spin" /> Waiting for wallet…</> : <><PenLine /> Sign in wallet</>}
          </Button>
        </div>
      )}
    </section>
  );
}
