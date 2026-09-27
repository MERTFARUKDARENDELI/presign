import type { Metadata } from "next";
import { BRAND } from "@/lib/brand";
import { GATE_MEANING } from "@/lib/agent/gate";

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

const ENDPOINTS = [
  { method: "POST", path: "/api/transaction/analyze", body: '{ "input": "<base64 | base58 | signature>", "walletAddress"?: "<signer>" }', does: "Decode, simulate and risk-check a transaction. Squads approvals include the proposal's vault instructions, simulation and authority changes." },
  { method: "POST", path: "/api/multisig/inspect", body: '{ "input": "<Squads link | address | <multisig> #<n>>", "signer"?: "<member>" }', does: "Inspect a proposal without a transaction to sign, or a multisig's setup and recent proposals." },
  { method: "GET", path: "/api/token?mint=<mint>", body: "—", does: "Token security signals: authorities, Token-2022 extensions, concentration, age, metadata links." },
  { method: "GET", path: "/api/health", body: "—", does: "Cluster and configured data sources (no secrets)." },
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
          {[["api", "HTTP API"], ["gate", "The gate"], ["mcp", "MCP for agents"], ["guard", "Guard snippet"], ["watchtower", "Watchtower"]].map(([id, label]) => (
            <a key={id} href={`#${id}`} className="rounded-md border border-zinc-800 px-2 py-1 text-zinc-300 hover:bg-zinc-900">{label}</a>
          ))}
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

      <Section id="mcp" title="MCP server for AI agents">
        <p className="text-sm text-zinc-400">
          Agents that hold a wallet can be prompt-injected. The MCP server gives them a pre-sign check whose answer comes from rules, not from the model. Tools:
          <span className="font-mono"> presign_verify_transaction</span>, <span className="font-mono">presign_inspect_multisig</span>, <span className="font-mono">presign_check_token</span>. It calls your {BRAND.name} API, so
          RPC keys stay on the server. Requires Node.js 22.18+.
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

      <Section id="guard" title="Guard snippet">
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
          Watchtower polls your multisigs and sends every new proposal&apos;s brief — verdict, authority changes, top signals and a verify link — to every signer at once, through a channel
          independent of the UI that created the proposal. First start records a baseline; later changes alert.
        </p>
        <Code>{`WATCH_MULTISIGS=<multisig>[,<multisig>…] \\
PRESIGN_API_URL=https://<your-presign-host> \\
TELEGRAM_BOT_TOKEN=<bot token> TELEGRAM_CHAT_ID=<signers' group id> \\
npm run watchtower            # add -- --once for a single cycle (cron)`}</Code>
        <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-400">
          <li><span className="font-mono">ALERT_WEBHOOK_URL</span>: Slack or Discord incoming webhook, alongside or instead of Telegram.</li>
          <li><span className="font-mono">POLL_SECONDS</span> (default 30, minimum 10), <span className="font-mono">PRESIGN_PUBLIC_URL</span> for links, <span className="font-mono">ALERT_EXISTING=true</span> to report already-pending proposals on first start.</li>
          <li>Tokens are read from the environment only and never logged.</li>
        </ul>
        <Code>{`🛑 New proposal #7 on multisig 2LW6…hx88 — CRITICAL
• Drift Protocol v2 updateAdmin → H7Pi…7ZgL (NOT controlled by the multisig)
• CRITICAL: Admin moves outside the multisig
• HIGH: No time lock
Verify before signing: https://<your-presign-host>/verify?q=…`}</Code>
      </Section>
    </div>
  );
}
