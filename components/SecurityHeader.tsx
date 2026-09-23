import { ShieldCheck } from "lucide-react";

export default function SecurityHeader() {
  return (
    <header className="flex items-center justify-between border-b border-zinc-800 pb-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white text-black">
          <ShieldCheck size={22} />
        </div>

        <div>
          <h1 className="text-xl font-bold">
            AI Web3 Security Agent
          </h1>

          <p className="text-sm text-zinc-500">
            Solana Security & Defense
          </p>
        </div>
      </div>

      <div className="rounded-full border border-green-500/30 bg-green-500/10 px-4 py-2 text-sm text-green-400">
        <span className="mr-2">●</span>
        System Online
      </div>
    </header>
  );
}