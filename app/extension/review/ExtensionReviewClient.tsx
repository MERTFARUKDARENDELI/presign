"use client";

import { CheckCircle2, Circle, CircleHelp, Loader2, Puzzle, X } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SigningReview } from "@/components/presign/SigningReview";
import { CLIENT_CLUSTER } from "@/components/providers/WalletProviders";
import { REVIEW_METHOD_LABEL, type ReviewTicket } from "@/extension/src/lib/protocol";
import { api, ApiClientError } from "@/lib/client/api";
import { fetchSession, recordEvent } from "@/lib/presign/client";
import { cancelInExtension, closeReview, EXTENSION_ID_PATTERN, extensionAvailable, forwardToExtension, getTicket } from "@/lib/presign/extension-bridge";
import type { ConnectionContext, SigningReview as Review } from "@/lib/presign/types";
import { cn } from "@/lib/utils";
import { OwnershipGate } from "./OwnershipGate";

type Phase =
  | { kind: "loading"; step: number }
  | { kind: "no-extension" }
  | { kind: "error"; message: string }
  | { kind: "handled"; ticket: ReviewTicket }
  | { kind: "unreadable"; ticket: ReviewTicket; reason: string }
  | { kind: "review"; ticket: ReviewTicket; review: Review };

const STEPS = ["Request received from the extension", "Application address checked", "Decode · simulate · deterministic rules"];

const hostOf = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

const clusterChain = CLIENT_CLUSTER === "devnet" ? "solana:devnet" : "solana:mainnet";

/**
 * Review of a signing request captured by the Presign browser extension on
 * another site. Same analysis, same decision rules and same server approval
 * as every Presign review; the only difference is where the wallet is: the
 * approval goes back to the extension, whose page hook lets the wallet sign
 * the request it captured itself.
 */
export default function ExtensionReviewClient() {
  const params = useSearchParams();
  const rid = params.get("rid") ?? "";
  const ext = params.get("ext") ?? "";
  const [phase, setPhase] = useState<Phase>({ kind: "loading", step: 0 });
  const [verifiedWallet, setVerifiedWallet] = useState<string | null | undefined>(undefined);

  // Approval needs this session's proof of ownership; re-read it whenever it may have changed.
  useEffect(() => {
    let cancelled = false;
    const load = () => fetchSession().then((s) => !cancelled && setVerifiedWallet(s.verified?.wallet ?? null)).catch(() => !cancelled && setVerifiedWallet(null));
    void load();
    window.addEventListener("presign-session", load);
    return () => {
      cancelled = true;
      window.removeEventListener("presign-session", load);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const set = (p: Phase) => !cancelled && setPhase(p);
    void (async () => {
      if (!/^[0-9a-f-]{36}$/.test(rid) || !EXTENSION_ID_PATTERN.test(ext)) return set({ kind: "error", message: "This page is opened by the Presign extension for one request. The link is incomplete." });
      if (!extensionAvailable()) return set({ kind: "no-extension" });
      let ticket: ReviewTicket;
      try {
        ticket = await getTicket(ext, rid);
      } catch (e) {
        return set({ kind: "error", message: e instanceof Error ? e.message : "The extension did not share this request." });
      }
      if (ticket.state !== "pending") return set({ kind: "handled", ticket });
      const r = ticket.request;
      if (r.type === "UNREADABLE" || !r.payload) return set({ kind: "unreadable", ticket, reason: r.reason ?? "Presign could not read this request." });
      if (!r.walletAddress) return set({ kind: "unreadable", ticket, reason: "The wallet account that would sign is not known, so the request cannot be analyzed for it." });

      set({ kind: "loading", step: 1 });
      const host = hostOf(ticket.origin);
      let connectionToken: string | null = null;
      try {
        // The origin was observed by the extension (the browser's sender origin), not claimed by the site.
        const c = await api<ConnectionContext>("/api/presign/connect", { json: { target: ticket.origin, name: host, ...(r.walletName ? { walletType: r.walletName } : {}) } });
        connectionToken = c.connectionToken;
      } catch {
        connectionToken = null;
      }

      set({ kind: "loading", step: 2 });
      try {
        const review = await api<Review>("/api/presign/signing/analyze", {
          json: { type: r.type, payload: r.payload, payloadEncoding: "base64", walletAddress: r.walletAddress, application: host, ...(connectionToken ? { connectionToken } : { domain: ticket.origin }) },
        });
        recordEvent("REQUEST_ANALYZED", `${host} · ${REVIEW_METHOD_LABEL[r.method]}: ${review.decision.technicalValidation === "VALID" ? review.decision.risk.level : "cannot be verified"}`);
        set({ kind: "review", ticket, review });
      } catch (e) {
        set({ kind: "error", message: e instanceof ApiClientError ? e.message : "Presign could not analyze this request." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rid, ext]);

  const ticket = "ticket" in phase ? phase.ticket : null;
  const close = () => {
    if (EXTENSION_ID_PATTERN.test(ext)) void closeReview(ext, rid);
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      <header className="space-y-2">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-violet-300"><Puzzle className="size-3.5" aria-hidden /> Presign extension · review before your wallet opens</p>
        {ticket && (
          <dl className="grid gap-2 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 text-sm sm:grid-cols-2">
            <div><dt className="text-xs text-zinc-500">Requested by</dt><dd className="font-mono text-zinc-100">{hostOf(ticket.origin)}</dd><dd className="text-[11px] text-zinc-500">Address observed by the extension in your browser, not stated by the site.</dd></div>
            <div><dt className="text-xs text-zinc-500">Request</dt><dd className="text-zinc-100">{REVIEW_METHOD_LABEL[ticket.request.method]}{ticket.request.total > 1 ? ` · ${ticket.request.index} of ${ticket.request.total} (each is reviewed separately)` : ""}</dd>{ticket.request.walletName && <dd className="text-[11px] text-zinc-500">Wallet: {ticket.request.walletName}</dd>}</div>
          </dl>
        )}
        {ticket?.request.reconstructed && <p className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3 text-xs text-sky-100">Sign-In With Solana: your wallet builds the text from the site&apos;s fields. Presign rebuilt the same text with the standard&apos;s format; if your wallet signs anything else, Presign withholds the signature from the site.</p>}
        {ticket?.request.chain && ticket.request.chain !== clusterChain && <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-100" role="alert">This request is for {ticket.request.chain.replace("solana:", "")}, but this Presign instance analyzes {CLIENT_CLUSTER}. The simulation may not reflect what the request does.</p>}
        {ticket?.request.method === "signAndSendTransaction" && <p className="text-xs text-zinc-500">Your wallet will broadcast this transaction itself after you sign it.</p>}
      </header>

      {phase.kind === "loading" && (
        <ol className="space-y-1.5 rounded-xl border border-zinc-800 bg-zinc-950 p-4 text-sm" aria-label="Analysis progress">
          {STEPS.map((s, i) => (
            <li key={s} className={cn("flex items-center gap-2", i < phase.step ? "text-emerald-300" : i === phase.step ? "text-violet-200" : "text-zinc-600")}>
              {i < phase.step ? <CheckCircle2 className="size-4" aria-hidden /> : i === phase.step ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Circle className="size-4" aria-hidden />} {s}
            </li>
          ))}
        </ol>
      )}

      {phase.kind === "no-extension" && (
        <div className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 text-sm">
          <p className="font-semibold text-zinc-100">The Presign extension is not connected to this page.</p>
          <p className="text-zinc-400">This page reviews requests captured by the Presign browser extension. Open it from the extension (it opens automatically when a site asks your wallet to sign).</p>
        </div>
      )}

      {phase.kind === "error" && <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-100" role="alert">{phase.message}</div>}

      {phase.kind === "handled" && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-300" role="status">
          This request is already {phase.ticket.state}{phase.ticket.detail ? `: ${phase.ticket.detail}` : "."}
        </div>
      )}

      {phase.kind === "unreadable" && (
        <article className="space-y-4 rounded-2xl border border-zinc-700 bg-zinc-950 p-5" aria-labelledby="unverifiable-title">
          <div className="flex items-start gap-3 rounded-xl border border-zinc-600 bg-zinc-800/40 p-4">
            <CircleHelp className="mt-0.5 size-5 shrink-0" aria-hidden />
            <div className="space-y-1">
              <p id="unverifiable-title" className="font-semibold">Unable to safely verify this signing request.</p>
              <p className="text-sm text-zinc-300">{phase.reason}</p>
              <p className="text-sm text-zinc-400">Presign cannot determine what this request would do, so it does not offer &quot;sign anyway&quot;. If you trust this site, you can turn Presign off for it in the extension menu.</p>
            </div>
          </div>
          <div className="flex justify-end">
            <Button variant="outline" autoFocus onClick={() => void cancelInExtension(ext, rid, "UNKNOWN")}><X /> Cancel</Button>
          </div>
        </article>
      )}

      {phase.kind === "review" && verifiedWallet !== undefined && verifiedWallet !== phase.ticket.request.walletAddress && phase.review.decision.technicalValidation === "VALID" && (
        <OwnershipGate wallet={phase.ticket.request.walletAddress!} onVerified={() => window.dispatchEvent(new Event("presign-session"))} />
      )}

      {phase.kind === "review" && (
        <SigningReview
          review={phase.review}
          external={{
            walletAddress: phase.ticket.request.walletAddress!,
            walletSends: phase.ticket.request.method === "signAndSendTransaction",
            blockedReason: verifiedWallet === phase.ticket.request.walletAddress ? undefined : "Verify that you own this wallet (above) to sign. Cancel is always available.",
            onCancel: (level) => void cancelInExtension(ext, rid, level),
            forward: (approval, payload) => forwardToExtension(ext, rid, approval, payload, phase.review.decision.risk.level, phase.review.decision.expectedChoice ?? "SIGN"),
          }}
        />
      )}

      {phase.kind !== "loading" && phase.kind !== "no-extension" && (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={close}>Close window</Button>
        </div>
      )}
    </div>
  );
}
