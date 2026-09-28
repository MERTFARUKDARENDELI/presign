# Devnet demo — Presign Guard against a Drift-style takeover

Runbook for the pitch scene "a guardian vetoes the takeover" and the technical demo. Everything runs on **devnet**, from Linux or WSL (some networks block Solana devnet endpoints from Windows but not from WSL).

## 0. Toolchain (once)

Rust, Agave (Solana CLI) 3.1.10, Anchor 1.1.x, Node 24 — inside WSL/Linux. Program id: `A8cpj1d7zxF3T9kZzVn2wkEueGxqGVgd9VaqBA54EDRS` (its keypair stays outside the repository, in `~/.config/solana/presign_guard-program-keypair.json` on the build machine).

## Rehearsal on a local validator (no SOL needed)

The whole scenario also runs against a local validator with the real Squads v4 program cloned from devnet — the way it was first verified (2026-09-28: setup, takeover proposal, pending action CRITICAL in Presign, veto prepared by `/api/guard/prepare` and submitted through `/api/transaction/submit`, a vetoed action refused with `NotPending`, and a non-vetoed one executed after the delay, moving the mint authority by CPI).

```bash
solana-test-validator --reset --url devnet --clone-upgradeable-program SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf --clone BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr --upgradeable-program A8cpj1d7zxF3T9kZzVn2wkEueGxqGVgd9VaqBA54EDRS guard/target/deploy/presign_guard.so ~/.config/solana/id.json
```

```bash
SOLANA_RPC_URL=http://127.0.0.1:8899 PRESIGN_DEMO_DIR=~/.presign-demo-local GUARD_DELAY_SECONDS=120 npm run demo:guard -- setup
```

Presign against it: `SOLANA_CLUSTER=devnet HELIUS_API_KEY=" " SOLANA_FALLBACK_RPC_URL=http://127.0.0.1:8899 NEXT_PUBLIC_GUARD_PROGRAM_ID=A8cpj1d7zxF3T9kZzVn2wkEueGxqGVgd9VaqBA54EDRS npm run dev`.

## 1. Fund the deployer

The deployer is `~/.config/solana/id.json` (devnet only). Deploying needs about 2.6 SOL (the program's rent plus a temporary buffer); the demo needs about 0.3 SOL more.

```bash
solana address
```

`solana airdrop` is often rate-limited; use https://faucet.solana.com (sign in with GitHub, choose devnet, paste the address, request 5 SOL).

## 2. Build, test and deploy the program

```bash
cd guard && anchor build && cargo test -p presign-guard
```

```bash
anchor deploy --provider.cluster devnet
```

Optional, so explorers and other tools can decode it:

```bash
anchor idl init --provider.cluster devnet --filepath target/idl/presign_guard.json A8cpj1d7zxF3T9kZzVn2wkEueGxqGVgd9VaqBA54EDRS
```

## 3. Run the scenario

From the repository root, in WSL. Each step prints Presign links. Keys and state stay in `~/.presign-demo`.

| Step | What happens on devnet | What to show in Presign |
|---|---|---|
| `npm run demo:guard -- setup` | 2-of-3 Squads multisig (no time lock), a token whose mint authority the vault holds, a guard (proposer = vault, 3 guardians, 10-minute delay), proposal #1 moving the mint authority to the guard | Proposal #1: "Mint authority moves to Presign Guard" (LOW, delay and guardians stated) |
| `npm run demo:guard -- attack-propose` | Proposal #2: the vault schedules "mint authority → attacker" through the guard, with a routine memo; one approval | Proposal #2 before the second signer approves: the scheduled takeover is decoded and flagged |
| `npm run demo:guard -- attack-execute` | Second approval + execution (as in Drift). The action is pending for 10 minutes | The action page: CRITICAL, countdown, veto button |
| `npm run demo:guard -- veto` | An independent guardian vetoes (or use the veto button in `/verify` with that key in a devnet wallet) | Action status Vetoed |
| `npm run demo:guard -- execute-action` | The program refuses to execute a vetoed action | Mint authority still held by the guard |
| `npm run demo:guard -- status` | Addresses, current mint authority, links | — |

Presign must run against devnet with the guard configured:

```bash
SOLANA_CLUSTER=devnet NEXT_PUBLIC_GUARD_PROGRAM_ID=A8cpj1d7zxF3T9kZzVn2wkEueGxqGVgd9VaqBA54EDRS npm run dev
```

(or the same variables on the deployment). Watchtower: `WATCH_GUARDS=<guard address>` or `/watch <guard>` in Telegram announces the scheduled action with its countdown.

## Recording notes

- Say on screen that it is devnet.
- Record the attack with the real delay running (10 minutes) — cut, do not fake the wait.
- The same `setup` state can be reused; run `attack-propose` again for a second take (a new proposal and action index).
