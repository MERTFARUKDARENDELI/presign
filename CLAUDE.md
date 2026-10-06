@AGENTS.md

# PRESIGN - MASTER DEVELOPMENT DIRECTIVE

## BÖLÜM 1: KESİN TEKNİK KURALLAR (CORE INVARIANTS)
This section contains critical technical constraints from the earlier phases of the project. These rules MUST NOT be violated or forgotten during new feature development.

1. **Tech Stack & Architecture:** Use Next.js (App Router), TypeScript, Tailwind CSS, shadcn/ui.
2. **Helius RPC Rate Limiting (Anti-429):** Always implement throttle/rate-limiting logic when fetching data from Helius RPC (maximum 4 concurrent requests) to prevent 429 Too Many Requests errors.
3. **RugCheck Edge Cases:** A token having "$0 liquidity" or "0 holders" MUST NOT automatically trigger a "HIGH/CRITICAL" scam flag. Treat these specific 0-value cases as `INSUFFICIENT_DATA` or `UNKNOWN` to avoid false positives.
4. **BigInt Serialization:** NEVER send raw blockchain data containing `BigInt` values directly to JSON or OpenAI. All `BigInt` values must be parsed with `.toString()` before serialization to prevent token limit crashes or 500 errors.
5. **AI Isolation Principle:** The Deterministic Risk Engine decides the actual risk level (SAFE, LOW, MEDIUM, HIGH, CRITICAL). OpenAI is ONLY an explanation layer. The AI cannot and must not change, override, or invent risk scores.

## BÖLÜM 2: YENİ ÜRÜN VİZYONU VE GÜVENLİK GEÇİDİ (PRE-SIGN GATE)

You are working on the EXISTING Presign project.

IMPORTANT:
Do NOT rebuild the application from scratch.
Do NOT replace the existing architecture.
Do NOT remove existing Presign functionality.

The current deployed application is:

https://solana-ai-defender.vercel.app/

The project is branded as:

**Presign — Know exactly what you sign.**

The repository/project may still use the historical name `solana-ai-defender`. Preserve repository/package naming where required by the existing project, but keep the product/UI branding as Presign.

Your job is to inspect the existing codebase first, understand the current architecture, and then extend it.

==================================================
1. CURRENT PRODUCT — PRESERVE THIS
==================================================

The existing product already has a strong security architecture around:

- Presign homepage
- `/verify`
- `/transaction`
- `/case/drift`
- `/docs`
- `/dashboard`
- `/demo`
- multisig proposal inspection
- transaction analysis
- deterministic risk rules
- simulation
- evidence-based findings
- wallet/token risk scanning
- HTTP API
- MCP/AI-agent support
- Watchtower
- Presign Guard
- devnet Guard flow
- existing security policies
- existing read-only wallet scanning
- existing analysis endpoints
- existing risk `gate`

Do NOT break these.

The current philosophy is:

- evidence, not arbitrary scores
- deterministic rules decide risk
- AI explains but does not decide
- incomplete information is not treated as safe
- no seed phrases
- no private keys
- no custodial signing

Preserve all of those principles.

==================================================
2. THE NEW PRODUCT GOAL
==================================================

The new feature is:

# SECURE WALLET ONBOARDING + PRE-SIGN SECURITY GATE

The user wants Presign to protect BOTH:

1. THE USER / WALLET
2. THE APPLICATION / dApp THEY ARE CONNECTING TO
3. THE ACTUAL MESSAGE OR TRANSACTION THEY ARE ABOUT TO SIGN

The concept is:

USER
  ↓
PRESIGN SECURITY CHECK
  ↓
DAPP / ORIGIN CHECK
  ↓
WALLET CONNECTION
  ↓
WALLET OWNERSHIP VERIFICATION
  ↓
ACTUAL SIGNING REQUEST
  ↓
DECODE
  ↓
SIMULATE
  ↓
DETERMINISTIC RISK ENGINE
  ↓
AI EXPLANATION
  ↓
USER SEES EXACTLY WHAT WILL HAPPEN
  ↓
USER MAKES FINAL DECISION
  ↓
WALLET SIGNATURE
  ↓
WALLET DASHBOARD

The most important concept:

# PRESIGN ADVISES.
# THE USER DECIDES.

Presign must NOT take away the user's control merely because a transaction is risky.

If a valid and analyzable transaction is HIGH or CRITICAL:

Presign should:
- warn
- explain
- show evidence
- show consequences
- recommend cancellation

BUT:

The user must still be able to explicitly choose:

"I understand the risk. Continue."

Then and ONLY then should the real wallet signature request be triggered.

==================================================
3. CRITICAL DISTINCTION: AUTOMATED GATE VS HUMAN USER
==================================================

The existing Presign system has a `gate` concept used by:

- automated signers
- bots
- AI agents
- backend systems
- MCP

Existing behavior such as:

HIGH / CRITICAL
→ block automated signing

must remain intact.

DO NOT weaken the existing automated security gate just to allow human override.

Instead create TWO separate decision layers:

A. MACHINE / AUTOMATION GATE

Example:

block
require_human_review
no_known_risk

This remains fail-closed.

B. HUMAN SIGNING DECISION

Example:

SAFE
→ Sign

MEDIUM
→ Continue Anyway

HIGH
→ I Understand the Risk — Sign Anyway

CRITICAL
→ I Understand the Critical Risk — Sign Anyway

The human UI may permit an override for a valid/analyzable signing request.

Therefore:

`data.gate === "block"`

does NOT mean:

"Presign is allowed to secretly prevent the human forever."

It means:

"Automated systems must not sign this."

For a human, Presign presents the risk and lets the user make an explicit decision when safe analysis is possible.

==================================================
4. FIRST STEP — DO NOT OPEN THE WALLET IMMEDIATELY
==================================================

Current navigation has:

Connect wallet

Change the behavior.

When the user clicks:

[ Connect Wallet ]

DO NOT immediately open Phantom / Solflare / Backpack.

First open a Presign security stage.

Example:

/connect

or:

/connect/verify

Choose the route that best fits the existing application architecture.

The user should see:

----------------------------------
PRESIGN SECURE CONNECT
----------------------------------

Before connecting your wallet,
Presign checks the connection context.

✓ Presign origin verified
✓ Secure HTTPS connection
✓ Session valid
✓ Request structure valid
✓ No obvious phishing indicators

Target application:
<dApp>

Domain:
<domain>

[ Continue to Wallet ]

If an external dApp was not provided:

Target application:
Not provided

Explain:

"Presign cannot verify a target application because no external dApp context was supplied."

DO NOT call that SAFE.

Use:

UNKNOWN / NOT PROVIDED

This is important because:

missing information must never be treated as safety.

==================================================
5. HOW PRESIGN KNOWS WHICH dAPP THE USER IS CONNECTING TO
==================================================

Do NOT invent the ability for a normal website to magically know which random third-party website the user intends to connect to.

A standard standalone website cannot automatically observe every signing request generated by another arbitrary website.

Implement the architecture honestly.

Create a normalized integration/request context such as:

type PresignConnectionRequest = {
  requestId: string;
  targetOrigin?: string;
  targetHostname?: string;
  targetName?: string;
  walletType?: string;
  returnUrl?: string;
  createdAt: string;
  expiresAt: string;
  nonce: string;
};

Use this when Presign is entered from:

- a Presign-supported dApp integration
- a future SDK
- a future browser extension/provider
- a controlled demo
- a supported deep-link flow

Do NOT accept arbitrary unvalidated redirect URLs.

Validate:
- protocol
- hostname
- origin
- allowed/expected callback
- expiration
- request ID
- nonce
- session

Protect against:
- open redirects
- origin spoofing
- query parameter manipulation
- malicious callback URLs

For a future browser extension/provider integration, create a clean adapter boundary.

==================================================
6. DAPP / DOMAIN SECURITY CHECK
==================================================

Create or reuse a real domain analysis service.

Input:

- URL
- origin
- hostname
- dApp name
- request metadata

Check what is actually available.

Potential checks:

- HTTPS
- valid URL
- normalized hostname
- punycode/homograph concerns
- suspicious subdomains
- suspicious hostname patterns
- obvious phishing indicators
- suspicious TLD patterns
- known threat intelligence if an existing provider is already configured
- existing project integrations

Return:

{
  domain: string;
  origin: string;
  status:
    | "SAFE"
    | "LOW"
    | "MEDIUM"
    | "HIGH"
    | "CRITICAL"
    | "UNKNOWN";
  score?: number;
  findings: SecurityFinding[];
  reasons: string[];
  checkedAt: string;
}

Do not fabricate domain reputation.

Do not call UNKNOWN "SAFE".

==================================================
7. WALLET CONNECTION
==================================================

Only after the Presign connection/security stage has completed should the wallet picker open.

Flow:

Pre-connect check
→ user reviews
→ Continue
→ Wallet selector
→ Connect wallet

Reuse the CURRENT wallet integration.

Do NOT install multiple competing wallet stacks unless absolutely necessary.

Preserve:
- Phantom
- Solflare
- Backpack
- other currently supported wallets

only if they are already supported by the current codebase.

==================================================
8. WALLET OWNERSHIP VERIFICATION
==================================================

After the wallet connects:

- get public wallet address
- do not request secrets
- do not request private keys
- do not request seed phrase

If the existing application already has a secure sign-in/message verification mechanism, reuse it.

Otherwise create:

server-generated nonce
→ clear verification message
→ wallet signs message
→ server verifies signature
→ nonce invalidated

The message MUST clearly say this is a wallet ownership verification signature.

Example:

PRESIGN WALLET VERIFICATION

Domain:
<Presign domain>

Wallet:
<address>

Nonce:
<nonce>

Issued:
<timestamp>

Expires:
<timestamp>

This signature proves wallet control.
It does not authorize a transfer.

Do not confuse this step with transaction signing.

==================================================
9. THE MOST IMPORTANT FEATURE —
ACTUAL MESSAGE / TRANSACTION INSPECTION
==================================================

After wallet connection, Presign needs to inspect the ACTUAL thing that the wallet is being asked to sign.

Support:

- message signing
- legacy transaction signing if applicable
- versioned transactions if applicable

Create a normalized request:

type PresignSigningRequest = {
  requestId: string;
  walletAddress: string;
  type: "MESSAGE" | "TRANSACTION";
  payload: string;
  payloadEncoding?: "base58" | "base64" | "utf8";
  domain?: string;
  application?: string;
  createdAt: string;
  expiresAt: string;
};

IMPORTANT:

Presign must analyze the exact payload.

Do not analyze one transaction and later let the client send another transaction to the wallet.

==================================================
10. EXACT PAYLOAD INTEGRITY
==================================================

Create a cryptographic payload hash.

Example conceptual structure:

requestId
walletAddress
targetOrigin
payloadHash
analysisVersion
createdAt
expiresAt

When analysis completes, store or bind:

requestId
+
wallet
+
session
+
payloadHash

Then when the user chooses:

[ Sign ]

or:

[ I Understand the Risk — Sign Anyway ]

the server/client flow must verify that the payload being sent to the wallet is EXACTLY the payload Presign analyzed.

Reject if:

- payload changed
- wallet changed
- request expired
- session changed
- request ID invalid
- payload hash differs
- analysis missing
- nonce invalid
- request replayed

This prevents a malicious client from doing:

Analyze safe transaction
→ change transaction
→ sign dangerous transaction

==================================================
11. TRANSACTION DECODER
==================================================

Reuse the existing decoder where possible.

Do NOT create a second unrelated decoder if one already exists.

Decode:

- fee payer
- recent blockhash
- durable nonce where applicable
- accounts
- signer accounts
- writable accounts
- program IDs
- instruction types
- instruction data
- SOL transfers
- SPL token transfers
- token accounts
- mint addresses
- source accounts
- destination accounts
- delegate approvals
- authority changes
- account creation
- account closure
- Token-2022 features
- permanent delegate
- mint authority
- freeze authority
- program upgrade/admin changes
- multisig interactions
- unexpected account mutations

For messages:

- message content
- application/domain context
- nonce
- timestamp
- suspicious authorization patterns
- ambiguous permission language

Do not claim information that could not actually be decoded.

==================================================
12. SIMULATION
==================================================

Reuse the existing simulation infrastructure.

For a transaction:

- simulate unsigned transaction
- capture logs
- capture errors
- capture state changes
- inspect balance changes
- inspect token changes
- inspect relevant account changes
- detect unexpected effects

Example:

User expects:

Swap 10 USDC → SOL

Simulation reveals:

250 USDC transfer
or
unexpected delegate approval
or
unexpected authority mutation

Presign must show that discrepancy.

Return:

{
  status:
    | "PASS"
    | "WARNING"
    | "FAILED"
    | "UNAVAILABLE";
  logs: string[];
  errors: string[];
  balanceChanges: [];
  tokenChanges: [];
  accountChanges: [];
  unexpectedEffects: [];
  warnings: [];
}

Do NOT call simulation unavailable "passed".

Do NOT call simulation failure "safe".

==================================================
13. MULTISIG SUPPORT — KEEP EXISTING ADVANTAGE
==================================================

The current Presign product has strong multisig proposal analysis.

Do not lose that.

The new signing flow should reuse the existing multisig analysis where applicable.

For a Squads proposal:

Presign should continue to be able to inspect:

- proposal
- vault transaction
- multisig config
- threshold
- members
- authority changes
- time lock
- durable nonce
- simulation
- privileged actions

The new human signing UX should surface the same evidence before signing.

Example:

APPLICATION
Drift

ACTION
Approve Proposal #7

AFTER EXECUTION
Admin → H7Pi...7ZgL

MULTISIG CONTROL
❌ Admin leaves multisig

TIME LOCK
❌ None

DURABLE NONCE
⚠ Present

SIMULATION
⚠ Unexpected authority change

RISK
CRITICAL

==================================================
14. DETERMINISTIC RISK ENGINE
==================================================

Reuse the current risk engine.

Do not create fake/random scoring.

Risk levels:

SAFE
LOW
MEDIUM
HIGH
CRITICAL
UNKNOWN

Signals may include:

- suspicious domain
- unknown program
- known malicious program
- unexpected SOL transfer
- unexpected token transfer
- excessive transfer
- authority escalation
- delegate approval
- permanent delegate
- mint authority
- freeze authority
- Token-2022 risk
- account closure
- drain pattern
- simulation errors
- unexpected account mutations
- signer/writable anomalies
- multisig governance weakening
- durable nonce
- missing timelock
- admin authority leaving multisig
- suspicious message

The deterministic risk result remains authoritative.

AI cannot change it.

==================================================
15. IMPORTANT:
RISK DOES NOT AUTOMATICALLY EQUAL USER BLOCK
==================================================

This is a HARD REQUIREMENT.

For a VALID AND ANALYZABLE transaction:

SAFE:
user can sign

LOW:
user can sign after seeing information

MEDIUM:
warn
user can cancel
user can continue

HIGH:
strong warning
Presign recommendation = DO NOT SIGN
user can cancel
user can explicitly continue

CRITICAL:
very strong warning
Presign recommendation = DO NOT SIGN
user can cancel
user can explicitly continue

The user is allowed to take the risk.

Example:

CRITICAL RISK DETECTED

Presign strongly recommends that you do not sign this request.

Why:
- admin authority leaves multisig
- no timelock
- durable nonce
- destination is outside expected authority

Your choice:

[ CANCEL ]

[ I UNDERSTAND THE CRITICAL RISK — SIGN ANYWAY ]

The second option must remain available for valid/analyzable requests.

==================================================
16. WHEN OVERRIDE MUST NOT BE AVAILABLE
==================================================

There is one major exception.

If Presign CANNOT reliably determine what the user is signing, it must not offer a misleading "sign anyway" action merely to pretend the product supports everything.

Examples:

- malformed serialized transaction
- unsupported transaction format
- payload cannot be decoded
- request integrity cannot be verified
- payload changed after analysis
- wallet address mismatch
- expired security request
- invalid signature/nonce
- technical state corruption

In these cases:

"Unable to safely verify this signing request."

Then:

[ Cancel ]

Do not pretend Presign understands a payload that it cannot understand.

IMPORTANT:

A high-risk valid transaction is different from an invalid/unverifiable transaction.

==================================================
17. AI EXPLANATION
==================================================

Presign already follows the principle:

AI explains, never decides.

Keep this.

Pipeline:

REQUEST
→ DECODE
→ SIMULATE
→ DETERMINISTIC RULES
→ STRUCTURED FINDINGS
→ AI EXPLANATION

Give the AI structured findings only.

AI must explain:

- what the user is about to sign
- what changes
- who receives assets
- what authorities change
- what simulation showed
- why Presign is warning
- what the likely consequence is
- what the user should check

Do NOT let AI alter:

- risk level
- evidence
- simulation
- user approval state
- signing permission

The AI must never downgrade CRITICAL to SAFE.

==================================================
18. SECURITY REVIEW SCREEN
==================================================

Create a premium, evidence-first review interface.

Before the actual wallet signing popup appears, show:

----------------------------------------
PRESIGN PRE-SIGN SECURITY CHECK
----------------------------------------

Application
<dApp>

Domain
<domain>

Wallet
<address>

Request
<action>

Risk
HIGH — 87/100

----------------------------------------
WHAT YOU ARE SIGNING
----------------------------------------

<plain-language summary>

----------------------------------------
ASSETS AFFECTED
----------------------------------------

SOL
0.42

USDC
250

----------------------------------------
AUTHORITIES / PERMISSIONS
----------------------------------------

<details>

----------------------------------------
PROGRAMS
----------------------------------------

<programs>

----------------------------------------
SIMULATION
----------------------------------------

✓ Simulation completed

⚠ Unexpected transfer
⚠ Authority change

----------------------------------------
EVIDENCE
----------------------------------------

<existing Presign evidence links>

----------------------------------------
PRESIGN RECOMMENDATION
----------------------------------------

DO NOT SIGN

<AI explanation>

----------------------------------------
YOUR DECISION
----------------------------------------

[ CANCEL ]

[ SIGN ]

For risky requests change the button text:

MEDIUM:
[ CONTINUE ANYWAY ]

HIGH:
[ I UNDERSTAND THE RISK — SIGN ANYWAY ]

CRITICAL:
[ I UNDERSTAND THE CRITICAL RISK — SIGN ANYWAY ]

Do not make the safe/cancel action difficult to find.

==================================================
19. EXPLICIT OVERRIDE CONFIRMATION
==================================================

For HIGH and CRITICAL, require one explicit confirmation.

Example:

You are choosing to continue despite Presign's warning.

Presign detected:

• Admin authority leaves the multisig
• No time lock
• Durable nonce
• Recipient not controlled by the multisig

Presign recommends cancelling.

[ CANCEL ]

[ I UNDERSTAND — CONTINUE ]

After this explicit confirmation:

ONLY THEN:

call wallet signing API.

Do not require 5 unnecessary confirmations.

Do not use dark patterns.

==================================================
20. ACTUAL WALLET SIGNING
==================================================

This is the ONLY stage where the real wallet signature request is triggered.

Correct flow:

unsigned payload
→ Presign analysis
→ user sees result
→ user chooses
→ optional explicit override confirmation
→ exact payload integrity check
→ wallet signing request
→ wallet returns signature

Presign must NOT:

- sign server-side
- store private keys
- store seed phrases
- silently sign
- auto-sign after analysis
- reuse prior approval for another transaction

The wallet itself must still show its normal signing confirmation.

==================================================
21. HUMAN DECISION MUST BE REQUEST-SPECIFIC
==================================================

Do NOT create:

"user accepted risks forever"

Do NOT store a global:

"allow risky transactions"

state.

Every override is tied to:

- request ID
- session
- wallet address
- exact payload hash
- current expiration
- current analysis

Once the request ends, the authorization disappears.

==================================================
22. OPTIONAL BROADCAST / SEND
==================================================

Signing and broadcasting are different actions.

Do not automatically broadcast after signing unless the current product architecture explicitly requires it and the user has explicitly chosen to submit/send.

Prefer:

[ Sign ]

then:

Signature received.

[ Submit Transaction ]

where appropriate.

If the existing project already has `/api/transaction/submit`, integrate with it correctly.

Do not silently broadcast.

==================================================
23. WALLET DASHBOARD
==================================================

After a successful wallet connection and ownership verification:

route to the existing wallet tools/dashboard.

Prefer the existing:

/dashboard

unless there is already a dedicated `/wallet` route.

Do not create a duplicate wallet dashboard unnecessarily.

The dashboard should now show:

Wallet
<address>

Connection
✓ Verified

Security Status
<status>

Current Wallet Risk
<status>

Assets
...

Token Risk
...

Recent Security Events
...

Recent Transactions
...

The existing read-only wallet scanner must continue working.

Do not replace its public-address-only safety model.

==================================================
24. EXISTING ROUTES MUST KEEP WORKING
==================================================

Regression test:

/
 /verify
 /transaction
 /case/drift
 /docs
 /dashboard
 /demo

Do not break them.

The new connect/sign flow should be integrated into the existing navigation.

Keep:

Verify proposal
Transaction
Drift case
API & agents
Wallet tools

working.

==================================================
25. EXISTING API MUST KEEP WORKING
==================================================

Inspect and preserve existing endpoints, including where present:

POST /api/transaction/analyze
POST /api/multisig/inspect
POST /api/guard/prepare
GET /api/token
GET /api/health
POST /api/transaction/submit

Do not rename or remove them without a compatibility reason.

Reuse their result structures where possible.

The new signing flow may add APIs such as:

POST /api/presign/connect/verify
POST /api/presign/signing/analyze
POST /api/presign/signing/approve
POST /api/presign/nonce

but only after inspecting whether equivalent infrastructure already exists.

Do not duplicate an existing endpoint.

==================================================
26. HUMAN SIGNING API VS AUTOMATED API
==================================================

This distinction is extremely important.

Automated endpoint:

/api/transaction/analyze

can continue returning:

gate = block

for HIGH / CRITICAL.

That is correct for bots and agents.

Human UI should interpret:

gate = block
+
userCanReview = true

as:

"Presign strongly recommends not signing."

not:

"Human user is permanently forbidden."

Create a separate concept such as:

recommendedAction
userDecision
userCanOverride
technicalValidation

Example:

{
  risk: {
    level: "CRITICAL",
    score: 96
  },
  gate: "block",
  technicalValidation: "VALID",
  recommendedAction: "DO_NOT_SIGN",
  userCanOverride: true
}

For malformed requests:

{
  risk: {
    level: "UNKNOWN"
  },
  technicalValidation: "INVALID",
  userCanOverride: false
}

==================================================
27. SECURITY STATE MACHINE
==================================================

Create a clear state machine for the user flow.

Example:

IDLE
↓
PRE_CONNECT_CHECK
↓
PRE_CONNECT_VERIFIED
↓
WALLET_CONNECTING
↓
WALLET_CONNECTED
↓
OWNERSHIP_VERIFICATION
↓
WALLET_VERIFIED
↓
WAITING_FOR_SIGN_REQUEST
↓
REQUEST_RECEIVED
↓
DECODING
↓
SIMULATING
↓
RISK_ANALYSIS
↓
SECURITY_REVIEW
↓
USER_APPROVAL
↓
OPTIONAL_RISK_OVERRIDE
↓
WALLET_SIGNING
↓
SIGNED
↓
OPTIONAL_SUBMISSION
↓
DASHBOARD

Possible failure states:

CONNECT_CANCELLED
SIGN_REQUEST_INVALID
REQUEST_EXPIRED
PAYLOAD_MISMATCH
SIMULATION_UNAVAILABLE
SIMULATION_FAILED
SIGN_REJECTED
RPC_ERROR
AI_UNAVAILABLE
TECHNICAL_VALIDATION_FAILED

Never let state transitions be bypassed by manipulating client state.

==================================================
28. PREVENT TAMPERING
==================================================

Attack scenario:

1. Presign analyzes safe transaction A.
2. Client changes payload to malicious transaction B.
3. Client clicks "Sign".
4. Wallet receives B.

This MUST fail.

Use:

request ID
+
payload hash
+
wallet address
+
session binding
+
expiration
+
server-side validation

Before signing:

verify:
- same request
- same wallet
- same payload
- same session
- not expired
- analysis exists

If any mismatch:

STOP.

Show:

"Signing request changed after security analysis. Presign will not sign an unverified payload."

==================================================
29. BROWSER EXTENSION / FUTURE dAPP INTERCEPTION
==================================================

The web application alone cannot transparently intercept every wallet-signing request from every unrelated website.

Do not fake this.

Instead architect a future adapter:

type SigningInterceptor = {
  receiveRequest(...);
  analyze(...);
  presentSecurityReview(...);
  requestUserDecision(...);
  forwardToWallet(...);
};

Possible future implementations:

- browser extension
- wallet provider wrapper
- SDK
- injected provider
- Wallet Standard integration

The current web app should provide the security engine and a clean request-ingestion boundary.

The demo flow must be real.

==================================================
30. CREATE A REAL DEMO FLOW
==================================================

If an external dApp cannot currently be intercepted directly:

create a controlled demo dApp/page in the existing project or a clearly separated demo integration.

Example:

/demo/sign

The demo should generate actual unsigned signing requests.

Scenario:

SAFE

Then:

SUSPICIOUS

Then:

CRITICAL

The demo must use the same real analysis pipeline used by production.

Do NOT make a fake static modal that only says "HIGH".

==================================================
31. DEMO — SAFE FLOW
==================================================

User enters demo.

Clicks:

[ Connect Wallet ]

Presign security check appears.

Then wallet connects.

Then ownership verification if required.

Then a safe signing request is generated.

Presign analyzes it.

Result:

SAFE

User sees:

✓ No significant security issue detected.

Then:

[ SIGN WITH WALLET ]

Wallet opens.

User signs.

Success.

==================================================
32. DEMO — HIGH FLOW
==================================================

Generate a valid but risky transaction.

Presign analyses it.

Result:

HIGH.

Screen says:

HIGH RISK

Presign recommends that you do not sign.

Show actual findings.

User can:

[ CANCEL ]

OR

[ I UNDERSTAND THE RISK — SIGN ANYWAY ]

If user chooses the second:

show one explicit confirmation.

Then wallet signing popup opens.

That demonstrates the core product principle:

Presign warns.
User decides.

==================================================
33. DEMO — CRITICAL FLOW
==================================================

Create a valid, analyzable critical scenario.

Examples may use:

- dangerous authority change
- unexpected token transfer
- multisig authority leaving expected control
- missing timelock
- suspicious delegate
- drain pattern

Show:

CRITICAL

Presign recommends cancellation.

But user still has:

[ CANCEL ]

[ I UNDERSTAND THE CRITICAL RISK — SIGN ANYWAY ]

If the user explicitly confirms:

send the exact analyzed payload to the wallet.

==================================================
34. DEMO — INVALID FLOW
==================================================

Provide a malformed/unsupported request.

Result:

UNKNOWN / UNVERIFIABLE

Show:

Presign cannot safely determine what this request will do.

Then:

[ CANCEL ]

Do not give a fake "Sign Anyway" option.

==================================================
35. WALLET UX
==================================================

Do not make the user think:

"Presign is asking me to trust Presign."

Instead make the model:

"Presign is showing me evidence so I can make my own decision."

The wallet popup is the ultimate user authorization surface.

Presign is the analysis/review surface.

==================================================
36. SECURITY + PRIVACY
==================================================

Never request:

- seed phrase
- recovery phrase
- private key
- wallet password

Never transmit private key material.

Never store signing secrets.

Do not make the user believe Presign has custody.

Use public wallet address information where possible.

==================================================
37. ERROR HANDLING
==================================================

Handle:

- wallet not installed
- wallet rejected connection
- wallet disconnected
- account changed
- ownership verification rejected
- nonce expired
- duplicate nonce
- transaction malformed
- unsupported version
- simulation failed
- simulation unavailable
- RPC unavailable
- threat intelligence unavailable
- AI unavailable
- invalid dApp origin
- invalid return URL
- payload mismatch
- request expired
- signature rejected
- submit failed

Do not crash.

Explain errors in user-friendly language.

==================================================
38. UX RULE:
WARNING != TECHNICAL BLOCK
==================================================

Do not confuse:

"Presign thinks this is dangerous"

with:

"Presign cannot safely process this request"

These are different.

Dangerous but understandable:
→ warn
→ user may override

Unknown/unverifiable:
→ cannot safely verify
→ stop

This distinction must exist in code and UI.

==================================================
39. UI STYLE
==================================================

Use the current Presign visual design.

Do NOT redesign the whole product.

The new screens should feel native to Presign.

Use:
- dark UI
- near-black backgrounds
- clean cards
- white typography
- restrained violet/green accents
- evidence-first layout
- clear warning hierarchy
- subtle animations
- security-oriented visual language

Avoid:
- fake hacker graphics
- excessive neon
- random percentages
- cartoonish warning screens
- unnecessary animations

==================================================
40. ACCESSIBILITY
==================================================

Make warning screens accessible.

- clear contrast
- keyboard navigation
- buttons have obvious labels
- risk state does not rely on color alone
- screen-reader labels where applicable
- cancellation remains obvious

==================================================
41. TESTING
==================================================

Add tests for:

PRE-CONNECT:

- valid session
- invalid session
- safe target domain
- suspicious domain
- missing target origin
- malformed origin
- malicious redirect
- expired connection request

WALLET:

- successful connection
- rejected connection
- disconnected wallet
- account changed

OWNERSHIP:

- valid nonce
- invalid nonce
- expired nonce
- replayed nonce
- wrong wallet signature

SIGNING:

- safe message
- suspicious message
- safe transaction
- unexpected SOL transfer
- unexpected token transfer
- authority escalation
- delegate approval
- durable nonce
- missing timelock
- malicious program
- simulation failure
- simulation unavailable
- CRITICAL risk
- HIGH risk
- MEDIUM risk
- UNKNOWN / undecodable request

USER DECISION:

- user cancels
- user signs SAFE
- user continues MEDIUM
- user overrides HIGH
- user overrides CRITICAL
- user rejects second confirmation
- wallet rejects signature

ANTI-TAMPERING:

- payload hash mismatch
- wallet mismatch
- session mismatch
- request expiration
- request replay
- modified payload after analysis
- modified risk result on client

Most important tests:

A. HIGH transaction:
analysis occurs BEFORE wallet signature request.

B. HIGH transaction:
user clicks Cancel → wallet signing API is never called.

C. HIGH transaction:
user explicitly chooses Sign Anyway → wallet signing API is called for EXACTLY the analyzed payload.

D. Client modifies payload:
signing MUST be rejected.

E. CRITICAL transaction:
user can explicitly override when the request is valid/analyzable.

F. Invalid/unverifiable payload:
no misleading override is offered.

==================================================
42. REGRESSION TESTING
==================================================

Before finishing, verify that:

- homepage still works
- proposal verification still works
- transaction analysis still works
- Drift case still works
- docs still works
- wallet scanner still works
- demo still works
- API endpoints still work
- Watchtower-related assumptions are not broken
- Guard-related assumptions are not broken
- MCP/agent gate semantics are not weakened

==================================================
43. BUILD / TYPE / LINT
==================================================

After implementation run:

- TypeScript checks
- relevant tests
- production build
- lint if configured

Fix errors caused by your changes.

Do not leave knowingly broken code.

==================================================
44. IMPORTANT — DO NOT FAKE SECURITY
==================================================

Never write:

return { score: 93 }

without evidence.

Never use random risk results.

Never display:

✓ Safe

when checks were not actually completed.

Never claim:

"Protected"

when the transaction was not actually analyzed.

If something cannot be verified:

say:

"Unable to verify"

or:

"Unknown"

==================================================
45. FINAL USER EXPERIENCE
==================================================

The final ideal flow should feel like this:

--------------------------------------------------

USER OPENS PRESIGN

              [ CONNECT WALLET ]

                    ↓

PRESIGN:

"Before connecting your wallet,
we verify the connection context."

                    ↓

DAPP / ORIGIN CHECK

✓ Presign origin verified
✓ Session valid
✓ Target dApp recognized
✓ Connection request valid

                    ↓

              [ CONTINUE ]

                    ↓

WALLET

Phantom / Solflare / Backpack

                    ↓

WALLET CONNECTED

<address>

                    ↓

WALLET OWNERSHIP VERIFIED

                    ↓

SIGNING REQUEST ARRIVES

                    ↓

PRESIGN

"Before you sign,
let us show you what this does."

                    ↓

DECODE

                    ↓

SIMULATION

                    ↓

RISK ENGINE

                    ↓

AI EXPLANATION

                    ↓

SECURITY REVIEW

SAFE / LOW / MEDIUM / HIGH / CRITICAL

                    ↓

USER DECIDES

SAFE:
[ SIGN ]

RISKY:
[ CANCEL ]
[ I UNDERSTAND THE RISK — SIGN ANYWAY ]

                    ↓

ONLY NOW

REAL WALLET SIGNATURE POPUP

                    ↓

USER SIGNS

                    ↓

OPTIONAL SUBMISSION

                    ↓

DASHBOARD

--------------------------------------------------

46. CORE PRODUCT MESSAGE

The implementation should make Presign's philosophy obvious:

> "We don't decide for you.
> We make sure you know what you're signing."

A second suitable product statement:

> "Presign verifies the app, analyzes the action, simulates the outcome, explains the risk, and lets you make the final call."

The product must NOT communicate:

"We will always block dangerous transactions."

It should communicate:

"We will never let you unknowingly sign a dangerous transaction."

That distinction is essential.

==================================================
47. FINAL IMPLEMENTATION INSTRUCTION
==================================================

Do not merely describe this feature.

Actually implement it in the existing repository.

Start by auditing the existing codebase.

Then identify:
- current routes
- wallet integration
- existing analysis engine
- existing risk engine
- existing simulation
- existing APIs
- existing state management
- existing UI components
- current dashboard
- current transaction submission logic

Then integrate the feature without breaking existing functionality.

At the end provide:

1. Architecture found
2. Architecture changed
3. Files created
4. Files modified
5. Exact user flow
6. Exact distinction between automated gate and human override
7. Exact behavior of SAFE / LOW / MEDIUM / HIGH / CRITICAL
8. How payload integrity is enforced
9. How wallet signing is triggered
10. How dApp context is supplied
11. What cannot yet be intercepted directly by a normal web app
12. Future browser-extension/SDK integration boundary
13. Tests executed
14. Build result
15. Any remaining limitations

Do the implementation, tests, and build yourself.
Do not stop at a proposal or UI mockup.
