import { ArrowRight, Bot, BellRing, Clock, FileSearch, Hourglass, KeyRound, Landmark, ListChecks, Scale, ShieldAlert, SlidersHorizontal, Users } from "lucide-react";
import { RULE_CATALOG } from "@/lib/security/catalog";
import Link from "next/link";
import { BRAND } from "@/lib/brand";
import census from "@/docs/research/multisig-census.json";

const CATCHES = [
  { icon: KeyRound, title: "Control leaving the multisig", body: "Admin, upgrade and token authorities handed to an address the multisig does not control — decoded from the program's own IDL." },
  { icon: Clock, title: "Approvals that never expire", body: "Durable-nonce signatures that can be held for weeks and replayed at the attacker's chosen moment." },
  { icon: Landmark, title: "Treasury drains", body: "Every proposal simulated as the vault executing it now: exactly which assets leave, and to whom." },
  { icon: SlidersHorizontal, title: "Weakened governance", body: "Lower thresholds, removed time locks, new members, single-key config authorities." },
];

const STEPS = [
  { title: "Load", body: "Proposal, vault transaction and multisig config, straight from chain." },
  { title: "Decode", body: "Squads, SPL, Token-2022, BPF loader — and any Anchor program via its on-chain IDL." },
  { title: "Simulate", body: "As the vault, with the executing member paying the fee." },
  { title: "Rule", body: "Deterministic rules. Every signal cites the byte, account or IDL field behind it." },
  { title: "Brief", body: "One screen: what you authorize, who controls what afterwards, what could not be verified." },
];

const PRINCIPLES = [
  { icon: Scale, title: "Never \"safe\" by default", body: "Missing data is never read as safety. Incomplete checks say so, and the verdict stays unrated." },
  { icon: ListChecks, title: "Evidence, not scores", body: "Each finding links to the exact on-chain fact it comes from, so a co-signer can check it independently." },
  { icon: Bot, title: "AI explains, never decides", body: "The risk verdict comes from deterministic rules. An AI layer may explain it; it cannot change it." },
  { icon: ShieldAlert, title: "Read-only", body: "No keys, no seed phrases, no signing. Presign reads the chain and your pasted input — nothing else." },
];

const AUDIENCES = [
  { icon: Users, title: "Multisig signers & security councils", body: "Verify a proposal from a second, independent screen before approving it.", href: "/verify", cta: "Verify a proposal" },
  { icon: BellRing, title: "Protocol & treasury teams", body: "Watchtower sends every new proposal's brief to all signers the moment it is created, checked against your own team policy.", href: "/docs#policy", cta: "Set up alerts & policy" },
  { icon: Bot, title: "Wallets, custodians & AI agents", body: "The same engine over HTTP and MCP: a pre-sign check an LLM cannot talk its way past.", href: "/docs", cta: "Use the API" },
];

export default function Home() {
  return (
    <div className="flex flex-1 flex-col gap-16 pb-8">
      <section className="flex flex-col items-center pt-10 text-center sm:pt-16">
        <div className="mb-6 rounded-full border border-zinc-800 bg-zinc-900 px-4 py-1.5 text-sm text-zinc-400">Pre-sign verification for Solana multisigs</div>
        <h2 className="max-w-4xl text-4xl font-bold tracking-tight sm:text-6xl">{BRAND.tagline}</h2>
        <p className="mt-6 max-w-2xl text-base leading-7 text-zinc-400 sm:text-lg">
          On April 1, 2026, about $285M was drained from Drift&apos;s users. No contract bug, no stolen private key: after months of social engineering, two Security Council members had pre-signed approvals they did not fully understand.
          {" "}{BRAND.name} decodes every multisig proposal, simulates it, and tells signers — in one sentence, with evidence — who controls what afterwards.
        </p>
        <div className="mt-10 flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
          <Link href="/verify" className="inline-flex items-center justify-center gap-2 rounded-xl bg-white px-6 py-3 font-semibold text-black transition hover:bg-zinc-200">
            <FileSearch className="size-4" aria-hidden /> Verify a proposal
          </Link>
          <Link href="/case/drift" className="inline-flex items-center justify-center gap-2 rounded-xl border border-red-500/40 px-6 py-3 font-semibold text-red-200 transition hover:bg-red-500/10">
            Replay the Drift attack <ArrowRight className="size-4" aria-hidden />
          </Link>
        </div>
        <Link href="/transaction" className="mt-4 text-sm text-zinc-500 underline-offset-4 hover:text-zinc-300 hover:underline">or analyze any transaction before you sign it</Link>
      </section>

      <section aria-labelledby="numbers" className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
        <h3 id="numbers" className="mb-4 text-sm font-semibold uppercase tracking-wider text-zinc-500">Solana multisigs today</h3>
        <dl className="grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-sm text-zinc-400">Squads v4 multisigs on mainnet</dt>
            <dd className="text-3xl font-bold tabular-nums">{census.multisigs.all.count.toLocaleString("en-US")}</dd>
          </div>
          <div>
            <dt className="text-sm text-zinc-400">of them with no time lock</dt>
            <dd className="text-3xl font-bold tabular-nums text-red-300">{census.multisigs.all.noTimeLockPct}%</dd>
          </div>
          <div>
            <dt className="text-sm text-zinc-400">major programs upgradeable through a Squads multisig without a time lock</dt>
            <dd className="text-3xl font-bold tabular-nums text-orange-300">{census.programs.squadsV4Config.noTimeLock} of {census.programs.squadsV4}</dd>
          </div>
        </dl>
        <p className="mt-4 text-xs text-zinc-500">
          Read-only mainnet census, {census.generatedAt.slice(0, 10)}: every Squads v4 multisig account, and the upgrade authority of {census.programs.checked} widely used programs. Aggregates only. No time lock means an
          approved proposal executes the moment its threshold is reached — as Drift&apos;s did.
        </p>
      </section>

      <section aria-labelledby="catches">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h3 id="catches" className="text-sm font-semibold uppercase tracking-wider text-zinc-500">What {BRAND.name} catches</h3>
          <Link href="/rules" className="text-sm text-fuchsia-300 underline-offset-4 hover:underline">All {RULE_CATALOG.length} rules →</Link>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {CATCHES.map((c) => (
            <div key={c.title} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
              <c.icon className="mb-3 size-5 text-fuchsia-300" aria-hidden />
              <p className="font-semibold">{c.title}</p>
              <p className="mt-1 text-sm text-zinc-400">{c.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="how">
        <h3 id="how" className="mb-4 text-sm font-semibold uppercase tracking-wider text-zinc-500">How it works</h3>
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {STEPS.map((s, i) => (
            <li key={s.title} className="rounded-xl border border-zinc-800 p-4">
              <p className="text-xs text-zinc-500">{i + 1}</p>
              <p className="font-semibold">{s.title}</p>
              <p className="mt-1 text-sm text-zinc-400">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="guard" className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <Hourglass className="size-6 shrink-0 text-fuchsia-300" aria-hidden />
          <div className="space-y-2">
            <h3 id="guard" className="font-semibold">
              Presign Guard <span className="ml-1 rounded border border-sky-500/40 px-1.5 text-xs font-normal text-sky-200">on devnet</span>
            </h3>
            <p className="text-sm text-zinc-400">
              A warning helps only if someone can act on it. Presign Guard is an on-chain program that holds a protocol&apos;s critical authorities: anything done with them is
              scheduled, waits a fixed delay, and any single guardian can veto it — even a compromised multisig cannot remove the guardians. Routine operations stay fast.
            </p>
            <p className="text-xs text-zinc-500">
              Live on devnet with a real Squads multisig: a Drift-style takeover was scheduled, flagged CRITICAL, and vetoed by one guardian. Unaudited — devnet only.{" "}
              <Link href="/docs#presign-guard" className="text-fuchsia-300 underline-offset-4 hover:underline">How it works</Link>
            </p>
          </div>
        </div>
      </section>

      <section aria-labelledby="who">
        <h3 id="who" className="mb-4 text-sm font-semibold uppercase tracking-wider text-zinc-500">Built for</h3>
        <div className="grid gap-3 lg:grid-cols-3">
          {AUDIENCES.map((a) => (
            <Link key={a.title} href={a.href} className="group rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 transition hover:border-zinc-600">
              <a.icon className="mb-3 size-5 text-zinc-300" aria-hidden />
              <p className="font-semibold">{a.title}</p>
              <p className="mt-1 text-sm text-zinc-400">{a.body}</p>
              <p className="mt-3 inline-flex items-center gap-1 text-sm text-fuchsia-300">{a.cta} <ArrowRight className="size-3.5 transition group-hover:translate-x-0.5" aria-hidden /></p>
            </Link>
          ))}
        </div>
      </section>

      <section aria-labelledby="principles">
        <h3 id="principles" className="mb-4 text-sm font-semibold uppercase tracking-wider text-zinc-500">Principles</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {PRINCIPLES.map((p) => (
            <div key={p.title} className="flex gap-3 rounded-xl border border-zinc-800 p-4">
              <p.icon className="mt-0.5 size-5 shrink-0 text-zinc-300" aria-hidden />
              <div>
                <p className="font-semibold">{p.title}</p>
                <p className="mt-1 text-sm text-zinc-400">{p.body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <p className="text-center text-sm text-zinc-500">
        Also included: <Link href="/dashboard" className="underline-offset-4 hover:text-zinc-300 hover:underline">wallet & token risk scanner</Link> ·{" "}
        <Link href="/demo" className="underline-offset-4 hover:text-zinc-300 hover:underline">guided demo (no wallet)</Link>
      </p>
    </div>
  );
}
