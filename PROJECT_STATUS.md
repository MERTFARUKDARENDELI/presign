# Project Status — Presign

Last updated: 2026-10-10. States: NOT_STARTED · IN_PROGRESS · IMPLEMENTED · TESTING · VERIFIED · PARTIAL · BLOCKED.

"VERIFIED" = implemented, unit/integration tested, typecheck + lint + build passing, and (where noted) exercised against real mainnet data through the API. Nothing here means "production-ready".

The project was renamed from "AI Web3 Security Agent & Defender" to **Presign** and refocused on pre-sign verification for Solana multisigs. The history below the Presign section describes the original engine, which Presign builds on.

## Presign (2026-09-27 →)

### Release readiness pass (2026-10-10, local working tree, not committed)

| Item | Status |
|---|---|
| N-1 / N-2: success text and extension README | IMPLEMENTED — the review page's success note no longer says Presign checked the signature "before it went back to the application": it says the wallet was asked only after the decision, with bytes that hash to what Presign approved, and that comparing the wallet's result is best effort. `extension/README.md` limits what the hook enforces to the requests that pass through it. `tests/security/claims.test.ts` catches both old sentences |
| Regression tests from the second verification round | `tests/extension/payload-integrity.test.ts`: an approval for other bytes is refused on the 9 remaining entry points and on a sign-in the wallet signed first; a call with other bytes while an approved one is in the wallet is reviewed; a replayed decision asks the wallet once (12 tests; the 10 refusal tests fail when the hash comparison is removed, the in-flight test when any request in flight lets calls through). `tests/unit/regressions.test.ts`: the remaining liquidity cases |
| Extension in real Chrome, isolated | 62/62 checks, twice (`node scripts/e2e/local.mjs`): fake Wallet Standard and injected wallets with a test key, a deterministic local mock of the devnet RPC (`scripts/e2e/mock-rpc.mjs`), the local production server build with no keys, every outside request refused (none was attempted), the development extension build. New checks: injected provider approve and cancel; a site that changes its bytes after the call (both kinds of wallet); a genuine approval offered for other bytes (refused, and the same approval then accepted for its own bytes); a used approval replayed (refused); a call with other bytes while an approved one is in the wallet (reviewed, never sent). The production build's `inject.js` and `content.js` are byte-identical to the tested development build and its `background.js` differs only in also allowing localhost; the production build itself did not run end to end |
| F-06: dependencies | `sharp` 0.35.5, `shell-quote` 1.12.0, `source-map-js` 1.2.2, `@modelcontextprotocol/sdk` 1.32.1, each within its dependents' ranges (lockfile only, `package.json` unchanged). Production tree: 29 → 26 findings (critical 1 → 0, high 18 → 16, moderate 10); whole tree: 39 → 35. The 16 high findings trace to two advisories with no fixed release (`braces`, `bigint-buffer`) |
| F-07: blocking dependency gate | `scripts/audit-gate.mjs` (CI job `audit`; locally `npm run audit:gate`): a high or critical advisory anywhere in the tree fails unless `scripts/audit-allowlist.json` accepts that advisory with its path, impact, reason, removal condition and review date; stale, expired or incomplete entries fail too. Two entries (`braces`, `bigint-buffer`; review by 2027-01-10). An exception holds only for its advisory id, package and severity. The previous lockfile fails the gate with exactly the four advisories fixed above. `tests/unit/audit-gate.test.ts` |
| Tests | 810 Vitest tests in 61 files pass |

### Audit of 2026-10-09 and P0-1 (local `main`, not pushed)

| Item | Status |
|---|---|
| Read-only audit of `a79a84a` (2026-10-09) | RED: the extension's page hook looked up built-ins a site can replace after it loaded. F-01 (critical): the review showed one request while the wallet signed another (`btoa`), and the server confirmation agreed because it hashes the reviewed payload. F-02 (high): a page could skip the review (`Map.prototype.has`) or approve it itself (`Map.prototype.set`). Three proofs of concept succeeded. The report is kept outside the repository |
| P0-1: hook hardened against a hostile page | IMPLEMENTED · TESTING — built-ins captured at document_start (`extension/src/lib/primordials.ts`) and nothing else used from the site's call to the wallet's; channel, bytes, sign-in text and Ed25519 check rebuilt on them. Also closed while there: `Function.prototype.call` could read the channel secret; `Promise.prototype.then` / `Object.prototype.then` / the global `Promise` could forge a decision; the site's wallet object handed out the real wallet's descriptors, prototype and internal fields; `standard:events` changes carried unwrapped features; `request()` read `method` twice (an accessor could show Presign "connect" and the wallet "signTransaction"); a locked, two-faced `serialize` could reach the wallet |
| Hostile-page tests | `tests/extension/hostile-page.test.ts`: 36 replaced built-ins, alone and all together, × 17 entry points, cancel and approve — pass; 36 of its 44 tests fail against the previous hook. The audit's three proofs of concept no longer get through |
| Extension in real Chrome (fake wallet, local Presign) | 38/38 checks, twice, including a page that replaced call / apply / then / the Promise constructor / Map set+has / typed-array copies / toJSON / dispatchEvent; the previous build fails 5 of those checks |
| P0-2: last check before the wallet | IMPLEMENTED · TESTING — the payload hash Presign's server confirmed is relayed with the decision (approval → background → content script → page hook); right before the wallet call the hook hashes what the wallet is about to receive (its own SHA-256) and sends nothing on a mismatch or without a confirmed hash (only the extension's own pass has none). `tests/extension/payload-integrity.test.ts` (4 of 6 fail with the check off), `tests/extension/sha256.test.ts`; the Chrome end-to-end test passes twice with every approval going through it |
| P0-3: what Presign claims | IMPLEMENTED — the extension's popup no longer says every signing request is reviewed; README, `extension/README.md`, `/docs` and the review page say which requests it reviews, that a site written for a particular wallet can reach it through that wallet's own page code (the wallet's window stays the final check), that withholding a signature from such a site is best effort, that single use holds across instances only with a shared store, and that the extension is not on the Chrome Web Store nor tried with a real wallet. `tests/security/claims.test.ts` scans every tracked user-facing surface for the claims the audit ruled out (it flags the old popup line) |
| F-03: Watchtower limits | IMPLEMENTED · TESTING — `watchtower/limits.ts`: 20 targets per chat, 500 distinct targets through the bot (the environment's do not count; one already watched can always be added), 6 `/check` / `/watch` inspections a minute per person and 60 for everyone (refused before any inspection); each cycle polls the environment's targets first, then up to 100 bot targets in turns, at most 4 at once. Tests in `tests/unit/watchtower.test.ts` (with 1,000 subscriptions the environment's target is first in every cycle, a cycle stays at 1 + 100, at most 4 run at once, every target gets its turn); one offline `--once` cycle ran. Not yet deployed to the Railway instance |
| F-04: RPC concurrency (CLAUDE.md rule 2) | IMPLEMENTED — every RPC call goes through `rpcCall`, which now holds one of 4 slots per provider (Helius, public fallback) for each request in flight in a server instance; the rest wait in order (a request's timeout starts when it is sent; a retry's back-off holds no slot; more than 500 waiting fails as unavailable). Fan-outs (recipient history, multisig history, token scans, several users) need no limit of their own. `tests/integration/providers.test.ts`: 40 calls at once never exceed 4 at a provider; failures free their slots; the queue limit (3 tests fail with the limit off). Per instance: serverless instances each have their own 4 |
| F-05: CLAUDE.md rule 3 ($0 liquidity) | IMPLEMENTED — a RugCheck report that lists markets but puts their liquidity at $0 no longer raises TOKEN_LIQUIDITY_VERY_LOW (HIGH): liquidity is unknown, the analysis stays PARTIAL (UNKNOWN when nothing else fires), and the evidence and source status say "RugCheck reports $0 liquidity — treated as unknown". A positive amount below $1,000 is still HIGH. `tests/unit/regressions.test.ts` (the $0 test fails without the change) |
| Still open from the audit | F-06 / F-07: addressed on 2026-10-10 (above), not committed |
| Limit that stays | the wallet's own page code (its internals, its messages to its own extension) is outside the hook; withholding a result after the wallet signed is best effort |

### Release candidate status (2026-10-06, local `main`, not pushed)

| Item | Status |
|---|---|
| Security findings of the 2026-10-05 audit | P0 0 · P1 0 · P2 0 · P3 0 open, each closed with code, test and (where possible) behavior evidence. Historical baseline (f379d7c, 2026-10-05): 3 P0 / 6 P1 / 9 P2 / 10 P3, readiness 48/100 — kept in the audit report as history, not current |
| Tests / rules | 724 Vitest tests in 56 files pass; 111 catalogued rules |
| Typecheck · lint · production build · extension build | pass |
| Extension in real Chrome (fake wallet, local Presign) | 29/29 checks, twice — including a made-up approval that never reaches the wallet and a handshake probe that hears no secret |
| Approval confirmation (P2-8) | the extension's one request: `POST /api/presign/signing/verify-approval` on the allowed Presign origin, no cookies, no redirects; bound to payload hash, type, wallet and site, single use |
| CSP | every script of 11 pages carries the response's nonce on a production build (local) |
| Build artifacts | no secret from `.env.local` and no key pattern in `.next/` or `extension/dist/`; no source maps in client bundles |
| Presign Guard | `cargo build-sbf` and `cargo test -p presign-guard` (11/11) pass in WSL (Rust 1.89.0, Agave 3.1.10); program code unchanged since the audit; mainnet prerequisites in `guard/DESIGN.md` |
| Production e2e (`E2E_INSTANCE=production`) | VERIFIED 2026-10-10 — 64/64 against the live sites on `623e465` with Upstash Redis connected to both projects (`KV_REST_API_URL` / `KV_REST_API_TOKEN`, Production and Preview, redeployed), production extension build, from a phone hotspot (`*.vercel.app` is blocked on the usual network). Before that, same day: on `0303a4e` the `window.solana` steps timed out (no chain, so its devnet transactions were reviewed on mainnet: unknown blockhash, Cancel only; fixed in `623e465` with the menu's network for requests that name none), and without the shared store 2 checks failed — a used approval offered for a new request with the same bytes was accepted by another server instance (`lib/presign/replay.ts`) |
| `PRESIGN_SESSION_SECRET` on Vercel (mainnet, devnet; production and preview) | VERIFIED 2026-10-10 — set on both projects for Production and Preview (Vercel dashboard); `/api/health` reports `presignSessionSecret: true` on both sites |
| Real wallets (Phantom, Solflare, Backpack) | NOT VERIFIED |
| CI with the new workflow | VERIFIED on GitHub (corrected 2026-10-10): run 37459848494 on `a79a84a`, 2026-10-06 — typecheck, lint, tests, build, extension build and the Guard job passed |
| Branch | `origin/main` (Tarık's `CLAUDE.md` update, PR #1) is merged into local `main` (merge, no rewritten SHA): local `main` is ahead only, so a push is a fast-forward. `CLAUDE.md` combines both versions with nothing lost (`@AGENTS.md`, Tarık's core invariants, the full pre-sign spec) |

### Verification baseline

| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` (app, components, lib, tests, watchtower, mcp, scripts) | 0 errors / 0 warnings |
| `npm test` | **810 tests / 61 files** pass (2026-10-10; no network; RPC mocked at the edge). On 2026-10-09 (791 tests) also run with the network made unreachable (fetch never answers, DNS and TCP fail) and `SOLANA_DISABLE_PUBLIC_FALLBACK` unset: all pass, with no connection attempted. `tests/security/presign-signing.test.ts` answers its address-poisoning lookups itself and fails any test that makes an RPC call or `fetch` it does not answer |
| `npm run build` | pass (new since the rename: `/verify`, `/case/drift`, `/docs`, `/rules`, `/api/multisig/inspect`, `/api/guard/prepare`) |
| CI | GitHub Actions: typecheck, lint, test, build and extension build on every push, plus a blocking dependency gate since 2026-10-10 (`scripts/audit-gate.mjs`: a high or critical advisory fails unless `scripts/audit-allowlist.json` accepts it) (`.github/workflows/ci.yml`); actions pinned to commit SHAs; the Guard job installs Agave from the release archive checked against its published SHA-256. The workflow of 2026-10-06 ran on GitHub with `a79a84a` (run 37459848494, success). CI results do not gate Vercel: a push to `main` starts both projects' production deployments at the same time as CI, and `main` has no branch protection |
| Observability | Structured, redacting JSON logs on stdout (Vercel keeps them; a log drain can forward them). Optional operator alerts since 2026-10-06: with `PRESIGN_ALERT_WEBHOOK_URL` (Slack/Discord-compatible, https) every error and three outages (upstream 5xx, shared store down, an AI explanation contradicting the verdict) are posted, at most once per event per 10 minutes per instance; `/api/health` reports whether it is set. No metrics or tracing |
| Dependency audit | 2026-10-10: 26 production findings, none critical (release readiness pass above). History: `npm audit --omit=dev` on 2026-10-06 (Next 16.3.8; the shadcn CLI moved to devDependencies, its chain left the production tree): 27 findings (17 high, 10 moderate), all transitive. The React Native / mobile wallet adapter chain (`@solana/wallet-adapter-react` → `@solana-mobile/wallet-adapter-mobile` → `react-native` → `metro` → `micromatch` → `braces`) is development tooling the web bundle does not run. `source-map-js` comes through Next's `postcss` at build time. `bigint-buffer` comes through `@solana/spl-token`: Presign uses only spl-token's instruction builders and decoders, and every decoder checks the exact data length before decoding, so `toBigIntLE` always gets 8 bytes, not the short buffer the advisory needs. No upstream fix without replacing spl-token |
| Client bundle secret scan | 0 hits for server-only values (re-run 2026-09-28) |
| Live mainnet (read-only) | see below |

### Components

| Area | Status | Notes |
|---|---|---|
| Squads v4 decoder (36 instructions; Multisig, Proposal, VaultTransaction, ConfigTransaction, TransactionBuffer, Batch, VaultBatchTransaction accounts; PDAs) | VERIFIED (live) | Discriminators recomputed from names in tests; decoded the real Drift exploit bytes; PDAs match on-chain addresses |
| Anchor IDL decoding (legacy + 0.30 formats) from the program's legacy IDL account or, for Anchor 1.x, its canonical Program Metadata account | VERIFIED (live) | Drift `updateAdmin(admin)` decoded live; Presign Guard's IDL read from Program Metadata on devnet; IDL accounts not owned by the program are ignored; unsupported arg types stop decoding (marked incomplete) |
| BPF upgradeable loader decoding | VERIFIED | unit tests (upgrade, set authority, immutable) |
| Presign browser extension (`extension/`, MV3; review page `/extension/review`): page hook for Wallet Standard (register / app-ready interception) and injected providers; secret-named DOM-event channel whose secret is handed to the content script through a closed shadow root (never in an event); background opens Presign's review per request, accepts answers only from that Presign origin and only for the captured payload, and forwards an approval only after the Presign server confirms its sealed token for the payload hash the extension computed itself (`/api/presign/signing/verify-approval`, once; since 2026-10-06, e2e 26/26 twice against a local Presign); wallet result checked (only signature slots may change) before the site gets it; ownership proof once per session on the review page; SIWS text rebuilt with the standard's format; popup with on/off, per-site off, instance, network for requests that name no chain (mainnet by default), decision log | VERIFIED (real Chrome, fake wallet; local Presign) | 2026-10-06 (HEAD after the audit fixes): `node scripts/extension-e2e.mjs` — 29/29 checks twice in Chrome (fresh profile, development build loaded through DevTools), test dApp with a fake Wallet Standard wallet, local Presign (devnet) through a public RPC reachable from this network: the handshake leaks no secret to page scripts; no wallet call before the review; approve → exact bytes once, after the Presign server confirmed the approval; cancel / window closed → 4001, wallet never asked; CRITICAL (wallet reassign) → explicit confirmation, then exact bytes; a made-up approval sent from the Presign page → refused after asking the server, 4001, wallet never asked; ownership asked once. Unit tests in `tests/extension/*` (adversarial: swapped arrays, typed views, re-serializing objects, oversized requests, unknown entry points, legacy registration, forged / expired / mismatched approvals, network failures). Historical: 2026-10-05, before the fixes, 24/24 locally and 25/25 against the live sites. The live sites do not run this code yet (not pushed); production e2e and real wallet extensions (Phantom, Solflare, Backpack) NOT verified; not on the Chrome Web Store |
| Threat-coverage expansion (2026-10-04): Stake program and Metaplex Bubblegum decoding; rules for staked SOL (withdraw / stake authority, withdraw to others, lockup), compressed NFTs (transfer, drain, delegate, burn, v2 flagged), Metaplex Core (flagged), priority-fee drains, program upgrade / close with the wallet's authority, wallet allocate, mint to others, unverified program + durable nonce, simulation-evasion pattern; message rules for opaque / encoded data and the Solana off-chain message format; token impersonation (fake USDC etc.); signing-request checks for honeypot tokens received and address-poisoning recipients. Map of every threat class, its rules and limitations: `docs/security/threat-coverage.md` | IMPLEMENTED | 43 new tests (`tests/unit/transaction-extra.test.ts`, `tests/security/presign-extra.test.ts`, impersonation in `token-security.test.ts`); instruction bytes from `@solana/web3.js` / `@solana/spl-token` builders, Bubblegum discriminators recomputed from names; RPC, scanner and metadata mocked at the edge. Not yet run against live mainnet transactions |
| Multisig layer (config, proposals, payloads from args / accounts / buffers / batches, privileged actions, foreign signers) | VERIFIED (live) | Drift Security Council proposals #7 (admin → attacker, CRITICAL), #8 / #9 (require the attacker's key as signer) |
| Vault payload simulation (executing member as fee payer) | IMPLEMENTED | unit-tested with mocked simulation; live simulations of historical Drift proposals fail against today's state, as reported |
| Rules (durable-nonce governance, votes signed in advance from the proposal history, authority leaving multisig, time lock, thresholds, config changes, unverifiable payloads, vault outflows) and posture | VERIFIED | unit + live; on Drift #7 both votes are flagged as signed in advance (nonce accounts idle 8 days and 1 day) |
| Proposal inspector API + `/verify` UI | VERIFIED (live) | headless browser on the Drift multisig overview and proposal #7 |
| `/case/drift` replay | VERIFIED (live) | both pre-signed transactions analyzed from unsigned bytes in the browser: CRITICAL |
| Brief + deterministic gate in API responses | VERIFIED | unit + live |
| Watchtower (self-service Telegram bot: /watch, /unwatch, /list, /check; SQLite state; guard watching; alert when a vote lands through a durable nonce) | PARTIAL | live on devnet 2026-10-02 (console delivery): baseline, then a new proposal (HIGH) and a scheduled guard action (CRITICAL, countdown, untrusted memo, veto link) announced; earlier live cycle on the Drift multisig. Telegram live 2026-10-03 with a real bot in a test group, against the Vercel deployment: /help, /check (devnet multisig brief), /watch on the devnet multisig and guard (baseline recorded, polling), replies delivered as Telegram HTML. A new-proposal / guard alert has not been delivered to Telegram yet (none created since); Slack / Discord webhooks not exercised |
| Brand (logo, favicon / app icons, share image, web manifest, Watchtower bot avatar and descriptions) | IMPLEMENTED | 2026-10-03 from the final logo (`public/brand/`); package and GitHub repository renamed to `presign`; Vercel projects `presign-app` / `presign-devnet` (old `solana-ai-defender…` addresses still served) |
| Secure connect + pre-sign review (`/connect`, `/demo/sign`, `/api/presign/*`, `lib/presign/`): pre-connect context checks, domain analysis (unknown ≠ safe), ed25519 ownership verification with one-time nonce, exact-payload review of transactions and messages, human decision layer next to the unchanged machine gate, approval bound to request + wallet + session + target origin + payload hash + expiry (single use), submission bound to the approval, application-address and declared-vs-simulated effects folded into the request's risk, multisig view (action, after execution, control, time lock, durable nonce), web-app implementation of the interceptor boundary, optional AI explanation of server-attested findings | IMPLEMENTED | 91 new tests: real decoder/rules for SAFE / MEDIUM / HIGH / CRITICAL / unverifiable transactions and messages, anti-tampering (payload, wallet, session, expiry, replay, modified risk, forged tokens), cancel never reaches the wallet, override signs exactly the analyzed bytes, open-redirect and cross-site refusal, demo scenarios through the real pipeline; the Drift proposal #7 approval reviewed as CRITICAL with admin leaving the multisig, no time lock and a durable nonce; wallet connect / reject / disconnect / account-switch transitions; local HTTP smoke of every page and endpoint 2026-10-04. Not yet exercised with a real wallet extension (connect / sign / submit) |
| MCP server | VERIFIED (live) | stdio session: initialize → tools/call on Drift #7 returned `gate: block` |
| Mainnet census | VERIFIED (live) | 157,117 multisigs; 36 program ids verified on-chain; aggregates in `docs/research/multisig-census.json` |
| Program upgrade verification (solana-verify hash + OtterSec registry) | VERIFIED (live) | hash method matches OtterSec's `on_chain_hash` for the Squads v4 program |
| Team policy engine (11 rules; API, `/verify` editor, Watchtower and MCP via `PRESIGN_POLICY_FILE`) | VERIFIED (live) | Drift #7 against a council policy: 4 rules broken (holder, guard, time lock, threshold), outflow rule unverifiable (simulation fails today); unit tests per rule |
| Rule catalog `/rules` | VERIFIED | 111 rules; a test keeps it in sync with the rule sources |
| Simulation pre-state at the simulation slot | IMPLEMENTED | 2026-10-05, after a 0.001 SOL transfer from a busy devnet faucet was rated HIGH ("Unexpected SOL outflow"): the pre-state was read at slot N, the simulation ran at N+k after other transactions had moved the faucet's SOL. Now the simulation may not run on state older than the snapshot (`minContextSlot`), the pre-state is read again no earlier than the simulation slot (exact when the slots match), accounts that differ between the two snapshots are reported as changed concurrently (one more simulation, then `TX_SOL_CHANGE_UNCERTAIN` / `TX_TOKEN_CHANGE_UNCERTAIN`, PARTIAL; only outflow that activity cannot explain stays HIGH); if the second snapshot fails the signal is kept and the result is PARTIAL. The Presign declared-effects check (`PRESIGN_SOL_EXCEEDS_DECLARED`, `PRESIGN_TOKEN_EXCEEDS_DECLARED`, `PRESIGN_UNDECLARED_TOKEN_OUTFLOW`) uses the same bounds (`boundedOutflow`, now shared in `lib/transaction/effects.ts`): it is HIGH only if the outflow exceeds the declared amount under both readings, and the request stays PARTIAL. In both rules token outflow is bounded per token account, so opposite concurrent changes on two wallet accounts of one mint do not cancel out into a false outflow. `tests/unit/simulation-drift.test.ts` (18); not yet re-run live |
| Presign Guard — Presign side (decode schedules, guard / action views, veto / execute preparation, own-guard recognition) | VERIFIED (devnet) | unit-tested against the program's account layouts; exercised against the deployed devnet program (schedule decoded, CRITICAL, veto prepared and submitted through the API) |
| Presign Guard — Anchor program (`guard/`) | VERIFIED (devnet) | deployed on devnet 2026-10-02 (`A8cpj1d7zxF3T9kZzVn2wkEueGxqGVgd9VaqBA54EDRS`, slot 506577649, IDL via Program Metadata); 11 LiteSVM tests; IDL cross-checked against the TS codec; end-to-end on devnet with a real Squads v4 multisig: authority to guard → scheduled takeover (Presign: CRITICAL, gate block) → veto prepared by /api/guard/prepare, signed by an independent guardian, submitted through /api/transaction/submit → execution refused (NotPending). Also rehearsed on a local validator, including a non-vetoed execution. Unaudited. Before mainnet (recorded in `guard/DESIGN.md`, not changed in place so the source keeps matching the devnet program): raise the 60 s delay floor, keep action outcomes after `close_action`; the guard view lists closed actions as closed |

### Open items

1. **Anthropic key — set (2026-10-10).** The AI layer moved from OpenAI to Claude Sonnet 5.5 (`claude-sonnet-5-5`, official Anthropic SDK) on 2026-10-02 and now also explains `/verify` proposals. `ANTHROPIC_API_KEY` is set on both Vercel projects (Production; Preview on presign-app, `release/2026-10-10` on presign-devnet); after a redeploy `POST /api/ai/diagnose` reported `READY` on both sites (model list only, no tokens). A live explanation has not been generated on purpose (the account holds a small credit, kept for the demo). Backup since 2026-10-10: with `GEMINI_API_KEY`, the pre-sign explanations fall back to Gemini (`gemini-3.5-flash-lite` by default) when Claude cannot answer — Claude is asked first every time, a refusal or contradiction is final, the backup's text passes the same check and is labeled in the review; the chat stays Claude-only. Not set on the deployments yet.
2. Deployment keys. Live on Vercel since 2026-10-03 (team `presign`): https://presign-app.vercel.app (mainnet-beta; Drift #7 inspected and both Drift exploit transactions analyzed CRITICAL through the deployed API) and https://presign-devnet.vercel.app (devnet, Guard program id set; demo multisig and guard inspected). Helius is configured on both (`/api/health`: `helius: true`); `ANTHROPIC_API_KEY` is not (see 1). Both projects are connected to this repository: every push to `main` redeploys them. As of 2026-10-06 the audit fixes (`7457533` … HEAD) are committed locally and not pushed, so the live sites still run the code audited on 2026-10-05; their `PRESIGN_SESSION_SECRET` could not be checked from here (the stored Vercel CLI token is no longer authorized). The old domain https://solana-ai-defender.vercel.app still serves the app and is not on the extension's allow-list; setting `PRESIGN_CANONICAL_ORIGIN=https://presign-app.vercel.app` on that project's Production environment redirects its pages there (308, since 2026-10-06), as long as it deploys from this repository (otherwise use a Vercel redirect). The repository is public: https://github.com/MERTFARUKDARENDELI/presign
3. Telegram: an alert (new proposal / scheduled guard action) delivered to the test group; bot commands verified 2026-10-03. Watchtower runs always-on on Railway (project `presign-watchtower`, `Dockerfile.watchtower`, SQLite on a volume at `/data`, asking the devnet deployment); the demo multisig and guard are watched from the environment (`WATCH_MULTISIGS`, `WATCH_GUARDS`, `TELEGRAM_CHAT_ID` = the test group), and `/check` was answered from Railway. The Railway service is connected to this repository (branch `main`; restarts on failure, up to 10 times on the current plan): after CI passes, a push that touches `watchtower/`, `lib/policy/file.ts`, `Dockerfile.watchtower` or `package.json` redeploys it. Redeploy by pushing or from the Railway dashboard; `railway service redeploy` uses the service's legacy builder (Railpack) instead of the Dockerfile, so its start command is pinned to `node watchtower/main.ts` as a safeguard. Slack / Discord webhook delivery untested.
4. Items carried over from the original engine: wallet-extension signing, mobile wallets.
5. Pre-sign review limits: a website cannot intercept what OTHER sites ask a wallet to sign — the browser extension (`extension/`) does that on the `lib/presign/interceptor.ts` boundary; its hook does not depend on built-ins a site can replace, but a site written for a particular wallet can still reach that wallet around it through the wallet's own page code (wallet-level integration closes that). Single use (nonces, approvals, submissions) and route rate limits hold across instances only when a shared store is configured (`UPSTASH_REDIS_REST_*` or Vercel KV); otherwise, or when it does not answer, they are per instance (in memory, refusing new work when full rather than forgetting spent tokens). Every token is also bound to session, wallet, payload hash and a short expiry. Session tokens are sealed with `PRESIGN_SESSION_SECRET`, which production requires (at least 32 characters; Secure Connect and the pre-sign review refuse to run without it, and `/api/health` reports it); development falls back to a derived key. The "Recent security events" list on the dashboard is per browser tab (sessionStorage).

Verified on mainnet 2026-10-02: batch proposals (lookup tables included) and a proposal created from a real pending transaction buffer.

## Original engine (history)

Nothing below reflects the Presign work; it is kept as the record of the engine's validation. The AI provider in this history was OpenAI; it is now Anthropic (see Open items above).

## Verification baseline (re-run 2026-09-25, after the read-only live validation)

| Check | Result |
|---|---|
| `npm run typecheck` | pass (run in order: typecheck → test → lint → build) |
| `npm run lint` (app, components, lib, tests) | pass, 0 errors / 0 warnings (2026-09-25). On 2026-09-24 this required fixing 6 `react-hooks/static-components` errors in `components/transaction/TransactionReport.tsx` (the `Section` component was defined inside `ExplanationCard` during render; moved to module scope as `ExplanationSection`). The previous "0 warnings" entry was stale: the errors came in with changes made after the last status update. |
| `npm test` | **289 tests / 23 files** pass. The read-only live validation added +7 regression tests (`tests/unit/live-regressions.test.ts`, plus 1 assertion in `url-reputation.test.ts`) for gaps found against mainnet data. Before that it was 282 / 22. The 2026-09-24 entry said 157 / 13, but the actual count at the start of 2026-09-25 was 159 / 13. The first 2026-09-25 pass added +66 tests (see "Wallet-independent pass"), bringing it to 225 / 18. The second pass added +57 tests in four new files (see "Token age, Token-2022 extensions, URL reputation"); one existing timeline assertion was updated for defanged evidence |
| `npm run build` | pass (2026-09-25; Next.js 16.3.6, Turbopack, 20 routes); `bigint: Failed to load bindings` warning expected (pure-JS fallback) |
| Live API smoke test (mainnet, Helius + RugCheck) | **Re-run 2026-09-25 over real HTTP** (read-only; see "Live read-only validation"). Wallet scan, token deep scan (incl. age), executed-tx analysis and history were exercised; 16 valid/invalid request cases returned the expected codes; 0 secret values in any response. Pre-sign simulation and cleanup prepare were last run live on 2026-09-23 |
| Browser UI (2026-09-25) | Headless Chrome driven over CDP (isolated temp profile, **no extensions, no wallet**), against a mainnet `next dev`. It **typed a real address and clicked Scan**, expanded token rows by mouse, and opened a real Token-2022 tx, a v1 tx (error state) and a classic SPL tx, plus `/demo`. The 390 px mobile viewport had no horizontal overflow. Screenshots were checked visually. **Still not done:** wallet extension, signing, real mobile device |
| Browser UI (2026-09-24) | Headless Chrome (isolated profile, **no extensions, no clicks**) on `next dev`: `/`, `/dashboard`, `/transaction`, `/demo` load and hydrate; client fetches run; no Next.js dev error overlay. `/transaction?input=<unsigned tx>&wallet=…` renders the full report (risk → explanation → balance changes → programs → instructions → logs → sign panel). **No interactive clicks, no wallet extension, no real mobile device** |
| Live simulation-only check (2026-09-24) | unsigned v0 self-transfer (no keys) analyzed on mainnet via `/api/transaction/analyze`: decoded, simulated, risk COMPLETE, `blockhashValid=false` detected, sign panel blocked it. Nothing signed or sent |
| Client bundle secret scan (2026-09-25) | Re-run after both passes, and 0 hits both times. After the second pass it also confirmed the server-only token-age fetcher (`lib/token/age-source.ts`) is not in the client bundle; only the pure `lib/token/age.ts` is. Re-run on the fresh build. It scanned `.next/static` (33 files) for the value of every non-`NEXT_PUBLIC_` variable in `.env.local` (`HELIUS_API_KEY`, `OPENAI_API_KEY`), plus `sk-…` and Helius `api-key=` patterns → **0 hits**. Values were compared in-process and never printed |
| Devnet / real signatures | **none**; no transaction has ever been signed, sent or confirmed |

## Changes after the 2026-09-23 audit

These files changed after the 2026-09-23 audit. They typecheck, lint and build, and have the direct tests noted below. **None of them has been run with a real wallet or submitted to a real cluster**, and they have not been re-audited.

| Area | Files | Test coverage |
|---|---|---|
| Wallet signing: sign exactly the prepared bytes, message-hash + signature verification | `lib/wallet/signing.ts`, `components/transaction/SignPanel.tsx`, `components/wallet/ConnectWallet.tsx`, `components/providers/WalletProviders.tsx` | direct tests in `tests/security/signing.test.ts` (tampering, wrong signer, wallet-modified tx, invalid/missing/foreign signature, v0 support, rejection); never run with a real wallet |
| Send & submit: relay signed tx, re-verify intent, confirm | `lib/solana/send.ts`, `lib/cleanup/submit.ts`, `app/api/transaction/submit/route.ts` | direct tests in `tests/security/submit.test.ts` with only the RPC edge mocked (see Security test coverage). `/api/transaction/submit` is not a general relay (since 2026-10-06): it requires a pre-sign approval token or a Guard prepared token for the exact message. The Guard veto path was executed on devnet before the token existed |
| Cleanup dialog + prepare/intent/reclaim/capabilities updates | `components/cleanup/CleanupDialog.tsx`, `lib/cleanup/{prepare,intent,reclaim,capabilities}.ts` | intent/integrity/reclaim/capability unit tests (`tests/unit/cleanup.test.ts`); dialog not browser-tested |
| Transaction explanation (deterministic "what will happen / why risky") | `lib/transaction/explain.ts`, `components/transaction/TransactionReport.tsx`, `app/transaction/TransactionClient.tsx`, plus `lib/transaction/{analyze,decoder}.ts`, `lib/security/rules/transaction.ts` | direct tests in `tests/unit/sign-checks-explain.test.ts`; decoder/risk rules covered by `tests/unit/transaction.test.ts` |
| AI agent + chat | `lib/ai/agent.ts`, `components/ai/AiChat.tsx` | mock-model tests (`tests/security/ai-security.test.ts`), status/diagnostic tests (`tests/security/ai-status.test.ts`); live model not verified (see FAZ 8) |
| Demo scenario | `lib/demo/scenario.ts` | determinism tests |
| AI status + on-demand diagnostic | `lib/ai/status.ts`, `app/api/health/route.ts`, `app/api/ai/diagnose/route.ts`, `components/SystemStatus.tsx` | `tests/security/ai-status.test.ts` (fetch mocked; no real OpenAI call) |
| Explanation backup (Gemini) | `lib/ai/gemini.ts`, `lib/presign/explain.ts`; `aiBackup` in `/api/health`, `backup` in `/api/ai/diagnose` | `tests/security/ai-gemini.test.ts` (key in a header only, never in a URL, error or response; blocked answers; model-name check; diagnostic without tokens), `tests/unit/presign-demo-explain.test.ts` (Claude first; backup only when Claude cannot answer; refusal and contradiction final; same contradiction check). Fetch mocked; no real Gemini call |

## Browser-readiness review (2026-09-24)

Reviewed the routes (`/`, `/dashboard`, `/transaction`, `/demo`; cleanup/burn/revoke is a dialog inside `/dashboard`, there is no separate page), the wallet provider, the signing/submit path, the cleanup dialog and the demo separation.

Fixes made:
- `app/globals.css`: `--font-sans: var(--font-sans)` referred to itself, so the whole UI fell back to a serif font. It now points to `--font-geist-sans`. This bug dates from the shadcn setup commit.
- Absolute wording: the risk badge and portfolio legend printed "SAFE"; they now show "No risk found". The demo metric "Scam tokens" is now "High-risk tokens & NFTs".
- Cluster mismatch guard: the browser wallet context uses `NEXT_PUBLIC_SOLANA_CLUSTER` and the server uses `SOLANA_CLUSTER`. The header now shows a red "Cluster mismatch" badge if they differ, instead of failing silently.
- Cleanup dialog: the dialog can no longer be closed (Cancel, Esc or outside click) while the wallet is signing or the transaction is submitting, because closing would hide the outcome and signature. REVOKE now shows an "Estimated network fee" row; it previously had no fee row, because there is no reclaim.

Verified by reading the code (not by clicking):
- Wallet: Wallet Standard via `@solana/wallet-adapter-react`, with `wallets={[]}`. Phantom, Solflare and Backpack self-register. The Mobile Wallet Adapter is bundled for Android Chrome. On iOS there is no MWA, so users must use the wallet's in-app browser (the UI says this).
- Wallet data handling: only `publicKey.toBase58()` is read and sent to the API (scan query, cleanup `owner`, analyze `walletAddress`). The app never calls `signMessage`, and there is no key or seed input anywhere.
- Signing: `signExactly` checks the message hash before and after the wallet signs, requires the connected wallet to be a signer, checks v0 support and verifies the ed25519 signature. Submission is a separate, explicit step.
- Signing from `/transaction` uses the same pre-sign pipeline as `/demo/sign` and the extension (since 2026-10-06): wallet ownership proven in the session, `/api/presign/signing/analyze` of the exact bytes for the connected wallet, the shared review (one explicit confirmation for HIGH / CRITICAL), server approval, then the wallet; submission carries the approval. The server-side checks (`transactionIssues`) refuse demo transactions, signature input, a wallet that is not a required signer or another wallet's perspective, no payload hash, unresolved lookup tables, no, failed or stale simulation, an expired blockhash and incomplete risk data. The review is valid for 5 minutes, the approval for 2.
- Cleanup confirmation shows operation, network, token, token account, amount (burn), account to close, rent destination, delegate (revoke), signer, program, gross/fee/net reclaim, the exact decoded instructions, the simulation result and spendable SOL. An explicit checkbox is required.
- Unsupported cases are handled: cNFT burn/revoke UNSUPPORTED (no button); frozen, uninitialized, foreign close authority or not-owned accounts UNSUPPORTED; a non-empty account for CLOSE is NOT_APPLICABLE; NFT burn needs manual review. Insufficient SOL, simulation failure, unexpected CPI (unknown program) and foreign SOL outflow become blockers that disable the button.
- Demo vs real: the demo uses `DemoCleanupDialog` (no wallet, "Run demo outcome" only), `SignPanel` returns null for demo analyses, and the server-side sign checks and prepare route both reject demo data.

Not testable here:
- clicking through the UI
- connecting Phantom or Solflare
- wallet popups
- real mobile devices or wallet in-app browsers
- the headless mobile-width check was inconclusive, because Chrome enforces a minimum window width

Previously known issue, now fixed (see next section): `/api/health` treated a *present* key as a working AI.

## AI status fix (2026-09-24)

- `/api/health` returns an `ai` status value. It is never a boolean and never contains the key. The values are:
  - `NOT_CONFIGURED`: no key.
  - `INVALID_KEY`: the key is malformed, or the provider rejected it (401/403).
  - `CONFIGURED`: a key is present but **unverified**.
  - `READY`: the last real provider call succeeded.
  - `UNAVAILABLE`: the last provider call failed for another reason.
- `/api/health` never calls OpenAI. A test checks that no `fetch` happens during a health request.
- The status comes from real provider calls in this server process: either an agent call or the new on-demand `POST /api/ai/diagnose`.
- The diagnostic calls `GET /v1/models`, which checks the key without generating tokens.
  - It is cached for 10 minutes, concurrent callers share one request, and it is rate limited to 3 requests per minute.
  - It never sends a missing or already-rejected key, and it logs only the HTTP status code.
  - The state lives on `globalThis`, so all route bundles in the process share it.
- A rejected key stays `INVALID_KEY` until restart. After that, the agent returns the deterministic fallback without contacting the provider (tested).
- UI changes:
  - The header badge is green only for `READY`.
  - `CONFIGURED` shows an amber "AI unverified" badge and a "Verify AI" button. The button runs only on an explicit click and is never polled.
  - The invalid, unavailable and off states are shown explicitly.
  - Chat and agent behavior are unchanged.
- **Not done:** no live diagnostic or live model call was made in this pass, so it is **unknown** whether the key in `.env.local` is valid. The last live check, before this pass, was rejected by OpenAI.

## Security test coverage (2026-09-24)

Directly tested at library level. Only the RPC/network edge is mocked; every verification step runs for real:

| Behavior | Test |
|---|---|
| `signExactly`: tampering before signing, wrong signer, wallet that adds an instruction or returns a different message, invalid/missing/foreign-key signature, v0 support, user rejection | `tests/security/signing.test.ts` |
| `sendSignedAndConfirm`: exact bytes relayed with preflight on; confirmed / failed on-chain after submit / never confirmed → `unconfirmed`; transient poll errors; preflight rejection (e.g. expired blockhash) propagates without polling | `tests/security/submit.test.ts` |
| `submitSignedCleanup`: prepared = signed = sent (relays exactly the verified bytes); blocks signed ≠ prepared (hash mismatch), a tampered tx sent with its own matching hash (intent mismatch), wrong signer/fee payer, unsigned, invalid signature, and never calls send when blocked; failed / unconfirmed confirmation skips post-verification; REVOKE post-verification | `tests/security/submit.test.ts` |
| `submitAnalyzedTransaction`: analyzed = signed = sent; blocks changed bytes, missing/invalid signature, missing co-signer, unparseable input | `tests/security/submit.test.ts` |
| Server-side sign checks: expired blockhash, failed/missing/stale/non-pre-sign simulation, no payload hash, wrong signer or perspective, demo, executed signature, incomplete risk | `tests/unit/sign-checks-explain.test.ts` |
| `explainTransaction`: instructions, movements, account changes, signals; no signing recommendation or safety guarantee; failed/missing simulation; partial/unrated analysis | `tests/unit/sign-checks-explain.test.ts` |
| Server never signs (static scan): no `app/api` or `server-only` module contains a signing call or secret-key API; no module loads a secret key, generates a keypair or handles a mnemonic; `Keypair.fromSeed` only yields demo public keys; `signTransaction` appears only in the two `"use client"` wallet-adapter components | `tests/security/no-server-signing.test.ts` |
| AI status/diagnostic; health never calls the provider or leaks the key; invalid key → deterministic fallback | `tests/security/ai-status.test.ts` |

Added on 2026-09-25: `prepareCleanup` end to end (mocked RPC), HTTP-level route tests for submit / cleanup / diagnose, CPI decoding, text signals and the `analyzeTransaction` pipeline. See "Wallet-independent pass" below.

Still **not** directly tested:
- The `SignPanel`, `SigningReview` and `CleanupDialog` React components. Wiring, button states and dialog locking are checked by reading the code (the `/transaction` sign panel's no-wallet state also in a browser); the decision logic behind them (`lib/presign/controller.ts`) has direct tests. There is no React test environment (vitest runs in `node`).
- The happy-path relay through `/api/cleanup/submit`. The library function behind it is tested for it; `/api/transaction/submit` has a route-level happy path (prepared token).
- `lib/wallet/scan*.ts` and `lib/token/report.ts` directly. They are covered through integration tests with mocked providers.
- Anything that involves a real wallet, a real signature, or a real submit on any cluster.

## Wallet-independent pass (2026-09-25)

Everything below ran against mocked RPC edges: no wallet, no signing, no network. Nothing was signed, sent or submitted.

New direct tests (+66):

| File | What it covers |
|---|---|
| `tests/security/prepare.test.ts` (24) | `prepareCleanup` end to end, with only accounts, RPC and simulation mocked. **Output:** the prepared tx is **unsigned** (all signature slots are zero). The owner is the fee payer. The bytes match the intent (integrity check), `messageHash` is the hash of the returned bytes, and the simulation runs on exactly those bytes. **Actions:** BURN_AND_CLOSE, CLOSE (amount 0), REVOKE (delegate, no reclaim) and Token-2022 program selection. **Refused before building:** the demo wallet (no network call), a missing account or cNFT id, a non-token account, a foreign owner, a frozen account, CLOSE with a balance, REVOKE without a delegate, a foreign close authority, Token-2022 withheld fees, an NFT (manual review) and an unavailable simulation. **`canSign=false` blockers:** failed or stale simulation, unexpected CPI, account not closed, delegate not removed, SOL to a foreign account, 0 SOL, and a fee that would break rent exemption |
| `tests/security/routes.test.ts` (15) | HTTP-level tests for `/api/cleanup/submit`, `/api/transaction/submit`, `/api/cleanup/prepare` and `/api/ai/diagnose`. Invalid JSON, an oversized body or a schema violation → 400. A tampered, hash-mismatched, unsigned or demo-wallet tx → 409 `SECURITY_BLOCK`, with the **network untouched**; `/api/transaction/submit` without an approval or prepared token, or with a forged, expired, mismatched or wrong-kind token → 409 with the network untouched, and a prepared, validly signed tx is relayed. A demo prepare → 422 with no network call. An unexpected internal error → a generic 500 whose body contains no provider URL or key. Per-client rate limits (6/min for submit, 3/min for diagnose) return `Retry-After`. Diagnose without a key makes no fetch, and a rejected key is never echoed |
| `tests/unit/cpi-and-text-signals.test.ts` (11) | `applyInnerInstructions` (previously untested): parsed, compiled and raw CPI shapes. SOL transfer, unlimited approve, setAuthority and close are extracted with the `cpi` flag. Malformed groups are counted, never guessed, and programs reached only via CPI are registered. A benign-looking unknown-program call that approves or closes via CPI is rated CRITICAL. `scanText` (previously untested): URLs, domains, lure words, prompt injection, the 4 000-character and 5-item bounds, and dedupe |
| `tests/unit/analyze-pipeline.test.ts` (8) | `analyzeTransaction` (previously untested). Invalid input → `INVALID_TRANSACTION` without a simulation. The hash covers the analyzed bytes, and the perspective wallet is handled. A simulation that cannot run → `INSUFFICIENT_DATA`, **never SAFE**; other errors propagate. A stale simulation → PARTIAL. Simulated CPI is applied and token mints are filled from the pre-state. A successful simulation with a SOL outflow is not SAFE |
| `tests/unit/timeline.test.ts` (8) | the new timeline classifier and `getTransactionHistory` validation (see FAZ 15) |

New feature: **FAZ 15 timeline classification.** `lib/security/timeline.ts` classifies every history entry deterministically, using only data that `getSignaturesForAddress` already returns (no extra RPC). The classes are:
- `PHISHING_MEMO` (HIGH): a link plus lure wording, or prompt-injection text.
- `SUSPICIOUS_MEMO` (MEDIUM): a link alone (labelled "unverified") or lure wording alone.
- `FAILED`.
- `MEMO`.
- `UNCLASSIFIED`: labelled "Not classified — open to analyze", never "safe".

`lib/solana/history.ts` attaches `event` to each item. `components/dashboard/SecurityTimeline.tsx` shows the label with a coloured dot, and the evidence as plain text. The evidence is only the bare domain and keywords, never the raw memo and never a clickable link. The UI change is typechecked, linted and built, but **not rendered in a browser**.

## Live read-only validation (2026-09-25, mainnet)

**Setup.** No wallet was connected, nothing was signed or sent, and no write was made on any cluster. Mainnet ran as a `next dev` server with a process-env override (`.env.local` stays `devnet` and was not modified). Devnet ran from the production build (`next start`). An independent cross-check used raw JSON-RPC to Helius mainnet from a scratch script that does not use the app's code; the key was read in-process and never printed. The public `api.mainnet-beta.solana.com` endpoint was **unreachable** from this environment (TLS reset). Addresses are shortened below.

**Wallet scan** (a well-known public wallet, 86xC…2MMY).
- HTTP 200 in 12.5 s. SOL balance, **1091 token accounts** (424 Token-2022) and metadata for all 1091.
- 40 tokens were deep-analyzed (scan budget) and 1051 are reported as unanalyzed.
- Wallet risk MEDIUM/PARTIAL. The DAS NFT listing FAILED for this wallet (known limitation), reported as such.
- All 142 signals reference existing evidence ids. There was no SAFE result on a non-COMPLETE analysis and no raw URL in any evidence.
- Token age is reported as `SKIPPED` ("not checked in wallet scan").

**Token age** (`/api/token`; each result cross-checked independently).

| Token | Result | Independent check |
|---|---|---|
| a Token-2022 pump token created **today** (BDE7…pump) | `KNOWN`, 4 h → `TOKEN_VERY_NEW` (MEDIUM) + `TOKEN_NEW_WITH_RISK_FACTORS` (HIGH), citing the age, liquidity, holders and **top-holder concentration** evidence ids | creation tx found live, 07:02 UTC |
| CAT (6uMc…i3Ty, Token-2022) | `KNOWN` 2024-01-28 | 2 signatures in total; the oldest tx is `initializeMint2` for this mint ✓ |
| Comrades (mcDJ…pump) | `LOWER_BOUND` (RugCheck, ≥ 84 d) | 3642 signatures exceed the 3 000 budget; true creation was 2 s before RugCheck's first-seen ✓ |
| STAKE (CT4B…XT5K) | `LOWER_BOUND` ≥ 1653 d (on-chain) | ≥ 3000 signatures; oldest seen is not the initialize ✓ |
| BONK, USDC | `LOWER_BOUND` via RugCheck (≥ 833 d, ≥ 162 d) | valid lower bounds (both are older) |
| wallet address / nonexistent account as "mint" | `UNAVAILABLE`, no date, risk UNKNOWN / INSUFFICIENT_DATA | — |
| same mainnet mints on the **devnet** server | `UNAVAILABLE` ("mint account unavailable"), RugCheck `UNSUPPORTED`, no mainnet result carried over | — |

Not seen live: "new token + active mint authority". Pump.fun revokes mint authority at creation and no other token under 7 days was found, so that combination is **unit-tested only**.

**Token-2022** (real mainnet txs through `/api/transaction/analyze`, compared position by position with the RPC's own jsonParsed output).
- **Pump.fun Token-2022 creation tx:**
  - `initializeMetadataPointer` (extension disc 39) was decoded correctly.
  - `initializeMint2`, `initializeAccount3`, `mintTo`, `setAuthority` (MintTokens → none, CPI) and `transferChecked` were all decoded with the `token-2022:` prefix and a Token-2022 transfer record.
  - `initializeTokenMetadata` / `updateTokenMetadataAuthority` (8-byte token-metadata interface) stayed **undecoded**, not guessed.
- **Classic SPL Token tx** (`initializeAccount3`, `syncNative`, `closeAccount`): `token:` prefix, no Token-2022 interpretation, SAFE/COMPLETE.
- **Token-2022 `closeAccount`:** `token-2022:closeAccount`.
- **Not seen live** in the sampled txs (unit-tested only): `transferCheckedWithFee`, CPI Guard, transfer hook, pause, confidential transfers, and approve/delegate on Token-2022.

**Gaps found live, and fixed.**
1. **v1 transactions.** Mainnet now carries **v1 transactions**. The app requested `maxSupportedTransactionVersion: 0` and returned a misleading `RPC_ERROR` 502. It now returns `UNSUPPORTED_TRANSACTION` 422, "newer transaction format … not analyzed" (verified live and in the UI). **v1 decoding itself is not supported** (web3.js 1.x decodes legacy and v0 only). Token age does not break on v1: an undecodable creation tx only yields a lower bound.
2. **Base instructions 21/22.** `getAccountDataSize` (21) and `initializeImmutableOwner` (22) appear in every ATA creation and showed as undecoded. They are now decoded byte-exactly on both programs (re-verified live).
3. **URL brand matching.** On 1837 real metadata texts (208 containing links), the brand token "solana" matched as a substring and flagged ordinary meme-coin sites (`catwifhatsolana.com`) as impersonation: 4 of the 6 MEDIUM results. It is now a whole label-part match.
4. **Raw links in UI and AI context.** The transaction report rendered **raw memo text** (plain text, not clickable), and the AI context carried raw URLs inside untrusted wrappers. Both now show only defanged hosts via `defangLinks` (`claim-orca[.]info/…`).
5. **Test-setup pitfall.** `beforeEach(() => rpc.mockReset())` returned the mock, which vitest then ran as a teardown. It was fixed in two test files; it was not an application bug.

**URL reputation on real metadata** (deterministic engine only, no external service).
- 262 unknown domains → `NO_SIGNAL` (not phishing).
- 2 `KNOWN_DOMAIN` (pump.fun).
- 13 weak-only results (throwaway TLDs, lure words, http).
- 2 `SUSPICIOUS`: `claim-orca[.]info` (brand impersonation + lure wording) and `bonk[.]bet`.
- End to end via `/api/token`, the claim-orca token's description produced `TOKEN_METADATA_SUSPICIOUS_URL` with evidence id `…:meta.descriptionLinkReputation`, defanged, and no raw URL anywhere in the risk payload.
- In the browser, the dashboard evidence showed `jupfinally[.]com` and the token table contains no `<a>` links.
- **Not present in real data:** punycode, IP-host, userinfo and hidden-character links. These are **unit-tested only**.
- The API `metadata.description` data field still carries the raw provider text. The UI does not render it, and the AI receives it defanged.

**AI.** No live OpenAI call was made (key unverified). By code path, `lib/ai` only reads risk levels (`tools.ts`), and no security, token, transaction, wallet or cleanup module imports `lib/ai`, so AI cannot change a risk decision.

## Token age, Token-2022 extensions, URL reputation (2026-09-25, second pass)

This pass needed no wallet and no signing, and involved no live network: only RPC edges were mocked in tests. It has **not** been run against mainnet or devnet data yet.

**Token age** (`lib/token/age.ts` pure, `lib/token/age-source.ts` server).
- **Deep scan only.** It runs in `analyzeToken` (`/api/token`), not in the wallet scan. The wallet scan reports a `SKIPPED` source ("Token age not checked in wallet scan"), and its status is unchanged.
- **On-chain lookup.** `getSignaturesForAddress(mint)` is paged back at most 3×1000.
  - If history ends and the oldest transaction's parsed `initializeMint`/`initializeMint2` is for **this** mint (top-level or CPI), the age is `KNOWN`.
  - Otherwise, e.g. with pruned RPC history, a reused address or too many transactions, the result is only `LOWER_BOUND`.
- **RugCheck.** `detectedAt` counts as a lower bound only, and only on mainnet.
- **When nothing is verifiable** the result is `UNAVAILABLE`. The age is never guessed.
- **Cache.** 30 min, keyed by `cluster:mint`, so a devnet mint never reuses a mainnet result. Failures are cached for 1 min.
- **Rules.**
  - Known age under 1 day → `TOKEN_VERY_NEW` (MEDIUM); under 7 days → `TOKEN_NEW` (LOW). Age alone never produces HIGH or CRITICAL.
  - New + an independent MEDIUM-or-higher factor (active mint authority, low liquidity, few holders, top-holder concentration) → `TOKEN_NEW_WITH_RISK_FACTORS` (HIGH), citing the age evidence and the factor evidence ids.
  - Unavailable age, or a lower bound under 7 days, → evidence + PARTIAL (UNKNOWN, not SAFE), with no signal.
- **UI.** "Age: 3 d / at least 40 d / unavailable" appears in the token table when a report carries an age (deep-scan reports).

**Token-2022 extension instructions** (`lib/transaction/token2022.ts`, `decoder.ts`, `inner.ts`, `explain.ts`, `rules/transaction.ts`).
- **What is decoded.** Discriminators 25–46 are decoded byte-exactly: discriminator, sub-instruction, data length and account count must all match. This covers transferCheckedWithFee, the transfer-fee admin instructions, CPI Guard, required memo, default account state, transfer hook, permanent delegate, mint close authority, pausable, metadata/group pointers, interest-bearing, reallocate, createNativeMint, non-transferable and withdrawExcessLamports.
- **Identified but not decoded.** Confidential-transfer (27, 37, 42), scaled-UI-amount (43), unwrapLamports (45) and permissioned-burn (46) are recognised by family but not decoded. They count as undecoded, so the analysis is never COMPLETE, and they get no invented explanation.
- **Unknown or malformed** discriminators, sub-instructions or lengths → `SPL Token-2022:undecoded`.
- **Classic SPL Token.** Discriminators ≥ 25 sent to the classic SPL Token program are **never** decoded as extensions. Extended `SetAuthority` names (PermanentDelegate, TransferHookProgramId, …) apply to Token-2022 only; on SPL Token they show as `Unknown(n)`.
- **Transfers.** `transferCheckedWithFee` feeds `tokenTransfers`, top-level and CPI (the CPI case applies only when the program id is Token-2022), so the normal outflow rules apply.
- **New transaction signals.**
  - `TX_CPI_GUARD_DISABLED` (MEDIUM, only when the wallet is the owner).
  - `TX_CPI_GUARD_DISABLED_WITH_UNKNOWN_PROGRAM` (HIGH, two evidence ids).
  - `TX_TOKEN2022_CONFIDENTIAL` (LOW: amounts hidden).
- **Explanations.** Deterministic explanation lines were added for the security-relevant decoded instructions.

**URL reputation** (`lib/security/url-reputation.ts`).
- **Normalization.** Trimming, wrapper and trailing punctuation removal, a default `https://`, a lower-case punycode host, registrable-domain extraction (with common multi-part suffixes) and integer-IP normalization.
- **Patterns.**
  - HIGH: `javascript:`/`data:` schemes, the `user@host` trick, hidden zero-width/bidi characters, and look-alike brand spelling (digit substitution).
  - MEDIUM: brand name on a non-brand domain, punycode, IP hosts and link shorteners.
  - LOW: throwaway TLDs, lure wording, deep subdomains and plain http.
- **Combining.** Two MEDIUM-or-higher flags, or one plus two LOW flags, → `URL_MULTIPLE_RED_FLAGS` (HIGH). A URL alone never produces CRITICAL.
- **Unknown or known domains.** An unknown domain with no pattern is `NO_SIGNAL` (reputation unknown, not phishing). The known-domain list is identity only.
- **External reputation.** No external reputation service is integrated, and none needing a key was added. The capability is reported as `NOT_CONFIGURED` instead of pretending a lookup ran.
- **Display.** Evidence shows **defanged hosts** (`jup-claim[.]xyz`) plus pattern codes only, never raw URLs, paths or query strings, and it is rendered as plain text.
- **Integrated into:**
  - Token name/symbol links (existing `TOKEN_METADATA_LINK` evidence is now defanged, and URL signals were added).
  - Token descriptions (flagged only on a phishing pattern).
  - NFT/cNFT name/description/`external_url` (`ASSET_PHISHING_URL` / `ASSET_SUSPICIOUS_URL`).
  - Transaction memo instructions (`TX_MEMO_SUSPICIOUS_LINK`, capped at MEDIUM).
  - Timeline memos (a HIGH-pattern link → phishing memo).

**Risk-engine guarantees (tested).**
- Every new signal carries evidence ids that exist.
- Single weak signals stay LOW/MEDIUM, and combined independent evidence reaches at most HIGH.
- UNKNOWN/PARTIAL are preserved.
- In Demo Mode all evidence stays `DEMO`-labelled and no token age is claimed.
- The AI layer is untouched: risk levels are still computed only by the deterministic rules.

New tests (+57):
- `tests/unit/url-reputation.test.ts` (17)
- `tests/unit/token-age.test.ts` (19)
- `tests/unit/token2022.test.ts` (16, bytes produced by `@solana/spl-token` builders)
- `tests/unit/phishing-integration.test.ts` (5)

## Core MVP

| Phase | Status | Implemented | Tested | Remaining / limitations |
|---|---|---|---|---|
| 0 Infrastructure | VERIFIED | Solana web3.js, spl-token, wallet-adapter, AI SDK v7, zod, vitest; Buffer polyfill; env template; security headers | build/lint/tests | `bigint-buffer` native binding not built (npm install scripts blocked) → pure-JS fallback |
| 1 Architecture | VERIFIED | layered `lib/` (solana, token, transaction, security, cleanup, ai, demo, api, validation, wallet); standard `ApiResponse` + `AppError` | unit | — |
| 2 Solana + Helius | VERIFIED (live) | normalized wallet/token/tx data, SPL + Token-2022, u64 as strings, validated provider responses, history | unit + integration + mainnet | DAS NFT listing can fail for wallets with multi-MB spam metadata → reported PARTIAL/FAILED |
| 3 Token scanner | VERIFIED (live) | mint/freeze authority, Token-2022 extensions (permanent delegate, hook, fee, non-transferable, default-frozen, paused), RugCheck, on-chain holder concentration, phishing-name detection, cNFT lure/injection detection, token age (deep scan: on-chain creation verified via initializeMint, else lower bound / unavailable) | unit + mainnet (token age: live 2026-09-25 — KNOWN / LOWER_BOUND / UNAVAILABLE and devnet separation, cross-checked independently) | wallet scan does not check age (cost); "new + active mint authority" combination not observed live |
| 4 Risk engine | VERIFIED | deterministic levels SAFE…CRITICAL + UNKNOWN; analysis status separate; SAFE only when COMPLETE; evidence required per signal | unit | thresholds are heuristics, documented in code |
| 5 Decoder | VERIFIED (live) | legacy + v0, LUT resolution, System/Token/Token-2022/ComputeBudget/ATA/Memo; unknown programs listed, never guessed | unit + mainnet v0 tx + live Token-2022 / SPL txs (2026-09-25) | **v1 transactions (now on mainnet) are not decodable** — reported as `UNSUPPORTED_TRANSACTION`; Token-2022 extension decoding live-verified only for `initializeMetadataPointer` (+ base 21/22), others unit-tested against `@solana/spl-token` builders; confidential-transfer / scaled-UI / unwrapLamports / permissioned-burn payloads and third-party programs stay "undecoded"; token-metadata interface instructions (8-byte discriminators) undecoded; decoder changed after the mainnet check |
| 6 Simulation | VERIFIED (live) | `simulateTransaction` with pre-state snapshot, slot-drift staleness, blockhash validity, fee quote/estimate | mainnet | results can change before signing (stated in UI) |
| 7 Tx risk | VERIFIED | outflow (explained/unexpected/drain), approvals (unlimited), authority changes, wallet reassign, durable nonce, rent redirect, unknown program | unit + mainnet | no address-reputation data (unknown ≠ malicious) |
| 8 AI agent | PARTIAL / BLOCKED | read-only deterministic tools, sanitization, untrusted-data wrapping, evidence contract, deterministic fallback (`deterministicSummary`) used when AI is unavailable; truthful AI status (`CONFIGURED` ≠ ready) + cached on-demand key diagnostic | mock-model + status/diagnostic tests (fetch mocked) | **BLOCKED:** the key exists only in `.env.local`; the last live attempt (before the 2026-09-24 AI-status fix) was rejected by OpenAI and has not been re-checked. Real OpenAI integration not verified |
| 9 Scam & junk center | IMPLEMENTED | token table with risk/status/authorities/liquidity/holders/cleanup labels; NFT/cNFT list | API-level + headless render (demo data) | not click-tested |
| 10 Burn/Reclaim/Revoke | PARTIAL | capability matrix, eligibility, server-built unsigned tx, simulation gate, fee check, reclaim estimate, integrity check, cleanup dialog, wallet signing, relay with re-verification, post-state verification | unit (tamper tests) + direct signing/submit tests (RPC mocked) + mainnet prepare/simulate | sign → submit → confirm **not verified on-chain** (needs a real wallet; devnet first). cNFT burn/revoke unsupported by design |
| 11 Wallet connection | IMPLEMENTED | Wallet Standard (Phantom/Solflare/Backpack), MWA on Android, public key only; cluster-mismatch badge | typecheck/build + code review | **not tested with real extensions or mobile in-app browsers** |
| 12 Dashboard | IMPLEMENTED | metrics, wallet risk, portfolio bar, tokens, assets, AI panel, timeline | API-level + headless browser with scripted typing/clicks on a live mainnet scan (2026-09-25): scan, loading, results, row expansion, evidence, sources, timeline | no wallet-connected flow; assets list not exercised (DAS failed for the test wallet) |
| 13 Transaction UI | IMPLEMENTED | signature / base64 / base58 input, decode, effects, programs, logs, risk + evidence, deterministic explanation card, sign panel; memo shown with defanged links | headless browser on live executed Token-2022, SPL and v1 (error) txs (2026-09-25) | no wallet signing tested |
| 25 Demo mode | VERIFIED | deterministic synthetic wallet + suspicious tx (50 USDC + unlimited approval) through real engines, DEMO-labelled evidence, signing disabled | determinism tests | — |
| 26 Security & privacy | VERIFIED | no key/seed input, no server/AI signing, secrets server-only (bundle scanned), redacting logger, wallet masking for AI | tests + bundle scan (re-run 2026-09-25, 0 hits) | — |
| 28 Input validation | VERIFIED | zod schemas on every route; body size caps | unit | — |
| 29 AI security | VERIFIED (mock) | see Phase 8 | mock-model + status tests | live model not verified |
| 30 Tests | PARTIAL | 289 deterministic tests / 23 files (incl. live-validation regressions; unit, integration with mocked providers, security incl. signing, send/submit, prepare, route-level submit/cleanup/diagnose, sign gate, explanation, CPI, analyze pipeline, no-server-signing, AI status, timeline, token age, Token-2022 extensions, URL reputation) | — | no browser E2E; no React component tests for SignPanel/CleanupDialog; no on-chain tests |
| 31 Devnet | NOT_STARTED | `SOLANA_CLUSTER=devnet` supported in config | — | devnet E2E not done; requires a human with a devnet wallet to sign |
| 32 Mainnet safety | PARTIAL | guards for frozen, delegated, Token-2022, non-closeable, zero/insufficient SOL, ownership | unit | sign → send → confirm not verified on-chain; no real signatures |
| 33 UI/UX | PARTIAL | dark, responsive layout, loading/empty/error/partial states; font variable fixed | headless desktop + 390 px mobile-viewport screenshots (2026-09-25: no horizontal overflow on /dashboard, /transaction) | no real device / wallet in-app browser testing |
| 34 Landing | IMPLEMENTED | message + routes to scan / tx / demo | build | — |
| 35 Demo flow | IMPLEMENTED | 5-step flow incl. simulation and cleanup demo | API-level + headless render (step 1) | steps not click-tested |
| 40 Deployment | VERIFIED (live) | production build, env docs, security headers; Vercel deployments 2026-10-03 (https://presign-app.vercel.app mainnet-beta, https://presign-devnet.vercel.app devnet) | live: pages, `/api/multisig/inspect`, `/api/transaction/analyze` | Anthropic key not set on the deployments |
| 41 Tx safety UI | IMPLEMENTED | confirmation screen (token, action, account, amount, reclaim, fee incl. revoke, net, network, program, destination), acknowledgement required, dialog locked while signing/submitting | integrity unit tests + code review | not clicked through with a wallet |
| 42 Final audit | PARTIAL | audit done 2026-09-23 (see README “Security model”) | — | code changed after the audit (signing/submit/explanation/agent/AI status); those changes now have direct tests but were not re-audited |
| 43 Submission docs | IMPLEMENTED | README, this file | — | screenshots not produced |

## Secondary / advanced

| Phase | Status | Notes |
|---|---|---|
| 14 AI chat | IMPLEMENTED | dashboard + demo panel; live model not verified (key validity unknown, last rejected); deterministic fallback shown otherwise |
| 15 Timeline | IMPLEMENTED | recent signatures, each with an "Analyze" link and a deterministic status/memo class (phishing memo, suspicious memo, failed, memo, unclassified); unit-tested. Deeper per-tx classes (swap, transfer, approval) would need one `getTransaction` per entry and are not done. Rendered in a headless browser on a live scan (internal "Analyze" links only); phishing-memo class not observed live |
| 16 Address intelligence | NOT_STARTED | |
| 17 Wallet score | IMPLEMENTED | deterministic score from engine; `null` when data insufficient |
| 18 Portfolio risk | IMPLEMENTED | distribution incl. Unrated |
| 19 Market intelligence | NOT_STARTED | |
| 20 Holder/whale | PARTIAL | on-chain top-1/top-10 concentration only |
| 21 Alerts | NOT_STARTED | |
| 22 Realtime monitoring | NOT_STARTED | |
| 23 Phishing (URL) | IMPLEMENTED | deterministic URL normalization + pattern reputation (obfuscation, look-alikes, shorteners, userinfo, hidden chars, script schemes), wired into token/asset metadata, tx memos and timeline; unit-tested. No external reputation service (reported `NOT_CONFIGURED`); unknown domain = reputation unknown, not phishing. Live on real mainnet metadata (2026-09-25): 262 unknown → NO_SIGNAL, real brand impersonation caught, "solana" matching recalibrated; defanged evidence seen in the browser. Punycode / IP / userinfo not present in real data → unit-only |
| 24 Reports | NOT_STARTED | |
| 27 API protection | IMPLEMENTED | per-route rate limit (in-memory), timeouts, bounded retry + backoff |
| 36 Demo metrics | IMPLEMENTED | derived from demo session state only |
| 37 Caching | PARTIAL | RugCheck TTL cache with in-flight dedupe; no wallet-scoped caching |
| 38 RPC fallback | VERIFIED | capability-aware (DAS never falls back) |
| 39 Logging | IMPLEMENTED | structured JSON, secret redaction, masked addresses |

## Open blockers

1. **OpenAI key not verified** → live AI (FAZ 8/14/29) is unverified. The key exists only in `.env.local`; the last live attempt was rejected and it has not been re-checked. After replacing the key, use the header's "Verify AI" button (one `GET /v1/models` call).
2. **No real wallet signature** → sign → send → confirm (FAZ 10/32) is unverified on every cluster, and devnet E2E (FAZ 31) has not started. No transaction has ever been signed, sent or confirmed.
3. **No interactive browser / wallet-extension / mobile testing** (FAZ 9, 11, 12, 13, 33, 35, 41). Headless render only.
4. **Anthropic key on the deployments** (FAZ 40): deployed to Vercel on 2026-10-03 with Helius; `ANTHROPIC_API_KEY` set on 2026-10-10 and verified (`READY`, no tokens) on both sites; a live explanation not yet generated. The Gemini backup key is not set yet.
