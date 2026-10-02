# Technical demo video — script (target 2:50, limit 3:00)

The technical demo explains *how*, not *why*. Show the product, then the parts of the code and data that make it trustworthy.

| Time | On screen | Voice-over |
|---|---|---|
| 0:00–0:12 | Architecture diagram from README ("How it works") | "Presign is a Next.js app, two Node services, and an on-chain program. Input is a Squads link, an address, or a serialized transaction. The app is read-only." |
| 0:12–0:40 | `lib/squads/decode.ts`, `tests/unit/squads.test.ts` (discriminator test), `/case/drift` instruction list | "We decode Squads v4 from bytes: all 36 instructions, seven account types, and the vault message inside a proposal — including program ids loaded from lookup tables. Tests recompute every discriminator from its name and run on the real Drift exploit bytes." |
| 0:40–1:00 | `lib/anchor/source.ts` + the `updateAdmin(admin = …)` row labeled "named via on-chain IDL" | "For any Anchor program we read its IDL from the canonical on-chain account — only if the program owns it. That's how `updateAdmin` and its new admin appear. Names state intent, not behavior, and the evidence says so." |
| 1:00–1:15 | `lib/multisig/payload.ts` `withFeePayer` + simulated vault balance changes | "Then we simulate the proposal as the vault would execute it, with an executing member as fee payer, so the vault's balance changes show only what the proposal does." |
| 1:15–1:35 | `/rules` catalog → `lib/security/rules/multisig.ts` → evidence panel | "73 deterministic rules, listed publicly and kept in sync with the code by a test. Every signal cites the instruction, account or IDL field behind it. Missing data never becomes 'safe'." |
| 1:35–1:55 | `lib/policy/evaluate.ts` → `/verify` policy card with one ✗ and one ? | "Team policies are data, not code. Each rule passes, fails, or is *unverifiable* — a payload we couldn't decode or simulate is never compliant by default. Violations flow into the same verdict and gate." |
| 1:55–2:25 | `guard/programs/presign-guard/src/lib.rs` (`schedule`, `veto`, `execute`) → `guard/DESIGN.md` invariants | "Presign Guard: the multisig vault schedules, the guard signer PDA signs only after the delay, any guardian vetoes. Two details matter. A config change can't strip the guardians — only a removal of one guardian, and nothing else, is exempt from that guardian's own veto. And the config a guardian reviews is byte-for-byte what executes. Presign flags any scheduled change that weakens the guard." |
| 2:25–2:40 | Terminal: MCP stdio call → `gate: block`; Watchtower `/watch` in Telegram | "The same engine is an MCP server for agents and Watchtower, a Telegram bot teams add themselves." |
| 2:40–2:50 | `npm test` (409 passing), `docs/research/multisig-census.json`, CI badge | "409 deterministic tests, CI on every push, and a reproducible census of every Squads multisig on mainnet." |

## Before recording

- `npm run typecheck && npm run lint && npm test && npm run build` green on the recording machine; `anchor test` green for the guard.
- Pre-run `/case/drift` and `/verify` once (warm caches).
- Terminal font ≥ 16px; editor font ≥ 16px; one file on screen at a time.
