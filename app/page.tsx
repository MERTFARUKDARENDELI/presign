import SecurityHeader from "@/components/SecurityHeader";

const appName = process.env.NEXT_PUBLIC_APP_NAME;

export default function Home() {
  return (
    <main className="min-h-screen bg-black text-white">
      <div className="mx-auto flex min-h-screen max-w-7xl flex-col px-6 py-10">
        <SecurityHeader />

        <section className="flex flex-1 flex-col items-center justify-center text-center">
          <div className="mb-6 rounded-full border border-zinc-800 bg-zinc-900 px-4 py-2 text-sm text-zinc-400">
            🛡️ AI-Powered Solana Security
          </div>

          <h2 className="max-w-4xl text-5xl font-bold tracking-tight sm:text-6xl">
            {appName}
            <span className="block text-zinc-500">
              Protect your wallet before you sign.
            </span>
          </h2>

          <p className="mt-6 max-w-2xl text-lg leading-8 text-zinc-400">
            Detect malicious tokens, phishing transactions and wallet
            drainers with AI-powered security analysis.
          </p>

          <div className="mt-10 flex flex-col gap-4 sm:flex-row">
            <button className="rounded-xl bg-white px-6 py-3 font-semibold text-black transition hover:bg-zinc-200">
              Scan Wallet
            </button>

            <button className="rounded-xl border border-zinc-700 px-6 py-3 font-semibold text-white transition hover:bg-zinc-900">
              Analyze Transaction
            </button>
          </div>
        </section>

        <footer className="border-t border-zinc-800 pt-6 text-center text-sm text-zinc-600">
          AI Web3 Security Agent & Defender · Solana
        </footer>
      </div>
    </main>
  );
}