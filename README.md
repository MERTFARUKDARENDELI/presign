# Presign — know exactly what you sign

Pre-sign verification for Solana multisigs. Presign loads a Squads proposal (or the transaction you are about to sign), decodes every instruction the vault would run, simulates it, and tells each signer — in one sentence, with evidence — **what it does and who controls what afterwards**.

> On April 1, 2026, about $285M was drained from Drift Protocol's users (Drift later put the loss at $295M). There was no contract bug and no private key was stolen: after a months-long social-engineering operation, two of five Security Council members had pre-signed durable-nonce transactions they did not fully understand, on a 2-of-5 multisig whose time lock had been removed days earlier. The proposal that handed over Drift's admin appeared on chain and executed one second apart. Run Presign on the exact bytes they signed and it answers **CRITICAL — "Admin moves outside the multisig" · "This signature never expires"** before anything is executed. See [`/case/drift`](app/case/drift/page.tsx).

## Why

- **157,117** Squads v4 multisigs exist on Solana mainnet; **98.2%** have no time lock, so an approved proposal executes the moment its threshold is reached. Of 36 widely used programs, **13** are upgradeable through a Squads v4 multisig and **8** of those have no time lock. ([read-only census](docs/research/multisig-census.json), 2026-09-27)
- Signers see bytes and a Squads UI summary. Wallet previews are built for dApp drainers, not for governance: they do not tell you that an `updateAdmin` argument hands your protocol to an address the multisig does not control, or that a signature will stay valid for weeks.

## What it does

| Surface | For | What you get |
|---|---|---|
| **`/verify`** | Multisig signers | Paste a Squads link, a proposal / transaction / multisig address, or `<multisig> #<n>` → the proposal brief, votes, decoded vault instructions, simulated vault balance changes, and every authority change classified as *outside the multisig / single member / removed / internal*. A multisig address gives its setup risks and recent proposals with verdicts. |
| **`/transaction`** | Anyone about to sign | Paste the serialized transaction (or a signature) → decode, simulate, rules. Squads approvals include the proposal they approve; durable nonces are flagged; the message hash is shown to compare on a hardware wallet. |
| **Watchtower** | Protocol & treasury teams | Add the bot to the signers' Telegram group and send `/watch <multisig>`: every new proposal's brief reaches every signer — an independent second channel — and so does any vote that lands on a pending proposal through a durable nonce. Also Slack / Discord webhooks. |
| **Presign Guard** (on-chain, live on devnet, unaudited) | Protocols with critical authorities | A Solana program that holds admin / upgrade / mint authorities: actions using them are scheduled, wait a fixed delay, and any single guardian can veto them. Presign shows the countdown and offers veto / execute. See [`guard/DESIGN.md`](guard/DESIGN.md). |
| **Team policy** | Teams with rules | One JSON file: approved authority holders, actions that must go through Presign Guard, minimum time lock / threshold, approved programs and recipients, outflow caps, verified upgrades, no durable nonces. Checked on every proposal in `/verify`, the API, Watchtower and MCP; a rule that cannot be checked is flagged, never assumed. See [`/docs#policy`](app/docs/page.tsx). |
| **HTTP API & MCP server** | Wallets, custodians, bots, AI agents | The same engine as JSON, and as MCP tools for agents. Every result carries a deterministic `gate`: `block` / `require_human_review` / `no_known_risk`. |
| **Wallet & token tools** | Holders | The original scanner: token authorities, Token-2022 extensions, concentration, age, metadata phishing, cleanup (burn / close / revoke). |

### Detections (deterministic, evidence-linked)

The full list — code, severity and trigger of every rule — is the [rule catalog](app/rules/page.tsx) (`/rules`), kept in sync with the rule sources by a test.

- **Authority leaving the multisig** — admin / upgrade / token authority handed to an address that is not the multisig, one of its vaults, or a member (CRITICAL); to a single member (HIGH); removed permanently (HIGH).
- **Approvals that never expire** — Squads create / approve / execute inside a durable-nonce transaction (CRITICAL).
- **Votes signed in advance** — a create / approve / execute already on chain that landed inside a durable nonce, read from the proposal's own history, with how long the nonce account had sat unused (HIGH). On Drift's proposal #7: both votes, nonce accounts idle for 8 days and 1 day.
- **Treasury drains** — the vault's simulated balance changes: outflows, near-total drains, approvals.
- **Governance weakening** — threshold lowered or set to 1, time lock removed, members added / removed, single-key config authority.
- **Unverifiable content** — proposals whose contents cannot be loaded or decoded are never "no risk"; required signers the multisig cannot provide are flagged.
- **Setup posture** — no time lock, minority threshold, single signature, controlled config.
- **Program upgrades** — the new code's hash (computed like `solana-verify`) checked against the OtterSec verified-builds registry; an unreadable buffer is HIGH.
- **Actions scheduled through Presign Guard** — decoded and classified like immediate ones; one level lower when the guard's delay and veto are verified on-chain, unchanged otherwise.
- Plus everything from the transaction engine: unlimited approvals, owner reassignment, CPI guard, unexpected outflows, phishing links in memos.

## How it works

```text
input (Squads link · address · serialized tx · signature)
  → load from chain       multisig config, proposal, vault / config transaction, transaction buffer
  → decode                Squads v4 (36 instructions, 7 accounts incl. batches), SPL Token, Token-2022,
                          System, BPF upgradeable loader, Presign Guard, and any Anchor program via its
                          on-chain IDL (legacy IDL account or Anchor 1.x Program Metadata)
  → simulate              the vault message as-is, with an executing member prepended as fee payer
  → rules                 deterministic; every signal cites the instruction, account or IDL field
  → brief + gate          one screen for humans, one word for machines
```

Design rules carried over from the original engine:

- **Risk level and analysis status are separate.** `SAFE` is only possible when every required check completed; missing data yields `UNKNOWN` / `PARTIAL`, never `SAFE`.
- **Every signal references evidence** (source, observed value, rule); the engine throws if one does not.
- **Names from an IDL state intent, not behavior**, and are labelled as such. An IDL account not owned by the program is ignored.
- **The AI layer explains; it never decides.** Verdicts and gates come from rules.
- **Read-only.** No keys, no seed phrases, no server-side signing.

## Getting started

Requirements: Node.js 24 (22.18+ for the Watchtower / MCP scripts), npm, a Helius API key (recommended).

```bash
npm install
cp .env.example .env.local        # set HELIUS_API_KEY; SOLANA_CLUSTER=mainnet-beta for real multisigs
npm run dev                       # http://localhost:3000
```

```bash
npm run typecheck && npm run lint && npm test && npm run build
npm run watchtower                # TELEGRAM_BOT_TOKEN and/or WATCH_MULTISIGS (reads .env.local); -- --once for one cycle
                                  # always-on: Dockerfile.watchtower (e.g. Railway, WATCH_DB on a volume)
npm run mcp                       # MCP server on stdio; PRESIGN_API_URL points at your instance
node scripts/research/multisig-census.ts   # re-run the mainnet census (read-only)
```

API reference, the gate, MCP client configuration and Watchtower setup: [`/docs`](app/docs/page.tsx).

## Verification status

- **Mainnet, read-only:** both Drift exploit transactions analyzed by signature and from their unsigned bytes (CRITICAL); both votes on proposal #7 flagged as signed in advance, and the nonce accounts traced to their creation by an address outside the council ([notes](docs/research/drift-nonce-trail.md)); the Drift Security Council multisig inspected live (proposal #7 admin takeover; #8 / #9 require the attacker's key as signer); census of all 157,117 Squads v4 multisigs; MCP and Watchtower exercised against a running instance.
- **Program hashes:** the `solana-verify` convention was checked against OtterSec's `on_chain_hash` for the live Squads v4 program (`scripts/research/hash-check.ts`).
- **Tests:** 434, deterministic, no network (RPC mocked at the edge). Squads and Guard discriminators are recomputed from names in tests; the Drift fixtures are real mainnet bytes. CI runs typecheck, lint, tests and build on every push.
- **Presign Guard program:** deployed on devnet (`A8cpj1d7zxF3T9kZzVn2wkEueGxqGVgd9VaqBA54EDRS`, IDL published); 11 LiteSVM tests of its invariants pass; its IDL is checked against the TypeScript codec; the full scenario ran end-to-end on devnet with a real Squads v4 multisig — takeover scheduled, CRITICAL in Presign, vetoed through Presign by an independent guardian, execution refused by the program. Unaudited.
- **Batches and buffers on mainnet:** real batch proposals (up to 7 transactions, lookup tables included) decode and simulate, showing each transaction's vault outflows; a proposal created from a real pending transaction buffer decodes from the buffer.
- **Live deployments:** https://solana-ai-defender.vercel.app (mainnet-beta: Drift replay, `/verify` on real multisigs) and https://solana-ai-defender-devnet.vercel.app (devnet: Presign Guard demo). Watchtower's Telegram bot answered `/check` and `/watch` (devnet multisig and guard) in a real group, asking the devnet instance.
- **Not yet verified:** an alert delivered to Telegram and Slack / Discord webhook delivery (formatting and escaping are unit-tested); wallet-extension signing and mobile wallets (see [PROJECT_STATUS.md](PROJECT_STATUS.md)); live Claude explanations (needs an `ANTHROPIC_API_KEY`).

## Limitations

- Squads v4 only (v3 and other multisig programs are not decoded). Batches are inspected up to their first 10 transactions; larger batches are reported as partially inspected.
- Name-based classification of Anchor instructions (e.g. `update_admin`) depends on the program publishing an IDL; without one, the payload is reported `PARTIAL`, not safe.
- Vault simulation reflects current state; it can differ at execution (an executed or underfunded proposal simulates as failing, and says so). Program ids that a proposal loads from a lookup table are listed directly for the simulation, since only the multisig program can invoke them that way; a message that becomes too large is reported as not simulated.
- Rate limiting and caching are in-memory (per instance). Watchtower is a single process with a local SQLite file; Telegram is the only self-service channel so far.
- Presign Guard protects only the authorities handed to it, and only against actions its guardians notice within the delay — which is why Watchtower announces every scheduled action.

## Security model

| Invariant | How it is enforced |
|---|---|
| Never signs, never holds keys | No keypairs server-side; Watchtower and MCP only read through the API. |
| Missing data ≠ safe | Engine + tests; unavailable payloads raise signals, incomplete analyses cannot reach `no_known_risk`. |
| Untrusted text | Memos, logs, IDL names and metadata are treated as data; links are defanged; Telegram HTML is escaped. |
| Secrets | Server-only env vars; client bundle scanned; logger redacts keys; Watchtower never logs its bot token. |
| Abuse | zod validation, body size caps, per-route rate limits, RPC timeouts with bounded backoff. |

## License

[Apache-2.0](LICENSE). Results are evidence-based signals, not guarantees; the decision to sign is yours.
