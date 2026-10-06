"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { Transaction } from "@solana/web3.js";
import { Ban, Loader2, Play } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api, ApiClientError } from "@/lib/client/api";
import type { PreparedGuardTransaction } from "@/lib/guard/prepare";
import type { SendResult } from "@/lib/solana/send";
import { messageHashOfTx } from "@/lib/wallet/signing";

type Phase = { kind: "idle" } | { kind: "working"; step: string } | { kind: "done"; result: SendResult } | { kind: "error"; message: string };

/**
 * Veto (guardians) and execute (anyone, after the delay). The server prepares
 * the unsigned transaction; the connected wallet signs exactly those bytes
 * (message hash re-checked here and on the server); the server relays it.
 */
export function GuardActionButtons({ action, guardians, pending, executable, onDone }: { action: string; guardians: string[]; pending: boolean; executable: boolean; onDone: () => void }) {
  const { publicKey, signTransaction } = useWallet();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const me = publicKey?.toBase58() ?? null;
  const isGuardian = me !== null && guardians.includes(me);

  async function run(kind: "veto" | "execute") {
    if (!me || !signTransaction) return;
    try {
      setPhase({ kind: "working", step: "Preparing the transaction…" });
      const prepared = await api<PreparedGuardTransaction>("/api/guard/prepare", { json: { kind, action, signer: me } });
      const bytes = Uint8Array.from(atob(prepared.transaction), (c) => c.charCodeAt(0));
      if ((await messageHashOfTx(bytes)) !== prepared.messageHash) throw new Error("The prepared transaction does not match its hash. Nothing was signed.");
      setPhase({ kind: "working", step: "Waiting for your wallet…" });
      const signed = await signTransaction(Transaction.from(bytes));
      const signedBytes = signed.serialize();
      if ((await messageHashOfTx(signedBytes)) !== prepared.messageHash) throw new Error("The wallet changed the transaction. It was not sent.");
      setPhase({ kind: "working", step: "Sending…" });
      const result = await api<SendResult>("/api/transaction/submit", { json: { signedTransaction: btoa(String.fromCharCode(...signedBytes)), expectedMessageHash: prepared.messageHash, preparedToken: prepared.preparedToken } });
      setPhase({ kind: "done", result });
      if (result.status === "confirmed") onDone();
    } catch (e) {
      setPhase({ kind: "error", message: e instanceof ApiClientError || e instanceof Error ? e.message : "The transaction failed." });
    }
  }

  if (!pending) return null;
  const busy = phase.kind === "working";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button variant="destructive" disabled={!isGuardian || busy} onClick={() => run("veto")}>
          {busy ? <Loader2 className="animate-spin" /> : <Ban />} Veto this action
        </Button>
        <Button variant="outline" disabled={!executable || !me || busy} onClick={() => run("execute")}>
          <Play /> Execute
        </Button>
      </div>
      <p className="text-xs text-zinc-500">
        {!me ? "Connect a wallet to veto (guardians) or execute (anyone, after the delay)." : isGuardian ? "Your wallet is a guardian: one veto is enough to stop this action." : "The connected wallet is not a guardian of this guard; it cannot veto."}
        {!executable ? " Execution opens when the delay has passed." : ""}
      </p>
      {phase.kind === "working" && <p className="text-sm text-zinc-300" aria-live="polite">{phase.step}</p>}
      {phase.kind === "error" && <p role="alert" className="text-sm text-red-300">{phase.message}</p>}
      {phase.kind === "done" && (
        <p className={phase.result.status === "confirmed" ? "text-sm text-emerald-300" : "text-sm text-amber-200"} aria-live="polite">
          {phase.result.status === "confirmed" ? "Confirmed" : phase.result.status === "failed" ? `Failed: ${phase.result.error}` : "Sent, not yet confirmed"} · <span className="font-mono text-xs">{phase.result.signature}</span>
        </p>
      )}
    </div>
  );
}
