# Presign Guard — design

Presign tells signers what a proposal does. **Presign Guard makes the dangerous ones wait, and lets any one honest signer stop them.**

Status: builds with Anchor 1.x (Agave 3.1.10); 11 LiteSVM tests cover the plan below; the IDL (`idl/presign_guard.json`) is checked against Presign's TypeScript codec in `tests/unit/guard-idl.test.ts`. Deployed on devnet: `A8cpj1d7zxF3T9kZzVn2wkEueGxqGVgd9VaqBA54EDRS` (IDL published through the Program Metadata program). Unaudited.

```bash
anchor build && cargo test -p presign-guard   # in guard/, on Linux or WSL
```

## Problem it solves

Drift's admin role sat in a 2-of-5 Squads vault with no time lock. Two pre-signed approvals were enough to hand the protocol to an attacker in one second. Squads offers a time lock, but it applies to *every* transaction and cancelling needs a threshold of cancel votes — so 98.2% of Squads multisigs on mainnet run without one (census, 2026-09-27).

Guard separates **critical authorities** from routine operations:

- The multisig keeps its routine authorities (treasury transfers, parameter tweaks) and stays fast.
- **Critical authorities** — protocol admin, program upgrade authority, mint / freeze authority — are handed to a Guard-controlled PDA. Anything done with them is **scheduled**, waits a fixed **delay**, and can be **vetoed by any single guardian** during the delay.

With Guard holding Drift's admin role, the attacker's approvals would only have *scheduled* `updateAdmin`; Watchtower would have alerted every signer; any of the three untouched members could have vetoed it with one signature.

## Roles

| Role | Who | Can |
|---|---|---|
| Proposer | The multisig vault (Squads vault PDA) | Schedule actions; cancel its own pending actions |
| Guardian (1–10) | Individual multisig members, a security firm, an ops key | Veto any pending action, alone |
| Anyone | Keeper, member, bot | Execute an action once its delay has passed and it was not vetoed |
| Guard signer | PDA `["signer", guard]` | Holds the critical authorities; signs only inside `execute` |

Nobody can make Guard sign immediately — including the proposer. Guardians can stop things; they can never execute anything.

## Accounts

- **Guard** — PDA `["guard", create_key]`: `create_key`, `proposer`, `guardians` (≤10), `delay_seconds`, `action_count`, bumps.
- **Action** — PDA `["action", guard, index u64 LE]`: `guard`, `index`, `proposer`, `rent_payer`, `scheduled_at`, `eta`, `status` (Pending / Executed / Vetoed / Cancelled), `vetoed_by`, `executed_at`, `memo` (≤128 bytes), `instructions` (≤4, each: program id, account metas, data).

## Instructions

| Instruction | Signer | Effect |
|---|---|---|
| `create_guard(proposer, guardians, delay)` | create key, payer | New guard; `delay ≥ 60s` (recommend ≥ 24h in production) |
| `schedule(instructions, memo)` | proposer | New pending action with `eta = now + delay` |
| `veto()` | a guardian | Pending → Vetoed |
| `cancel()` | proposer | Pending → Cancelled |
| `execute()` | anyone | Pending and `now ≥ eta` → Executed; each instruction is invoked with the guard signer's seeds |
| `update_config(config)` | guard signer only | New proposer / guardians / delay — reachable **only** through a scheduled, delayed, vetoable action |
| `close_action()` | anyone | Closes a finished action, rent back to whoever paid it |

## Invariants

1. The guard signer signs only in `execute`, only for an action that is Pending, past its `eta`, and was never vetoed or cancelled.
2. A scheduled instruction may request exactly one signer: the guard signer. Any other signer flag is rejected at scheduling time — nothing can smuggle in extra authority.
3. The only instruction an action may call on Guard itself is `update_config`. Configuration therefore changes only with the same delay and veto as everything else; there is no admin bypass.
4. The only action a guardian cannot veto is one whose single instruction removes *that* guardian and changes nothing else that weakens the guard (same proposer, delay not shortened, every other guardian kept). A rogue guardian therefore cannot block its own removal, while a compromised proposer cannot strip the guardians: removing two or more at once, replacing them, shortening the delay or bundling anything with a removal stays vetoable by every guardian, and removing honest guardians one at a time is vetoable by the others. With a single honest guardian this protection is gone, which is why one guardian is flagged.
5. The status is set to Executed before any cross-program call.
6. Bounds: ≤4 instructions per action, ≤24 accounts per instruction, ≤900 bytes of data per instruction, ≤10 guardians, delay 60 s – 30 days.

## How it fits Squads

1. Create a guard with `proposer = <Squads vault>` and the members (plus, optionally, an external security key) as guardians.
2. Move each critical authority to the guard signer PDA (BPF loader `SetAuthority`, SPL `SetAuthority`, or the protocol's own admin setter). Presign recognizes the signer of a guard whose proposer is the proposal's vault (found with `getProgramAccounts` on the proposer field) and reports the move as staying under the multisig's control, with the guard's delay and guardian count — not as the authority leaving the multisig. A guard proposed by anyone else stays "outside" (CRITICAL).
3. To use a critical authority, the team creates a normal Squads proposal whose vault instruction is `guard.schedule(...)`. After the Squads vote executes it, the action waits `delay`.
4. Presign decodes the schedule — including the instructions inside it — shows it in the Signer Brief and pushes it to Watchtower with the countdown and a veto link.
5. After the delay, anyone calls `execute`.

## Test plan (program)

Implemented in `programs/presign-guard/tests/guard.rs` (LiteSVM); each is a property the program must hold:

1. `schedule` by anyone but the proposer fails; with a foreign signer in a scheduled instruction fails; a self-call other than `update_config` fails; an `update_config` with trailing bytes or an invalid config fails.
2. `execute` before `eta` fails; after `eta` succeeds for anyone; a second `execute` fails (status is written before the CPIs).
3. Any guardian can `veto` a pending action, including after `eta` until it is executed; a non-guardian cannot; vetoed and cancelled actions cannot execute.
4. Guardian stripping: a config that replaces all guardians, removes two at once, shortens the delay, changes the proposer, or bundles a removal with another instruction is vetoable by every current guardian (including the removed ones).
5. A config that only removes guardian G cannot be vetoed by G, but can by every other guardian.
6. `update_config` cannot be called directly (the guard signer PDA must sign); through a scheduled action it waits the delay like anything else.
7. `execute` with a missing referenced account fails without changing state; the guard signer can pay (writable) when the outer instruction marks it writable.
8. `close_action` refuses pending actions and returns rent only to the payer.

## Known limits

- Scheduled instructions cannot require additional keypair signers (e.g. a fresh account keypair). Use PDAs or pre-created accounts.
- `execute` passes every referenced account in one transaction (about 30 distinct accounts fit). The program accepts larger actions (4 instructions × 24 accounts); Presign refuses to prepare an execute that does not fit and says so. Split large actions.
- Execution happens with chain state at execution time; the delay is the review window, not a snapshot.
- A guardian set of one is allowed but only one veto key then protects the protocol; the UI warns about it.
- Unaudited hackathon code. Devnet only until audited.
