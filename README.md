<p align="center"><img src="public/brand/presign-logo.png" alt="Presign — Know exactly what you sign." width="640"></p>

# Presign — know exactly what you sign

> The tagline is the goal, not a guarantee: Presign shows evidence for the requests it analyzes, it cannot see a request that goes around it, and your wallet's own window stays the final check.

Pre-sign verification for Solana multisigs. Presign loads a Squads proposal (or the transaction you are about to sign), decodes every instruction the vault would run, simulates it, and tells each signer — in one sentence, with evidence — **what it does and who controls what afterwards**.

**Live:** [presign-app.vercel.app](https://presign-app.vercel.app) (mainnet-beta) · [presign-devnet.vercel.app](https://presign-devnet.vercel.app) (devnet, Presign Guard demo) · Telegram: [@presign_watchtower_bot](https://t.me/presign_watchtower_bot) · X: [@Pre_sign_](https://x.com/Pre_sign_)

> On April 1, 2026, about $285M was drained from Drift Protocol's users (Drift later put the loss at $295M). There was no contract bug and no private key was stolen: after a months-long social-engineering operation, two of five Security Council members had pre-signed durable-nonce transactions they did not fully understand, on a 2-of-5 multisig whose time lock had been removed days earlier. The proposal that handed over Drift's admin appeared on chain and executed one second apart. Replay the exact bytes they signed through Presign and it answers **CRITICAL — "Admin moves outside the multisig" · "This signature never expires"** from the bytes alone. The analysis is marked PARTIAL today because those accounts have since changed and the simulation cannot be reproduced. It is a replay, not a claim that Presign would have stopped the attack. See [`/case/drift`](app/case/drift/page.tsx).

## Try it — no wallet, no keys

1. **Replay the Drift approvals:** open [presign-app.vercel.app/case/drift](https://presign-app.vercel.app/case/drift) and press **Member 1: create + approve**. The brief shows CRITICAL · PARTIAL, the decoded `updateAdmin`, and the message hash to compare on a hardware wallet.
2. **Inspect the same proposal:** paste `2LW6PSEjp81xSEttWwXDB6Etb1eKdhYPbFEojYbyhx88 #7` into [`/verify`](https://presign-app.vercel.app/verify).
3. **Call the API** (read-only, rate-limited):

```bash
curl -s -X POST https://presign-app.vercel.app/api/multisig/inspect \
  -H 'content-type: application/json' \
  -d '{"input":"2LW6PSEjp81xSEttWwXDB6Etb1eKdhYPbFEojYbyhx88 #7"}'
```

The response's `inspection.risk` is `CRITICAL` with status `PARTIAL`, and `inspection.gate` is `block`.

## Why

- **157,117** Squads v4 multisigs exist on Solana mainnet; **98.2%** have no time lock, so an approved proposal executes the moment its threshold is reached. Of 36 widely used programs, **13** are upgradeable through a Squads v4 multisig and **8** of those have no time lock. ([read-only census](docs/research/multisig-census.json), 2026-09-27)
- Signers see bytes and a Squads UI summary. Wallet previews are built for dApp drainers, not for governance: they do not tell you that an `updateAdmin` argument hands your protocol to an address the multisig does not control, or that a signature will stay valid for weeks.
- Squads itself recommends verifying what you sign through more than one interface ([announcement, 2026-04-27](https://x.com/multisig/status/2048843641377157554)). Presign is built to be that independent second interface: it reads the proposal straight from chain, not from the interface that created it, and states who controls what afterwards.

## What it does

| Surface | For | What you get |
|---|---|---|
| **`/verify`** | Multisig signers | Paste a Squads link, a proposal / transaction / multisig address, or `<multisig> #<n>` → the proposal brief, votes, decoded vault instructions, simulated vault balance changes, and every authority change classified as *outside the multisig / single member / removed / internal*. A multisig address gives its setup risks and recent proposals with verdicts. |
| **`/transaction`** | Anyone about to sign | Paste the serialized transaction (or a signature) → decode, simulate, rules. Squads approvals include the proposal they approve; durable nonces are flagged; the message hash is shown to compare on a hardware wallet. |
| **Secure connect & pre-sign review** | Anyone signing in a wallet | "Connect wallet" first checks the connection context (Presign origin, HTTPS, session, the target dApp's domain — unknown is never "safe"), then verifies wallet ownership with a message that authorizes nothing. Before any signature, the exact transaction or message is decoded, simulated and rated; Presign recommends, **you decide**: HIGH / CRITICAL can still be signed after one explicit confirmation, while a request Presign cannot verify offers Cancel only. The approval is bound to the payload hash, wallet, session and expiry. Try it on [`/demo/sign`](app/demo/sign/page.tsx). |
| **Watchtower** | Protocol & treasury teams | Add the bot to the signers' Telegram group and send `/watch <multisig>`: every new proposal's brief reaches every signer — an independent second channel — and so does any vote that lands on a pending proposal through a durable nonce. Also Slack / Discord webhooks. |
| **Presign Guard** (on-chain, live on devnet, unaudited) | Protocols with critical authorities | A Solana program that holds admin / upgrade / mint authorities: actions using them are scheduled, wait a fixed delay, and any single guardian can veto them. Presign shows the countdown and offers veto / execute. See [`guard/DESIGN.md`](guard/DESIGN.md). |
| **Team policy** | Teams with rules | One JSON file: approved authority holders, actions that must go through Presign Guard, minimum time lock / threshold, approved programs and recipients, outflow caps, verified upgrades, no durable nonces. Checked on every proposal in `/verify`, the API, Watchtower and MCP; a rule that cannot be checked is flagged, never assumed. See [`/docs#policy`](app/docs/page.tsx). |
| **HTTP API & MCP server** | Wallets, custodians, bots, AI agents | The same engine as JSON, and as MCP tools for agents. Every result carries a deterministic `gate`: `block` / `require_human_review` / `no_known_risk`. |
| **Browser extension** | Anyone signing on any site | Load [`extension/`](extension/README.md) in Chrome (not yet on the Chrome Web Store; one devnet run with Phantom so far, see [Verification status](#verification-status)): when a website asks your wallet to sign through the wallet APIs it wraps (Wallet Standard and injected providers), Presign's review opens first and the wallet only after your decision — no link to share. The wallet receives only bytes whose hash Presign's server approved, and while protection is on a request it cannot review is refused. The hook does not depend on built-ins a site can replace, but a site written for a particular wallet can still reach it through that wallet's own page code, so the wallet's confirmation window stays the final check; withholding a signature for other bytes from such a site is best effort. |
| **Wallet & token tools** | Holders | The original scanner: token authorities, Token-2022 extensions, concentration, age, metadata phishing, cleanup (burn / close / revoke). |

### Detections (deterministic, evidence-linked)

The full list — code, severity and trigger of every rule — is the [rule catalog](app/rules/page.tsx) (`/rules`), kept in sync with the rule sources by a test.

- **Authority leaving the multisig** — admin / upgrade / token authority handed to an address that is not the multisig, one of its vaults, or a member (CRITICAL); to a single member (HIGH); removed permanently (HIGH).
- **Approvals that never expire** — Squads create / approve / execute inside a durable-nonce transaction, or signed offline through one of the programs replacing durable nonces (Anza's programmatic signer, Blueshift Vector) (CRITICAL).
- **Votes signed in advance** — a create / approve / execute already on chain that landed inside a durable nonce or through one of those programs, read from the proposal's own history, with how long the nonce account had sat unused (HIGH). On Drift's proposal #7: both votes, nonce accounts idle for 8 days and 1 day.
- **Treasury drains** — the vault's simulated balance changes: outflows, near-total drains, approvals.
- **Governance weakening** — threshold lowered or set to 1, time lock removed, members added / removed, single-key config authority.
- **Unverifiable content** — proposals whose contents cannot be loaded or decoded are never "no risk"; required signers the multisig cannot provide are flagged.
- **Setup posture** — no time lock, minority threshold, single signature, controlled config.
- **Program upgrades** — the new code's hash (computed like `solana-verify`) checked against the OtterSec verified-builds registry; an unreadable buffer is HIGH.
- **Actions scheduled through Presign Guard** — decoded and classified like immediate ones; one level lower when the guard's delay and veto are verified on-chain, unchanged otherwise.
- Plus everything from the transaction engine: drains and unexpected outflows, unlimited approvals, owner reassignment, CPI guard, staked SOL handed over (withdraw authority, withdrawals to others), compressed NFTs moved or delegated (invisible to balance simulation), drains disguised as priority fees, program upgrades / closes, the wallet account reassigned or allocated, never-expiring signatures for unverified programs, programs that get access to your tokens but do nothing in simulation, phishing links in memos.
- **Signing requests:** what the dApp said versus what the simulation shows, honeypot or fake tokens you would receive (e.g. "USDC" on another mint), recipients matching the address-poisoning pattern (their only contact with you was dust), lookalike / phishing domains, and messages that hide a transaction, invisible characters, unreadable encoded data, seed-phrase requests or another site's name.

Drift is the showcase, not the scope: [`docs/security/threat-coverage.md`](docs/security/threat-coverage.md) maps every threat class Presign checks — transactions, signing requests, messages, tokens, wallets, multisigs and Presign's own integrity — to its rules, and lists what it does not cover.

## How it works

```text
input (Squads link · address · serialized tx · signature)
  → load from chain       multisig config, proposal, vault / config transaction, transaction buffer
  → decode                Squads v4 (36 instructions, 7 accounts incl. batches), SPL Token, Token-2022,
                          System, Stake, Metaplex Bubblegum (cNFT), BPF upgradeable loader, Presign Guard,
                          and any Anchor program via its
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
cp .env.example .env.local        # set HELIUS_API_KEY; SOLANA_CLUSTER=mainnet-beta for real multisigs; PRESIGN_SESSION_SECRET is required in production
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
- **Tests:** 840 in 63 files, deterministic, no network (RPC mocked at the edge). Squads and Guard discriminators are recomputed from names in tests; the Drift fixtures are real mainnet bytes. CI runs typecheck, lint, tests and build on every push, and a dependency gate that fails the run on a high or critical advisory without a written exception and review date (`scripts/audit-allowlist.json`). CI results do not gate the Vercel deployments.
- **Presign Guard program:** deployed on devnet (`A8cpj1d7zxF3T9kZzVn2wkEueGxqGVgd9VaqBA54EDRS`, IDL published); 11 LiteSVM tests of its invariants pass; its IDL is checked against the TypeScript codec; the full scenario ran end-to-end on devnet with a real Squads v4 multisig — takeover scheduled, CRITICAL in Presign, vetoed through Presign by an independent guardian, execution refused by the program. Unaudited.
- **Batches and buffers on mainnet:** real batch proposals (up to 7 transactions, lookup tables included) decode and simulate, showing each transaction's vault outflows; a proposal created from a real pending transaction buffer decodes from the buffer.
- **Live deployments:** https://presign-app.vercel.app (mainnet-beta: Drift replay, `/verify` on real multisigs) and https://presign-devnet.vercel.app (devnet: Presign Guard demo). Watchtower's Telegram bot answered `/check` and `/watch` (devnet multisig and guard) in a real group, asking the devnet instance, and its alerts reached that group: on 2026-10-11 a new proposal (HIGH), its execution, a scheduled guard action (CRITICAL) and its veto; on 2026-10-17 a new proposal and a vote sent through Anza's programmatic signer ("a vote landed through a durable nonce").
- **Browser extension:** end to end in a real Chrome (`scripts/extension-e2e.mjs`; isolated with `node scripts/e2e/local.mjs`: fake Wallet Standard and injected wallets, a local mock of the devnet RPC, no outside network): no wallet call before the review, approve signs exactly the reviewed bytes after the Presign server confirmed the approval, cancel / closing never reach the wallet, CRITICAL only after the explicit confirmation, a made-up approval, a genuine one for other bytes or a used one never reaches the wallet, a site that changes its bytes after the call or asks for other bytes while the wallet is open does not change what the wallet signs, the handshake leaks no secret to page scripts, ownership once per session.
- **Real wallet, devnet (2026-10-10):** on [presign-devnet `/demo/sign`](https://presign-devnet.vercel.app/demo/sign) with Phantom, every demo scenario was rated as expected, Cancel never opened the wallet, a message was signed for exactly the reviewed bytes, and CRITICAL opened the wallet only after the explicit confirmation. Phantom adds a priority fee, so the demo transactions now set their own compute budget; with the extension on, the safe demo transaction was signed, submitted and [confirmed on devnet](https://explorer.solana.com/tx/M7wrVR9eF9X4Rb5AxdNbKUpvHuoHuPaVD5JzA9kqU6LiwrniT4AZ7w345mmxtt4DWu2JaP1y1Eacp9d2TobvDAm?cluster=devnet). On a third-party site (the wallet-adapter example), Presign's review opened before the wallet for sign message, sign transaction and [sign-and-send](https://explorer.solana.com/tx/2CzukUvYryGEQ11B12mSq1mM86tuAJrL735gctzZPoQFxtSUvudLSViPC8hbHX4fmgEVpLgpkqXhMPUcnxaMUuLK?cluster=devnet), and Cancel never reached the wallet. Details in [PROJECT_STATUS.md](PROJECT_STATUS.md).
- **Durable-nonce replacements, devnet (2026-10-16):** a 2-of-2 Squads v4 multisig whose second member is a cold key's programmatic-signer PDA (Anza's programs, devnet, pre-audit). The cold key signed its vote offline as an authorization message with no blockhash; a relayer submitted it later — [92 seconds after signing](https://explorer.solana.com/tx/3z1LdKEGKNmCuXs3KdJkk9szQXfJpga2yFAYt44pp7j15cfsmqus65TyfCF8ewzrBRqhtZnShrMtRkbYRJ6qK8Sz?cluster=devnet), past the ~30 s a blockhash lasts. The deployed Presign rated the unsubmitted relay transaction LOW (three unknown programs) and the [first such vote](https://explorer.solana.com/tx/4eGrZhXuGDYpX66X8pU6UKXcHNFPNjy1CVPbLiR7v5f9Aj48ed8BHrMcnkwfgpgKPdstYNiionpP7zHZ7R5nmEm9?cluster=devnet) did not show as signed in advance. With this change, run on a local server against the same devnet, the next vote's unsubmitted relay transaction was CRITICAL ("Multisig approval that never expires", gate `block`) and both landed votes were flagged as signed in advance (HIGH). Vector is not deployed on devnet or mainnet, so it is tested only with transactions built in the tests. Fixture: `tests/fixtures/programmatic-signer-devnet.json`. On 2026-10-17 the deployed presign-devnet rated the landed votes HIGH (gate `block`) and a new, unsubmitted vote CRITICAL.
- **Live AI explanation (2026-10-17):** on presign-app, Claude explained Drift's proposal #7 through the inspect tool, with the same verdict as the rules (CRITICAL, gate `block`), every citation resolving to an evidence id, and no fallback. The Gemini backup has not produced an explanation yet.
- **Not yet verified:** Slack / Discord webhook delivery (formatting and escaping are unit-tested); Sign In through the extension with a real wallet (still open), Solflare and Backpack, and mobile wallets (see [PROJECT_STATUS.md](PROJECT_STATUS.md)).

## Limitations

- Squads v4 only (v3, SPL Governance and other multisig programs are not decoded). Bubblegum v2 and Metaplex Core NFT instructions are flagged but not decoded. No blocklist / threat-intelligence feed: unknown programs and domains are shown as unknown. Full list in [threat coverage](docs/security/threat-coverage.md#known-limitations). Batches are inspected up to their first 10 transactions; larger batches are reported as partially inspected.
- Name-based classification of Anchor instructions (e.g. `update_admin`) depends on the program publishing an IDL; without one, the payload is reported `PARTIAL`, not safe.
- Vault simulation reflects current state; it can differ at execution (an executed or underfunded proposal simulates as failing, and says so). Program ids that a proposal loads from a lookup table are listed directly for the simulation, since only the multisig program can invoke them that way; a message that becomes too large is reported as not simulated.
- Rate limiting and caching are in-memory (per instance). Watchtower is a single process with a local SQLite file; Telegram is the only self-service channel so far. It polls (environment targets first each cycle, bot-added targets in turns of 100, 4 at once) and limits what one chat or person can add (20 targets per chat, 500 in all, 6 inspections a minute per person), so alerts come on the next poll — not instantly.
- Presign Guard protects only the authorities handed to it, and only against actions its guardians notice within the delay — which is why Watchtower announces every scheduled action.
- Durable nonces are being deprecated: Solana plans to move them out of the protocol into on-chain offline-signer programs — see the [deprecation guide](https://solana.com/upgrades/durable-nonce-deprecation). Presign recognizes Anza's programmatic signer (devnet, pre-audit) and Blueshift Vector (published program ids, not deployed yet): it decodes a programmatic-signer envelope down to the instructions its signed message runs, and flags a Squads vote sent through either one like a durable nonce. Vector's passthrough payload is not decoded; its effects come from simulation or the executed record. Presign reviews the transaction that carries an envelope, not yet the authorization message an authority signs on its own.

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
