# Colosseum submission — Presign

Copy-ready text for the Crypto World's Fair submission form (Solana track). Items in `[brackets]` need the team's input. Every number below is reproducible from this repository; every claim about Drift cites a public source (see `/case/drift`).

## Project name

Presign

## One-liner

Presign shows Solana multisig signers what a proposal really does — decoded, simulated, and who controls what afterwards — and Presign Guard lets any one honest signer stop a critical action before it runs.

## Short description (≈280 characters)

Drift lost ~$285M after two council members blind-signed a handover of admin control. Presign decodes every Squads proposal, simulates it, and flags authority leaving the multisig and never-expiring approvals; Presign Guard lets one guardian veto critical actions.

## Full description

**Problem.** On April 1, 2026, about $285M was drained from the users of Drift Protocol (Drift later put the loss at $295.4M). There was no smart-contract bug and no private key was stolen. After a six-month social-engineering operation that, according to Drift, likely compromised two contributors' devices, two of the five Security Council members pre-signed durable-nonce transactions they did not fully understand. The council had moved to a 2-of-5 multisig with zero time lock days earlier. On chain, the proposal that handed Drift's admin to the attacker appeared and executed one second apart (slots 410344005 → 410344009); the other three members never had a chance to look, let alone object.

Two things were missing: a screen that says what a signature does, and a hand that can still say "stop". This is not an edge case. Our read-only census of Solana mainnet (2026-09-27) found **157,117 Squads v4 multisigs; 98.2% have no time lock, and so do 99% of the 18,939 with ten or more transactions**. Of 36 widely used programs (hand-picked: Jupiter, Raydium, Orca, Kamino…), **13 are upgradeable through a Squads v4 multisig and 8 of those have no time lock.**

**Product.** One deterministic engine, three jobs:

- **See — Verify.** Paste a Squads link, a proposal address or `<multisig> #<n>`. Presign loads the proposal from chain, decodes every instruction the vault would run (Squads, SPL, Token-2022, BPF loader, and any Anchor program through the IDL it publishes on chain), simulates it *as the vault* (lookup tables included), and produces a one-screen **Signer Brief**: what executes, which assets move, and for every authority change whether the new holder is the multisig, a single member, nobody, or **an address the multisig does not control**. For votes already cast, Presign reads the proposal's own history: a create, approve or execute that landed inside a durable nonce is flagged as signed in advance, with how long its nonce account had sat unused. The transaction check does the same for the bytes you are about to sign: durable-nonce signatures are flagged as never-expiring, and the message hash is shown to compare on a hardware wallet.
- **Stop — Presign Guard** (on-chain, live on devnet: `A8cpj1d7zxF3T9kZzVn2wkEueGxqGVgd9VaqBA54EDRS`, unaudited). An Anchor program that holds a protocol's critical authorities: anything done with them is scheduled, waits a fixed delay, and any single guardian can veto it. Routine operations stay fast on the multisig; only critical ones wait. A compromised multisig cannot strip the guardians, and a rogue guardian cannot block its own removal (11 program tests). Presign decodes scheduled actions inside proposals, shows the countdown, and prepares veto / execute.
- **Enforce — team policy and alerts.** A team writes its rules once as JSON (approved authority holders, actions that must go through Guard, minimum time lock and threshold, approved programs and recipients, outflow caps, verified upgrades, no durable nonces). Every proposal, alert and API call is checked against it; a rule that cannot be checked is flagged, never assumed. Watchtower sends each new proposal's brief, each vote that lands through a durable nonce, and each scheduled Guard action with its countdown to every signer's Telegram (or Slack / Discord), on a channel the proposer does not control.
- **API + MCP** — the same engine for wallets, custodians and AI agents, with a deterministic `gate` (`block` / `require_human_review` / `no_known_risk`) that an LLM cannot argue past.

**Proof.**
- Run Presign on the exact bytes Drift's council members signed (signatures removed): **CRITICAL — "Admin moves outside the multisig: Drift `updateAdmin` → H7Pi…7ZgL"** and **"Multisig approval that never expires"**, before execution. Inspecting proposal #7 itself flags both votes as **signed in advance with a durable nonce** — nonce accounts that had sat unused for 8 days and 1 day. The chain shows more: an address outside the council created both nonce accounts, naming the two members as authority, and nothing used them until the attack (`docs/research/drift-nonce-trail.md`). An alert on that is our next Watchtower feature; it needs a transaction stream, which we measured at about 240 nonce transactions per second. The council's later proposals #8 and #9 are flagged as requiring the attacker's key as a signer.
- On devnet, the same attack against a guarded protocol: a real Squads multisig schedules "mint authority → attacker" through Presign Guard; Presign marks it CRITICAL before the second approval, Watchtower announces the countdown, an independent guardian vetoes through Presign, and the program refuses to execute it.
- Mainnet checks: real batch proposals (lookup tables included) and a proposal created from a real transaction buffer decode and simulate; a smoke test over 20 active multisigs and 15 recent Squads transactions ran without errors.

**Principles.** Deterministic rules (73, listed in a public catalog at `/rules`); every signal cites the byte, account or IDL field behind it; missing data is never read as safe; the AI layer explains but cannot change a verdict; the web app is read-only — no keys, no signing.

## Landscape

Drift made this problem visible, and several teams now work on it. We list them because judges will know them:

| | What it does | Where Presign differs |
|---|---|---|
| TxScope | Pre-sign threat reports for Solana multisigs, Squads links, Telegram/Slack alerts | Open source; any Anchor program through its on-chain IDL; team policy, API/MCP gate, verified-build checks; and an on-chain veto (Guard), not only a warning |
| Range Security (Squads partner) | Enterprise multisig security: previews, device security, monitoring, incident response | A free, open layer anyone can run; Guard works alongside a Range setup |
| Squads + STRIDE tools (multisig-verifier, monitor, cli) | Decode proposals, show approvals, notify on changes | Risk verdicts with evidence: who controls each authority afterwards, durable nonces, policy violations, simulation |
| Vetowall (same hackathon) | On-chain delays and veto for stablecoin issuers' Token-2022 authorities | Guard covers any critical authority, and comes with the verifier, alerts and policy that tell guardians what to veto |
| Hypernative, Chainalysis GateSigner | Enterprise transaction firewalls and policies | Squads-specific depth, open source, free tier |

## How it uses Solana

- Squads v4 program: all 36 instructions recognized and their security-relevant arguments decoded; 7 account types decoded from bytes (discriminators verified against the IDL in tests), including batches, transaction buffers and vault messages whose program ids come from address lookup tables.
- Anchor IDLs read from chain — the legacy IDL account or, for Anchor 1.x programs, the canonical Program Metadata account — owner-checked, to name any program's instructions and arguments.
- `simulateTransaction` of the vault message with an executing member as fee payer; lookup-table program ids listed statically for simulation; durable nonce detection.
- `getProgramAccounts` census of Squads v4 multisigs; BPF upgradeable loader program data for upgrade authorities.
- Program upgrades: the buffer's code hashed like `solana-verify` (checked against OtterSec's `on_chain_hash` for the live Squads program) and compared with the OtterSec verified-builds registry.
- Presign Guard: an Anchor 1.x program (PDA signer, scheduled instructions executed by CPI after the delay, IDL published through Program Metadata); Presign finds a multisig's guards with `getProgramAccounts` on the proposer field.
- Helius RPC (primary) with public RPC fallback.

## Tech stack

Next.js 16 / React 19 / TypeScript, @solana/web3.js, @solana/spl-token, zod, Vitest (434 tests, no network), Anchor 1.x with LiteSVM (11 program tests), GitHub Actions CI. Node services for Watchtower and the MCP server. Optional explanations through Claude. Apache-2.0.

## Links

- Repository: https://github.com/MERTFARUKDARENDELI/solana-ai-defender
- Live app: https://presign-app.vercel.app (mainnet-beta) · Presign Guard demo: https://presign-devnet.vercel.app (devnet)
- Pitch video: [URL] · Technical demo: [URL]
- Try it: `/case/drift` (replay) · `/verify?q=2LW6PSEjp81xSEttWwXDB6Etb1eKdhYPbFEojYbyhx88%20%237` · devnet demo addresses in `docs/hackathon/devnet-demo.md`

## Team

Team Nonce Sense.

- Mert Faruk Darendeli — [role, relevant background: e.g. security / Solana engineering]
- Nurullah Tarık Köseler — [role, relevant background: e.g. product / go-to-market]
- Why us: [one or two sentences of founder-market fit — what you saw first-hand]

## Go-to-market

1. **Free verifier as the wedge.** Every signer can check a proposal in seconds, with nothing to install. Distribution through signers of the 18,939 Squads multisigs with 10+ transactions, security councils, DAO treasuries and funds, and the Squads / auditor ecosystem.
2. **Team plan (paid).** Watchtower for all signers, team policies, Presign Guard setup, an audit log of what each signer saw. Per multisig, per month. The Solana Foundation's STRIDE program covers large protocols (>$10M TVL) for free; the Team plan targets everyone below that line and teams that want enforcement, not only monitoring.
3. **API / MCP (usage-based).** Wallets, custodians and agent frameworks call the gate before every signature.

Pricing hypotheses to validate: Team $99–$499 per multisig per month; API per verification. Illustrative ceiling for the Team plan alone: 18,939 active multisigs × $99–$499 × 12 ≈ $22M–$113M ARR (an upper bound from on-chain counts, not a forecast).

## What's next

1. **Nonce watch.** Alert every signer when a new durable nonce account names one of them as its authority. Drift's two were created by an address outside the council 8 days and 1 day before the attack. This needs a transaction stream (Geyser), not RPC polling.
2. **Design partners** on Watchtower and team policies; first paid Team plans.
3. **Presign Guard**: external audit, then mainnet with design partners.
4. **Squads v5** support next to v4, then SPL Governance.

## Demand validation

[Fill in after interviews: number of conversations, who, what they said, design partners, pilots / LOIs, Watchtower installs, verifier usage.] Interview kit: `docs/hackathon/customer-discovery.tr.md`.

## What was built during the hackathon

The repository's first commit is 2026-09-23 (within the event window, which opened 2026-09-14). Presign's multisig engine, inspector, Watchtower (self-service bot), MCP server, census, program-upgrade verification, team policy engine, rule catalog, Presign Guard program and UI were built 2026-09-27 onward on top of the transaction-analysis engine; see the public git history.
