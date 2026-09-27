"use client";

import { WalletReadyState, type WalletName } from "@solana/wallet-adapter-base";
import { useWallet } from "@solana/wallet-adapter-react";
import { LogOut, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { WALLET_ERROR_EVENT } from "@/components/providers/WalletProviders";
import { shortAddr } from "@/components/security/badges";

/**
 * Connects via Wallet Standard wallets (Phantom, Solflare, Backpack, mobile
 * in-app browsers). Selecting a wallet lets the provider's autoConnect open
 * it — the documented wallet-adapter flow. Only the PUBLIC address is used;
 * this app never asks for private keys or seed phrases.
 */
export default function ConnectWallet() {
  const { wallets, wallet, publicKey, connecting, connected, select, disconnect } = useWallet();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onError = (e: Event) => setError((e as CustomEvent<string>).detail);
    window.addEventListener(WALLET_ERROR_EVENT, onError);
    return () => window.removeEventListener(WALLET_ERROR_EVENT, onError);
  }, []);

  const installed = wallets.filter((w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable);
  const notDetected = wallets.filter((w) => w.readyState === WalletReadyState.NotDetected);

  function choose(name: WalletName) {
    setError(null);
    select(name); // WalletProvider autoConnect performs the connection
    setOpen(false);
  }

  if (connected && publicKey) {
    return (
      <div className="flex items-center gap-2">
        <span className="hidden rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 font-mono text-xs text-zinc-300 sm:inline" title={publicKey.toBase58()}>
          {wallet?.adapter.name}: {shortAddr(publicKey.toBase58())}
        </span>
        <Button variant="outline" size="sm" onClick={() => void disconnect()} aria-label="Disconnect wallet">
          <LogOut /> <span className="sm:hidden">{shortAddr(publicKey.toBase58())}</span>
          <span className="hidden sm:inline">Disconnect</span>
        </Button>
      </div>
    );
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} disabled={connecting}>
        <Wallet /> {connecting ? "Connecting…" : "Connect wallet"}
      </Button>
      {error && !open && <span className="max-w-48 truncate text-xs text-red-300" title={error}>{error}</span>}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="border-zinc-800 bg-zinc-950 text-zinc-100">
          <DialogHeader>
            <DialogTitle>Connect a Solana wallet</DialogTitle>
            <DialogDescription>
              Only your public address is used. This app will never ask for your private key or seed phrase.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {installed.length === 0 && (
              <p className="rounded-lg border border-zinc-800 p-3 text-sm text-zinc-400">
                No Solana wallet detected. Install Phantom or Solflare, or open this page inside your wallet&apos;s in-app browser. You can still scan any address read-only or try Demo Mode.
              </p>
            )}
            {installed.map((w) => (
              <button
                key={w.adapter.name}
                type="button"
                onClick={() => choose(w.adapter.name)}
                className="flex w-full items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-left text-sm hover:border-zinc-600"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={w.adapter.icon} alt="" className="size-6 rounded" />
                <span className="font-medium">{w.adapter.name}</span>
                <span className="ml-auto text-xs text-zinc-500">{w.adapter.supportedTransactionVersions?.has(0) ? "v0 ✓" : "legacy only"}</span>
              </button>
            ))}
            {notDetected.length > 0 && <p className="text-xs text-zinc-500">Not installed: {notDetected.map((w) => w.adapter.name).join(", ")}</p>}
            {error && <p className="text-sm text-red-300">{error}</p>}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
