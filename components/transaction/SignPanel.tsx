"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { Loader2, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { OwnershipGate } from "@/components/presign/OwnershipGate";
import { SigningReview } from "@/components/presign/SigningReview";
import { Button } from "@/components/ui/button";
import { WalletPicker } from "@/components/wallet/WalletPicker";
import { api, ApiClientError } from "@/lib/client/api";
import { fetchSession, recordEvent } from "@/lib/presign/client";
import type { SigningReview as Review } from "@/lib/presign/types";
import { bytesToBase64, parseTransactionInput } from "@/lib/transaction/input";
import type { TransactionAnalysis } from "@/lib/transaction/types";

type Phase =
  | { kind: "idle" }
  | { kind: "analyzing" }
  | { kind: "review"; review: Review }
  | { kind: "error"; message: string };

/**
 * Signing from /transaction goes through the same pre-sign pipeline as every
 * other Presign surface: wallet ownership proven in this session → the exact
 * bytes analyzed for the connected wallet (/api/presign/signing/analyze) → the
 * shared security review (one explicit confirmation for HIGH / CRITICAL,
 * Cancel only when the request cannot be verified) → server approval → the
 * wallet → optional submission bound to that approval. The app never signs.
 */
export function SignPanel({ analysis, input }: { analysis: TransactionAnalysis; input: string }) {
  const { publicKey } = useWallet();
  const connected = publicKey?.toBase58() ?? null;
  const bytes = useMemo(() => {
    const parsed = parseTransactionInput(input);
    return parsed.kind === "serialized-base64" || parsed.kind === "serialized-base58" ? parsed.bytes : null;
  }, [input]);
  const [verifiedWallet, setVerifiedWallet] = useState<string | null | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    const load = () => fetchSession().then((s) => !cancelled && setVerifiedWallet(s.verified?.wallet ?? null)).catch(() => !cancelled && setVerifiedWallet(null));
    void load();
    window.addEventListener("presign-session", load);
    return () => {
      cancelled = true;
      window.removeEventListener("presign-session", load);
    };
  }, [connected]);

  if (analysis.inputKind === "signature" || analysis.demo || !bytes) return null;

  const verified = connected !== null && verifiedWallet === connected;

  async function review() {
    if (!bytes || !connected) return;
    setPhase({ kind: "analyzing" });
    try {
      const r = await api<Review>("/api/presign/signing/analyze", { json: { type: "TRANSACTION", payload: bytesToBase64(bytes), payloadEncoding: "base64", walletAddress: connected } });
      recordEvent("REQUEST_ANALYZED", `Transaction from /transaction: ${r.decision.technicalValidation === "VALID" ? r.decision.risk.level : "cannot be verified"}`);
      setPhase({ kind: "review", review: r });
    } catch (e) {
      setPhase({ kind: "error", message: e instanceof ApiClientError ? e.message : "The transaction could not be analyzed for signing." });
    }
  }

  if (phase.kind === "review") {
    return <SigningReview key={phase.review.request.requestId} review={phase.review} allowSubmit onClose={() => setPhase({ kind: "idle" })} />;
  }

  return (
    <section className="space-y-3 rounded-xl border border-zinc-700 bg-zinc-900/60 p-4" aria-labelledby="sign-panel-title">
      <h3 id="sign-panel-title" className="text-sm font-semibold uppercase tracking-wide text-zinc-300">Sign (optional)</h3>
      <p className="text-xs text-zinc-500">
        Signing happens only in your wallet. Presign first reviews these exact bytes for your wallet, you decide, and the wallet receives only the reviewed transaction. Submission is a separate step. You can also stop here and not sign.
      </p>

      {connected === null && (
        <div className="space-y-2 text-sm text-zinc-300">
          <p>Connect the wallet that must sign this transaction.</p>
          <WalletPicker />
        </div>
      )}

      {connected !== null && verifiedWallet !== undefined && !verified && (
        <OwnershipGate wallet={connected} onVerified={() => window.dispatchEvent(new Event("presign-session"))} source="/transaction" />
      )}

      {phase.kind === "error" && <p className="text-sm text-orange-200" role="alert">{phase.message}</p>}

      {verified && (
        <div className="flex justify-end">
          <Button onClick={() => void review()} disabled={phase.kind === "analyzing"}>
            {phase.kind === "analyzing" ? <><Loader2 className="animate-spin" /> Reviewing…</> : <><ShieldCheck /> Review &amp; sign</>}
          </Button>
        </div>
      )}
    </section>
  );
}
