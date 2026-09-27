# Pitch video — script (target 2:50, limit 3:00)

The pitch video is what judges watch first. One idea per scene, real product on screen, no filler. Record the screen at 1080p; speak slower than feels natural. `[ ]` = the team fills in.

| Time | On screen | Voice-over |
|---|---|---|
| 0:00–0:15 | Black → "April 1, 2026 · Drift Protocol · $285M" → two signatures | "On April 1st, $285 million left Drift in minutes. No smart-contract bug. No stolen keys. Two signatures." |
| 0:15–0:35 | Timeline from `/case/drift`: durable nonce → create + approve → execute → `updateAdmin` | "Two Security Council members had pre-signed transactions they thought were routine. They used durable nonces, so they never expired. The multisig had no time lock. When the attacker submitted them, admin control moved in one second." |
| 0:35–0:55 | Landing numbers: 157,117 · 98.2% · 8 of 13 | "This isn't Drift's problem. We read every Squads multisig on Solana: 157,000. 98% have no time lock. Of the major protocols upgradeable through a multisig, 8 of 13 have none. Every one of them depends on signers reading bytes." |
| 0:55–1:40 | `/case/drift` → click "Member 1" → Signer Brief (CRITICAL, never expires, NOT controlled by this multisig) | "This is Presign. These are the exact bytes a Drift council member signed. Presign decodes the Squads proposal inside, reads Drift's own on-chain IDL, and says it plainly: this makes H7Pi… the admin, an address outside your multisig. And this signature never expires. Critical — before anything executes." |
| 1:40–2:00 | `/verify` with a Squads link → proposal brief; Watchtower alert in Telegram | "Signers paste a Squads link and get the same brief for any proposal — decoded, simulated as the vault, every authority change classified. Watchtower sends it to every signer the moment a proposal is created, on a channel the proposer doesn't control." |
| 2:00–2:15 | `/docs` gate + MCP call returning `gate: block` | "Wallets, custodians and AI agents get the same engine as an API and an MCP server, with a deterministic gate an LLM can't talk its way past." |
| 2:15–2:35 | Simple slide: Free verifier → Team plan (Watchtower, policies, audit log) → API | "The verifier is free — that's our distribution. Teams pay per multisig for Watchtower, policies and an audit trail. Wallets and agents pay per verification. [Traction: e.g. 'X teams we interviewed, Y design partners, Z multisigs on Watchtower.']" |
| 2:35–2:50 | Team faces / names | "[Name 1: background.] [Name 2: background.] [Why us, one sentence.]" |
| 2:50–3:00 | Logo + "Know exactly what you sign." | "Presign. Know exactly what you sign." |

## Recording checklist

- Deployment on **mainnet-beta**, warm (run each demo once before recording so IDL and accounts are cached).
- Browser zoom 110–125% so text is readable; hide bookmarks and unrelated tabs.
- Show addresses briefly; do not dwell on raw JSON.
- If a live call is slow, cut the wait — never fake a result. Everything on screen must be real output.
- Captions: burn in or upload; judges often watch muted.
