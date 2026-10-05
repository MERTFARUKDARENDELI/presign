"use client";

import { WalletReadyState, type WalletName } from "@solana/wallet-adapter-base";
import { useWallet } from "@solana/wallet-adapter-react";

/**
 * Wallet Standard wallets detected in this browser (Phantom, Solflare,
 * Backpack, mobile in-app browsers). Selecting one lets the provider's
 * autoConnect open it — the documented wallet-adapter flow. Only the PUBLIC
 * address is used; Presign never asks for a private key or seed phrase.
 */
export function WalletPicker({ onChoose }: { onChoose?: (name: WalletName) => void }) {
  const { wallets, select } = useWallet();
  const installed = wallets.filter((w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable);
  const notDetected = wallets.filter((w) => w.readyState === WalletReadyState.NotDetected);

  return (
    <div className="space-y-2">
      {installed.length === 0 && (
        <p className="rounded-lg border border-zinc-800 p-3 text-sm text-zinc-400">
          No Solana wallet detected. Install Phantom, Solflare or Backpack, or open this page inside your wallet&apos;s in-app browser. You can still scan any address read-only or try Demo Mode.
        </p>
      )}
      {installed.map((w) => (
        <button
          key={w.adapter.name}
          type="button"
          onClick={() => {
            select(w.adapter.name); // WalletProvider autoConnect performs the connection
            onChoose?.(w.adapter.name);
          }}
          className="flex w-full items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-left text-sm hover:border-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={w.adapter.icon} alt="" className="size-6 rounded" />
          <span className="font-medium">{w.adapter.name}</span>
          <span className="ml-auto text-xs text-zinc-500">{w.adapter.supportedTransactionVersions?.has(0) ? "v0 ✓" : "legacy only"}</span>
        </button>
      ))}
      {notDetected.length > 0 && <p className="text-xs text-zinc-500">Not installed: {notDetected.map((w) => w.adapter.name).join(", ")}</p>}
    </div>
  );
}
