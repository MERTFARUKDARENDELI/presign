# The Drift nonce trail (on-chain, read-only)

Checked 2026-10-02 against Solana mainnet through Helius RPC. Every fact below is public chain data; the transaction signatures are in `lib/demo/drift.ts` (`DRIFT_NONCE_ACCOUNTS`, `DRIFT_EXPLOIT_TXS`).

## What the chain shows

| Nonce account | Authority (council member) | Created | Created by | Used next |
|---|---|---|---|---|
| `7s7s6saC5LHZoLyBXLM3pCjpWaA7meyQdP8NiH9ktAeC` | `39JyWrdb…7C7Aq8` | 2026-03-24 01:22:06 UTC, slot 408,444,056 | `FMJnBkVp…Ni7YPF` | the attack, 2026-04-01 16:05:18 UTC (create + approve proposal #7) |
| `EmYEryTD…vvhQnc` | `6UJbu9ut…Pvu924` | 2026-03-31 02:35:49 UTC, slot 409,999,217 | `FMJnBkVp…Ni7YPF` | the attack, 2026-04-01 16:05:19 UTC (approve + execute) |

- Each account was created and initialized in one transaction (`createAccount` + `initializeNonce`) and had no other transaction until the attack.
- `initializeNonce` names the authority in its data; the authority does not sign and does not appear among the transaction's accounts. A member's own transaction history does not show that a nonce account names them.
- The creator, `FMJnBkVp…Ni7YPF`, is not a council member. It made six transactions in total, from 2026-03-24 01:12:24 UTC to 2026-03-31 02:35:49 UTC.
- A durable-nonce transaction must carry the nonce value stored in the account. That value is set from a recent blockhash at initialization and changes only when the nonce is advanced. Neither account was advanced before the attack, so each member's signature on the attack transaction was made after its account's creation: no earlier than March 24 (member 39Jy…) and March 31 (member 6UJb…).

We do not attribute the creator address to anyone; the incident reports linked from `/case/drift` cover attribution.

## What Presign does with it

- **Shipped:** proposal inspection reads the proposal's own transaction history. A create, approve or execute that landed inside a durable nonce is flagged (`MS_VOTE_SIGNED_IN_ADVANCE`, HIGH), with the nonce account, its authority and how long it had sat unused. Drift proposal #7, live: both votes, idle 8 days and 1 day. The team policy's `forbidDurableNonce` rule checks these votes too.
- **Not shipped:** an alert when a new nonce account names a watched member as its authority. That alert would have been possible on March 24. The measurements below show why it needs a transaction stream rather than RPC polling.

## Why the early alert needs a stream

- `getProgramAccounts` on the System program with `dataSize: 80` and `memcmp` on the authority (offset 8) is refused by Helius ("too many accounts"). Its paginated `getProgramAccountsV2` returned nothing for the Drift members after 60 pages / 16 s, and still nothing after 200+ pages / 60 s with `changedSinceSlot` set to the last ~150 slots.
- `logsSubscribe` mentioning the RecentBlockhashes sysvar (every nonce initialize and advance) delivered 6,969 transactions in 29 s: about 240 per second, 2,658 of them successful. Logs do not say whether a transaction initialized or advanced a nonce, or name its authority, so each one would need a `getTransaction` call.
- A Geyser-style transaction stream (instruction data included) can filter System instructions 6 (`InitializeNonceAccount`) and 7 (`AuthorizeNonceAccount`) by authority directly. That is the planned design for a Watchtower nonce alert.
