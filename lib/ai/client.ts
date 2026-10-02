import "server-only";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Claude access for the AI layer. Server-only: the key never reaches the
 * browser bundle. The model can be overridden with AI_MODEL; the key is always
 * passed explicitly so an `ant auth login` profile on a dev machine is never
 * picked up by accident.
 */

export const DEFAULT_AI_MODEL = "claude-sonnet-5-5";

export function aiModel(): string {
  return process.env.AI_MODEL?.trim() || DEFAULT_AI_MODEL;
}

export function configuredKey(): string | null {
  return process.env.ANTHROPIC_API_KEY?.trim() || null;
}

export function createAnthropicClient(apiKey: string, options: { timeoutMs?: number; maxRetries?: number } = {}): Anthropic {
  return new Anthropic({ apiKey, timeout: options.timeoutMs ?? 45_000, maxRetries: options.maxRetries ?? 2 });
}

/** True when the provider rejected the credentials (401/403), as opposed to a transient failure. */
export function isAuthError(error: unknown): boolean {
  return error instanceof Anthropic.APIError && (error.status === 401 || error.status === 403);
}
