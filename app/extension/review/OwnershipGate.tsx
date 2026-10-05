"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import bs58 from "bs58";
import { BadgeCheck, KeyRound, Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { WalletPicker } from "@/components/wallet/WalletPicker";
import { api, ApiClientError } from "@/lib/client/api";
import { recordEvent } from "@/lib/presign/client";
import type { OwnershipChallenge, VerifiedWallet } from "@/lib/presign/types";

/**
 * Presign approves a signature only for a wallet whose ownership was proven
 * in this browser session (a signature that authorizes nothing). With the
 * extension the wallet lives in the application's tab, so the proof is made
 * here once per session: your wallet extension works on this page too.
 */
export function OwnershipGate({ wallet, onVerified }: { wallet: string; onVerified: () => void }) {
  const { publicKey, signMessage, disconnect } = useWallet();
  const connected = publicKey?.toBase58() ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const short = `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;

  async function verify() {
    if (connected !== wallet || !signMessage) return;
    setBusy(true);
    setError(null);
    try {
      const ch = await api<OwnershipChallenge>("/api/presign/nonce", { json: { walletAddress: wallet } });
      let sig: Uint8Array;
      try {
        sig = await signMessage(new TextEncoder().encode(ch.message));
      } catch {
        setError("You declined the verification in your wallet. Nothing was signed.");
        return;
      }
      const v = await api<VerifiedWallet>("/api/presign/connect/verify", { json: { walletAddress: wallet, message: ch.message, signature: bs58.encode(sig), nonceToken: ch.nonceToken } });
      recordEvent("WALLET_VERIFIED", `Verified ownership of ${v.wallet} (extension review)`);
      onVerified();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Ownership could not be verified.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3 rounded-xl border border-violet-500/30 bg-violet-500/5 p-4 text-sm" aria-labelledby="ownership-title">
      <p id="ownership-title" className="flex items-center gap-2 font-semibold text-zinc-100"><KeyRound className="size-4 text-violet-300" aria-hidden /> Verify that you own {short} (once per session)</p>
      <p className="text-zinc-400">
        Presign signs nothing and holds no keys; it only approves requests for a wallet you have proven is yours. Your wallet will show a message that says it does not authorize any transfer. The review below is already complete — the decision unlocks after this step.
      </p>
      {connected === null && <WalletPicker />}
      {connected !== null && connected !== wallet && (
        <div className="space-y-2">
          <p className="text-amber-200">Your wallet is connected to {connected.slice(0, 4)}…{connected.slice(-4)} here, but the request is for {short}. Switch accounts in your wallet, then reconnect.</p>
          <Button variant="outline" size="sm" onClick={() => void disconnect()}>Disconnect</Button>
        </div>
      )}
      {connected === wallet && (
        <Button onClick={() => void verify()} disabled={busy}>
          {busy ? <><Loader2 className="animate-spin" /> Waiting for your wallet…</> : <><BadgeCheck /> Verify ownership</>}
        </Button>
      )}
      {error && <p className="text-orange-200" role="alert">{error}</p>}
    </section>
  );
}
