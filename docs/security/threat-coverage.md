# Presign threat coverage

Presign is a **pre-sign verification layer**: before a wallet signs, it decodes the exact bytes, simulates them, runs deterministic rules and shows the evidence. It is not a code audit and it does not guarantee that anything is safe. "No known risk" means no rule fired on complete data, not "proven safe". Missing or unverifiable data is never treated as safe.

The Drift multisig takeover is the showcase case, not the scope. This document lists every threat class Presign looks for, which rules cover it, and what it does **not** cover.

**Status:** Covered = decoded and checked by rules with tests · Partial = detected or flagged, but not fully decoded or provable · Not covered = outside what Presign can see today.

Every rule cites the evidence it fires on (decoded instruction, simulated state, on-chain account or provider response). The full catalogue with severities is in `lib/security/catalog.ts`; `tests/unit/catalog.test.ts` fails if a rule exists that is not catalogued.

## 1. Transactions: wallet drainers and hidden effects

| Threat | Status | Rules | How it is detected |
|---|---|---|---|
| SOL drained / full balance sent | Covered | `TX_SOL_DRAIN`, `TX_FULL_BALANCE_TRANSFER`, `TX_UNEXPECTED_SOL_OUTFLOW`, `TX_SOL_OUTFLOW` | Simulated balance changes compared with the decoded transfers |
| Tokens drained, several assets at once | Covered | `TX_MULTI_ASSET_DRAIN`, `TX_UNEXPECTED_TOKEN_OUTFLOW`, `TX_TOKEN_OUTFLOW` | Simulated token balance changes, including CPI transfers |
| Token approvals (delegate can spend later) | Covered | `TX_UNLIMITED_APPROVAL`, `TX_TOKEN_APPROVAL` | Decoded Approve/ApproveChecked and simulated delegate changes |
| Token account handed to another owner | Covered | `TX_TOKEN_ACCOUNT_OWNER_CHANGE` | Decoded SetAuthority(AccountOwner) and simulated owner change |
| Close authority changed / rent sent elsewhere | Covered | `TX_CLOSE_AUTHORITY_CHANGE`, `TX_CLOSE_RENT_TO_OTHER` | Decoded SetAuthority / CloseAccount |
| Wallet account reassigned to a program | Covered | `TX_WALLET_OWNER_REASSIGN` | Decoded System Assign and simulated owner change |
| Wallet account given data space (becomes unusable) | Covered | `TX_WALLET_ALLOCATE` | Decoded System Allocate / AllocateWithSeed on the wallet |
| Drain disguised as a priority fee | Covered | `TX_EXCESSIVE_PRIORITY_FEE` (MEDIUM ≥ 0.01 SOL, HIGH ≥ 0.1 SOL, CRITICAL ≥ half the wallet's SOL) | Compute unit price × limit, only when the wallet pays the fee |
| Staked SOL taken (stake accounts are not in the wallet balance) | Covered | `TX_STAKE_WITHDRAW_AUTHORITY_CHANGE` (CRITICAL), `TX_STAKE_AUTHORITY_CHANGE`, `TX_STAKE_WITHDRAW_TO_OTHER`, `TX_STAKE_LOCKUP_CHANGE` | Stake program decoded (Authorize, AuthorizeChecked, WithSeed variants, Withdraw, SetLockup, Split, Delegate, Deactivate, Merge) |
| Compressed NFTs moved (invisible to balance simulation) | Covered (Bubblegum v1) · Partial (v2) | `TX_CNFT_TRANSFER`, `TX_CNFT_DRAIN` (CRITICAL, 2+), `TX_CNFT_DELEGATE`, `TX_CNFT_BURN`, `TX_CNFT_UNDECODED` | Bubblegum transfer / delegate / burn decoded; v2 instructions identified by name and flagged, recipient not decoded |
| Metaplex Core NFTs moved | Partial | `TX_NFT_PROGRAM_UNDECODED` | Instruction involving the wallet is flagged; not decoded |
| Standard / programmable NFTs moved | Covered | outflow rules | They are token accounts, so the simulation shows them |
| Token-2022 tricks (CPI guard off, transfer hook, permanent delegate, pause, default frozen, confidential transfers, fee changes) | Covered | `TX_CPI_GUARD_DISABLED`, `TX_CPI_GUARD_DISABLED_WITH_UNKNOWN_PROGRAM`, `TX_TOKEN2022_CONFIDENTIAL` and the token rules (section 4) | Token-2022 extension instructions decoded |
| Never-expiring signatures (durable nonce) | Covered | `TX_DURABLE_NONCE`, `TX_NONCE_AUTHORITY_CHANGE`, `TX_UNKNOWN_PROGRAM_DURABLE_NONCE`, `MS_DURABLE_NONCE_GOVERNANCE` | AdvanceNonceAccount as first instruction (the Drift vector) |
| Program code replaced, closed, or upgrade authority moved | Covered | `TX_UPGRADE_AUTHORITY_CHANGE`, `TX_PROGRAM_UPGRADE`, `TX_PROGRAM_CLOSE` | BPF upgradeable loader decoded |
| Mint authority misused | Covered | `TX_MINT_AUTHORITY_CHANGE`, `TX_MINT_TO_OTHER` | Decoded SetAuthority(MintTokens) / MintTo |
| Phishing links in memos | Covered | `TX_MEMO_SUSPICIOUS_LINK` | URL pattern checks on memo text |
| Accounts hidden behind address lookup tables | Covered | analysis status | Tables are resolved; if they cannot be, the analysis is not complete and cannot reach "no known risk" |
| Drainer that behaves differently when simulated | Partial | `TX_SIMULATION_EVASION_RISK`, `TX_SIMULATION_FAILED`, stale-state notes | An unverified program receives the wallet's signature and write access to its token accounts but changes nothing in simulation. This is a heuristic: a simulation cannot prove future behavior |
| Unknown / unverified programs | Partial | `TX_UNKNOWN_PROGRAM`, `TX_CPI_GUARD_DISABLED_WITH_UNKNOWN_PROGRAM` | Identity only; there is no list of known-malicious programs |

## 2. Signing request context (`/connect`, `/demo/sign`, `/api/presign/*`)

| Threat | Status | Rules | How it is detected |
|---|---|---|---|
| Bait and switch ("swap 10 USDC" that moves 250) | Covered | `PRESIGN_SOL_EXCEEDS_DECLARED`, `PRESIGN_TOKEN_EXCEEDS_DECLARED:<mint>`, `PRESIGN_UNDECLARED_TOKEN_OUTFLOW:<mint>` | Effects the application declared, compared with the simulation |
| Honeypot token received (cannot be sold, can be taken back) | Covered | `PRESIGN_RECEIVED_RISKY_TOKEN:<mint>` | Each token the simulation credits to the wallet goes through the token rules; HIGH/CRITICAL findings become request signals. A failed scan makes the analysis PARTIAL |
| Fake copy of a popular token ("USDC" on another mint) | Covered when metadata is available | `TOKEN_IMPERSONATION` | Symbol / name compared with canonical mints (USDC, USDT, SOL, PYUSD, JUP, BONK, JTO, PYTH, RAY, WIF, mSOL, JitoSOL, bSOL), with lookalike letters, full-width characters and spacing normalized. Needs Helius DAS or Token-2022 on-chain metadata |
| Address poisoning (dust from a lookalike address) | Covered for direct transfers | `PRESIGN_POISONED_RECIPIENT:<address>` | The recipient's only earlier contact with the wallet was unsolicited dust (≤ 0.001 SOL / 0.01 tokens, never signed by the wallet), within the last 1,000 transactions of each side. A failed lookup makes the analysis PARTIAL |
| Phishing / lookalike website | Partial | `DOMAIN_<pattern>` (punycode, brand lookalike, brand impersonation, IP host, deep subdomain, shortener, suspicious TLD, user-info trick, hidden characters, lure wording), `DOMAIN_NAME_IMPERSONATION`, `DOMAIN_NOT_HTTPS`, `DOMAIN_INVALID` | Pattern checks only. An unknown domain is shown as unknown, never as safe. There is no external reputation service or blocklist |
| Spoofed origin | Covered | connection token | An origin counts as verified only through a sealed connection token; anything else is shown as a claim. With the extension, the origin is the one the browser reports to the extension, not what the page says |
| Wallet signs something other than what was reviewed | Covered | wallet result check | Web app: the signed bytes are re-hashed before use. Extension: the wallet gets a private copy of the reviewed bytes (a site that changes its array or object after the call changes nothing), a signed transaction may differ from the reviewed one only in its signature slots, a signed message must be byte-identical and its ed25519 signature valid for the reviewed bytes and account (`tests/extension/message-signatures.test.ts`); otherwise the signature is withheld from the site |
| Wrong wallet / account switched mid-flow | Covered | ownership proof | ed25519 signature over a one-time nonce; the approval is bound to the verified wallet |

## 3. Message signing

| Threat | Status | Rules |
|---|---|---|
| A transaction disguised as a "message" | Covered | `MSG_IS_TRANSACTION` (CRITICAL) |
| Text you cannot read (keys, signatures, encoded payloads; names an embedded transaction) | Covered | `MSG_OPAQUE_DATA` |
| Invisible / direction-changing characters | Covered | `MSG_HIDDEN_CHARACTERS` |
| Request for a seed phrase or private key | Covered | `MSG_SECRET_REQUEST` |
| Message names a different website than the requester | Covered | `MSG_DOMAIN_MISMATCH` |
| Phishing links | Covered | `MSG_SUSPICIOUS_LINK` |
| Permission or transfer wording | Covered | `MSG_AUTHORIZATION_LANGUAGE` |
| Text aimed at manipulating AI reviewers | Covered | `MSG_PROMPT_INJECTION` |
| Replayable sign-in (no nonce or expiry) | Covered | `MSG_REPLAYABLE_LOGIN` |
| Solana off-chain message format (Ledger / solana-sdk header, extended header) | Covered | header removed (exact length check), then the text is analyzed |
| Bytes that are not readable text | Covered | `MESSAGE_NOT_TEXT`: UNVERIFIABLE, never safe |

## 4. Tokens (token page, wallet scan, received tokens)

| Threat | Status | Rules |
|---|---|---|
| Issuer can freeze, mint, pause or take tokens back | Covered | `TOKEN_FREEZE_AUTHORITY_ACTIVE`, `TOKEN_MINT_AUTHORITY_ACTIVE`, `TOKEN_PERMANENT_DELEGATE` (CRITICAL), `TOKEN_PAUSED`, `TOKEN_DEFAULT_FROZEN` |
| Cannot be transferred, or arbitrary code on transfer | Covered | `TOKEN_NON_TRANSFERABLE`, `TOKEN_TRANSFER_HOOK` |
| Fake copy of a popular token | Covered with metadata | `TOKEN_IMPERSONATION` |
| Phishing in metadata | Covered | `TOKEN_METADATA_LINK`, `TOKEN_METADATA_LURE` |
| Rug pull indicators | Covered (external opinion) | `TOKEN_RUGCHECK_*`, `TOKEN_LIQUIDITY_LOW`, `TOKEN_LIQUIDITY_VERY_LOW`, `TOKEN_HOLDER_CONCENTRATION`, `TOKEN_HOLDER_CONCENTRATION_HIGH`, `TOKEN_FEW_HOLDERS` |
| Brand-new token | Covered | `TOKEN_NEW`, `TOKEN_VERY_NEW`, `TOKEN_NEW_WITH_RISK_FACTORS` |

Stablecoin issuer controls (USDC, USDT) are reported as documented issuer controls at a lower severity.

## 5. Wallet hygiene

| Threat | Status | Rules |
|---|---|---|
| Spam / phishing NFTs and cNFTs | Covered | `WALLET_PHISHING_ASSETS`, `ASSET_CLAIM_LURE`, `ASSET_NAME_LINK`, `ASSET_METADATA_INJECTION`, `ASSET_UNVERIFIED_SPAM_CNFT` |
| Frozen accounts, risky holdings | Covered | `WALLET_FROZEN_ACCOUNTS`, `WALLET_HOLDS_CRITICAL_TOKENS`, `WALLET_HOLDS_HIGH_RISK_TOKENS` |

## 6. Multisig and governance

| Threat | Status | Rules |
|---|---|---|
| Squads v4 takeover: authority leaves the multisig, threshold cut, config authority set, members swapped, time lock removed, votes pre-signed with durable nonces | Covered | 27 `MS_*` rules, `VAULT_TX_*` (the transaction rules applied to the vault payload) |
| Weak setup (single signature, controlled multisig, minority threshold, no time lock) | Covered | `POSTURE_*` |
| Presign Guard (time-locked execution with guardian veto) weakened or bypassed | Covered | `GUARD_*` |
| Upgrade to code that does not match a verified build | Covered (external registry) | `UPGRADE_CODE_UNAVAILABLE`, `UPGRADE_UNVERIFIED_CODE`, `UPGRADE_MATCHES_VERIFIED_BUILD` (OtterSec verified builds) |
| Team rules (allowed destinations, limits, required guard…) | Covered | `POLICY_*` (11 rules) |
| Squads v3, SPL Governance (Realms), other multisigs | Not covered | Treated as unknown programs |

## 7. Integrity of Presign itself

| Threat | Status | Protection (tests) |
|---|---|---|
| Bytes swapped between review and signing | Covered | Approval bound to the sha256 of the exact message bytes; the client signs only bytes with that hash (`tests/security/presign-signing.test.ts`, `signing.test.ts`) |
| Forged, modified, replayed or expired approval | Covered | HMAC-sealed tokens bound to wallet, session, target origin, payload hash and expiry; single use; submit re-checks (`presign-decision-flow.test.ts`, `submit.test.ts`) |
| Session cookie chosen or injected by someone else | Covered | Session ids carry the server's MAC; any other value is no session and gets a fresh one. Approvals also need the separate sealed wallet cookie (`session-secret.test.ts`) |
| A page on the Presign origin (e.g. through XSS) sends the extension a made-up approval | Covered | The extension forwards only after the Presign server confirms its sealed approval for the payload hash the extension computed from its own captured bytes, once (`approval-confirm.test.ts`, e2e). A script that can drive Presign's own analyze and approve endpoints in the user's verified session could still obtain a genuine approval, subject to the server's rules (no approval for unreadable requests, explicit override for HIGH / CRITICAL); the strict CSP makes such a script unlikely |
| Presign's relay used for transactions it never reviewed | Covered | `/api/transaction/submit` requires an approval token or a Guard prepared token for the exact message; without one nothing is sent (`routes.test.ts`) |
| Verdict lowered on the client | Covered | Server recomputes the risk on approve; the client value is ignored (`presign-signing.test.ts`) |
| Signing through an API the hook does not wrap (extension) | Covered | Wallet Standard `signTransaction`, `signAndSendTransaction`, `signAndSendAllTransactions`, `signMessage`, `signOffchainMessage`, `signIn` and the injected equivalents are reviewed; any other `solana:` signing feature, `sign…` provider method or `request({ method: "sign…" })` is refused (`tests/extension/intercept.test.ts`) |
| A site replaces built-ins after the extension's hook loaded (`Function.prototype.call`, Promise / Map / Array methods, `btoa`, accessors or `then` on `Object.prototype`, the global `Promise` / `Proxy`, …) to skip a review, forge an approval, swap the reviewed bytes or read the channel secret | Covered (Presign's hook) | The hook's path from the site's call to the wallet's uses only built-ins captured at document_start (`extension/src/lib/primordials.ts`), records without a prototype and typed-array indexing; site objects are read once and pinned; the site gets a wallet exposing only the Wallet Standard properties. 36 replacements × 17 entry points, cancel and approve (`tests/extension/hostile-page.test.ts`), and a hostile page in the Chrome end-to-end test. The wallet's own page code is outside this (limitation 2) |
| Review unavailable or request unreadable (extension) | Covered | Fails closed: an unreadable, oversized or too-large batch request is reviewed as unreadable (Cancel only); a review that cannot open is a refusal, never "continue anyway" (`tests/extension/fail-closed.test.ts`) |
| Server holding or using keys | Covered | No server-side signing; a static test fails on any signing call in server code (`no-server-signing.test.ts`) |
| AI changing the verdict, prompt injection in untrusted text | Covered | The verdict comes only from rules; AI explains server-attested findings (`ai-security.test.ts`) |
| Script injected into Presign's own pages (the origin whose approvals the extension has confirmed) | Covered | Content-Security-Policy with a fresh nonce per response and `'strict-dynamic'`: no inline script without the nonce, no eval in production, connections only to Presign, the public Solana RPC and `ws://localhost:*` — the on-device websocket the Android Mobile Wallet Adapter uses to reach the wallet app (`proxy.ts`, `lib/security/csp.ts`, `tests/unit/csp.test.ts`; on a production build every script of 11 pages carries the response's nonce). Pages render per request because of it |
| Open redirect, cross-site requests, cookie theft | Covered | Same-origin return paths only; HttpOnly, SameSite=Strict, Secure cookies (`presign-connect.test.ts`) |
| Abuse of the API | Covered | Rate limit on every route; payload size limits (transaction size, 4 KB messages) |
| Data source down | Covered | Missing data → PARTIAL / UNKNOWN, never SAFE; machine gate cannot reach `no_known_risk` |

## Known limitations

1. **No threat-intelligence feeds.** There is no blocklist of known-malicious programs, addresses or domains, and no external domain reputation. This is deliberate (deterministic, explainable rules); RugCheck and OtterSec are the only external opinions, and both are labeled as such.
2. **Interception on other sites needs the browser extension** ([`extension/`](../../extension/README.md)). A website alone cannot see what other sites ask a wallet to sign. The extension wraps the wallet APIs in each page, and its hook does not depend on any built-in the site can replace; but it cannot control the wallet's own page code. A site written for a particular wallet can still reach it around Presign (through the wallet's internals or its messages to its own extension) or change what that wallet's page code passes on, so the wallet's confirmation window stays the final check — only wallet-level integration closes that. After the wallet signs, its result passes through the wallet's code first: withholding a signature from a hostile site is best effort. It is not yet on the Chrome Web Store and not yet exercised with a real wallet extension.
3. **Batch signing** (`signAllTransactions`): each transaction is reviewed as its own request; there is no combined view across a batch.
4. **Bubblegum v2 and Metaplex Core** are identified and flagged, but their recipients are not decoded.
5. **Squads v3, SPL Governance (Realms) and other multisig programs** are not decoded.
6. **Simulation cannot prove the future.** Upgradeable programs, oracles and state can change after review; durable-nonce and simulation-evasion rules flag the risky cases but cannot rule them out.
7. **Address poisoning** is checked for direct transfers only, within the last 1,000 transactions of the wallet and the recipient. Presign does not compare lookalike characters with past counterparties.
8. **Token impersonation** needs metadata: Helius DAS (when configured) or Token-2022 on-chain metadata.
9. **Shared state is optional.** With a shared store configured (Upstash Redis REST / Vercel KV: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`), single use and rate limits hold across every server instance. Without one — or if it does not answer — they are per instance; approvals still expire within minutes and a signed transaction stops being valid when its blockhash expires (unless it uses a durable nonce, which is flagged). Under memory pressure nothing live is dropped: a full single-use registry refuses new work, and the rate limiter evicts only the least recently seen clients (`tests/security/shared-state.test.ts`).
10. **Not yet exercised with a real wallet extension** end to end (connect → sign → submit). The Presign Guard program is deployed on devnet and unaudited. A wallet that changes the transaction before signing (for example by adding a priority fee) gets its signature withheld, with an explanation; whether Phantom, Solflare or Backpack do that by default is untested.

11. **The extension needs Presign's server to forward an approval.** Every approval is confirmed with the Presign origin the review came from before the wallet is asked; if that server cannot be reached, approved requests are blocked (fail closed), not passed through. The confirmation binds the payload hash, type, wallet and site; the browser session is checked when the approval is issued, not again in the confirmation (the extension's request carries no cookies).
12. **The confirmation endpoint is new.** An extension built from this repository refuses every approval from a Presign deployment that does not yet serve `/api/presign/signing/verify-approval`; deploy the server before (or with) the extension.

## How to verify

```bash
npm test
```

Rule tests by area: `tests/unit/transaction.test.ts`, `token2022.test.ts`, `transaction-extra.test.ts` (stake, cNFT, fees, programs, nonce, simulation evasion), `token-security.test.ts` (including impersonation), `squads.test.ts`, `guard.test.ts`, `multisig-pipeline.test.ts`, `tests/security/presign-*.test.ts` (connect, context, signing, decision flow, honeypot, address poisoning, off-chain messages).
