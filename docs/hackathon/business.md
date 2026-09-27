# Presign — business one-pager

## Customer and pain

**Primary customer:** teams whose protocol, treasury or program upgrade authority sits in a Squads multisig — security councils, core teams, DAOs, funds, market makers. **User:** each signer. **Buyer:** the security lead, CTO or ops lead.

**Pain:** signers approve proposals they cannot independently read. The proposer's description is the only explanation most signers get. Drift showed the cost: ~$285M from two approvals, with no code bug.

**Size (on-chain, 2026-09-27):** 157,117 Squads v4 multisigs; 103,401 with at least one transaction; 18,939 with ten or more. 98.2% have no time lock. 13 of 36 widely used programs are upgradeable through a Squads v4 multisig; 8 of those 13 have no time lock.

## Product → revenue

| Tier | Who | What | Price (hypothesis) |
|---|---|---|---|
| Verifier | Every signer | `/verify`, `/transaction`, Drift replay | Free — distribution |
| Team | Protocols, treasuries, funds | Watchtower for all signers; policies (allowed authority holders, required time lock, blocked programs); audit log of what each signer was shown; posture reports | $99–$499 per multisig per month |
| API / MCP | Wallets, custodians, agent frameworks, bots | Pre-sign gate per transaction | Usage-based, per verification |
| Enterprise | Custodians, large protocols | Self-hosted, custom rule packs, SLA | Annual contract |

Illustrative Team-tier ceiling: 18,939 active multisigs × $99–$499 × 12 ≈ **$22M–$113M ARR**. This is an upper bound from on-chain counts, not a forecast; the first milestone is 10 paying teams.

## Why now

- The largest Solana loss of 2026 was a signing failure, not a code bug; teams are re-examining signing processes now.
- Agents are starting to hold keys; they need a check that is deterministic, not another model.
- Squads has encouraged independent verification front-ends — the ecosystem wants more than one screen.

## Competition and difference

| Alternative | What it does | Gap Presign fills |
|---|---|---|
| Squads UI and its open-source CLI / verifier | Shows and decodes proposals, simulates | No risk judgment: does not say *who controls what afterwards*, flag durable-nonce approvals, or alert signers independently |
| Wallet transaction previews (e.g. Phantom's, Blockaid-powered) | Drainer detection for dApp flows | Not built for governance: authority transfers via program-specific instructions, multisig payloads, time locks |
| Post-execution monitoring | Alerts after something happens | Presign acts before the signature, where the Drift attack could have been stopped |
| Manual review | Engineers read proposals | Slow, inconsistent, unavailable at 3 a.m.; Presign makes it a one-screen, evidence-backed check |

**Defensibility:** decoding depth across programs (Squads, loaders, IDLs), a growing rule set grounded in real incidents, per-team policy and audit data, and distribution through the free verifier. Open source (Apache-2.0) builds the trust a security tool needs; the hosted Team tier, policies and integrations are the business.

## 12-month plan

1. **Hackathon → Q4 2026:** 10 design partners on Watchtower; verifier usage from signers; first paid Team plans.
2. **Q1 2027:** policies + audit log; Slack / Telegram / email integrations; verified-build checks for program upgrades.
3. **Q2 2027:** API / MCP for wallets and agent frameworks; enterprise pilots with custodians.
4. **Beyond:** other multisig and governance programs (Squads v3, SPL Governance) and other chains' multisigs.

## Metrics we will report

Signers using the verifier (weekly), multisigs on Watchtower, proposals verified, critical findings surfaced (with permission), design partners, paying teams, API verifications.
