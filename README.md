# AI Web3 Security Agent & Defender

> **Simulate before you sign. Detect scams. Clean your wallet.**
>
> We don't just show risks. We simulate attacks before they happen, and help users clean their wallets.

A Solana security tool that scans wallets, tokens, NFTs/cNFTs and transactions with a **deterministic, evidence-based risk engine**, simulates transactions before signing, explains the results with an AI agent that cannot change them, and helps users burn, close and revoke eligible token accounts — signed only in their own wallet.

> ⚠️ Hackathon / research project. The code aims for production-quality engineering, but it is **not a production-ready product**: the cleanup signing path has not been executed on-chain yet, and wallet/browser behavior has not been tested on real devices. See [Limitations](#limitations) and [PROJECT_STATUS.md](PROJECT_STATUS.md).

## What works today

| Feature | State |
|---|---|
| Wallet scan (SOL, SPL + Token-2022 accounts, NFTs/cNFTs via Helius DAS) | Verified against mainnet |
| Token security (authorities, Token-2022 extensions, RugCheck liquidity/holders, on-chain concentration, phishing names) | Verified against mainnet |
| cNFT / NFT spam & phishing-lure detection | Verified against mainnet |
| Transaction decode (legacy + v0 with lookup tables) | Verified against mainnet |
| Pre-sign simulation with balance/state diffs | Verified against mainnet |
| Transaction risk (outflows, drains, approvals, authority changes, durable nonce…) | Unit-tested + mainnet |
| Cleanup: eligibility, unsigned tx build, simulation, fee check, reclaim estimate | Verified (prepare/simulate only) |
| Cleanup: wallet signing → submit → confirm → post-state check | Implemented, **not yet executed on-chain** |
| AI Security Agent | Implemented + mock-tested; live model blocked by an invalid API key in this environment |
| Demo Mode (no wallet needed) | Verified, deterministic |

## Architecture

```text
Browser (Next.js client)                      Server (Next.js route handlers)                 External
─────────────────────────                     ────────────────────────────────                ────────
Wallet (Wallet Standard) ─ public key only ─▶  /api/wallet/scan ─┐
Dashboard / Tx / Demo UI  ─────────────────▶  /api/token         │   lib/solana   ── RPC client ─▶ Helius RPC ─(fallback)▶ public RPC
                                              /api/transaction   ├─▶ lib/token    ── RugCheck (external opinion)
AI chat ───────────────────────────────────▶  /api/ai/chat       │   lib/transaction (decode · simulate · effects)
                                              /api/cleanup/*     │   lib/security (rules · deterministic engine)
Confirmation screen:                          /api/demo          │   lib/cleanup (capabilities · intent · prepare · submit)
  decode bytes → verify vs intent → hash                          └─▶ lib/ai (read-only tools · sanitize · evidence contract) ─▶ OpenAI
  → wallet.signTransaction → re-hash
  → /api/cleanup/submit (re-verify, relay)
```

Flow: **Wallet → Blockchain data → Token security → Transaction decode → Simulation → Risk engine → AI explanation → User warning → Scam detection → Cleanup eligibility → Burn / Revoke / Close / Reclaim**

### Key design rules

- **Risk level and analysis status are separate.** Levels: `SAFE · LOW · MEDIUM · HIGH · CRITICAL`, plus `UNKNOWN` ("Unrated"). Status: `COMPLETE · PARTIAL · INSUFFICIENT_DATA · UNAVAILABLE`. `SAFE` is only possible when every required check completed; missing data yields `UNKNOWN`, never `SAFE`.
- **Every risk signal must reference evidence** (source, observed value, rule). The engine throws if a signal has no evidence.
- **Data sources are labelled**: on-chain RPC, Helius DAS, RugCheck (external opinion), simulation, decoder, deterministic rule, DEMO.
- **Simulation success ≠ safe.** It only means the transaction would execute.
- **Unknown address / program / domain ≠ malicious.** It is shown as "unverified".
- **u64 values are decimal strings end-to-end**; no `number` conversions of lamports or token amounts.

## Security model

| Invariant | How it is enforced |
|---|---|
| Server never signs | The server only builds **unsigned** transactions and relays bytes the user's wallet signed. No keypairs exist server-side. |
| AI never signs | AI tools are read-only (`get_wallet_security_overview`, `find_scam_tokens`, `analyze_token`, `analyze_transaction`, `get_cleanup_options`); a test asserts no signing/sending tool exists. |
| No private keys / seed phrases | No input for them anywhere; chat warns if a seed-phrase-like text is pasted. |
| No transaction without user confirmation | Confirmation screen + explicit acknowledgement; wallet approval required. |
| Confirmed tx == signed tx | The confirmation screen decodes the actual bytes; `verifyCleanupTransaction` rebuilds the expected instructions from the displayed intent and blocks on any change of program, accounts, mint, amount, destination, authority, fee payer or extra instructions. The message hash is checked before signing, after signing (wallet must not modify it) and again on the server → `SECURITY BLOCK`. |
| Simulation before signing | Cleanup can only be signed if simulation succeeded, was not stale and showed the expected effect (account closed / delegate removed). |
| Insufficient data ≠ SAFE | Engine + tests; provider failures degrade to `PARTIAL` / `INSUFFICIENT_DATA`. |
| Fallback capability checks | Helius DAS methods never fall back to public RPC; enhanced data is reported unavailable instead. |
| cNFT ≠ SPL cleanup | cNFTs are `UNSUPPORTED` for burn/close (Bubblegum + Merkle proof not implemented). |
| Untrusted metadata | Token/NFT names, descriptions, memos and logs are wrapped as `{"untrusted": …}` for the AI, hidden Unicode stripped, injection attempts flagged; AI citations to non-existent evidence are removed. |
| Secrets | Server-only env vars; client bundle scanned for keys; logger redacts keys, seeds, `api-key=` URLs and `sk-…` strings; wallet addresses masked in logs. |
| Abuse | zod validation on every route, body size caps, per-route rate limits, RPC timeouts with bounded exponential backoff. |
| Clickjacking of the signing screen | `X-Frame-Options: DENY` + `frame-ancestors 'none'`. |

## Supported / unsupported operations

| Asset | Burn & close | Close (empty) | Revoke delegate |
|---|---|---|---|
| SPL Token | Supported | Supported | Supported |
| Token-2022 | Partially (blocked by withheld fees, confidential balances, paused mint, unknown mint state → manual review) | Partially | Supported (account delegate; a mint **Permanent Delegate cannot be revoked** by holders) |
| Wrapped SOL | Never burned | Supported (unwraps) | Supported |
| Metaplex NFT / pNFT | Requires manual review (needs Metaplex burn) | Manual review | Supported (not for frozen pNFTs) |
| Compressed NFT (cNFT) | **Unsupported** | Not applicable | **Unsupported** |
| Frozen account | Unsupported | Unsupported | Unsupported |
| Foreign close authority | Unsupported | Unsupported | — |

Reclaim values are **estimates, not guaranteed profit**: rent is only returned if the transaction succeeds, and the network fee is paid either way. If the wallet can't cover the fee the UI stops with: *"İşlem yapmak için cüzdanınızda yeterli SOL bulunmamaktadır."*

## Demo Mode

`/demo` runs without a wallet. A synthetic, deterministic wallet (scam token with phishing name, Token-2022 permanent-delegate token, frozen honeypot, active delegation, empty account, phishing cNFT) and a suspicious transaction (**50 USDC to an unknown address + unlimited approval**) are processed by the **real** parsers, risk rules, decoder, capability matrix and integrity verifier. Every evidence item is labelled `DEMO`, nothing touches a blockchain, and signing is disabled — the cleanup demo shows the same confirmation screen and integrity check, then applies a demo outcome.

Demo walkthrough: **Wallet scan → Risk detection → Suspicious transaction (simulation, 50 USDC outflow) → Scam & cNFT detection → Cleanup (burn / close / revoke / reclaim; unsupported cases shown honestly)**.

## Getting started

Requirements: Node.js 24+, npm.

```bash
npm install
cp .env.example .env.local   # Windows: copy .env.example .env.local
npm run dev                  # http://localhost:3000
```

Environment (`.env.example` documents all options):

| Variable | Required | Purpose |
|---|---|---|
| `HELIUS_API_KEY` | recommended | Primary RPC + DAS (metadata, NFTs, cNFTs). Without it, only public-RPC data is available and results are PARTIAL. |
| `OPENAI_API_KEY` | optional | AI agent. Without it, deterministic summaries are shown. |
| `OPENAI_MODEL` | optional | Defaults to `gpt-4.1-mini`. |
| `SOLANA_CLUSTER` / `NEXT_PUBLIC_SOLANA_CLUSTER` | optional | `mainnet-beta` (default) or `devnet`. **Test cleanup on devnet first.** |
| `SOLANA_FALLBACK_RPC_URL`, `SOLANA_DISABLE_PUBLIC_FALLBACK`, `RUGCHECK_DISABLED` | optional | Resilience controls. |

Scripts:

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint app components lib tests
npm test            # vitest (99 deterministic tests, no network)
npm run build
```

## API

| Route | Description |
|---|---|
| `GET /api/health` | Capability flags (never secrets) |
| `GET /api/wallet?address=` | Normalized wallet snapshot |
| `GET /api/wallet/scan?address=` | Full security scan (tokens, assets, wallet risk, cleanup eligibility, metrics) |
| `GET /api/wallet/history?address=` | Recent signatures |
| `GET /api/token?mint=` | Deep token analysis |
| `POST /api/transaction/analyze` | `{ input, walletAddress? }` → decode + simulate + risk |
| `POST /api/cleanup/prepare` | `{ owner, tokenAccount, action }` → unsigned tx + simulation + confirmation data |
| `POST /api/cleanup/submit` | `{ signedTransaction, expectedMessageHash, intent }` → re-verified relay + confirmation |
| `POST /api/ai/chat` | `{ messages, walletAddress?, demo? }` |
| `GET /api/demo`, `POST /api/demo/cleanup` | Demo data |

All responses use `{ success, data, error }`; bigint values are serialized as strings.

## Limitations

- **Cleanup signing path not executed on-chain.** Prepare + simulation were verified on mainnet; wallet signing, submission and confirmation still need a devnet run with a real wallet.
- Wallet connection not tested with real Phantom/Solflare extensions or mobile in-app browsers.
- AI agent verified only with a mock model (the configured OpenAI key was rejected).
- Wallet scans analyze at most 40 tokens (fungible first); the rest are shown as "Unrated" and the analysis is PARTIAL.
- Some spam-heavy wallets carry NFTs with multi-megabyte metadata that exceed Helius' response cap; NFT/cNFT results are then partial or unavailable and reported as such.
- RugCheck is an external opinion source; when it has no market data, liquidity/holders are unknown (not "low").
- Rate limiting and caching are in-memory (per instance).
- Transaction risk has no address-reputation data; unknown destinations are only "unverified".
- `npm audit` reports advisories in transitive Solana dependencies (`bigint-buffer`, `uuid`, `stream-json`); `bigint-buffer` runs in pure-JS fallback here.
- Not implemented yet: address intelligence, market data, alerts, realtime monitoring, URL phishing checker, exportable reports.

## Disclaimer

No security tool can detect every malicious token or transaction. Results are evidence-based signals, not guarantees; you make the final decision. This app never asks for private keys or seed phrases.
