import Image from "next/image";
import Link from "next/link";
import SystemStatus from "@/components/SystemStatus";
import ConnectWallet from "@/components/wallet/ConnectWallet";
import { BRAND } from "@/lib/brand";

const NAV = [
  { href: "/verify", label: "Verify proposal" },
  { href: "/transaction", label: "Transaction" },
  { href: "/case/drift", label: "Drift case" },
  { href: "/docs", label: "API & agents" },
  { href: "/dashboard", label: "Wallet tools" },
];

export default function SecurityHeader() {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-800 pb-5">
      <Link href="/" className="flex items-center gap-3" aria-label={`${BRAND.name} home`}>
        <Image src="/brand/presign-icon.png" alt="" width={40} height={40} priority className="h-10 w-10" />
        <div>
          <h1 className="text-lg font-bold leading-tight">{BRAND.name}</h1>
          <p className="text-xs text-zinc-500">{BRAND.tagline}</p>
        </div>
      </Link>

      <nav aria-label="Main" className="order-3 flex w-full gap-1 overflow-x-auto text-sm sm:order-none sm:w-auto">
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
