# Colosseum submission — Presign

Copy-ready text for the Crypto World's Fair submission form (Solana track). Items in `[brackets]` need the team's input. Every number below is reproducible from this repository.

## Project name

Presign

## One-liner

Presign tells Solana multisig signers exactly what they are about to approve — decoded, simulated and checked for who controls what afterwards — before they sign.

## Short description (≈280 characters)

Drift lost ~$285M because two multisig signers approved transactions they couldn't read. Presign decodes every Squads proposal, simulates it as the vault, and flags authority leaving the multisig, never-expiring approvals and treasury drains — with evidence.

## Full description

**Problem.** On April 1, 2026, about $285M left Drift Protocol in minutes. There was no smart-contract bug and no stolen key: two of the five Security Council members had pre-signed durable-nonce transactions that looked routine, on a 2-of-5 Squads multisig with no time lock. One of those transactions handed Drift's admin role to an attacker-controlled address. Nothing the signers used showed that.

This is not an edge case. Our read-only census of Solana mainnet (2026-09-27) found **157,117 Squads v4 multisigs; 98.2% have no time lock**, so an approved proposal executes the instant it reaches its threshold. Of 36 widely used programs, **13 are upgradeable through a Squads v4 multisig and 8 of those have no time lock.** Signers of these multisigs approve bytes, guided by whatever the proposal's creator wrote.

**Product.** Presign is a pre-sign verification layer for multisig signers:

- **Verify** — paste a Squads link, a proposal address or `<multisig> #<n>`. Presign loads the proposal from chain, decodes every instruction the vault would run (Squads, SPL, Token-2022, BPF loader, and any Anchor program through its on-chain IDL), simulates it *as the vault*, and produces a one-screen **Signer Brief**: what executes, which assets move, and for every authority change whether the new holder is the multisig, a single member, nobody, or **an address the multisig does not control**.
- **Transaction check** — paste the transaction you are about to sign. Squads approvals include the proposal they approve; durable-nonce signatures are flagged as never-expiring; the message hash is shown to compare on a hardware wallet.
- **Watchtower** — each new proposal's brief is pushed to every signer (Telegram / Slack / Discord), independent of the UI that created it.
- **API + MCP** — the same engine for wallets, custodians and AI agents, with a deterministic `gate` (`block` / `require_human_review` / `no_known_risk`) that an LLM cannot argue past.

**Proof.** Run Presign on the exact bytes Drift's council members signed (signatures removed) and it returns **CRITICAL: "Admin moves outside the multisig — Drift `updateAdmin` → H7Pi…7ZgL"** and **"Multisig approval that never expires"** — before execution. The same check flags the council's later proposals #8 and #9 as requiring the attacker's key as a signer.

**Principles.** Deterministic rules; every signal cites the byte, account or IDL field behind it; missing data is never read as safe; the AI layer explains but cannot change a verdict; read-only — no keys, no signing.

## How it uses Solana

- Squads v4 program: all 36 instructions recognized and their security-relevant arguments decoded; 7 account types decoded from bytes (discriminators verified against the IDL in tests), including vault messages whose program ids come from address lookup tables.
- Anchor on-chain IDL accounts (owner-checked) to name any program's instructions and arguments.
- `simulateTransaction` of the vault message with an executing member as fee payer; address lookup table resolution; durable nonce detection.
- `getProgramAccounts` census of Squads v4 multisigs; BPF upgradeable loader program data for upgrade authorities.
- Helius RPC (primary) with public RPC fallback.

## Tech stack

Next.js 16 / React 19 / TypeScript, @solana/web3.js, @solana/spl-token, zod, Vitest (362 tests, no network). Node services for Watchtower and the MCP server. Apache-2.0.

## Links

- Repository: [public GitHub URL]
- Live app: [deployment URL]
- Pitch video: [URL] · Technical demo: [URL]
- Try it: `/case/drift` (replay) · `/verify?q=2LW6PSEjp81xSEttWwXDB6Etb1eKdhYPbFEojYbyhx88%20%237`

## Team

- [Name 1] — [role, relevant background: e.g. security / Solana engineering]
- [Name 2] — [role, relevant background: e.g. product / go-to-market]
- Why us: [one or two sentences of founder-market fit — what you saw first-hand]

## Go-to-market

1. **Free verifier as the wedge.** Every signer can check a proposal in seconds, with nothing to install. Distribution through signers of the 18,939 Squads multisigs with 10+ transactions, security councils of top protocols, and the Squads / auditor ecosystem.
2. **Team plan (paid).** Watchtower for all signers, policies (allowlisted authorities, required time lock), audit log of what each signer saw. Per multisig, per month.
3. **API / MCP (usage-based).** Wallets, custodians and agent frameworks call the gate before every signature.

Pricing hypotheses to validate: Team $99–$499 per multisig per month; API per verification. Illustrative ceiling for the Team plan alone: 18,939 active multisigs × $99–$499 × 12 ≈ $22M–$113M ARR (not a forecast).

## Demand validation

[Fill in after interviews: number of conversations, who, what they said, design partners, pilots / LOIs, Watchtower installs, verifier usage.] Interview kit: `docs/hackathon/customer-discovery.tr.md`.

## What was built during the hackathon

The repository's first commit is 2026-09-23 (within the event window). Presign's multisig engine, inspector, Watchtower, MCP server, census and UI were built 2026-09-27 onward on top of the transaction-analysis engine; see the git history.
