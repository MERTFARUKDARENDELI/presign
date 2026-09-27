import type { Metadata } from "next";
import { ExternalLink } from "lucide-react";
import { Address } from "@/components/security/badges";
import { DRIFT_EXPLOIT_TXS, DRIFT_MULTISIG, DRIFT_NEW_ADMIN } from "@/lib/demo/drift";
import { DriftReplay } from "./DriftReplay";

export const metadata: Metadata = {
  title: "The Drift exploit, replayed · Presign",
  description: "The exact transactions two Drift Security Council members pre-signed, run through Presign.",
};

const utc = (s: number) => new Date(s * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";

const SOURCES = [
  { label: "BlockSec — multisig governance compromise via durable nonce", href: "https://blocksec.com/blog/drift-protocol-incident-multisig-governance-compromise-via-durable-nonce-exploitation" },
  { label: "CoinDesk — how a Solana convenience feature let an attacker drain Drift", href: "https://www.coindesk.com/tech/2026/04/02/how-a-solana-feature-designed-for-convenience-let-an-attacker-drain-usd270-million-from-drift" },
  { label: "Chainalysis — lessons from the Drift hack", href: "https://www.chainalysis.com/blog/lessons-from-the-drift-hack/" },
  { label: "TRM Labs — Drift Protocol heist", href: "https://www.trmlabs.com/resources/blog/north-korean-hackers-attack-drift-protocol-in-285-million-heist" },
];

export default function DriftCasePage() {
  const [t1, t2] = DRIFT_EXPLOIT_TXS;
  return (
    <div className="space-y-10">
      <header className="max-w-3xl">
        <p className="text-sm font-semibold uppercase tracking-wider text-red-300">Case study · April 1, 2026</p>
        <h2 className="mt-2 text-3xl font-bold sm:text-4xl">The Drift exploit, replayed</h2>
        <p className="mt-4 text-zinc-400">
          About $285M left Drift Protocol, Solana&apos;s largest perpetuals exchange. Public incident reports agree on the mechanism: no contract bug and no stolen keys. Two of the
          five Security Council members had pre-signed transactions they believed were routine. The transactions used durable nonces, so they never expired — and the
          multisig had no time lock. Below are those exact transactions. Run {"Presign"} on them and see what the signers could have seen.
        </p>
      </header>

      <section aria-labelledby="timeline">
        <h3 id="timeline" className="mb-4 text-sm font-semibold uppercase tracking-wider text-zinc-500">On-chain timeline</h3>
        <ol className="relative space-y-5 border-l border-zinc-800 pl-6">
          <li>
            <p className="text-sm text-zinc-500">Weeks before (per incident reports)</p>
            <p className="text-zinc-200">Two members of the 2-of-5 Security Council sign transactions with durable nonces. The signatures stay valid indefinitely.</p>
          </li>
          <li>
            <p className="text-sm text-zinc-500">{utc(t1.blockTime)} · slot {t1.slot.toLocaleString("en-US")}</p>
            <p className="text-zinc-200">Member <Address value={t1.signer} n={6} />&apos;s pre-signed transaction lands: advance nonce → create proposal #7 → approve it.</p>
            <a href={`https://explorer.solana.com/tx/${t1.signature}`} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200">View on explorer <ExternalLink className="size-3" aria-hidden /></a>
          </li>
          <li>
            <p className="text-sm text-zinc-500">{utc(t2.blockTime)} · slot {t2.slot.toLocaleString("en-US")}</p>
            <p className="text-zinc-200">
              Member <Address value={t2.signer} n={6} />&apos;s pre-signed transaction lands: advance nonce → approve → execute. The vault calls Drift&apos;s <span className="font-mono">updateAdmin</span>: the
              new admin is <Address value={DRIFT_NEW_ADMIN} n={6} />, an address outside the multisig.
            </p>
            <a href={`https://explorer.solana.com/tx/${t2.signature}`} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200">View on explorer <ExternalLink className="size-3" aria-hidden /></a>
          </li>
          <li>
            <p className="text-sm text-zinc-500">Minutes later (per incident reports)</p>
            <p className="text-zinc-200">With admin control, the attacker lists worthless collateral and withdraws real assets.</p>
          </li>
        </ol>
      </section>

      <section aria-labelledby="replay">
        <h3 id="replay" className="mb-2 text-sm font-semibold uppercase tracking-wider text-zinc-500">Run Presign on what they signed</h3>
        <p className="mb-4 max-w-3xl text-sm text-zinc-400">
          Each button sends the exact message bytes that member signed (signatures removed) to the same analysis any signer would use. The multisig <Address value={DRIFT_MULTISIG} n={6} /> and Drift&apos;s
          IDL are read live from mainnet. The simulation fails today because those accounts have since changed — the verdict comes from the bytes themselves.
        </p>
        <DriftReplay />
      </section>

      <section aria-labelledby="sources" className="text-sm">
        <h3 id="sources" className="mb-2 text-sm font-semibold uppercase tracking-wider text-zinc-500">Sources</h3>
        <ul className="space-y-1">
          {SOURCES.map((s) => (
            <li key={s.href}><a href={s.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-zinc-400 hover:text-zinc-200">{s.label} <ExternalLink className="size-3" aria-hidden /></a></li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-zinc-600">Transaction data is public mainnet data. Off-chain details (how signatures were obtained, the drain) are summarized from the reports above.</p>
      </section>
    </div>
  );
}
