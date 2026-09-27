"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import { AlertOctagon, CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { CleanupAction } from "@/lib/cleanup/capabilities";
import { messageHashOf, verifyCleanupTransaction, type CleanupIntent } from "@/lib/cleanup/intent";
import type { PreparedCleanup } from "@/lib/cleanup/prepare";
import type { SubmitResult } from "@/lib/cleanup/submit";
import type { DemoCleanupPreview } from "@/lib/demo/scenario";
import { api, ApiClientError } from "@/lib/client/api";
import { TOKEN_2022_PROGRAM_ID } from "@/lib/solana/constants";
import { formatRawAmount } from "@/lib/token/amount";
import { decodeTransaction } from "@/lib/transaction/decoder";
import type { DecodedTransaction } from "@/lib/transaction/types";
import { signExactly } from "@/lib/wallet/signing";
import { Address, DemoBadge } from "@/components/security/badges";

const ACTION_LABEL: Record<CleanupAction, string> = {
  BURN_AND_CLOSE: "Burn tokens & close account",
  CLOSE: "Close empty account",
  REVOKE: "Revoke delegate",
};

type Phase =
  | { kind: "preparing" }
  | { kind: "review" }
  | { kind: "signing" }
  | { kind: "submitting" }
  | { kind: "done"; result: SubmitResult }
  | { kind: "blocked"; reason: string }
  | { kind: "error"; message: string };

function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s);
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-zinc-800/70 py-1.5 text-sm last:border-0">
      <span className="text-zinc-500">{k}</span>
      <span className="text-right text-zinc-100">{v}</span>
    </div>
  );
}

function IntentRows({ intent, symbol, reclaim, feeLamports }: { intent: CleanupIntent; symbol: string | null; reclaim: PreparedCleanup["reclaim"]; feeLamports?: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-1">
      <Row k="Operation" v={ACTION_LABEL[intent.action]} />
      <Row k="Network" v={intent.cluster} />
      <Row k="Token" v={<>{symbol ?? "Unknown"} <Address value={intent.mint} /></>} />
      <Row k="Token account" v={<Address value={intent.tokenAccount} n={6} />} />
      {intent.action === "BURN_AND_CLOSE" && <Row k="Burn amount" v={<span className="font-mono">{formatRawAmount(intent.amountRaw, intent.decimals)} (all)</span>} />}
      {intent.action !== "REVOKE" && <Row k="Account to close" v={<Address value={intent.tokenAccount} n={6} />} />}
      {intent.action !== "REVOKE" && <Row k="Rent destination" v={<>your wallet <Address value={intent.destination} /></>} />}
      {intent.action === "REVOKE" && (
        <>
          <Row k="Delegation type" v={`Account-level delegate (${intent.tokenProgram === TOKEN_2022_PROGRAM_ID ? "Token-2022" : "SPL Token"})`} />
          <Row k="Delegate being revoked" v={<Address value={intent.delegate ?? null} n={6} />} />
        </>
      )}
      <Row k="Authority / signer" v={<>your wallet <Address value={intent.owner} /></>} />
      <Row k="Program" v={<Address value={intent.tokenProgram} n={6} />} />
      {reclaim && (
        <>
          <Row k="Estimated reclaim (gross)" v={`${reclaim.display.gross} SOL`} />
          <Row k="Estimated network fee" v={`${reclaim.display.fee} SOL`} />
          <Row k="Estimated net reclaim" v={<span className={reclaim.estimatedNetLamports.startsWith("-") ? "text-red-300" : "text-emerald-300"}>{reclaim.display.net} SOL</span>} />
        </>
      )}
      {!reclaim && feeLamports && <Row k="Estimated network fee" v={`${formatRawAmount(feeLamports, 9)} SOL (no rent reclaimed)`} />}
    </div>
  );
}

function InstructionList({ decoded }: { decoded: DecodedTransaction }) {
  return (
    <ol className="space-y-1 text-xs">
      {decoded.instructions.map((i) => (
        <li key={i.index} className="rounded-md bg-zinc-900 px-2 py-1.5">
          <span className="font-mono text-zinc-200">#{i.index} {i.type}</span>
          <span className="ml-2 text-zinc-500">{i.programName}</span>
          <div className="mt-0.5 break-all font-mono text-[11px] text-zinc-400">
            {Object.entries(i.info).map(([k, v]) => `${k}=${v}`).join("  ")}
          </div>
        </li>
      ))}
    </ol>
  );
}

export interface CleanupTarget {
  tokenAccount: string;
  action: CleanupAction;
  symbol: string | null;
}

/** Production flow: prepare → verify → user confirmation → wallet signs → verify → relay → confirm → verify state. */
export function CleanupDialog({ target, owner, onClose, onDone }: { target: CleanupTarget | null; owner: string; onClose: () => void; onDone: () => void }) {
  // While the wallet is signing or the tx is being submitted, closing would hide the outcome.
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto border-zinc-800 bg-zinc-950 text-zinc-100 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{target ? ACTION_LABEL[target.action] : "Cleanup"}</DialogTitle>
          <DialogDescription>Review every field. Nothing is sent until you approve in your own wallet. The server never signs.</DialogDescription>
        </DialogHeader>
        {target && <CleanupFlow key={`${target.tokenAccount}:${target.action}`} target={target} owner={owner} onClose={onClose} onDone={onDone} onBusyChange={setBusy} />}
      </DialogContent>
    </Dialog>
  );
}

/** Keyed by target, so every new cleanup starts from a fresh state. */
function CleanupFlow({ target, owner, onClose, onDone, onBusyChange }: { target: CleanupTarget; owner: string; onClose: () => void; onDone: () => void; onBusyChange: (busy: boolean) => void }) {
  const { publicKey, signTransaction, wallet } = useWallet();
  const [phase, setPhase] = useState<Phase>({ kind: "preparing" });
  const [prepared, setPrepared] = useState<PreparedCleanup | null>(null);
  const [confirmedHash, setConfirmedHash] = useState<string | null>(null);
  const [ack, setAck] = useState(false);

  const busy = phase.kind === "signing" || phase.kind === "submitting";
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);

  const bytes = useMemo(() => (prepared ? b64ToBytes(prepared.transaction) : null), [prepared]);
  const decoded = useMemo(() => (bytes ? decodeTransaction(VersionedTransaction.deserialize(bytes)) : null), [bytes]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await api<PreparedCleanup>("/api/cleanup/prepare", { json: { owner, tokenAccount: target.tokenAccount, action: target.action } });
        const txBytes = b64ToBytes(p.transaction);
        // Client-side integrity: what we display (intent) must equal the bytes we will sign.
        const integrity = verifyCleanupTransaction(txBytes, p.intent);
        const hash = await messageHashOf(txBytes);
        if (cancelled) return;
        if (!integrity.ok || hash !== p.messageHash || p.intent.owner !== owner || p.intent.tokenAccount !== target.tokenAccount || p.intent.action !== target.action) {
          setPhase({ kind: "blocked", reason: `Prepared transaction does not match the requested cleanup. ${integrity.mismatches.join(" ")}` });
          return;
        }
        setPrepared(p);
        setConfirmedHash(hash);
        setPhase({ kind: "review" });
      } catch (e) {
        if (!cancelled) setPhase({ kind: "error", message: e instanceof ApiClientError ? e.message : "Could not prepare the cleanup transaction." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target, owner]);

  async function signAndSubmit() {
    if (!prepared || !bytes || !confirmedHash) return;
    if (!publicKey || publicKey.toBase58() !== prepared.intent.owner) {
      setPhase({ kind: "blocked", reason: "Connected wallet does not match the account owner." });
      return;
    }
    if (!signTransaction) {
      setPhase({ kind: "error", message: "This wallet does not support transaction signing." });
      return;
    }
    // Re-verify the displayed intent against the exact bytes immediately before signing.
    if (!verifyCleanupTransaction(bytes, prepared.intent).ok) {
      setPhase({ kind: "blocked", reason: "Transaction changed after confirmation." });
      return;
    }
    setPhase({ kind: "signing" });
    const outcome = await signExactly({
      bytes,
      confirmedHash,
      signer: prepared.intent.owner,
      sign: signTransaction,
      supportedVersions: wallet?.adapter.supportedTransactionVersions ?? null,
    });
    if (!outcome.ok) {
      setPhase(outcome.kind === "SECURITY_BLOCK" ? { kind: "blocked", reason: outcome.reason } : { kind: "error", message: outcome.reason });
      return;
    }
    const signedBytes = outcome.signed;
    setPhase({ kind: "submitting" });
    try {
      const result = await api<SubmitResult>("/api/cleanup/submit", {
        json: { signedTransaction: bytesToB64(signedBytes), expectedMessageHash: confirmedHash, intent: prepared.intent },
      });
      setPhase({ kind: "done", result });
      onDone();
    } catch (e) {
      if (e instanceof ApiClientError && e.code === "SECURITY_BLOCK") setPhase({ kind: "blocked", reason: e.message });
      else setPhase({ kind: "error", message: e instanceof ApiClientError ? e.message : "Submission failed." });
    }
  }

  const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}${prepared?.intent.cluster === "devnet" ? "?cluster=devnet" : ""}`;

  return (
    <>
        {phase.kind === "preparing" && (
          <p className="flex items-center gap-2 text-sm text-zinc-400"><Loader2 className="size-4 animate-spin" /> Checking eligibility, building and simulating…</p>
        )}

        {phase.kind === "blocked" && (
          <div className="rounded-lg border border-red-500/50 bg-red-500/10 p-3 text-sm text-red-200">
            <div className="mb-1 flex items-center gap-2 font-bold"><AlertOctagon className="size-4" /> SECURITY BLOCK</div>
            {phase.reason}
          </div>
        )}

        {phase.kind === "error" && <div className="rounded-lg border border-orange-500/40 bg-orange-500/10 p-3 text-sm text-orange-200">{phase.message}</div>}

        {prepared && decoded && (phase.kind === "review" || phase.kind === "signing" || phase.kind === "submitting") && (
          <div className="space-y-4">
            <IntentRows intent={prepared.intent} symbol={target.symbol} reclaim={prepared.reclaim} feeLamports={prepared.feeCheck.requiredLamports} />

            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">Exact instructions you will sign (decoded from the transaction)</h4>
              <InstructionList decoded={decoded} />
            </div>

            <div className="rounded-lg border border-zinc-800 p-3 text-sm">
              <div className="mb-1 font-medium">Simulation: {prepared.simulation.success ? <span className="text-emerald-300">succeeded</span> : <span className="text-red-300">failed</span>}</div>
              <p className="text-xs text-zinc-500">
                Simulated against chain state at slot {prepared.simulation.slot ?? "?"}. Success means it would execute at that moment — it does not guarantee the future result (state or blockhash can change before it lands) and is not a safety verdict.
              </p>
              {prepared.simulation.solChanges.map((c) => (
                <div key={c.address} className="mt-1 font-mono text-xs text-zinc-300"><Address value={c.address} /> {formatRawAmount(c.deltaLamports, 9)} SOL</div>
              ))}
            </div>

            {prepared.reclaim && <p className="text-xs text-amber-200/80">{prepared.reclaim.disclaimer}</p>}
            <p className="text-xs text-zinc-500">
              Spendable SOL (above rent-exempt minimum): {formatRawAmount(prepared.feeCheck.spendableLamports, 9)} SOL · required fee: {formatRawAmount(prepared.feeCheck.requiredLamports, 9)} SOL
            </p>
            {prepared.intent.action === "REVOKE" && prepared.eligibility.delegation?.permanentDelegate && (
              <p className="rounded-lg border border-orange-500/40 bg-orange-500/10 p-2 text-xs text-orange-200">
                This mint also has a Token-2022 Permanent Delegate (<Address value={prepared.eligibility.delegation.permanentDelegate} />). It is NOT affected by this revoke and cannot be revoked by holders.
              </p>
            )}

            {prepared.blockers.length > 0 ? (
              <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
                <div className="mb-1 font-semibold">Cannot proceed</div>
                <ul className="list-disc pl-5">{prepared.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
              </div>
            ) : (
              <label className="flex items-start gap-2 text-sm text-zinc-300">
                <input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                I reviewed the operation, token, amount and accounts above.{prepared.intent.action === "BURN_AND_CLOSE" && " Burning is irreversible."}
              </label>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button disabled={!ack || !prepared.canSign || phase.kind !== "review"} onClick={() => void signAndSubmit()}>
                {phase.kind === "signing" ? <><Loader2 className="animate-spin" /> Waiting for wallet…</> : phase.kind === "submitting" ? <><Loader2 className="animate-spin" /> Submitting…</> : <><ShieldCheck /> Approve in wallet</>}
              </Button>
            </div>
          </div>
        )}

        {phase.kind === "done" && (
          <div className="space-y-2 text-sm">
            <div className={phase.result.status === "confirmed" ? "flex items-center gap-2 text-emerald-300" : "text-amber-200"}>
              {phase.result.status === "confirmed" && <CheckCircle2 className="size-4" />}
              Transaction {phase.result.status}
              {phase.result.error ? `: ${phase.result.error}` : ""}
            </div>
            <a className="block break-all font-mono text-xs text-sky-300 underline" href={explorer(phase.result.signature)} target="_blank" rel="noreferrer">{phase.result.signature}</a>
            <p className="text-zinc-400">Post-transaction verification: {phase.result.postVerification.detail}</p>
            <Button variant="outline" onClick={onClose}>Close</Button>
          </div>
        )}
    </>
  );
}

/** Demo flow: identical confirmation data and integrity check, but signing is disabled. */
export function DemoCleanupDialog({ target, onClose, onSimulated }: { target: CleanupTarget | null; onClose: () => void; onSimulated: (preview: DemoCleanupPreview) => void }) {
  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto border-fuchsia-500/30 bg-zinc-950 text-zinc-100 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">{target ? ACTION_LABEL[target.action] : "Cleanup"} <DemoBadge /></DialogTitle>
          <DialogDescription>Same confirmation screen and integrity check as production. In Demo Mode no wallet is involved and nothing is signed or sent.</DialogDescription>
        </DialogHeader>
        {target && <DemoCleanupFlow key={`${target.tokenAccount}:${target.action}`} target={target} onClose={onClose} onSimulated={onSimulated} />}
      </DialogContent>
    </Dialog>
  );
}

function DemoCleanupFlow({ target, onClose, onSimulated }: { target: CleanupTarget; onClose: () => void; onSimulated: (preview: DemoCleanupPreview) => void }) {
  const [preview, setPreview] = useState<DemoCleanupPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<DemoCleanupPreview>("/api/demo/cleanup", { json: { tokenAccount: target.tokenAccount, action: target.action } })
      .then((p) => !cancelled && setPreview(p))
      .catch((e) => !cancelled && setError(e instanceof ApiClientError ? e.message : "Demo preview failed."));
    return () => {
      cancelled = true;
    };
  }, [target]);

  return (
    <>
      {error && <p className="text-sm text-red-300">{error}</p>}
      {!preview && !error && <p className="flex items-center gap-2 text-sm text-zinc-400"><Loader2 className="size-4 animate-spin" /> Building demo transaction…</p>}
      {preview && (
        <div className="space-y-3">
          <IntentRows intent={preview.intent} symbol={target.symbol} reclaim={preview.reclaim} />
          <div className={preview.integrity.ok ? "text-sm text-emerald-300" : "text-sm text-red-300"}>
            Integrity check (confirmed intent ↔ transaction bytes): {preview.integrity.ok ? "match" : `MISMATCH — ${preview.integrity.mismatches.join(" ")}`}
          </div>
          <p className="rounded-lg border border-fuchsia-500/30 bg-fuchsia-500/5 p-2 text-xs text-fuchsia-200">{preview.simulatedOutcome} Signing: disabled in demo — in production your wallet would open here.</p>
          {preview.reclaim && <p className="text-xs text-amber-200/80">{preview.reclaim.disclaimer}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button disabled={!preview.integrity.ok} onClick={() => { onSimulated(preview); onClose(); }}>Run demo outcome</Button>
          </div>
        </div>
      )}
    </>
  );
}
