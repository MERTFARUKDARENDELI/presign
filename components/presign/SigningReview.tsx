"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import bs58 from "bs58";
import { AlertOctagon, BadgeCheck, CheckCircle2, CircleHelp, CircleX, Loader2, PenLine, Send, ShieldAlert, Sparkles, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DomainStatusChip } from "@/components/presign/CheckList";
import { Address, RiskBadge, StatusBadge } from "@/components/security/badges";
import { RiskDetails } from "@/components/security/RiskDetails";
import { TransactionReport } from "@/components/transaction/TransactionReport";
import { api, ApiClientError } from "@/lib/client/api";
import { recordEvent, verifyMessageSignature } from "@/lib/presign/client";
import { executeDecision, executeForwardedDecision, type ApproveRequestBody, type DecisionResult, type ForwardOutcome } from "@/lib/presign/controller";
import { canTransition, type FlowState } from "@/lib/presign/flow";
import { requestLabel } from "@/lib/presign/interceptor";
import type { SigningApproval, SigningReview as Review } from "@/lib/presign/types";
import type { SendResult } from "@/lib/solana/send";
import type { TransactionAnalysis } from "@/lib/transaction/types";
import { signExactly } from "@/lib/wallet/signing";
import { cn } from "@/lib/utils";

/**
 * Signing through the Presign browser extension: the wallet lives in the
 * application's tab, so after approval the decision is handed to the
 * extension instead of a wallet connected to this page.
 */
export interface ExternalSigning {
  walletAddress: string;
  forward: (approval: SigningApproval, payload: string) => Promise<ForwardOutcome>;
  onCancel: (riskLevel: string) => void;
  /** The wallet broadcasts the transaction itself (signAndSendTransaction). */
  walletSends: boolean;
  /** Why the sign path is not available yet (e.g. ownership not verified). Cancel always stays available. */
  blockedReason?: string;
}

interface Explanation {
  available: boolean;
  text: string | null;
  unavailableReason: string | null;
  provider?: "claude" | "gemini" | null;
}

const RECOMMENDATION: Record<Review["decision"]["recommendedAction"], { label: string; tone: string }> = {
  SIGN: { label: "No significant issue found", tone: "text-emerald-300" },
  REVIEW: { label: "Review, then decide", tone: "text-sky-300" },
  CAUTION: { label: "Proceed with caution", tone: "text-amber-200" },
  DO_NOT_SIGN: { label: "Do not sign", tone: "text-red-300" },
  CANNOT_VERIFY: { label: "Cannot be verified", tone: "text-zinc-300" },
};

const SIM_STYLE = {
  PASS: { icon: CheckCircle2, tone: "text-emerald-300", label: "Simulation completed" },
  WARNING: { icon: TriangleAlert, tone: "text-amber-200", label: "Simulation completed with warnings" },
  FAILED: { icon: CircleX, tone: "text-red-300", label: "Simulation failed" },
  UNAVAILABLE: { icon: CircleHelp, tone: "text-zinc-400", label: "Simulation unavailable" },
} as const;

function toB64(bytes: Uint8Array): string {
  let s = "";
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 border-t border-zinc-800 pt-4">
      <h4 className="text-xs font-semibold uppercase tracking-[0.15em] text-zinc-500">{title}</h4>
      {children}
    </section>
  );
}

function Row({ label, ok, children }: { label: string; ok: boolean | null; children: React.ReactNode }) {
  const Icon = ok === null ? CircleHelp : ok ? CheckCircle2 : CircleX;
  return (
    <div className="flex items-start gap-2 text-sm">
      <dt className="w-36 shrink-0 text-xs uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd className="flex items-start gap-1.5 text-zinc-200"><Icon className={cn("mt-0.5 size-4 shrink-0", ok === null ? "text-zinc-400" : ok ? "text-emerald-300" : "text-red-300")} aria-label={ok === null ? "unknown" : ok ? "ok" : "problem"} /> <span>{children}</span></dd>
    </div>
  );
}

/** The multisig view, in the order a council member checks it. */
function MultisigBlock({ m, simulation, risk }: { m: NonNullable<Review["multisigSummary"]>; simulation: string | null; risk: Review["decision"]["risk"] }) {
  const tl = m.timeLockSeconds;
  return (
    <Section title="Multisig">
      <dl className="space-y-1.5">
        <Row label="Action" ok={null}>{m.action}</Row>
        {m.afterExecution.length > 0 && <Row label="After execution" ok={null}>{m.afterExecution.join(" · ")}</Row>}
        <Row label="Multisig control" ok={m.control ? !m.control.leavesMultisig : true}>{m.control ? m.control.text : "No authority change"}</Row>
        {m.threshold && <Row label="Threshold" ok={null}>{m.threshold}</Row>}
        <Row label="Time lock" ok={tl === null ? null : tl > 0}>{tl === null ? "Unknown (multisig account not loaded)" : tl > 0 ? `${tl} s` : "None"}</Row>
        <Row label="Durable nonce" ok={!m.durableNonce}>{m.durableNonce ? "Present — this signature never expires" : "No"}</Row>
        <Row label="Simulation" ok={simulation === null ? null : simulation === "PASS"}>{simulation ?? "Not run"}</Row>
        <Row label="Risk" ok={risk.status !== "COMPLETE" ? null : risk.level === "SAFE" || risk.level === "LOW"}>{risk.status === "COMPLETE" ? risk.level : `${risk.level} (some checks did not run)`}</Row>
      </dl>
    </Section>
  );
}

function Lines({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <p className="text-sm text-zinc-500">{empty}</p>;
  return <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-300">{items.map((x, i) => <li key={`${i}-${x}`}>{x}</li>)}</ul>;
}

/**
 * PRESIGN PRE-SIGN SECURITY CHECK. Shown BEFORE the wallet is asked to sign.
 * Presign advises, the user decides: a valid request can always be signed —
 * HIGH / CRITICAL only after one explicit confirmation — while a request
 * Presign cannot verify offers Cancel only. The wallet's own confirmation
 * is still the final authorization.
 */
export function SigningReview({ review, allowSubmit = false, onClose, external }: { review: Review; allowSubmit?: boolean; onClose?: () => void; external?: ExternalSigning }) {
  const { publicKey, signTransaction, signMessage, wallet } = useWallet();
  const connected = external ? external.walletAddress : (publicKey?.toBase58() ?? null);
  const d = review.decision;
  const req = review.request;
  const valid = d.technicalValidation === "VALID";
  const level = d.risk.level;
  const needsOverride = d.requiredConfirmation === "EXPLICIT_OVERRIDE";

  const [state, setState] = useState<FlowState>("SECURITY_REVIEW");
  const [result, setResult] = useState<DecisionResult | null>(null);
  const [submitted, setSubmitted] = useState<SendResult | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [ai, setAi] = useState<Explanation | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const go = (to: FlowState) => setState((s) => (canTransition(s, to) ? to : s));
  if (state === "SECURITY_REVIEW") setState("USER_APPROVAL");

  useEffect(() => {
    let cancelled = false;
    api<Explanation>("/api/presign/signing/explain", { json: { findings: review.findings, findingsToken: review.findingsToken } })
      .then((x) => !cancelled && setAi(x))
      .catch(() => !cancelled && setAi({ available: false, text: null, unavailableReason: "PROVIDER_ERROR" }));
    return () => {
      cancelled = true;
    };
  }, [review]);

  useEffect(() => {
    if (state === "OPTIONAL_RISK_OVERRIDE") cancelRef.current?.focus();
  }, [state]);

  const walletChanged = connected !== null && connected !== req.walletAddress;
  const topSignals = useMemo(() => review.findings.signals.filter((s) => s.severity !== "LOW").slice(0, 6), [review]);

  function cancel() {
    recordEvent("USER_CANCELLED", `Cancelled ${req.type.toLowerCase()} request (${level})`);
    external?.onCancel(level);
    setResult({ kind: "CANCELLED" });
    go("WAITING_FOR_SIGN_REQUEST");
  }

  async function decide(overrideConfirmed: boolean) {
    if (!d.expectedChoice) return;
    go("WALLET_SIGNING");
    const approve = (body: ApproveRequestBody) => api<SigningApproval>("/api/presign/signing/approve", { json: body });
    const outcome = external
      ? await executeForwardedDecision(review, { choice: d.expectedChoice, overrideConfirmed }, { approve, forward: external.forward })
      : await executeDecision(review, { choice: d.expectedChoice, overrideConfirmed }, {
          approve,
          walletSignTransaction: signTransaction && connected
            ? (bytes, confirmedHash) => signExactly({ bytes, confirmedHash, signer: connected, sign: signTransaction, supportedVersions: wallet?.adapter.supportedTransactionVersions ?? null })
            : undefined,
          walletSignMessage: signMessage ? (bytes) => signMessage(bytes) : undefined,
          verifyMessageSignature,
        });
    setResult(outcome);
    if (outcome.kind === "SIGNED_TRANSACTION" || outcome.kind === "SIGNED_MESSAGE" || outcome.kind === "SIGNED_IN_WALLET") {
      recordEvent(needsOverride ? "USER_OVERRIDE" : "USER_SIGNED", `${needsOverride ? "Signed despite" : "Signed"} ${level} ${req.type.toLowerCase()}${needsOverride ? " warning (explicit override)" : ""}`);
      setState("SIGNED");
    } else if (outcome.kind === "SIGN_REJECTED") {
      setState("SIGN_REJECTED");
    } else if (outcome.kind === "BLOCKED") {
      recordEvent("SIGN_BLOCKED", outcome.reason);
      setState(outcome.code === "PAYLOAD_MISMATCH" ? "PAYLOAD_MISMATCH" : outcome.code === "REQUEST_EXPIRED" ? "REQUEST_EXPIRED" : "TECHNICAL_VALIDATION_FAILED");
    } else {
      setState("USER_APPROVAL");
    }
  }

  async function submit(signed: Uint8Array, approval: SigningApproval) {
    setSubmitError(null);
    go("OPTIONAL_SUBMISSION");
    try {
      const r = await api<SendResult>("/api/transaction/submit", { json: { signedTransaction: toB64(signed), expectedMessageHash: approval.payloadHash, approvalToken: approval.approvalToken } });
      setSubmitted(r);
      recordEvent("SUBMITTED", `Submitted transaction ${r.signature.slice(0, 8)}… (${r.status})`);
    } catch (e) {
      setSubmitError(e instanceof ApiClientError ? e.message : "Submission failed.");
    }
  }

  const rec = RECOMMENDATION[d.recommendedAction];
  const sim = review.simulation;
  const SimIcon = sim ? SIM_STYLE[sim.status].icon : CircleHelp;
  const banner =
    !valid ? "border-zinc-600 bg-zinc-800/40 text-zinc-100"
    : level === "CRITICAL" ? "border-red-500/50 bg-red-500/10 text-red-100"
    : level === "HIGH" ? "border-orange-500/50 bg-orange-500/10 text-orange-100"
    : level === "MEDIUM" || level === "UNKNOWN" ? "border-amber-500/40 bg-amber-500/10 text-amber-100"
    : "border-emerald-500/30 bg-emerald-500/5 text-emerald-100";
  const BannerIcon = !valid ? CircleHelp : level === "CRITICAL" ? AlertOctagon : level === "HIGH" ? ShieldAlert : level === "MEDIUM" || level === "UNKNOWN" ? TriangleAlert : CheckCircle2;

  return (
    <article className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-950 p-5 shadow-xl shadow-black/30" aria-labelledby="presign-review-title">
      <header className="space-y-3">
        <p id="presign-review-title" className="text-xs font-semibold uppercase tracking-[0.2em] text-violet-300">Presign pre-sign security check</p>
        <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div><dt className="text-xs text-zinc-500">Application</dt><dd className="text-zinc-100">{review.connection.name ?? "Not provided"}</dd></div>
          <div>
            <dt className="text-xs text-zinc-500">Domain</dt>
            <dd className="flex flex-wrap items-center gap-2 font-mono text-zinc-100">
              {review.connection.domain ? <>{review.connection.domain.domain} <DomainStatusChip status={review.connection.domain.status} /></> : <span className="font-sans text-zinc-400">Unknown / not provided</span>}
              {review.connection.origin && !review.connection.verifiedByPresign && <span className="font-sans text-[11px] text-amber-200">claimed, not verified</span>}
            </dd>
          </div>
          <div><dt className="text-xs text-zinc-500">Wallet</dt><dd><Address value={req.walletAddress} n={6} className="text-zinc-100" /></dd></div>
          <div className="sm:col-span-2 lg:col-span-1">
            <dt className="text-xs text-zinc-500">Request · {requestLabel(req)}</dt>
            <dd className="text-zinc-100">{review.explanation.headline}</dd>
            {req.expectedEffects?.summary && <dd className="mt-0.5 text-xs text-zinc-400">Application says: &ldquo;{req.expectedEffects.summary}&rdquo; <span className="text-zinc-500">(claim, compared with the simulation)</span></dd>}
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Risk</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <RiskBadge level={level} />
              {d.risk.score !== null && <span className="font-mono text-xs text-zinc-400" title="Deterministic weighted sum of the signals below">{d.risk.score}/100</span>}
              <StatusBadge status={d.risk.status} />
            </dd>
          </div>
          <div><dt className="text-xs text-zinc-500">Automated-signer gate</dt><dd className="font-mono text-xs text-zinc-300" title="What bots, backends and AI agents must do. Unchanged by your decision.">{d.gate}</dd></div>
        </dl>
      </header>

      <div className={cn("flex items-start gap-3 rounded-xl border p-4", banner)} role={valid && (level === "HIGH" || level === "CRITICAL") ? "alert" : "status"}>
        <BannerIcon className="mt-0.5 size-5 shrink-0" aria-hidden />
        <div className="space-y-1">
          <p className="font-semibold">{d.headline}</p>
          {valid && topSignals.length > 0 && <ul className="list-disc space-y-0.5 pl-5 text-sm opacity-90">{topSignals.map((s) => <li key={s.code}>{s.title}</li>)}</ul>}
          {!valid && <p className="text-sm opacity-90">Presign cannot safely determine what this request will do.</p>}
        </div>
      </div>

      <Section title="What you are signing">
        <p className="text-sm font-medium text-zinc-100">{review.explanation.headline}</p>
        <Lines items={review.explanation.whatHappens} empty="Nothing could be decoded." />
        {review.message && review.message.text !== null && (
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-zinc-800 bg-black/40 p-3 font-mono text-xs text-zinc-200" aria-label="Exact message text">{review.message.text}</pre>
        )}
      </Section>

      {req.type === "TRANSACTION" && valid && (
        <>
          <Section title="Assets affected"><Lines items={review.explanation.assetMovements} empty="No balance change for your wallet in the simulation (besides the network fee)." /></Section>
          <Section title="Authorities / permissions"><Lines items={review.findings.authorityChanges} empty="No authority change or token approval." /></Section>
          <Section title="Programs"><Lines items={review.explanation.programs} empty="—" /></Section>
          {review.multisigSummary && <MultisigBlock m={review.multisigSummary} simulation={sim?.status ?? null} risk={d.risk} />}
          {!review.multisigSummary && review.findings.multisig.length > 0 && <Section title="Multisig"><Lines items={review.findings.multisig} empty="" /></Section>}
        </>
      )}

      {req.type === "TRANSACTION" && (
        <Section title="Simulation">
          <p className={cn("flex items-center gap-2 text-sm", sim ? SIM_STYLE[sim.status].tone : "text-zinc-400")}><SimIcon className="size-4" aria-hidden /> {sim ? SIM_STYLE[sim.status].label : "Not run"}</p>
          {sim && sim.unexpectedEffects.length > 0 && <ul className="space-y-1 text-sm text-amber-100">{sim.unexpectedEffects.map((x) => <li key={x} className="flex gap-2"><TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {x}</li>)}</ul>}
          {sim && sim.errors.length > 0 && <Lines items={sim.errors} empty="" />}
        </Section>
      )}

      {review.txFacts && (
        <Section title="Transaction details">
          <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
            <div><dt className="inline text-zinc-500">Version </dt><dd className="inline font-mono text-zinc-300">{review.txFacts.version}</dd></div>
            <div><dt className="inline text-zinc-500">Instructions </dt><dd className="inline font-mono text-zinc-300">{review.txFacts.instructionCount}</dd></div>
            <div><dt className="inline text-zinc-500">Fee payer </dt><dd className="inline"><Address value={review.txFacts.feePayer} n={6} /></dd></div>
            <div><dt className="inline text-zinc-500">Recent blockhash / nonce </dt><dd className="inline font-mono text-zinc-300">{review.txFacts.recentBlockhash.slice(0, 8)}…{review.txFacts.usesDurableNonce ? " (durable nonce — never expires)" : ""}</dd></div>
            <div className="sm:col-span-2"><dt className="inline text-zinc-500">Signers </dt><dd className="inline font-mono text-zinc-300">{review.txFacts.signers.map((x) => `${x.slice(0, 4)}…${x.slice(-4)}`).join(", ")}</dd></div>
            <div className="sm:col-span-2"><dt className="inline text-zinc-500">Writable accounts ({review.txFacts.writableAccounts.length}) </dt><dd className="inline font-mono text-zinc-300">{review.txFacts.writableAccounts.slice(0, 8).map((x) => (x.length > 20 ? `${x.slice(0, 4)}…${x.slice(-4)}` : x)).join(", ")}{review.txFacts.writableAccounts.length > 8 ? ", …" : ""}</dd></div>
          </dl>
        </Section>
      )}

      {d.technicalIssues.length > 0 && (
        <Section title="Why Presign cannot verify this">
          <Lines items={d.technicalIssues.map((i) => i.message)} empty="" />
        </Section>
      )}

      <Section title="Evidence">
        {review.findings.signals.length === 0 ? (
          <p className="text-sm text-zinc-500">{valid ? "No risk signal was raised by the completed checks. This is not a guarantee of safety." : "No evidence could be produced."}</p>
        ) : (
          <ul className="space-y-1.5">{review.findings.signals.map((s) => <li key={s.code} className="flex flex-wrap items-baseline gap-2 text-sm"><RiskBadge level={s.severity as Review["decision"]["risk"]["level"]} /> <span className="text-zinc-200">{s.title}</span> <span className="text-xs text-zinc-500">{s.description}</span></li>)}</ul>
        )}
        {review.risk && review.risk.signals.length > 0 && (
          <details className="rounded-lg border border-zinc-800 p-3">
            <summary className="cursor-pointer text-sm text-zinc-300">Evidence behind each signal (sources, observed values, rules)</summary>
            <div className="mt-3"><RiskDetails risk={review.risk} /></div>
          </details>
        )}
        {review.transaction !== null && (
          <details className="rounded-lg border border-zinc-800 p-3">
            <summary className="cursor-pointer text-sm text-zinc-300">Full decoded evidence (instructions, accounts, simulation)</summary>
            <div className="mt-3"><TransactionReport analysis={review.transaction as TransactionAnalysis} /></div>
          </details>
        )}
      </Section>

      <Section title="Presign recommendation">
        <p className={cn("text-base font-bold uppercase tracking-wide", rec.tone)}>{rec.label}</p>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-sm">
          <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-violet-300"><Sparkles className="size-3.5" aria-hidden /> AI explanation <span className="font-normal normal-case text-zinc-500">(explains the findings; cannot change them){ai?.available && ai.provider === "gemini" ? " · backup model (Gemini)" : ""}</span></p>
          {ai === null ? <p className="flex items-center gap-2 text-zinc-500"><Loader2 className="size-3.5 animate-spin" aria-hidden /> Preparing explanation…</p>
          : ai.available && ai.text ? <p className="whitespace-pre-wrap text-zinc-300">{ai.text}</p>
          : <p className="text-zinc-500">AI explanation unavailable{ai.unavailableReason === "NOT_CONFIGURED" ? " (not configured)" : ""}. The deterministic findings above are complete and are what Presign&apos;s verdict is based on.</p>}
        </div>
      </Section>

      {walletChanged && <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100" role="alert">The connected wallet changed after this review. Analyze the request again with the wallet that must sign.</p>}

      {/* ---- Decision ---- */}
      <Section title="Your decision">
        {state === "USER_APPROVAL" && (
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button ref={needsOverride || !valid ? cancelRef : undefined} variant="outline" onClick={cancel} autoFocus={needsOverride || !valid}><X /> Cancel</Button>
            {valid && d.primaryActionLabel && (
              <Button
                variant={needsOverride ? "destructive" : "default"}
                disabled={walletChanged || !connected || !!external?.blockedReason}
                onClick={() => (needsOverride ? go("OPTIONAL_RISK_OVERRIDE") : void decide(false))}
              >
                <PenLine /> {d.primaryActionLabel}
              </Button>
            )}
          </div>
        )}
        {state === "USER_APPROVAL" && !valid && <p className="text-xs text-zinc-500">Presign does not offer &quot;sign anyway&quot; for a request it cannot verify.</p>}
        {state === "USER_APPROVAL" && valid && external?.blockedReason && <p className="text-xs text-amber-200">{external.blockedReason}</p>}
        {state === "USER_APPROVAL" && valid && !connected && !external && <p className="text-xs text-amber-200">Connect the wallet {req.walletAddress.slice(0, 4)}… to sign.</p>}

        {state === "OPTIONAL_RISK_OVERRIDE" && (
          <div className="space-y-3 rounded-xl border border-red-500/50 bg-red-500/10 p-4" role="alertdialog" aria-labelledby="override-title" aria-describedby="override-desc">
            <p id="override-title" className="font-semibold text-red-100">You are choosing to continue despite Presign&apos;s warning.</p>
            <div id="override-desc" className="space-y-2 text-sm text-red-50/90">
              <p>Presign detected:</p>
              <ul className="list-disc pl-5">{(topSignals.length ? topSignals : review.findings.signals.slice(0, 6)).map((s) => <li key={s.code}>{s.title}</li>)}</ul>
              <p>Presign recommends cancelling. Your wallet will still show its own confirmation.</p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <Button ref={cancelRef} variant="outline" onClick={cancel}><X /> Cancel</Button>
              <Button variant="destructive" onClick={() => void decide(true)}>I understand — continue</Button>
            </div>
          </div>
        )}

        {state === "WALLET_SIGNING" && <p className="flex items-center gap-2 text-sm text-zinc-300" role="status"><Loader2 className="size-4 animate-spin" aria-hidden /> {external ? "Approved by Presign for exactly these bytes. Confirm or reject in your wallet's window (opened by the application's tab)…" : "Checking the exact payload with Presign, then waiting for your wallet…"}</p>}

        {result?.kind === "CANCELLED" && <p className="text-sm text-zinc-400" role="status">Cancelled. Nothing was signed and the wallet was not asked.</p>}

        {state === "SIGN_REJECTED" && result?.kind === "SIGN_REJECTED" && (
          <div className="space-y-2 text-sm"><p className="text-amber-100">{result.reason} Nothing was signed.</p><Button variant="outline" onClick={() => setState("USER_APPROVAL")}>Back to the review</Button></div>
        )}

        {result?.kind === "BLOCKED" && (
          <div className="rounded-lg border border-red-500/50 bg-red-500/10 p-3 text-sm text-red-100" role="alert">
            <p className="mb-1 flex items-center gap-2 font-bold"><AlertOctagon className="size-4" aria-hidden /> SECURITY BLOCK</p>
            {result.reason}
          </div>
        )}

        {result?.kind === "SIGNED_IN_WALLET" && (
          <div className="space-y-1 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm" role="status">
            <p className="flex items-center gap-2 text-emerald-300"><BadgeCheck className="size-4" aria-hidden /> {result.detail}</p>
            <p className="text-xs text-zinc-400">
              Your wallet was asked only after your decision, with bytes that hash to what Presign approved
              {external?.walletSends ? " (this request is broadcast by your wallet itself, so only what was sent to the wallet could be checked)" : ""}. Presign then compared what the wallet returned with the reviewed bytes — a best-effort check, since the wallet&apos;s own page code handles its result first. You can close this window.
            </p>
          </div>
        )}

        {result?.kind === "SIGNED_MESSAGE" && (
          <div className="space-y-1 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm" role="status">
            <p className="flex items-center gap-2 text-emerald-300"><BadgeCheck className="size-4" aria-hidden /> Signature received and verified for exactly the reviewed message.</p>
            <p className="break-all font-mono text-xs text-zinc-400">{bs58.encode(result.signature)}</p>
          </div>
        )}

        {result?.kind === "SIGNED_TRANSACTION" && (
          <div className="space-y-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm" role="status">
            <p className="flex items-center gap-2 text-emerald-300"><BadgeCheck className="size-4" aria-hidden /> Signature received. Verified: same bytes as reviewed, valid signature. Nothing has been sent yet.</p>
            {submitted ? (
              <p className="text-zinc-300">Transaction {submitted.status}{submitted.error ? `: ${submitted.error}` : ""} · <span className="break-all font-mono text-xs">{submitted.signature}</span></p>
            ) : allowSubmit ? (
              <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                <Button variant="outline" onClick={() => onClose?.()}>Done — don&apos;t submit</Button>
                <Button onClick={() => void submit(result.signed, result.approval)} disabled={state === "OPTIONAL_SUBMISSION"}>
                  {state === "OPTIONAL_SUBMISSION" ? <Loader2 className="animate-spin" /> : <Send />} Submit transaction
                </Button>
              </div>
            ) : (
              <p className="text-xs text-zinc-500">This demo does not submit this request. Signing and broadcasting are separate steps.</p>
            )}
            {submitError && <p className="text-sm text-orange-200">{submitError}</p>}
          </div>
        )}
      </Section>
    </article>
  );
}
