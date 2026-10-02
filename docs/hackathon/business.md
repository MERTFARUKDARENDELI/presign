# Presign — business one-pager

## Customer and pain

**Primary customer:** teams whose protocol, treasury or program upgrade authority sits in a Squads multisig — security councils, core teams, DAOs, funds, market makers. **User:** each signer. **Buyer:** the security lead, CTO or ops lead.

**Pain:** signers approve proposals they cannot independently read. The proposer's description is the only explanation most signers get. Drift showed the cost: about $285M of users' funds (Drift's later figure: $295.4M) after two council members blind-signed approvals, with no code bug — and no one had time to say stop.

**Size (on-chain, 2026-09-27):** 157,117 Squads v4 multisigs; 103,401 with at least one transaction; 18,939 with ten or more. 98.2% have no time lock (99% of the active ones). 13 of 36 widely used programs are upgradeable through a Squads v4 multisig; 8 of those 13 have no time lock.

## Product → revenue

| Tier | Who | What | Price (hypothesis) |
|---|---|---|---|
| Verifier | Every signer | `/verify`, `/transaction`, Drift replay | Free — distribution |
| Team | Protocols, treasuries, funds | Watchtower for all signers; team policies (built); Presign Guard setup; audit log of what each signer was shown; posture reports | $99–$499 per multisig per month |
| API / MCP | Wallets, custodians, agent frameworks, bots | Pre-sign gate per transaction | Usage-based, per verification |
| Enterprise | Custodians, large protocols | Self-hosted, custom rule packs, SLA | Annual contract |

Illustrative Team-tier ceiling: 18,939 active multisigs × $99–$499 × 12 ≈ **$22M–$113M ARR**. This is an upper bound from on-chain counts, not a forecast; the first milestone is 10 paying teams.

## Why now

- The largest Solana loss of 2026 was a signing failure, not a code bug; teams are re-examining signing processes now.
- Agents are starting to hold keys; they need a check that is deterministic, not another model.
- Squads has encouraged independent verification front-ends — the ecosystem wants more than one screen.
- Squads v5 (announced April 2026) adds hooks and tiered time locks, but 157,117 v4 multisigs exist today and will stay on v4 for a while.

## Competition and difference

Drift made the problem visible and several teams now work on it; that confirms the market and means we must win on difference, not on being first.

| Alternative | What it does | Gap Presign fills |
|---|---|---|
| TxScope | Pre-sign threat reports for Solana multisigs (Squads links), Telegram/Slack alerts, free scans | Open source; any Anchor program through its on-chain IDL instead of a bundled list; team policy and API/MCP gate; verified-build checks; on-chain veto (Guard) |
| Range Security (Squads partner since May 2025) | Enterprise multisig security: previews, device security, monitoring, incident response, for >$10M TVL teams | Free, open layer for everyone; Guard can sit next to a Range setup |
| Squads + STRIDE tools (multisig-verifier, multisig-monitor, multisig-cli, April 2026) | Decode proposals, show approvals, notify on changes | Risk verdicts with evidence: who controls each authority afterwards, durable nonces, policy, simulation |
| Vetowall (same hackathon) | On-chain delays and a veto-only guardian for stablecoin issuers' Token-2022 authorities | Guard covers any critical authority and ships with the verifier, alerts and policy that tell guardians what to veto |
| Hypernative, Chainalysis Hexagate GateSigner | Enterprise transaction firewalls, policies, auto-reject | Squads-specific depth (embedded vault payloads, authority control), open source, free tier |
| Wallet previews (Phantom, which acquired Blowfish in Nov 2024; wallets using Blockaid) | Drainer detection for dApp flows | Not built for governance: authority transfers via program-specific instructions, multisig payloads, time locks |
| Post-execution monitoring (Custos Nox, solgov, Sec3 WatchTower) | Alerts after something happens, configuration risk | Presign acts before the signature, and Guard makes critical actions wait for a veto |
| Manual review | Engineers read proposals | Slow, inconsistent, unavailable at 3 a.m.; Presign makes it a one-screen, evidence-backed check |

**Defensibility:** see + stop + enforce in one open engine (verifier, Guard, policy, alerts, API share the same rules); decoding depth across programs (Squads, loaders, on-chain IDLs including Anchor 1.x); original census data; per-team policy and audit data; and distribution through the free verifier. Open source (Apache-2.0) builds the trust a security tool needs; the hosted Team tier, policies and integrations are the business.

## 12-month plan

1. **Hackathon → Q4 2026:** 10 design partners on Watchtower; verifier usage from signers; first paid Team plans; nonce watch (an alert when a new durable nonce account names a watched member as its authority, from a transaction stream; Drift's two were on chain 8 days and 1 day before the attack).
2. **Q1 2027:** audit log; Guard audit and mainnet launch; Slack / email integrations; Squads v5 support.
3. **Q2 2027:** API / MCP for wallets and agent frameworks; enterprise pilots with custodians.
4. **Beyond:** other multisig and governance programs (Squads v3, SPL Governance) and other chains' multisigs.

## Metrics we will report

Signers using the verifier (weekly), multisigs on Watchtower, proposals verified, critical findings surfaced (with permission), guards deployed, design partners, paying teams, API verifications.

## Risks we know about

- **Free alternatives for large protocols.** The Solana Foundation's STRIDE program gives >$10M TVL protocols free operational security and monitoring; Range targets the same teams. Our paid tier is for everyone below that line and for teams that want enforcement (policy, Guard), not only monitoring.
- **Squads v5** may cover part of the need with hooks and tiered time locks; v4 support remains necessary for years, and v5 support can be added.
- **No customer interviews yet.** Prices are hypotheses until design partners confirm them.
