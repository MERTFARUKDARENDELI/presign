"use client";

import { useEffect, useState } from "react";
import { CLIENT_CLUSTER } from "@/components/providers/WalletProviders";
import { api, ApiClientError } from "@/lib/client/api";
import { cn } from "@/lib/utils";

interface Health {
  cluster: string;
  helius: boolean;
  publicRpcFallback: boolean;
  rugcheck: boolean;
  ai: "NOT_CONFIGURED" | "CONFIGURED" | "READY" | "INVALID_KEY" | "UNAVAILABLE";
}

const AI_LABEL: Record<Health["ai"], string> = {
  READY: "ready (provider accepted the key on the last request)",
  CONFIGURED: "key present but NOT verified (deterministic reports always work)",
  NOT_CONFIGURED: "not configured (deterministic reports only)",
  INVALID_KEY: "API key invalid (deterministic reports only)",
  UNAVAILABLE: "provider error on last request (deterministic fallback)",
};

/** Badge suffix: anything but a verified key is spelled out, never shown as "ready". */
const AI_SUFFIX: Record<Health["ai"], string> = {
  READY: "",
  CONFIGURED: " · AI unverified",
  NOT_CONFIGURED: " · AI off",
  INVALID_KEY: " · AI key invalid",
  UNAVAILABLE: " · AI unavailable",
};

/** Outcome of an explicit "Verify AI" click, shown as a message (not only as a badge change). */
const AI_CHECK_RESULT: Record<Health["ai"], { tone: "ok" | "warn" | "bad"; text: string }> = {
  READY: { tone: "ok", text: "AI check: Anthropic accepted the API key. Billing/quota is only checked by the first AI request; if it fails, deterministic reports are shown." },
  INVALID_KEY: { tone: "bad", text: "AI check: Anthropic rejected the API key (invalid or revoked). AI chat is off; deterministic security reports still work." },
  UNAVAILABLE: { tone: "warn", text: "AI check: Anthropic could not be reached or returned an error. Deterministic reports still work; try again later." },
  NOT_CONFIGURED: { tone: "warn", text: "AI check: no Anthropic API key is configured on the server. Deterministic reports only." },
  CONFIGURED: { tone: "warn", text: "AI check: the key could not be verified yet." },
};

type AiCheck = { kind: "result"; status: Health["ai"]; cached: boolean } | { kind: "error"; message: string };

/** Real capability status (never a hard-coded "online" claim). */
export default function SystemStatus() {
  const [health, setHealth] = useState<Health | null>(null);
  const [failed, setFailed] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [check, setCheck] = useState<AiCheck | null>(null);

  useEffect(() => {
    api<Health>("/api/health").then(setHealth).catch(() => setFailed(true));
  }, []);

  if (failed) return <span className="rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1 text-xs text-red-300">API unreachable</span>;
  if (!health) return <span className="rounded-full border border-zinc-800 px-3 py-1 text-xs text-zinc-500">Checking…</span>;
  // Server analyzes/submits on SOLANA_CLUSTER; the wallet context uses NEXT_PUBLIC_SOLANA_CLUSTER.
  if (health.cluster !== CLIENT_CLUSTER) {
    return (
      <span title={`Server cluster: ${health.cluster}\nBrowser wallet cluster: ${CLIENT_CLUSTER}\nSet SOLANA_CLUSTER and NEXT_PUBLIC_SOLANA_CLUSTER to the same value and restart.`} className="rounded-full border border-red-500/40 bg-red-500/10 px-3 py-1 text-xs text-red-300">
        Cluster mismatch: server {health.cluster} · wallet {CLIENT_CLUSTER}
      </span>
    );
  }

  // Only a successful provider call counts as "ready"; a merely present key is shown as unverified.
  const degraded = !health.helius || health.ai !== "READY";
  async function verifyAi() {
    setVerifying(true);
    setCheck(null);
    try {
      const d = await api<{ status: Health["ai"]; cached: boolean }>("/api/ai/diagnose", { method: "POST" });
      setHealth((h) => (h ? { ...h, ai: d.status } : h));
      setCheck({ kind: "result", status: d.status, cached: d.cached });
    } catch (e) {
      // Rate limited or unreachable: the status stays as it was, but the user is told why.
      setCheck({ kind: "error", message: `AI check failed: ${e instanceof ApiClientError ? e.message : "request error"}` });
    } finally {
      setVerifying(false);
    }
  }

  const title = [
    `Cluster: ${health.cluster}`,
    `Helius: ${health.helius ? "configured" : "missing (enhanced data unavailable)"}`,
    `Public RPC fallback: ${health.publicRpcFallback ? "on" : "off"}`,
    `RugCheck: ${health.rugcheck ? "on" : "off"}`,
    `AI: ${AI_LABEL[health.ai]}`,
  ].join("\n");

  const result = check?.kind === "result" ? AI_CHECK_RESULT[check.status] : null;
  const message = check?.kind === "error" ? check.message : result ? `${result.text}${check?.kind === "result" && check.cached ? " (cached result)" : ""}` : null;
  const tone = check?.kind === "error" ? "warn" : (result?.tone ?? "warn");

  // Dynamic text sits in keyed elements: React then replaces the element instead of
  // editing a text node in place, so updates stay visible under browser page translation.
  return (
    <span className="relative inline-flex items-center gap-2">
      <span title={title} className={cn("rounded-full border px-3 py-1 text-xs", degraded ? "border-amber-500/30 bg-amber-500/10 text-amber-200" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300")}>
        <span className="mr-1.5">●</span>
        {health.cluster}
        <span key={`ai-${health.ai}`}>{AI_SUFFIX[health.ai]}</span>
        {!health.helius && <span key="helius-missing"> · Helius missing</span>}
      </span>
      {(health.ai === "CONFIGURED" || health.ai === "UNAVAILABLE") && (
        <button type="button" onClick={() => void verifyAi()} disabled={verifying} title="One lightweight check of the server's AI key (no tokens generated; cached for 10 minutes)." className="rounded-full border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800 disabled:opacity-50">
          <span key={verifying ? "verifying" : "idle"}>{verifying ? "Verifying…" : "Verify AI"}</span>
        </button>
      )}
      {message && (
        <span
          key={message}
          role="status"
          aria-live="polite"
          className={cn(
            "absolute right-0 top-full z-50 mt-2 flex w-72 items-start gap-2 rounded-lg border p-3 text-xs shadow-lg",
            tone === "ok" && "border-emerald-500/40 bg-zinc-950 text-emerald-200",
            tone === "warn" && "border-amber-500/40 bg-zinc-950 text-amber-200",
            tone === "bad" && "border-red-500/40 bg-zinc-950 text-red-200",
          )}
        >
          <span className="flex-1">{message}</span>
          <button type="button" onClick={() => setCheck(null)} aria-label="Dismiss" className="text-zinc-500 hover:text-zinc-200">
            ×
          </button>
        </span>
      )}
    </span>
  );
}
