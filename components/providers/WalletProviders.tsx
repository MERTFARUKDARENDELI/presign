"use client";

import { Buffer } from "buffer";
import type { WalletError } from "@solana/wallet-adapter-base";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { useCallback, type ReactNode } from "react";

// @solana/web3.js expects a global Buffer in the browser.
if (typeof window !== "undefined" && !(globalThis as { Buffer?: unknown }).Buffer) {
  (globalThis as { Buffer?: unknown }).Buffer = Buffer;
}

/** Cluster the browser-side wallet context uses; must equal the server's SOLANA_CLUSTER. */
export const CLIENT_CLUSTER = process.env.NEXT_PUBLIC_SOLANA_CLUSTER === "devnet" ? "devnet" : "mainnet-beta";

const PUBLIC_ENDPOINT = CLIENT_CLUSTER === "devnet" ? "https://api.devnet.solana.com" : "https://api.mainnet-beta.solana.com";

export const WALLET_ERROR_EVENT = "wallet-adapter-error";

/**
 * Client-only wallet context. Phantom, Solflare, Backpack… register through
 * the Wallet Standard (and the Mobile Wallet Adapter on Android), so no
 * adapter list is bundled. `autoConnect` connects the wallet the user just
 * selected (and restores the last selection on reload); only the PUBLIC key
 * is ever read. The connection endpoint is public and used by the adapter for
 * mobile cluster detection — app data goes through the server API.
 */
export default function WalletProviders({ children }: { children: ReactNode }) {
  const onError = useCallback((error: WalletError) => {
    window.dispatchEvent(new CustomEvent(WALLET_ERROR_EVENT, { detail: error.message || error.name || "Wallet error" }));
  }, []);

  return (
    <ConnectionProvider endpoint={PUBLIC_ENDPOINT}>
      <WalletProvider wallets={[]} autoConnect onError={onError}>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}
