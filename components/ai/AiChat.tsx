"use client";

import { Bot, Loader2, Send, User } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { AgentReply } from "@/lib/ai/agent";
import { api, ApiClientError } from "@/lib/client/api";
import { cn } from "@/lib/utils";

interface Message {
  role: "user" | "assistant";
  content: string;
  meta?: AgentReply;
}

const SUGGESTIONS = ["Cüzdanımda riskli ne var?", "Why is this token risky?", "What does the suspicious transaction do?", "Which tokens can I clean up?"];

/** Evidence citations like [ev:id] render as small tags; everything is plain text (no HTML injection). */
function Rendered({ text }: { text: string }) {
  const parts = text.split(/(\[ev:[^\]\s]+\])/g);
  return (
    <p className="whitespace-pre-wrap text-sm leading-6">
      {parts.map((p, i) =>
        /^\[ev:/.test(p) ? (
          <span key={i} className="mx-0.5 rounded bg-sky-500/15 px-1 font-mono text-[10px] text-sky-300" title={p.slice(4, -1)}>evidence</span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </p>
  );
}

export function AiChat({ walletAddress, demo = false, transactionInput }: { walletAddress: string | null; demo?: boolean; transactionInput?: string }) {
  const enabled = Boolean(walletAddress || demo || transactionInput);
  const suggestions = transactionInput ? ["Explain this transaction in plain language", "Bu işlem ne yapıyor?"] : SUGGESTIONS;
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    if (/\b([a-z]+\s){11,23}[a-z]+\b/i.test(content) && /seed|phrase|mnemonic|private|recovery|anahtar|kelime/i.test(content)) {
      setError("It looks like you may be pasting a seed phrase or private key. Never share it — not with this app, not with anyone.");
      return;
    }
    const withContext = transactionInput && messages.length === 0 ? `${content}\n\nTransaction input: ${transactionInput}` : content;
    const next = [...messages, { role: "user" as const, content: withContext }];
    setMessages(next);
    setInput("");
    setBusy(true);
    setError(null);
    try {
      const reply = await api<AgentReply>("/api/ai/chat", {
        json: { messages: next.slice(-10).map(({ role, content }) => ({ role, content: content.slice(0, 4000) })), walletAddress: walletAddress ?? undefined, demo },
      });
      const why =
        reply.unavailableReason === "NOT_CONFIGURED"
          ? "AI is not configured on this server"
          : reply.unavailableReason === "INVALID_KEY"
            ? "The server's AI API key is invalid"
            : "The AI provider returned an error";
      const body = reply.available ? reply.text : `${why} — showing the deterministic security summary instead (no AI was used).\n\n${reply.deterministicFallback ?? ""}`;
      setMessages([...next, { role: "assistant", content: body, meta: reply }]);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "The assistant could not answer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-[420px] flex-col rounded-xl border border-zinc-800 bg-zinc-900/40">
      <div className="border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center gap-2 font-semibold"><Bot className="size-4" /> AI Security Agent</div>
        <p className="text-xs text-zinc-500">Explains deterministic findings with evidence. It cannot change risk levels, and it cannot sign or send transactions.</p>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && (
          <div className="flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <button key={s} type="button" onClick={() => void send(s)} disabled={!enabled} className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">
                {s}
              </button>
            ))}
            {!enabled && <p className="w-full text-xs text-zinc-500">Scan a wallet first to ask about it.</p>}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={cn("flex gap-2", m.role === "user" && "flex-row-reverse")}>
            <div className="mt-1 shrink-0 text-zinc-500">{m.role === "user" ? <User className="size-4" /> : <Bot className="size-4" />}</div>
            <div className={cn("max-w-[85%] rounded-lg px-3 py-2", m.role === "user" ? "bg-zinc-800 text-zinc-100" : "border border-zinc-800 bg-zinc-950 text-zinc-200")}>
              <Rendered text={m.content} />
              {m.meta && (
                <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-zinc-500">
                  {m.meta.demo && <span className="text-fuchsia-300">DEMO data</span>}
                  {m.meta.toolsUsed.length > 0 && <span>tools: {m.meta.toolsUsed.join(", ")}</span>}
                  {m.meta.citedEvidence.length > 0 && <span>{m.meta.citedEvidence.length} evidence cited</span>}
                  {m.meta.invalidCitations.length > 0 && <span className="text-amber-300">{m.meta.invalidCitations.length} unsupported citation(s) removed</span>}
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && <p className="flex items-center gap-2 text-xs text-zinc-500"><Loader2 className="size-3 animate-spin" /> Analyzing with deterministic tools…</p>}
        {error && <p className="text-xs text-red-300">{error}</p>}
      </div>

      <form
        className="flex gap-2 border-t border-zinc-800 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
          maxLength={4000}
          rows={1}
          placeholder={enabled ? "Ask about your wallet, a token, a transaction or cleanup…" : "Scan a wallet first"}
          disabled={!enabled || busy}
          className="min-h-10 resize-none border-zinc-800 bg-zinc-950"
        />
        <Button type="submit" size="icon" disabled={busy || !input.trim() || !enabled} aria-label="Send">
          <Send />
        </Button>
      </form>
    </div>
  );
}
