"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { BadgeCheck, LogOut, Wallet } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { WALLET_ERROR_EVENT } from "@/components/providers/WalletProviders";
import { shortAddr } from "@/components/security/badges";
import { clearVerifiedSession, fetchSession } from "@/lib/presign/client";

/**
 * Header wallet control. "Connect wallet" never opens a wallet directly: it
 * starts Presign Secure Connect (/connect), which checks the connection
 * context first. Once connected, the address and its ownership status show.
 */
export default function ConnectWallet() {
  const { wallet, publicKey, connected, disconnect } = useWallet();
  const pathname = usePathname();
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState<{ wallet: string; checkedFor: string } | null>(null);
  const address = publicKey?.toBase58() ?? null;

  useEffect(() => {
    const onError = (e: Event) => setError((e as CustomEvent<string>).detail);
    window.addEventListener(WALLET_ERROR_EVENT, onError);
    return () => window.removeEventListener(WALLET_ERROR_EVENT, onError);
  }, []);

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    const load = () =>
      fetchSession()
        .then((s) => !cancelled && setVerified({ wallet: s.verified?.wallet ?? "", checkedFor: address }))
        .catch(() => !cancelled && setVerified({ wallet: "", checkedFor: address }));
    void load();
    window.addEventListener("presign-session", load);
    return () => {
      cancelled = true;
      window.removeEventListener("presign-session", load);
    };
  }, [address]);

  if (connected && address) {
    const isVerified = verified?.checkedFor === address && verified.wallet === address;
    return (
      <div className="flex items-center gap-2">
        <span className="hidden items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 font-mono text-xs text-zinc-300 sm:inline-flex" title={address}>
          {wallet?.adapter.name}: {shortAddr(address)}
          {isVerified ? (
            <span className="inline-flex items-center gap-0.5 font-sans text-emerald-300" title="Ownership verified in this session"><BadgeCheck className="size-3.5" aria-hidden /> verified</span>
          ) : (
            <Link href={`/connect?next=${encodeURIComponent(pathname || "/dashboard")}`} className="font-sans text-amber-200 underline">verify</Link>
          )}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void clearVerifiedSession().catch(() => null).finally(() => window.dispatchEvent(new Event("presign-session")));
            void disconnect();
          }}
          aria-label="Disconnect wallet"
        >
          <LogOut /> <span className="sm:hidden">{shortAddr(address)}</span>
          <span className="hidden sm:inline">Disconnect</span>
        </Button>
      </div>
    );
  }

  return (
    <>
      {/* From the homepage the flow ends on the wallet dashboard; from a tool page it returns there. */}
      <Link href={`/connect${pathname && pathname !== "/" && pathname !== "/connect" ? `?next=${encodeURIComponent(pathname)}` : ""}`} className={buttonVariants({ size: "sm" })}>
        <Wallet /> Connect wallet
      </Link>
      {error && <span className="max-w-48 truncate text-xs text-red-300" title={error}>{error}</span>}
    </>
  );
}
