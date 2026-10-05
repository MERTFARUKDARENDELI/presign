import { getAiStatus } from "@/lib/ai/status";
import { withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { sessionSecretConfigured } from "@/lib/presign/tokens";
import { getCluster, isHeliusConfigured } from "@/lib/solana/config";

/** Capability status for the UI. Reports only booleans and status enums — never secrets, and never calls the AI provider. */
export const GET = withApi({ name: "health", limit: 60, windowMs: 60_000 }, async () =>
  ok({
    cluster: getCluster(),
    helius: isHeliusConfigured(),
    publicRpcFallback: process.env.SOLANA_DISABLE_PUBLIC_FALLBACK !== "true",
    // RugCheck indexes mainnet only, so it is inactive on devnet.
    rugcheck: process.env.RUGCHECK_DISABLED !== "true" && getCluster() === "mainnet-beta",
    ai: getAiStatus(),
    // Secure connect and the pre-sign review need it in production.
    presignSessionSecret: sessionSecretConfigured(),
  }),
);
