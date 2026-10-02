# Build-in-public drafts (X)

Post from the team's accounts. Attach a screen recording or screenshot to each. Replace `[link]` with the deployment URL. Never name a specific protocol with a weak configuration.

## Day 1 — launch thread

1/ April 1, 16:05:18 UTC: a proposal appears in Drift's Security Council. 16:05:19: it executes and hands the admin to an attacker. About $285M of users' funds followed.

No contract bug, no stolen key: two members blind-signed approvals after months of social engineering. 🧵

2/ The approvals used durable nonces — they never expire, and they sat in the attacker's pocket, not on chain. Days earlier the council had moved to 2-of-5 with no time lock. Inside one approval: `updateAdmin(admin = H7Pi…)` — an address the multisig didn't control.

3/ Presign reads the exact bytes a signer is about to approve, decodes the Squads proposal inside, reads the program's own on-chain IDL, and says it in one line:

"Admin moves outside the multisig. This signature never expires." → CRITICAL.

4/ Try it on the real Drift transactions: [link]/case/drift

Paste any Squads proposal: [link]/verify

Open source, read-only, no keys. Built for #Colosseum Crypto World's Fair.

## Day 2 — the census

We read every Squads v4 multisig on Solana mainnet. 157,117 of them.

• 98.2% have no time lock — 99% of the 18,939 active ones
• 13 of 36 major programs are upgradeable through a Squads multisig — 8 of those have no time lock

No time lock = an approved proposal executes instantly. That's what made Drift a one-second takeover. Method + script: https://github.com/MERTFARUKDARENDELI/solana-ai-defender

## Day 3 — for signers

If you sign for a multisig, three questions before you approve anything:
1. Who controls each authority after this executes?
2. Does my signature expire?
3. What does the vault's balance look like after?

Presign answers all three from the chain, with evidence: [link]/verify

## Day 4 — for agents

Agents with wallets can be prompt-injected. So we made the pre-sign check deterministic: Presign's MCP server returns `gate: block | require_human_review | no_known_risk` from rules, not a model. An LLM can't argue past it. Docs: [link]/docs

## Day 5 — Watchtower

Every new Squads proposal → a plain-language brief to every signer on Telegram, before anyone approves. Independent of the UI that created the proposal. [video]

## Day 6 — Presign Guard

A warning helps only if someone can act on it. Presign Guard (devnet) holds a protocol's critical authorities: anything done with them is scheduled, waits a delay, and any one guardian can veto it. Routine ops stay fast.

We replayed a Drift-style takeover against it: flagged CRITICAL, vetoed, refused. [video]
