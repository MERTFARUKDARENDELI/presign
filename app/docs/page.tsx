import type { Metadata } from "next";
import { BRAND } from "@/lib/brand";
import { GATE_MEANING } from "@/lib/agent/gate";
import { EXAMPLE_POLICY, PROGRAM_ALIASES } from "@/lib/policy/schema";

export const metadata: Metadata = {
  title: "API, agents & alerts · Presign",
  description: "Presign over HTTP, as an MCP server for AI agents, and as Watchtower alerts for multisig teams.",
};

function Code({ children }: { children: string }) {
  return <pre className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs leading-relaxed text-zinc-200"><code>{children}</code></pre>;
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-6 space-y-3">
      <h3 id={`${id}-h`} className="text-xl font-semibold">{title}</h3>
      {children}
    </section>
  );
}

const POLICY_RULES: Array<[string, string]> = [
  ["multisig", "The multisig the policy was written for. Applying it to another one is a violation."],
  ["severity", "MEDIUM, HIGH (default) or CRITICAL: how a broken rule counts. HIGH and CRITICAL make the gate block."],
  ["authorityHolders", 'Addresses that may receive an admin, upgrade, token or config authority, besides the multisig, its vaults and the signers of `guards`. Add "none" to allow removing an authority.'],
  ["requireGuardFor", "Privileged kinds that must be scheduled through Presign Guard: admin-transfer, admin-action, upgrade-authority, program-upgrade, token-authority, account-reassign, program-close. Handing an authority to a listed guard is allowed."],
  ["guards, minGuardDelaySeconds", "Which guards scheduled actions may use, and their minimum delay."],
  ["minTimeLockSeconds, minThreshold", "Checked on the current setup and on proposals that change it."],
  ["allowedPrograms", `Programs the vault (or a scheduled action) may call directly: addresses, or ${Object.keys(PROGRAM_ALIASES).join(", ")}.`],
  ["allowedRecipients", "Wallets that may receive SOL or tokens from the vault, or be approved as delegates. Token recipients are resolved to their owners from the simulation."],
  ["outflowLimits", 'Maximum net outflow per proposal from the vaults, in UI units, keyed by "SOL" or a mint. Batches add up; scheduled transfers count too.'],
  ["requireVerifiedUpgrades", "Program upgrades must deploy exactly a build verified in the OtterSec registry."],
  ["forbidDurableNonce", "Signatures must not use a durable nonce: checked on the transaction you sign, and on the votes already cast on a proposal."],
];

const ENDPOINTS = [
  { method: "POST", path: "/api/transaction/analyze", body: '{ "input": "<base64 | base58 | signature>", "walletAddress"?: "<signer>", "policy"?: {…} }', does: "Decode, simulate and risk-check a transaction. Squads approvals include the proposal's vault instructions, simulation and authority changes." },
  { method: "POST", path: "/api/multisig/inspect", body: '{ "input": "<Squads link | address | <multisig> #<n>>", "signer"?: "<member>", "policy"?: {…} }', does: "Inspect a proposal without a transaction to sign, a multisig's setup and recent proposals, or a Presign Guard and its scheduled actions." },
  { method: "POST", path: "/api/guard/prepare", body: '{ "kind": "veto" | "execute", "action": "<action>", "signer": "<wallet>" }', does: "Unsigned veto (guardians) or execute (anyone, after the delay) transaction for a Guard action; sign it in your wallet, then submit via /api/transaction/submit." },
  { method: "GET", path: "/api/token?mint=<mint>", body: "—", does: "Token security signals: authorities, Token-2022 extensions, concentration, age, metadata links." },
  { method: "GET", path: "/api/health", body: "—", does: "Cluster and configured data sources (no secrets)." },
  { method: "POST", path: "/api/presign/connect", body: '{ "target"?: "https://<dapp>", "name"?: "<label>", "returnUrl"?: "https://<dapp>/<callback>" }', does: "Pre-connect checks before any wallet opens: Presign origin, HTTPS, session, request structure, target domain (unknown is never safe), expiry. Returns a session-bound connection token." },
  { method: "POST", path: "/api/presign/nonce → /connect/verify", body: '{ "walletAddress" } → { "walletAddress", "message", "signature", "nonceToken" }', does: "Wallet ownership: a one-time message that authorizes nothing, verified with ed25519; the nonce is spent." },
  { method: "POST", path: "/api/presign/signing/analyze", body: '{ "type": "TRANSACTION" | "MESSAGE", "payload", "payloadEncoding"?, "walletAddress", "connectionToken"?, "expectedEffects"?: { "summary", "maxSolOutLamports", "maxTokenOut" } }', does: "Pre-sign review of the exact payload: decode, simulate, rules (plus the application address and what the application declared versus what the simulation shows), the unchanged machine gate, and the human decision (technicalValidation, recommendedAction, userCanReview, userCanOverride)." },
  { method: "POST", path: "/api/presign/signing/approve", body: '{ "analysisToken", "payload", "walletAddress", "choice": "SIGN" | "CONTINUE" | "OVERRIDE", "overrideConfirmed"? }', does: "The user's decision, bound to request + wallet + session + payload hash + expiry, single use. The wallet is asked only after this; /api/transaction/submit accepts the approval token." },
];

export default function DocsPage() {
  return (
    <div className="max-w-4xl space-y-12">
      <header>
        <h2 className="text-3xl font-bold">API, agents &amp; alerts</h2>
        <p className="mt-3 text-zinc-400">
          The same deterministic engine behind the {BRAND.name} UI, three ways: an HTTP API for wallets and backends, an MCP server for AI agents, and Watchtower alerts for
          multisig teams. Everything is read-only: {BRAND.name} never takes keys and never signs.
        </p>
        <nav aria-label="On this page" className="mt-4 flex flex-wrap gap-2 text-sm">
          {[["api", "HTTP API"], ["gate", "The gate"], ["presign-flow", "Secure connect & pre-sign"], ["extension", "Browser extension"], ["policy", "Team policy"], ["mcp", "MCP for agents"], ["agent-guard", "Guard snippet"], ["watchtower", "Watchtower"], ["presign-guard", "Presign Guard (on-chain)"]].map(([id, label]) => (
            <a key={id} href={`#${id}`} className="rounded-md border border-zinc-800 px-2 py-1 text-zinc-300 hover:bg-zinc-900">{label}</a>
          ))}
          <a href="/rules" className="rounded-md border border-fuchsia-500/40 px-2 py-1 text-fuchsia-200 hover:bg-zinc-900">Rule catalog →</a>
        </nav>
      </header>

      <Section id="api" title="HTTP API">
        <p className="text-sm text-zinc-400">
          JSON in, JSON out. Every response uses the envelope <span className="font-mono">{"{ success, data, error }"}</span>; errors carry a stable <span className="font-mono">code</span> and a message that never
          contains provider URLs, keys or stack traces. Requests are rate-limited per client.
        </p>
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="bg-zinc-900 text-xs uppercase text-zinc-500">
              <tr><th className="p-3">Endpoint</th><th className="p-3">Body</th><th className="p-3">What it does</th></tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {ENDPOINTS.map((e) => (
                <tr key={e.path}>
                  <td className="p-3 align-top font-mono text-xs"><span className="text-fuchsia-300">{e.method}</span> {e.path}</td>
                  <td className="p-3 align-top font-mono text-xs text-zinc-400">{e.body}</td>
                  <td className="p-3 align-top text-zinc-300">{e.does}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Code>{`curl -s -X POST https://<your-presign-host>/api/multisig/inspect \\
  -H 'content-type: application/json' \\
  -d '{"input":"2LW6PSEjp81xSEttWwXDB6Etb1eKdhYPbFEojYbyhx88 #7"}'`}</Code>
        <p className="text-sm text-zinc-400">
          Key fields: <span className="font-mono">risk</span> (verdict, completeness, signals, evidence), <span className="font-mono">gate</span>, <span className="font-mono">brief</span> (plain-language summary),
          <span className="font-mono"> multisig</span> (config, proposals, decoded and simulated vault payloads, privileged actions).
        </p>
      </Section>

      <Section id="gate" title="The gate">
        <p className="text-sm text-zinc-400">
          Every analysis carries a <span className="font-mono">gate</span> for automated signers. It is a fixed mapping from the verdict and its completeness — no model, no judgment — so an
          agent cannot be talked out of it. Missing data never maps to <span className="font-mono">no_known_risk</span>.
        </p>
        <ul className="space-y-2 text-sm">
          {Object.entries(GATE_MEANING).map(([gate, meaning]) => (
            <li key={gate} className="rounded-lg border border-zinc-800 p-3"><span className="font-mono text-zinc-100">{gate}</span> <span className="text-zinc-400">— {meaning}</span></li>
          ))}
        </ul>
        <p className="text-xs text-zinc-500">block: CRITICAL or HIGH · require_human_review: MEDIUM, unrated, or any incomplete analysis · no_known_risk: LOW or no signal, with every check complete.</p>
      </Section>

      <Section id="presign-flow" title="Secure connect & pre-sign review">
        <p className="text-sm text-zinc-400">
          For people signing in a wallet, {BRAND.name} adds a second decision layer on top of the gate. The gate above stays fail-closed for bots and agents; a human who has seen the
          evidence may still decide. {BRAND.name} advises, the user decides — but only about a request it could actually verify.
        </p>
        <ul className="space-y-2 text-sm text-zinc-300">
          <li className="rounded-lg border border-zinc-800 p-3"><span className="font-semibold">SAFE / LOW</span> — sign. <span className="font-semibold">MEDIUM</span> — warning, “Continue anyway”. <span className="font-semibold">HIGH / CRITICAL</span> — recommendation “do not sign”; the user can still choose “I understand the risk — sign anyway” after one explicit confirmation.</li>
          <li className="rounded-lg border border-zinc-800 p-3"><span className="font-semibold">Cannot verify</span> (malformed, unsupported, no simulation, wrong wallet, expired, changed after analysis) — Cancel only. No “sign anyway” for something {BRAND.name} does not understand.</li>
          <li className="rounded-lg border border-zinc-800 p-3"><span className="font-semibold">Exact payload</span> — the approval is bound to the request id, wallet, browser session, sha256 of the bytes the wallet signs and a short expiry, and is single use. The wallet is asked for exactly those bytes; a changed payload is refused before the wallet, after the wallet, and at submission.</li>
        </ul>
        <p className="text-sm text-zinc-400">
          An integration hands {BRAND.name} its context with a link such as <span className="font-mono text-xs">/connect?target=https://app.example&amp;name=Example&amp;return=https://app.example/done</span> (the return
          address must be on the target&apos;s own origin), then sends each signing request to <span className="font-mono text-xs">/api/presign/signing/analyze</span> before forwarding it to the wallet.
          A standalone website cannot see what other websites ask a wallet to sign; the <a href="#extension" className="text-violet-300 underline">{BRAND.name} browser extension</a> does that, on the same boundary
          (<span className="font-mono text-xs">lib/presign/interceptor.ts</span> — the web app&apos;s own implementation is used by the demo dApp). An integration can also declare what a request is supposed
          to do (<span className="font-mono text-xs">expectedEffects</span>); a simulation that moves more, or moves tokens it did not mention, is a HIGH finding. Try it with your own wallet in the <a href="/demo/sign" className="text-violet-300 underline">pre-sign demo</a>.
        </p>
      </Section>

      <Section id="extension" title="Browser extension (every site)">
        <p className="text-sm text-zinc-400">
          The extension reviews signing requests on any website, with no link to share: when a site asks your wallet to sign, {BRAND.name} opens its review first, and the wallet opens
          only after your decision.
        </p>
        <ul className="space-y-2 text-sm text-zinc-300">
          <li className="rounded-lg border border-zinc-800 p-3"><span className="font-semibold">What it wraps</span> — Wallet Standard wallets (Phantom, Solflare, Backpack and most others, including the legacy <span className="font-mono text-xs">navigator.wallets</span> registration) and injected providers such as <span className="font-mono text-xs">window.phantom.solana</span>: sign transaction(s), sign and send (one or several), sign message, off-chain message, Sign-In With Solana. Any other signing entry point is refused.</li>
          <li className="rounded-lg border border-zinc-800 p-3"><span className="font-semibold">Same review</span> — the request goes to <span className="font-mono text-xs">/extension/review</span> on {BRAND.name}: the same analysis, decision rules and server approval as everywhere else. The site&apos;s address is the one the browser reports, not what the site says.</li>
          <li className="rounded-lg border border-zinc-800 p-3"><span className="font-semibold">Exact bytes, both ways</span> — the bytes are copied the moment the site asks, and after approval the wallet gets that copy, so a site cannot change the request while you read the review. If the wallet returns a transaction or message that differs from what was reviewed, or a message signature that is not valid for it, the signature is withheld from the site.</li>
          <li className="rounded-lg border border-zinc-800 p-3"><span className="font-semibold">Fails closed</span> — while protection is on, a request {BRAND.name} cannot review (too large, too many signatures, malformed, review window unavailable) is never sent to the wallet unreviewed; only the extension&apos;s own switches (off, or off for this site) let requests through.</li>
          <li className="rounded-lg border border-zinc-800 p-3"><span className="font-semibold">Ownership, once per session</span> — {BRAND.name} approves only for a wallet you proved is yours with a message that authorizes nothing; your wallet extension works on the review page too.</li>
          <li className="rounded-lg border border-zinc-800 p-3"><span className="font-semibold">No keys, no network</span> — the extension never signs, never holds keys and makes no requests of its own; a test fails if it ever does.</li>
        </ul>
        <Code>{`npm run build:extension
# Chrome → chrome://extensions → Developer mode → Load unpacked → extension/dist`}</Code>
        <p className="text-sm text-zinc-400">
          Limits: a page written specifically to evade a page-level hook can bypass it (wallet-level integration closes that); a transaction the wallet broadcasts itself
          (sign and send) can only be checked before the wallet; a sign-in whose account is chosen inside the wallet goes to the wallet unreviewed and is logged as such.
        </p>
      </Section>

      <Section id="policy" title="Team policy">
        <p className="text-sm text-zinc-400">
          Write your team&apos;s rules once; {BRAND.name} checks every proposal and signature against them. A broken rule becomes a signal with the policy&apos;s severity, so the verdict, the
          gate and every Watchtower alert reflect it. A rule that cannot be checked — contents not decoded, not simulated, an account not loaded — is reported as such (MEDIUM), never as
          compliant. The policy is plain JSON: paste it in <a href="/verify" className="text-fuchsia-300 underline-offset-4 hover:underline">/verify</a> (kept in your browser), send it as{" "}
          <span className="font-mono">policy</span> to <span className="font-mono">/api/multisig/inspect</span> or <span className="font-mono">/api/transaction/analyze</span>, or set{" "}
          <span className="font-mono">PRESIGN_POLICY_FILE</span> for Watchtower and the MCP server (one policy, or an array told apart by <span className="font-mono">multisig</span>).
        </p>
        <Code>{JSON.stringify(EXAMPLE_POLICY, null, 2)}</Code>
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="bg-zinc-900 text-xs uppercase text-zinc-500">
              <tr><th className="p-3">Rule</th><th className="p-3">What it checks</th></tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {POLICY_RULES.map(([k, v]) => (
                <tr key={k}><td className="p-3 align-top font-mono text-xs text-zinc-200">{k}</td><td className="p-3 align-top text-zinc-300">{v}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-zinc-500">A policy only adds signals: it can never lower a verdict or hide a finding. Every rule is optional; unknown keys are rejected.</p>
      </Section>

      <Section id="mcp" title="MCP server for AI agents">
        <p className="text-sm text-zinc-400">
          Agents that hold a wallet can be prompt-injected. The MCP server gives them a pre-sign check whose answer comes from rules, not from the model. Tools:
          <span className="font-mono"> presign_verify_transaction</span>, <span className="font-mono">presign_inspect_multisig</span>, <span className="font-mono">presign_check_token</span>. It calls your {BRAND.name} API, so
          RPC keys stay on the server. Set <span className="font-mono">PRESIGN_POLICY_FILE</span> to hold every check to your team policy (the agent cannot change it). Requires Node.js 22.18+.
        </p>
        <Code>{`{
  "mcpServers": {
    "presign": {
      "command": "node",
      "args": ["/path/to/presign/mcp/server.ts"],
      "env": { "PRESIGN_API_URL": "https://<your-presign-host>" }
    }
  }
}`}</Code>
      </Section>

      <Section id="agent-guard" title="Guard snippet">
        <p className="text-sm text-zinc-400">For bots and backends that sign programmatically: refuse anything the gate does not clear.</p>
        <Code>{`async function presignGuard(serializedTx: string, signer: string) {
  const res = await fetch(\`\${PRESIGN_URL}/api/transaction/analyze\`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: serializedTx, walletAddress: signer }),
  });
  const { success, data, error } = await res.json();
  if (!success) throw new Error(\`Presign unavailable: \${error?.message}\`); // fail closed
  if (data.gate !== "no_known_risk") {
    throw new Error(\`Presign \${data.gate}: \${data.risk.signals.map((s) => s.title).join("; ")}\`);
  }
  return data; // data.messageHash: sign exactly these bytes
}`}</Code>
      </Section>

      <Section id="watchtower" title="Watchtower alerts">
        <p className="text-sm text-zinc-400">
          Watchtower sends every new proposal&apos;s brief — verdict, authority changes, top signals and a verify link — to every signer at once, through a channel independent of
          the UI that created the proposal. It watches Presign Guards too: each scheduled action is announced with its countdown and a veto link. A new watch records a baseline; later
          changes alert.
        </p>
        <p className="text-sm text-zinc-400"><b className="text-zinc-200">Self-service (Telegram):</b> add the bot to your signers&apos; group, then:</p>
        <Code>{`/watch <multisig or guard address, or Squads link>   (group admins only)
/unwatch <address>
/list
/check <Squads link, proposal, or <multisig> #<n>>     (anyone)`}</Code>
        <p className="text-sm text-zinc-400"><b className="text-zinc-200">Running it:</b> one process, state in a local SQLite file. Targets can also come from the environment:</p>
        <Code>{`PRESIGN_API_URL=https://<your-presign-host> \\
TELEGRAM_BOT_TOKEN=<bot token> \\
WATCH_MULTISIGS=<multisig>[,…]  WATCH_GUARDS=<guard>[,…]  TELEGRAM_CHAT_ID=<group id> \\
npm run watchtower            # add -- --once for a single cycle (cron)`}</Code>
        <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-400">
          <li><span className="font-mono">ALERT_WEBHOOK_URL</span>: Slack or Discord incoming webhook for environment targets.</li>
          <li><span className="font-mono">POLL_SECONDS</span> (default 30, minimum 10), <span className="font-mono">PRESIGN_PUBLIC_URL</span> for links, <span className="font-mono">WATCH_DB</span> for the state file, <span className="font-mono">ALERT_EXISTING=true</span> to report already-pending items on first start.</li>
          <li><span className="font-mono">PRESIGN_POLICY_FILE</span>: your <a href="#policy" className="text-fuchsia-300 underline-offset-4 hover:underline">team policy</a>; every alert then says whether the proposal complies.</li>
          <li>Tokens are read from the environment only and never logged.</li>
        </ul>
        <Code>{`🛑 New proposal #7 on multisig 2LW6…hx88 — CRITICAL
• Drift Protocol v2 updateAdmin → H7Pi…7ZgL (NOT controlled by the multisig)
• CRITICAL: Admin moves outside the multisig
• HIGH: No time lock
Verify before signing: https://<your-presign-host>/verify?q=…`}</Code>
      </Section>

      <Section id="presign-guard" title="Presign Guard (on-chain)">
        <p className="text-sm text-zinc-400">
          Warnings help only if someone can act on them. Presign Guard is a Solana program that holds a protocol&apos;s critical authorities — admin, upgrade authority, mint authority —
          so that anything done with them is <b className="text-zinc-200">scheduled</b>, waits a fixed <b className="text-zinc-200">delay</b>, and can be <b className="text-zinc-200">vetoed by any single guardian</b>.
          Routine operations stay on the multisig and stay fast; only critical ones wait.
        </p>
        <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-400">
          <li>The multisig vault is the proposer: a normal Squads proposal calls <span className="font-mono">schedule</span>; the action then waits the delay.</li>
          <li>Guardians (members, or an independent security key) can veto alone; they can never execute anything.</li>
          <li>After the delay anyone can execute; only then does the guard&apos;s PDA sign. Configuration changes go through the same delay and veto.</li>
          <li>Presign decodes scheduled actions inside proposals, shows the countdown in <a href="/verify" className="text-fuchsia-300 underline-offset-4 hover:underline">/verify</a> (paste a guard or action address), offers veto / execute, and Watchtower announces every scheduled action.</li>
        </ul>
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100">
          Status: deployed on devnet (program <span className="font-mono">A8cpj1d7zxF3T9kZzVn2wkEueGxqGVgd9VaqBA54EDRS</span>) and exercised end-to-end with a real Squads multisig — schedule, CRITICAL alert, veto, execution refused. Unaudited — do not hand it mainnet authorities.
          This deployment {process.env.NEXT_PUBLIC_GUARD_PROGRAM_ID ? <>uses program <span className="font-mono">{process.env.NEXT_PUBLIC_GUARD_PROGRAM_ID}</span>.</> : "has no Guard program configured."}
        </p>
      </Section>
    </div>
  );
}
