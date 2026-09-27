# Technical demo video — script (target 2:45, limit 3:00)

The technical demo explains *how*, not *why*. Show the product, then the parts of the code and data that make it trustworthy.

| Time | On screen | Voice-over |
|---|---|---|
| 0:00–0:15 | Architecture diagram from README ("How it works") | "Presign is a Next.js app plus two Node services. Input is a Squads link, an address, or a serialized transaction. Everything is read-only." |
| 0:15–0:50 | `lib/squads/decode.ts`, `tests/unit/squads.test.ts` (discriminator test), `/case/drift` instruction list | "We decode Squads v4 from bytes: all 36 instructions, seven account types, and the vault message embedded in a proposal. Tests recompute every Anchor discriminator from its name, and run on the real Drift exploit bytes. Vault messages can load program ids from lookup tables — Squads executes them by CPI — so we resolve those too." |
| 0:50–1:15 | `lib/anchor/source.ts` + the `updateAdmin(admin = …)` row labeled "named via on-chain IDL" | "For any Anchor program we fetch its IDL from the canonical on-chain account — only if the program owns it — and decode instruction names and arguments. That's how `updateAdmin` and its new admin appear. Names state intent, not behavior, and the evidence says so." |
| 1:15–1:40 | `lib/multisig/payload.ts` `withFeePayer` + simulated vault balance changes on `/verify` | "Then we simulate the proposal as the vault would execute it, with an executing member prepended as fee payer — so the vault's balance changes show only what the proposal does." |
| 1:40–2:05 | `lib/security/rules/multisig.ts` → evidence panel in the UI | "Rules are deterministic. Every signal carries evidence: the instruction, account or IDL field it came from. Missing data never becomes 'safe' — an undecodable proposal is its own finding." |
| 2:05–2:25 | Terminal: `npm run mcp` stdio call → `gate: block`; `npm run watchtower -- --once` output | "The same engine is an MCP server for agents, with a fixed gate mapping, and Watchtower, which polls multisigs and pushes each new proposal's brief to signers." |
| 2:25–2:45 | `npm test` (362 passing), `docs/research/multisig-census.json` | "362 deterministic tests, no network. And the census — every Squads multisig on mainnet, read-only — is a script in the repo, so every number we quote is reproducible." |

## Before recording

- `npm run typecheck && npm run lint && npm test && npm run build` green on the recording machine.
- Pre-run `/case/drift` and `/verify` once (warm caches).
- Terminal font ≥ 16px; editor font ≥ 16px; one file on screen at a time.
