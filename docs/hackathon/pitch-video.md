# Pitch video — script (target 2:50, limit 3:00)

The pitch video is what judges watch first. One idea per scene, real product on screen, no filler. Record the screen at 1080p; speak slower than feels natural. `[ ]` = the team fills in.

The story in one line: **see it** (Presign reads what you sign), **stop it** (Presign Guard gives the team a window to veto), **enforce it** (team policy).

| Time | On screen | Voice-over |
|---|---|---|
| 0:00–0:12 | Black → "April 1, 2026 · 16:05:18 UTC" → "16:05:19" | "April 1st, 16:05:18. A proposal appears in Drift's Security Council. 16:05:19, it executes. One second later, an attacker controls the exchange — and about 285 million dollars of users' money goes with it." |
| 0:12–0:28 | Timeline from `/case/drift`: social engineering → 2-of-5, no time lock → durable nonces → create + approve → execute | "No contract bug, no stolen key. A six-month social-engineering operation, two compromised devices, and two council members who signed durable-nonce transactions they didn't fully understand. Days before, the council had dropped to two of five and removed its time lock. Those signatures weren't on chain — they were in the attacker's pocket." |
| 0:28–0:43 | Landing numbers: 157,117 · 98.2% · 99% of active · 8 of 13 | "We read every Squads multisig on Solana: 157,000. Of the active ones, 99% have no time lock. Of the major programs upgradeable through a multisig, 8 of 13 have none." |
| 0:43–1:15 | `/case/drift` → "Member 1" → Signer Brief (CRITICAL, never expires, NOT controlled by this multisig) | "This is Presign, on the exact bytes a Drift council member signed. It decodes the Squads proposal inside, reads Drift's own on-chain IDL, and says it plainly: this makes H7Pi… the admin — an address outside your multisig — and this signature never expires. Critical, before anything executes." |
| 1:15–1:30 | `/verify` with the team policy on → "Breaks your team policy" card; Telegram alert from Watchtower | "Teams write their rules once — who may hold admin, what must be delayed, how much may leave. Every proposal is checked against them, and Watchtower sends the verdict to every signer the moment a proposal appears." |
| 1:30–2:05 | Devnet (say so on screen): the takeover proposal flagged before the second approval → Presign Guard action page with countdown → guardian vetoes → status Vetoed → execution refused | "But Drift's devices were compromised — a warning on the same screen can be faked. A warning only helps if someone can act. Presign Guard is an on-chain program that holds a protocol's critical authorities. Anything done with them is scheduled, waits a fixed delay — a day in production, ten minutes in this demo — and any single guardian can veto it. Here is the Drift attack against a guarded protocol: the admin change is scheduled, every signer is alerted, one guardian vetoes. Routine operations stay fast; only critical ones wait." |
| 2:05–2:15 | `/docs` gate + MCP call returning `gate: block` | "Wallets, custodians and AI agents get the same engine as an API and an MCP server, with a deterministic gate an LLM can't talk its way past." |
| 2:15–2:35 | Simple slide: Free verifier → Team plan (Watchtower, policies, Guard, audit log) → API | "The verifier is free — that's our distribution. Teams pay per multisig for Watchtower, policies and Guard. Wallets and agents pay per verification. [Traction: e.g. 'X teams interviewed, Y design partners, Z multisigs on Watchtower.']" |
| 2:35–2:50 | Team faces / names | "Mert Faruk Darendeli: [background.] Nurullah Tarık Köseler: [background.] [Why us, one sentence.]" |
| 2:50–3:00 | Logo + "Know exactly what you sign." | "Drift was missing two things: a screen that says what a signature does, and a hand that can still say stop. Presign brings both." |

## Recording checklist

- Deployment on **mainnet-beta** for the Drift scenes, warm (run each demo once before recording so IDL and accounts are cached). The Guard scene runs on **devnet**; say so on screen.
- Browser zoom 110–125% so text is readable; hide bookmarks and unrelated tabs.
- Show addresses briefly; do not dwell on raw JSON.
- If a live call is slow, cut the wait — never fake a result. Everything on screen must be real output.
- Captions: burn in or upload; judges often watch muted.
- Claims: say "about $285 million" (Drift's later official figure is $295.4M); never "Presign would have stopped Drift" or "no other tool does this". Competitors and sourced answers to hard questions: the "Presign Sunum Denetimi" report and `submission.md` → Landscape.
