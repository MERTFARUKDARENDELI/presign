/**
 * Public catalog of the deterministic rules behind Presign's verdicts. Each
 * entry is what a signal's `code` means; codes carry a suffix (instruction
 * index, mint, account) when one rule can fire several times. A test keeps
 * this list in sync with the rule sources.
 */

export type RuleFamily = "proposal" | "setup" | "upgrade" | "guard" | "policy" | "transaction" | "signing";

export interface RuleEntry {
  code: string;
  family: RuleFamily;
  /** Fixed level, or how it varies. */
  severity: string;
  when: string;
}

export const FAMILY_INFO: Record<RuleFamily, { title: string; about: string }> = {
  proposal: { title: "Multisig proposals", about: "What a Squads proposal (or a signature on one) would do, from the vault's point of view." },
  setup: { title: "Multisig setup", about: "Standing risks of a multisig's configuration, independent of any proposal." },
  upgrade: { title: "Program upgrades", about: "The code a proposal would deploy, hashed like solana-verify and compared with the OtterSec verified-builds registry." },
  guard: { title: "Presign Guard", about: "Actions scheduled through the on-chain guard (delay + single-guardian veto) and the guard's own setup." },
  policy: { title: "Team policy", about: "Your own rules, when a policy is supplied. A policy only adds signals." },
  transaction: { title: "Transactions", about: "Any transaction before it is signed: decoded instructions and simulated balance changes of the signer." },
  signing: { title: "Messages & connections", about: "Off-chain message signing requests and the application (domain) a wallet connects to, in Presign's pre-sign review." },
};

export const RULE_CATALOG: RuleEntry[] = [
  // Multisig proposals
  { code: "MS_AUTHORITY_LEAVES_MULTISIG", family: "proposal", severity: "CRITICAL", when: "An admin, upgrade, token or config authority goes to an address that is not the multisig, one of its vaults, a member, or the multisig's own Presign Guard." },
  { code: "MS_DURABLE_NONCE_GOVERNANCE", family: "proposal", severity: "CRITICAL", when: "A Squads create, approve or execute instruction is signed inside a durable-nonce transaction: the signature never expires." },
  { code: "MS_VOTE_SIGNED_IN_ADVANCE", family: "proposal", severity: "HIGH", when: "A create, approve or execute of this proposal already on chain landed inside a durable-nonce transaction: it may have been signed days or weeks before (the Drift takeover pattern)." },
  { code: "MS_CONFIG_AUTHORITY_SET", family: "proposal", severity: "CRITICAL", when: "A single key becomes the multisig's config authority and could change members and threshold without a vote." },
  { code: "MS_THRESHOLD_CHANGE", family: "proposal", severity: "CRITICAL if set to 1 · HIGH if lowered · LOW if raised", when: "The proposal changes the approval threshold." },
  { code: "MS_AUTHORITY_TO_SINGLE_KEY", family: "proposal", severity: "HIGH", when: "An authority goes to one member's key, which can then act without a vote." },
  { code: "MS_AUTHORITY_REMOVED", family: "proposal", severity: "HIGH", when: "An authority is removed permanently." },
  { code: "MS_PROGRAM_UPGRADE", family: "proposal", severity: "HIGH", when: "A program's code is replaced." },
  { code: "MS_PROGRAM_CLOSE", family: "proposal", severity: "HIGH", when: "A program or program buffer is closed." },
  { code: "MS_ACCOUNT_REASSIGN", family: "proposal", severity: "HIGH", when: "An account is reassigned to another owner program." },
  { code: "MS_ADMIN_CHANGE_UNKNOWN_TARGET", family: "proposal", severity: "HIGH", when: "An instruction named like an authority change (from the program's IDL) whose new holder cannot be identified." },
  { code: "MS_PAYLOAD_UNVERIFIED", family: "proposal", severity: "HIGH", when: "The proposal's contents could not be loaded or decoded; it can never be reported as no risk." },
  { code: "MS_TIME_LOCK_CHANGE", family: "proposal", severity: "HIGH if removed or shortened · LOW otherwise", when: "The proposal changes the time lock." },
  { code: "MS_NO_TIME_LOCK", family: "proposal", severity: "HIGH with a privileged action · MEDIUM otherwise", when: "The proposal can execute the moment its threshold is reached." },
  { code: "MS_MINORITY_THRESHOLD", family: "proposal", severity: "MEDIUM with a privileged action · LOW otherwise", when: "Fewer than half of the voting members can pass it." },
  { code: "MS_ADMIN_ACTION", family: "proposal", severity: "MEDIUM", when: "An administrative instruction (pause, fees, oracle, config…), or a call the vault signs as a program's admin." },
  { code: "MS_VAULT_OUTFLOW", family: "proposal", severity: "MEDIUM", when: "The simulated execution moves assets out of the vault." },
  { code: "MS_FOREIGN_SIGNER", family: "proposal", severity: "MEDIUM", when: "The vault transaction requires a signature the multisig cannot provide." },
  { code: "MS_CONTROLLED_MULTISIG", family: "proposal", severity: "MEDIUM", when: "A config authority can change the multisig without a vote." },
  { code: "MS_FINAL_APPROVAL", family: "proposal", severity: "MEDIUM", when: "Your approval is the one that makes the proposal executable." },
  { code: "MS_MEMBER_ADDED", family: "proposal", severity: "MEDIUM", when: "A member is added." },
  { code: "MS_MEMBER_REMOVED", family: "proposal", severity: "MEDIUM", when: "A member is removed." },
  { code: "MS_SPENDING_LIMIT_ADDED", family: "proposal", severity: "MEDIUM to any destination · LOW with a destination list", when: "Members may spend without a vote up to a limit." },
  { code: "MS_AUTHORITY_TO_GUARD", family: "proposal", severity: "LOW", when: "An authority goes to a Presign Guard whose proposer is this multisig's vault: still controlled, now delayed and vetoable." },
  { code: "MS_AUTHORITY_INTERNAL", family: "proposal", severity: "LOW", when: "An authority moves between addresses the multisig controls." },
  { code: "MS_PAYLOAD_PARTIAL", family: "proposal", severity: "LOW", when: "Some instructions could not be decoded (for example a program without a public IDL)." },
  { code: "MS_CONFIG_MINOR", family: "proposal", severity: "LOW", when: "The rent collector changes or a spending limit is removed." },
  { code: "VAULT_TX_*", family: "proposal", severity: "as the transaction rule", when: "Transaction rules (drains, approvals, owner changes…) applied to the vault's simulated execution." },

  // Multisig setup
  { code: "POSTURE_SINGLE_SIGNATURE", family: "setup", severity: "HIGH", when: "One signature is enough: a single member, or threshold 1 with several voters." },
  { code: "POSTURE_CONTROLLED", family: "setup", severity: "HIGH", when: "A config authority can change members, threshold and time lock without a vote." },
  { code: "POSTURE_MINORITY_THRESHOLD", family: "setup", severity: "MEDIUM", when: "A minority of voting members can pass any proposal." },
  { code: "POSTURE_NO_TIME_LOCK", family: "setup", severity: "MEDIUM", when: "Approved proposals execute immediately." },
  { code: "POSTURE_NO_EXECUTOR", family: "setup", severity: "LOW", when: "No member has the Execute permission." },

  // Program upgrades
  { code: "UPGRADE_CODE_UNAVAILABLE", family: "upgrade", severity: "HIGH", when: "The buffer with the new code could not be read." },
  { code: "UPGRADE_UNVERIFIED_CODE", family: "upgrade", severity: "MEDIUM", when: "The new code is not a build the registry verified for this program." },
  { code: "UPGRADE_MATCHES_VERIFIED_BUILD", family: "upgrade", severity: "LOW", when: "The new code is exactly a verified build (source repository and commit shown)." },

  // Presign Guard
  { code: "GUARD_CONFIG_WEAKENED", family: "guard", severity: "CRITICAL if the proposer leaves or every guardian is replaced · HIGH if guardians are removed or the delay shrinks", when: "A scheduled change of the guard's own configuration weakens it — the first thing an attacker holding the proposer would schedule." },
  { code: "GUARD_ACTION_UNDECODED", family: "guard", severity: "HIGH", when: "Part of a scheduled action could not be decoded." },
  { code: "GUARD_MS_*", family: "guard", severity: "one level below the immediate rule", when: "A privileged action scheduled through a guard whose delay and veto were verified on-chain; unchanged severity when the guard cannot be verified." },
  { code: "GUARD_ACTION_EXECUTABLE", family: "guard", severity: "MEDIUM", when: "The delay has passed: anyone can execute the action now." },
  { code: "GUARD_SHORT_DELAY", family: "guard", severity: "MEDIUM", when: "The guard's delay is under one hour." },
  { code: "GUARD_SINGLE_GUARDIAN", family: "guard", severity: "MEDIUM", when: "Only one guardian can veto." },
  { code: "GUARD_UNVERIFIED", family: "guard", severity: "MEDIUM", when: "The guard account could not be loaded, so its delay and guardians are unknown." },
  { code: "GUARD_CONFIG_CHANGE", family: "guard", severity: "MEDIUM if the current setup is unknown · LOW otherwise", when: "A scheduled configuration change that weakens nothing (adds guardians, lengthens the delay)." },
  { code: "GUARD_SCHEDULED", family: "guard", severity: "LOW", when: "The proposal schedules actions through Presign Guard." },
  { code: "GUARD_ACTION_PENDING", family: "guard", severity: "LOW", when: "The action is waiting and can still be vetoed." },
  { code: "GUARD_PROPOSER_IS_GUARDIAN", family: "guard", severity: "LOW", when: "The proposer is also a guardian." },

  // Team policy
  { code: "POLICY_<rule>", family: "policy", severity: "the policy's severity (HIGH by default)", when: "A rule of the supplied team policy is broken." },
  { code: "POLICY_UNVERIFIED_<rule>", family: "policy", severity: "MEDIUM", when: "A rule could not be checked: contents not decoded, not simulated, or an account not loaded." },

  // Transactions
  { code: "TX_WALLET_OWNER_REASSIGN", family: "transaction", severity: "CRITICAL", when: "Your wallet account is assigned to another program." },
  { code: "TX_TOKEN_ACCOUNT_OWNER_CHANGE", family: "transaction", severity: "CRITICAL", when: "Your token account gets a new owner." },
  { code: "TX_UNLIMITED_APPROVAL", family: "transaction", severity: "CRITICAL", when: "A delegate may spend an unlimited amount of your tokens." },
  { code: "TX_SOL_DRAIN", family: "transaction", severity: "CRITICAL", when: "Nearly all of your SOL leaves the wallet." },
  { code: "TX_MULTI_ASSET_DRAIN", family: "transaction", severity: "CRITICAL", when: "Several different tokens leave your wallet at once — a typical drainer pattern." },
  { code: "TX_UPGRADE_AUTHORITY_CHANGE", family: "transaction", severity: "CRITICAL to a new key · HIGH if removed", when: "A program's upgrade authority changes." },
  { code: "TX_TOKEN_APPROVAL", family: "transaction", severity: "HIGH", when: "A delegate may spend your tokens." },
  { code: "TX_UNEXPECTED_SOL_OUTFLOW", family: "transaction", severity: "HIGH", when: "More SOL leaves than the visible transfer instructions explain." },
  { code: "TX_UNEXPECTED_TOKEN_OUTFLOW", family: "transaction", severity: "HIGH", when: "Tokens leave through a program call that is not a visible transfer." },
  { code: "TX_FULL_BALANCE_TRANSFER", family: "transaction", severity: "HIGH", when: "Your entire balance of a token moves." },
  { code: "TX_CLOSE_AUTHORITY_CHANGE", family: "transaction", severity: "HIGH", when: "A close authority is transferred." },
  { code: "TX_NONCE_AUTHORITY_CHANGE", family: "transaction", severity: "HIGH", when: "A nonce account's authority is transferred." },
  { code: "TX_CLOSE_RENT_TO_OTHER", family: "transaction", severity: "HIGH", when: "An account is closed and its rent goes to someone else." },
  { code: "TX_CPI_GUARD_DISABLED_WITH_UNKNOWN_PROGRAM", family: "transaction", severity: "HIGH", when: "Token-2022 CPI Guard is disabled in the same transaction as an unverified program." },
  { code: "TX_SOL_OUTFLOW", family: "transaction", severity: "MEDIUM", when: "SOL is sent to a destination." },
  { code: "TX_TOKEN_OUTFLOW", family: "transaction", severity: "MEDIUM", when: "Tokens are sent or burned." },
  { code: "TX_MINT_AUTHORITY_CHANGE", family: "transaction", severity: "MEDIUM", when: "A mint or freeze authority changes." },
  { code: "TX_DURABLE_NONCE", family: "transaction", severity: "MEDIUM", when: "The transaction uses a durable nonce and does not expire with its blockhash." },
  { code: "TX_CPI_GUARD_DISABLED", family: "transaction", severity: "MEDIUM", when: "Token-2022 CPI Guard is disabled." },
  { code: "TX_MEMO_SUSPICIOUS_LINK", family: "transaction", severity: "MEDIUM", when: "A memo contains a link with phishing traits (links are always shown defanged)." },
  { code: "TX_UNKNOWN_PROGRAM", family: "transaction", severity: "LOW", when: "An unverified program is called." },
  { code: "TX_SIMULATION_FAILED", family: "transaction", severity: "LOW", when: "The simulation fails; balance changes cannot be observed." },
  { code: "TX_RENT_DEPOSIT", family: "transaction", severity: "LOW", when: "SOL goes into new accounts as their rent-exempt deposit." },
  { code: "TX_TOKEN2022_CONFIDENTIAL", family: "transaction", severity: "LOW", when: "A confidential transfer hides amounts." },
  { code: "TX_EXCESSIVE_PRIORITY_FEE", family: "transaction", severity: "MEDIUM ≥ 0.01 SOL · HIGH ≥ 0.1 SOL · CRITICAL ≥ half the wallet's SOL", when: "The priority fee (compute unit price × limit) the wallet pays is inflated — a drain that looks like a fee." },
  { code: "TX_STAKE_WITHDRAW_AUTHORITY_CHANGE", family: "transaction", severity: "CRITICAL", when: "The withdraw authority of a stake account held by the wallet moves to another address (staked SOL is not in the wallet balance)." },
  { code: "TX_STAKE_AUTHORITY_CHANGE", family: "transaction", severity: "HIGH", when: "The stake authority of a stake account held by the wallet moves to another address." },
  { code: "TX_STAKE_WITHDRAW_TO_OTHER", family: "transaction", severity: "HIGH", when: "SOL is withdrawn from a stake account the wallet controls to another address." },
  { code: "TX_STAKE_LOCKUP_CHANGE", family: "transaction", severity: "MEDIUM", when: "The lockup of a stake account the wallet controls changes." },
  { code: "TX_CNFT_TRANSFER", family: "transaction", severity: "HIGH", when: "A compressed NFT (Bubblegum) owned or delegated to the wallet is transferred to another address — invisible to token-balance simulation." },
  { code: "TX_CNFT_DRAIN", family: "transaction", severity: "CRITICAL", when: "Two or more compressed NFTs leave the wallet in one transaction." },
  { code: "TX_CNFT_DELEGATE", family: "transaction", severity: "HIGH", when: "Another address becomes the delegate of a compressed NFT the wallet owns." },
  { code: "TX_CNFT_BURN", family: "transaction", severity: "MEDIUM", when: "A compressed NFT the wallet owns is burned." },
  { code: "TX_CNFT_UNDECODED", family: "transaction", severity: "HIGH", when: "A Bubblegum v2 transfer / delegate / burn involves the wallet; identified, but its recipient is not decoded." },
  { code: "TX_NFT_PROGRAM_UNDECODED", family: "transaction", severity: "MEDIUM", when: "A Metaplex Core instruction involves the wallet: NFT ownership changes are not token balances and are not decoded." },
  { code: "TX_PROGRAM_UPGRADE", family: "transaction", severity: "HIGH", when: "The wallet, as upgrade authority, replaces a program's code." },
  { code: "TX_PROGRAM_CLOSE", family: "transaction", severity: "HIGH", when: "The wallet, as authority, closes a program or buffer permanently." },
  { code: "TX_WALLET_ALLOCATE", family: "transaction", severity: "HIGH", when: "The wallet account itself would get data space and may become unusable." },
  { code: "TX_MINT_TO_OTHER", family: "transaction", severity: "MEDIUM", when: "Tokens are minted with the wallet's mint authority to an account it does not own." },
  { code: "TX_UNKNOWN_PROGRAM_DURABLE_NONCE", family: "transaction", severity: "HIGH", when: "A never-expiring (durable nonce) signature calls an unverified program: it can run later, when behavior may differ from today's simulation." },
  { code: "TX_SIMULATION_EVASION_RISK", family: "transaction", severity: "MEDIUM", when: "An unverified program gets the wallet's signature and write access to its token accounts but does nothing visible in the simulation — the pattern of drainers that detect simulations." },
  // Messages & connections (pre-sign review)
  { code: "MSG_IS_TRANSACTION", family: "signing", severity: "CRITICAL", when: "The bytes presented as a message are a valid Solana transaction message; signing them can authorize that transaction." },
  { code: "MSG_HIDDEN_CHARACTERS", family: "signing", severity: "HIGH", when: "The message contains zero-width or direction-changing characters that hide or reorder text." },
  { code: "MSG_SECRET_REQUEST", family: "signing", severity: "HIGH", when: "The message mentions a seed phrase, recovery phrase or private key." },
  { code: "MSG_DOMAIN_MISMATCH", family: "signing", severity: "HIGH", when: "The message names a different website than the origin Presign verified for the request." },
  { code: "MSG_SUSPICIOUS_LINK", family: "signing", severity: "LOW–HIGH (link pattern level)", when: "A link in the message matches phishing patterns." },
  { code: "MSG_AUTHORIZATION_LANGUAGE", family: "signing", severity: "MEDIUM", when: "The message uses transfer, approval or permission language the requesting service may treat as your authorization." },
  { code: "MSG_PROMPT_INJECTION", family: "signing", severity: "MEDIUM", when: "The message contains wording aimed at manipulating automated reviewers." },
  { code: "MSG_OPAQUE_DATA", family: "signing", severity: "MEDIUM", when: "The message contains a long encoded block (100+ characters of hex / base58 / base64) — a key, signature or payload the signer cannot read; the evidence notes when it decodes as a Solana transaction." },
  { code: "MSG_REPLAYABLE_LOGIN", family: "signing", severity: "LOW", when: "A sign-in message has no one-time nonce or no timestamp, so the signature could be reused." },
  { code: "DOMAIN_<pattern>", family: "signing", severity: "LOW–HIGH", when: "The connecting application's address matches a phishing pattern (look-alike brand, punycode, shortener, raw IP, suspicious TLD, hidden characters, disguised destination…); an unknown domain is reported as unknown, never safe." },
  { code: "DOMAIN_NOT_HTTPS", family: "signing", severity: "HIGH", when: "The connecting application uses plain http (outside local development)." },
  { code: "PRESIGN_SOL_EXCEEDS_DECLARED", family: "signing", severity: "HIGH", when: "The simulation moves more SOL out of the wallet than the requesting application declared (network fee excluded)." },
  { code: "PRESIGN_TOKEN_EXCEEDS_DECLARED:<mint>", family: "signing", severity: "HIGH", when: "The simulation moves more of a token out of the wallet than the application declared." },
  { code: "PRESIGN_UNDECLARED_TOKEN_OUTFLOW:<mint>", family: "signing", severity: "HIGH", when: "The simulation moves a token out of the wallet that the application did not declare at all." },
  { code: "PRESIGN_RECEIVED_RISKY_TOKEN", family: "signing", severity: "HIGH", when: "(suffixed :<mint>) A token the simulation credits to the wallet has HIGH/CRITICAL token findings (freeze authority, permanent delegate, paused, default-frozen, RugCheck rugged…): a honeypot swap. A failed scan makes the analysis PARTIAL." },
  { code: "PRESIGN_POISONED_RECIPIENT", family: "signing", severity: "HIGH", when: "(suffixed :<address>) The wallet pays an address directly whose only earlier contact with it was unsolicited dust (≤ 0.001 SOL / 0.01 tokens, never signed by the wallet): the address-poisoning pattern. Checks the last 1,000 transactions; a failed lookup makes the analysis PARTIAL." },
  { code: "DOMAIN_NAME_IMPERSONATION", family: "signing", severity: "MEDIUM", when: "The application's name claims a well-known brand (Phantom, Jupiter, Solflare…) but its domain is not one of that brand's known domains." },
  { code: "DOMAIN_INVALID", family: "signing", severity: "HIGH", when: "The connecting application's address is not a valid https:// URL; the connection request is refused." },
  { code: "DOMAIN_LOCAL_DEVELOPMENT", family: "signing", severity: "LOW", when: "The connecting application runs on this computer (localhost) over plain http." },
];
