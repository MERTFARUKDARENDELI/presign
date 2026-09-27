import { ShieldCheck } from "lucide-react";
import Link from "next/link";
import SystemStatus from "@/components/SystemStatus";
import ConnectWallet from "@/components/wallet/ConnectWallet";

const NAV = [
  { href: "/dashboard", label: "Wallet Scan" },
  { href: "/transaction", label: "Transaction Security" },
  { href: "/demo", label: "Demo" },
];

export default function SecurityHeader() {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-800 pb-5">
      <Link href="/" className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white text-black">
          <ShieldCheck size={22} />
        </div>
        <div>
          <h1 className="text-lg font-bold leading-tight">AI Web3 Security Agent</h1>
          <p className="text-xs text-zinc-500">Solana Security &amp; Defense</p>
        </div>
      </Link>

      <nav className="order-3 flex w-full gap-1 overflow-x-auto text-sm sm:order-none sm:w-auto">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className="whitespace-nowrap rounded-lg px-3 py-1.5 text-zinc-400 hover:bg-zinc-900 hover:text-white">
            {n.label}
          </Link>
        ))}
      </nav>

      <div className="flex items-center gap-2">
        <SystemStatus />
        <ConnectWallet />
      </div>
    </header>
  );
}
