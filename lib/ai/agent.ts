import "server-only";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, isStepCount, type LanguageModel } from "ai";
import { logger } from "@/lib/api/logger";
import type { WalletSecurityScan } from "@/lib/wallet/scan-core";
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
  /** Why AI output is absent: no key, a key the provider rejected (or malformed), or another provider/model failure. */
  unavailableReason: "NOT_CONFIGURED" | "INVALID_KEY" | "PROVIDER_ERROR" | null;
  demo: boolean;
}

function defaultModel(): LanguageModel {
  const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai(process.env.OPENAI_MODEL?.trim() || "gpt-4.1-mini");
}

/** Deterministic, AI-free summary so the security report works without OpenAI. */
export function deterministicSummary(scan: WalletSecurityScan | null): string {
  if (!scan) return "AI explanations are unavailable. Deterministic analysis is still shown in the dashboard panels.";
  const r = scan.walletRisk;
  const lines = [
    `${scan.demo ? "[DEMO DATA] " : ""}Wallet risk: ${r.level} (analysis ${r.status}).`,
    r.summary,
    ...r.signals.slice(0, 6).map((s) => `• ${s.severity}: ${s.title}`),
    `Tokens: ${scan.metrics.tokenCount}, risky: ${scan.metrics.riskyTokenCount}, cleanup opportunities: ${scan.metrics.cleanupOpportunities}.`,
  ];
  return lines.join("\n");
}

export async function runSecurityAgent(
  messages: AgentMessage[],
  provider: SecurityDataProvider,
  /** `model` is a test seam only; API routes never pass it, so production always uses the configured OpenAI model. */
  options: { model?: LanguageModel } = {},
): Promise<AgentReply> {
  const demo = provider.mode === "demo";
  const status = options.model ? null : getAiStatus();
  // A missing or rejected key never reaches the provider again: deterministic fallback, no cost.
  if (status === "NOT_CONFIGURED" || status === "INVALID_KEY") {
    const scan = provider.wallet ? await provider.getWalletScan().catch(() => null) : null;
    return { available: false, text: "", toolsUsed: [], citedEvidence: [], invalidCitations: [], deterministicFallback: deterministicSummary(scan), unavailableReason: status, demo };
  }

  const traces: ToolTrace[] = [];
  const tools = createSecurityTools(provider, traces);

  try {
    const result = await generateText({
      model: options.model ?? defaultModel(),
      instructions: SECURITY_AGENT_INSTRUCTIONS,
      // User text is untrusted too; it is passed as a user message, never merged into instructions.
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      tools,
      stopWhen: isStepCount(5),
      maxRetries: 2,
      timeout: { totalMs: 45_000 },
      temperature: 0,
    });

    const known = new Set<string>();
    for (const t of traces) collectEvidenceIds(sanitizeForAi(t.output, { maskWallet: provider.wallet ?? undefined }), known);
    const enforced = enforceEvidenceContract(result.text, known);
    if (enforced.invalid.length) logger.warn("ai.invalid_citations", { count: enforced.invalid.length });
    logger.info("ai.tool_calls", { tools: traces.map((t) => t.tool), demo });
    if (!options.model) recordAiSuccess();

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
    logger.warn("ai.unavailable", { error });
    if (!options.model) recordAiFailure(error);
    const scan = provider.wallet ? await provider.getWalletScan().catch(() => null) : null;
    const unavailableReason = !options.model && getAiStatus() === "INVALID_KEY" ? "INVALID_KEY" : "PROVIDER_ERROR";
    return { available: false, text: "", toolsUsed: [], citedEvidence: [], invalidCitations: [], deterministicFallback: deterministicSummary(scan), unavailableReason, demo };
  }
}
