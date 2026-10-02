import type { InspectResult } from "../lib/multisig/types.ts";
import type { RiskAssessment } from "../lib/security/risk.ts";
import type { TransactionAnalysis } from "../lib/transaction/types.ts";
import type { PolicyReport } from "../lib/policy/types.ts";
import { firstAddress, policyFor, type PolicyJson } from "../lib/policy/file.ts";

/**
 * Model Context Protocol handler for Presign (JSON-RPC 2.0 messages). Tools
 * call the Presign HTTP API, so keys and RPC credentials stay on the Presign
 * server. Results lead with a deterministic `gate` an agent must obey:
 * "block" and "require_human_review" mean do not sign automatically.
 */

export const SERVER_INFO = { name: "presign", version: "0.1.0" } as const;
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

type Json = Record<string, unknown>;
export interface RpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Json;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const ADDRESS = { type: "string", description: "Solana address (base58)", pattern: "^[1-9A-HJ-NP-Za-km-z]{32,44}$" };

export const TOOLS = [
  {
    name: "presign_verify_transaction",
    title: "Verify a Solana transaction before signing",
    description:
      "Decode, simulate and risk-check a Solana transaction BEFORE it is signed. Input: a serialized transaction (base64/base58) or a transaction signature. Understands Squads multisig approvals (what the vault would do, who controls what afterwards) and durable-nonce signatures that never expire. Obey `gate`: never sign when it is 'block' or 'require_human_review'.",
    inputSchema: {
      type: "object",
      properties: {
        transaction: { type: "string", description: "Serialized transaction (base64 or base58) or a transaction signature", minLength: 1, maxLength: 2000 },
        signer: { ...ADDRESS, description: "Address of the wallet that would sign (perspective for balance changes)" },
      },
      required: ["transaction"],
      additionalProperties: false,
    },
  },
  {
    name: "presign_inspect_multisig",
    title: "Inspect a Squads multisig or proposal",
    description:
      "Inspect a Squads v4 multisig proposal before approving it, or a multisig's setup and pending proposals. Input: a Squads link, a proposal / transaction / multisig address, or '<multisig> #<index>'. Returns the decoded vault instructions, simulated vault balance changes, authority changes and a deterministic `gate`.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Squads link, address, or '<multisig> #<index>'", minLength: 1, maxLength: 500 },
        signer: { ...ADDRESS, description: "The member who would approve (optional)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "presign_check_token",
    title: "Check a token's security signals",
    description: "Security signals for an SPL / Token-2022 mint before buying or accepting it: mint and freeze authority, Token-2022 extensions, holder concentration, token age, metadata phishing patterns. Returns a deterministic `gate`.",
    inputSchema: { type: "object", properties: { mint: { ...ADDRESS, description: "Token mint address" } }, required: ["mint"], additionalProperties: false },
  },
] as const;

type GateName = "block" | "require_human_review" | "no_known_risk";

function gateOf(risk: RiskAssessment): GateName {
  if (risk.level === "CRITICAL" || risk.level === "HIGH") return "block";
  if (risk.level === "MEDIUM" || risk.level === "UNKNOWN" || risk.status !== "COMPLETE") return "require_human_review";
  return "no_known_risk";
}

/** Team policy outcome (set by the operator with PRESIGN_POLICY_FILE, not by the agent). */
function compactPolicy(p: PolicyReport | null | undefined) {
  if (!p) return null;
  return {
    name: p.name,
    status: p.status,
    broken: p.checks.filter((c) => c.status === "violation").map((c) => ({ rule: c.label, findings: c.findings.slice(0, 3) })),
    notCheckable: p.checks.filter((c) => c.status === "unverifiable").map((c) => c.label),
  };
}

function compactRisk(risk: RiskAssessment) {
  return {
    verdict: risk.level,
    completeness: risk.status,
    summary: risk.summary,
    signals: risk.signals.slice(0, 10).map((s) => ({ severity: s.severity, code: s.code, title: s.title, detail: s.description })),
  };
}

export function summarizeTransaction(a: TransactionAnalysis) {
  return {
    gate: a.gate,
    ...compactRisk(a.risk),
    brief: a.brief ? { headline: a.brief.headline, neverExpires: a.brief.neverExpires, signedInAdvance: a.brief.signedInAdvance, config: a.brief.config, ifExecuted: a.brief.payloads.map((p) => ({ label: p.label, status: p.status, steps: p.steps.map((s) => s.text), vaultChanges: p.vaultChanges })) } : null,
    authorityChanges: (a.multisig?.payloads ?? []).flatMap((p) => p.privileged).filter((x) => x.newAuthority !== undefined).map((x) => ({ program: x.programName, action: x.action, newHolder: x.newAuthority, control: x.control })),
    policy: compactPolicy(a.policy),
    durableNonce: a.decoded.usesDurableNonce,
    messageHash: a.messageHash,
    cluster: a.cluster,
  };
}

export function summarizeInspection(r: InspectResult) {
  if (r.kind === "proposal") {
    const i = r.inspection;
    return {
      kind: "proposal",
      gate: i.gate,
      multisig: i.multisig,
      proposal: i.transactionIndex,
      ...compactRisk(i.risk),
      brief: i.brief ? { headline: i.brief.headline, config: i.brief.config, ifExecuted: i.brief.payloads.map((p) => ({ steps: p.steps.map((s) => s.text), vaultChanges: p.vaultChanges, simulation: p.simulation })) } : null,
      authorityChanges: i.analysis.payloads.flatMap((p) => p.privileged).filter((x) => x.newAuthority !== undefined).map((x) => ({ program: x.programName, action: x.action, newHolder: x.newAuthority, control: x.control })),
      policy: compactPolicy(i.policy),
    };
  }
  if (r.kind === "guard-action") {
    const a = r.inspection;
    return {
      kind: "guard-action",
      gate: a.gate,
      guard: a.guard,
      action: a.address,
      status: a.action.status,
      eta: new Date(Number(a.action.eta) * 1000).toISOString(),
      ...compactRisk(a.risk),
      scheduledInstructions: a.scheduled.decoded.instructions.map((ix) => `${ix.programName}: ${ix.type}`),
      authorityChanges: a.scheduled.privileged.filter((x) => x.newAuthority !== undefined).map((x) => ({ program: x.programName, action: x.action, newHolder: x.newAuthority, control: x.control })),
    };
  }
  if (r.kind === "guard") {
    const g = r.overview;
    return {
      kind: "guard",
      guard: g.guard,
      setup: { ...compactRisk(g.posture), delaySeconds: g.account.delaySeconds, guardians: g.account.guardians.length, proposer: g.account.proposer },
      actions: g.actions.map((x) => ({ index: x.index, status: x.status, eta: new Date(Number(x.eta) * 1000).toISOString(), memo: x.memo })),
    };
  }
  const o = r.overview;
  return {
    kind: "multisig",
    multisig: o.multisig,
    setup: { ...compactRisk(o.posture), threshold: o.account?.threshold ?? null, members: o.account?.members.length ?? null, timeLockSeconds: o.account?.timeLock ?? null },
    policy: compactPolicy(o.policy),
    proposals: o.proposals.filter((p) => p.status !== "NOT_FOUND").map((p) => ({ index: p.transactionIndex, status: p.status, approvals: p.approvals, stale: p.stale, verdict: p.verdict, topSignal: p.topSignal })),
  };
}

export function createHandler(apiUrl: string, fetchImpl: Fetch = fetch, policies: PolicyJson[] = []) {
  const base = apiUrl.replace(/\/$/, "");

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetchImpl(`${base}${path}`, { ...init, signal: AbortSignal.timeout(90_000) });
    const body = (await res.json().catch(() => null)) as { success?: boolean; data?: T; error?: { message?: string } } | null;
    if (!res.ok || !body?.success || body.data === undefined) throw new Error(body?.error?.message ?? `Presign API error (HTTP ${res.status})`);
    return body.data;
  }

  async function runTool(name: string, args: Json): Promise<unknown> {
    const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : undefined);
    switch (name) {
      case "presign_verify_transaction": {
        if (!str("transaction")) throw new Error("`transaction` is required.");
        const a = await call<TransactionAnalysis>("/api/transaction/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: str("transaction"), walletAddress: str("signer"), policy: policyFor(policies, null) ?? undefined }) });
        return summarizeTransaction(a);
      }
      case "presign_inspect_multisig": {
        if (!str("query")) throw new Error("`query` is required.");
        const r = await call<InspectResult>("/api/multisig/inspect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: str("query"), signer: str("signer"), policy: policyFor(policies, firstAddress(str("query")!)) ?? undefined }) });
        return summarizeInspection(r);
      }
      case "presign_check_token": {
        if (!str("mint")) throw new Error("`mint` is required.");
        const t = await call<{ mint: string; risk: RiskAssessment }>(`/api/token?mint=${encodeURIComponent(str("mint")!)}`);
        return { gate: gateOf(t.risk), mint: t.mint, ...compactRisk(t.risk) };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  return async function handle(msg: RpcMessage): Promise<Json | null> {
    const id = msg.id ?? null;
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const error = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
    // Notifications (no id) never get a response.
    if (msg.id === undefined) return null;
    switch (msg.method) {
      case "initialize": {
        const requested = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "";
        return reply({
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: "Call presign_verify_transaction before signing any Solana transaction, and presign_inspect_multisig before approving a Squads proposal. Never sign when gate is 'block' or 'require_human_review'.",
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS });
      case "tools/call": {
        const name = typeof msg.params?.name === "string" ? msg.params.name : "";
        const args = (msg.params?.arguments ?? {}) as Json;
        if (!TOOLS.some((t) => t.name === name)) return error(-32602, `Unknown tool: ${name}`);
        try {
          const result = await runTool(name, args);
          return reply({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: false });
        } catch (e) {
          return reply({ content: [{ type: "text", text: e instanceof Error ? e.message : "Presign call failed." }], isError: true });
        }
      }
      default:
        return error(-32601, `Method not found: ${msg.method ?? ""}`);
    }
  };
}
