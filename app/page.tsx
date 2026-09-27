import { Activity, Brain, Flame, ScanSearch, ShieldAlert } from "lucide-react";
import Link from "next/link";

const FLOW = [
  { icon: ScanSearch, title: "Scan", body: "Real on-chain balances, SPL / Token-2022 accounts, NFTs and cNFTs." },
  { icon: ShieldAlert, title: "Detect", body: "Deterministic rules: freeze & mint authority, permanent delegate, liquidity, phishing metadata." },
  { icon: Activity, title: "Simulate", body: "Decode and simulate a transaction before you sign — see exactly which assets move and where." },
  { icon: Brain, title: "Explain", body: "An AI agent explains the evidence. It cannot change risk levels or sign anything." },
  { icon: Flame, title: "Clean", body: "Burn, close and revoke eligible accounts — simulated, verified and signed only in your wallet." },
];

export default function Home() {
  return (
    <div className="flex flex-1 flex-col">
      <section className="flex flex-col items-center py-12 text-center sm:py-20">
        <div className="mb-6 rounded-full border border-zinc-800 bg-zinc-900 px-4 py-1.5 text-sm text-zinc-400">
          🛡️ AI-powered Solana security · evidence first
        </div>
        <h2 className="max-w-4xl text-4xl font-bold tracking-tight sm:text-6xl">
          Simulate before you sign.
          <span className="block text-zinc-500">Detect scams. Clean your wallet.</span>
        </h2>
        <p className="mt-6 max-w-2xl text-base leading-7 text-zinc-400 sm:text-lg">
          We don&apos;t just show risks. We simulate attacks before they happen, and help you clean your wallet — with every
          finding backed by on-chain evidence.
        </p>
        <div className="mt-10 flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
          <Link href="/dashboard" className="rounded-xl bg-white px-6 py-3 font-semibold text-black transition hover:bg-zinc-200">
            Scan Wallet
          </Link>
          <Link href="/transaction" className="rounded-xl border border-zinc-700 px-6 py-3 font-semibold text-white transition hover:bg-zinc-900">
            Analyze Transaction
          </Link>
          <Link href="/demo" className="rounded-xl border border-fuchsia-500/40 px-6 py-3 font-semibold text-fuchsia-200 transition hover:bg-fuchsia-500/10">
            Try Demo (no wallet)
          </Link>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {FLOW.map((f, i) => (
          <div key={f.title} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <div className="mb-3 flex items-center gap-2 text-zinc-300">
              <f.icon className="size-5" />
              <span className="text-xs text-zinc-500">{i + 1}</span>
              <span className="font-semibold">{f.title}</span>
            </div>
            <p className="text-sm text-zinc-400">{f.body}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
