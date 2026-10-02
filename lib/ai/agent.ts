import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { logger } from "@/lib/api/logger";
import type { WalletSecurityScan } from "@/lib/wallet/scan-core";
import { aiModel, configuredKey, createAnthropicClient } from "./client";
import { SECURITY_AGENT_INSTRUCTIONS } from "./prompt";
import { collectEvidenceIds, enforceEvidenceContract, sanitizeForAi } from "./sanitize";
import { getAiStatus, recordAiFailure, recordAiSuccess } from "./status";
import { createSecurityTools, type SecurityDataProvider, type ToolTrace } from "./tools";

export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AgentReply {
  available: boolean;
  text: string;
  toolsUsed: string[];
  citedEvidence: string[];
  /** Citations the model produced that match no deterministic evidence (removed from text). */
  invalidCitations: string[];
  /** Deterministic fallback shown when AI is unavailable. */
  deterministicFallback: string | null;
  /** Why AI output is absent: no key, a key the provider rejected (or malformed), the model declined, or another provider/model failure. */
  unavailableReason: "NOT_CONFIGURED" | "INVALID_KEY" | "REFUSED" | "PROVIDER_ERROR" | null;
  demo: boolean;
}

/** One Messages API call. Production uses the Anthropic SDK; tests pass a fake. */
export type CreateMessage = (params: Anthropic.Beta.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }) => Promise<Anthropic.Beta.BetaMessage>;

const MAX_STEPS = 6;
const TOTAL_TIMEOUT_MS = 50_000;

class AiRefusalError extends Error {}

/** Deterministic, AI-free summary so the security report works without the AI provider. */
export function deterministicSummary(scan: WalletSecurityScan | null): string {
  if (!scan) return "AI explanations are unavailable. Deterministic analysis is still shown on this page.";
  const r = scan.walletRisk;
  const lines = [
    `${scan.demo ? "[DEMO DATA] " : ""}Wallet risk: ${r.level} (analysis ${r.status}).`,
    r.summary,
    ...r.signals.slice(0, 6).map((s) => `• ${s.severity}: ${s.title}`),
    `Tokens: ${scan.metrics.tokenCount}, risky: ${scan.metrics.riskyTokenCount}, cleanup opportunities: ${scan.metrics.cleanupOpportunities}.`,
  ];
  return lines.join("\n");
}

function textOf(message: Anthropic.Beta.BetaMessage): string {
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export async function runSecurityAgent(
  messages: AgentMessage[],
  provider: SecurityDataProvider,
  /** `createMessage` is a test seam only; API routes never pass it, so production always calls the configured Claude model. */
  options: { createMessage?: CreateMessage } = {},
): Promise<AgentReply> {
  const demo = provider.mode === "demo";
  const unavailable = async (reason: NonNullable<AgentReply["unavailableReason"]>): Promise<AgentReply> => {
    const scan = provider.wallet ? await provider.getWalletScan().catch(() => null) : null;
    return { available: false, text: "", toolsUsed: [], citedEvidence: [], invalidCitations: [], deterministicFallback: deterministicSummary(scan), unavailableReason: reason, demo };
  };

  const status = options.createMessage ? null : getAiStatus();
  // A missing or rejected key never reaches the provider again: deterministic fallback, no cost.
  if (status === "NOT_CONFIGURED" || status === "INVALID_KEY") return unavailable(status);

  let createMessage = options.createMessage;
  if (!createMessage) {
    const client = createAnthropicClient(configuredKey()!);
    createMessage = (params, opts) => client.beta.messages.create(params, opts);
  }

  const traces: ToolTrace[] = [];
  const tools = createSecurityTools(provider, traces);
  // User text is untrusted too; it is passed as user messages, never merged into the system prompt.
  const conversation: Anthropic.Beta.BetaMessageParam[] = messages.map((m) => ({ role: m.role, content: m.content }));
  const signal = AbortSignal.timeout(TOTAL_TIMEOUT_MS);

  try {
    let text: string | null = null;
    for (let step = 0; step < MAX_STEPS && text === null; step++) {
      const response = await createMessage(
        {
          model: aiModel(),
          max_tokens: 16_000,
          // Tools and the system prompt never change between requests, so they form one cached prefix.
          system: [{ type: "text", text: SECURITY_AGENT_INSTRUCTIONS, cache_control: { type: "ephemeral" } }],
          tools: tools.definitions,
          messages: conversation,
          output_config: { effort: "medium" },
          // Security wording (exploits, drains, takeovers) can trip a classifier; the API then retries on its recommended model.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        { signal },
      );
      if (response.stop_reason === "refusal") throw new AiRefusalError(response.stop_details?.category ?? "unspecified");

      // The full content (thinking blocks included) goes back unchanged, as the API requires.
      conversation.push({ role: "assistant", content: response.content as Anthropic.Beta.BetaContentBlockParam[] });
      const calls = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (response.stop_reason !== "tool_use" || calls.length === 0) {
        text = textOf(response);
        break;
      }
      const results = await Promise.all(
        calls.map(async (call): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
          const r = await tools.run(call.name, call.input);
          return { type: "tool_result", tool_use_id: call.id, content: JSON.stringify(r.output), ...(r.isError ? { is_error: true } : {}) };
        }),
      );
      // All results of one turn go back in a single user message.
      conversation.push({ role: "user", content: results });
    }
    if (!text) throw new Error("The model produced no answer within the step limit.");

    const known = new Set<string>();
    for (const t of traces) collectEvidenceIds(sanitizeForAi(t.output, { maskWallet: provider.wallet ?? undefined }), known);
    const enforced = enforceEvidenceContract(text, known);
    if (enforced.invalid.length) logger.warn("ai.invalid_citations", { count: enforced.invalid.length });
    logger.info("ai.tool_calls", { tools: traces.map((t) => t.tool), demo });
    if (!options.createMessage) recordAiSuccess();

    return {
      available: true,
      text: enforced.text,
      toolsUsed: [...new Set(traces.map((t) => t.tool))],
      citedEvidence: enforced.cited,
      invalidCitations: enforced.invalid,
      deterministicFallback: null,
      unavailableReason: null,
      demo,
    };
  } catch (error) {
    if (error instanceof AiRefusalError) {
      // A decline is a successful provider call: the key works.
      logger.warn("ai.refused", { category: error.message });
      if (!options.createMessage) recordAiSuccess();
      return unavailable("REFUSED");
    }
    logger.warn("ai.unavailable", { error });
    if (!options.createMessage) recordAiFailure(error);
    return unavailable(!options.createMessage && getAiStatus() === "INVALID_KEY" ? "INVALID_KEY" : "PROVIDER_ERROR");
  }
}
