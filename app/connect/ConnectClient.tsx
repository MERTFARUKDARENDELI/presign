"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import bs58 from "bs58";
import { ArrowRight, BadgeCheck, KeyRound, Loader2, ShieldCheck, TriangleAlert, Wallet, X } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { CheckList, DomainStatusChip } from "@/components/presign/CheckList";
import { Address } from "@/components/security/badges";
import { WalletPicker } from "@/components/wallet/WalletPicker";
import { WALLET_ERROR_EVENT } from "@/components/providers/WalletProviders";
import { api, ApiClientError } from "@/lib/client/api";
import { recordEvent, safeInternalPath, storeConnection } from "@/lib/presign/client";
import { canTransition, onWalletEvent, type FlowState, type WalletEvent } from "@/lib/presign/flow";
import type { ConnectionContext, OwnershipChallenge, VerifiedWallet } from "@/lib/presign/types";
import { cn } from "@/lib/utils";

const STEPS = [
  { title: "Check connection", states: ["PRE_CONNECT_CHECK", "PRE_CONNECT_VERIFIED"] },
  { title: "Connect wallet", states: ["WALLET_CONNECTING", "WALLET_CONNECTED"] },
  { title: "Verify ownership", states: ["OWNERSHIP_VERIFICATION", "WALLET_VERIFIED"] },
];

function reasonOf(e: unknown): string | null {
  return e instanceof ApiClientError && typeof e.details?.reason === "string" ? e.details.reason : null;
}

/**
 * PRESIGN SECURE CONNECT: connection context → wallet → ownership. The wallet
 * picker only appears after the context checks, and the ownership signature
 * is a plain message that authorizes nothing.
 */
export default function ConnectClient() {
  const params = useSearchParams();
  const router = useRouter();
  const target = params.get("target") ?? undefined;
  const name = params.get("name") ?? undefined;
  const returnUrl = params.get("return") ?? undefined;
  const next = safeInternalPath(params.get("next"));
  const { publicKey, connected, signMessage, wallet, disconnect } = useWallet();
  const address = publicKey?.toBase58() ?? null;

  const [state, setState] = useState<FlowState>("PRE_CONNECT_CHECK");
  const [runId, setRunId] = useState(1);
  const [ctx, setCtx] = useState<ConnectionContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<OwnershipChallenge | null>(null);
  const [verified, setVerified] = useState<VerifiedWallet | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [seen, setSeen] = useState<{ connected: boolean; address: string | null }>({ connected, address });

  const go = (to: FlowState) => setState((s) => (canTransition(s, to) ? to : s));

  // 1. Pre-connect checks — before any wallet is opened.
  useEffect(() => {
    let cancelled = false;
    api<ConnectionContext>("/api/presign/connect", { json: { target, name, returnUrl } })
      .then((c) => {
        if (cancelled) return;
        setCtx(c);
        storeConnection(c);
        recordEvent("CONNECT_CHECK", c.request.targetHostname ? `Checked connection context for ${c.request.targetHostname}` : "Checked connection context (no external application supplied)");
        setState((s) => (canTransition(s, "PRE_CONNECT_VERIFIED") ? "PRE_CONNECT_VERIFIED" : s));
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof ApiClientError ? e.message : "The connection context could not be checked.");
        const to: FlowState = reasonOf(e) === "REQUEST_EXPIRED" ? "REQUEST_EXPIRED" : e instanceof ApiClientError && e.code === "NETWORK_ERROR" ? "RPC_ERROR" : "SIGN_REQUEST_INVALID";
        setState((s) => (canTransition(s, to) ? to : s));
      });
    return () => {
      cancelled = true;
    };
  }, [target, name, returnUrl, runId]);

  // 2. External wallet events (render-time adjustment): connect, disconnect, account switch.
  if (seen.connected !== connected || seen.address !== address) {
    setSeen({ connected, address });
    const ev: WalletEvent | null = !connected || !address
      ? (seen.connected ? { kind: "DISCONNECTED" } : null)
      : !seen.connected || !seen.address
        ? { kind: "CONNECTED", address }
        : seen.address !== address ? { kind: "ACCOUNT_CHANGED", address } : null;
    if (ev) {
      const nextState = onWalletEvent(state, ev);
      if (nextState !== state) {
        setState(nextState);
        if (nextState === "WALLET_CONNECTED" || nextState === "WALLET_CONNECTING") setVerified(null);
      }
      if (ev.kind === "CONNECTED") setWalletError(null);
    }
  }
  // A wallet that was already connected when the picker opened.
  if (state === "WALLET_CONNECTING" && connected && address) setState("WALLET_CONNECTED");

  // The wallet refused or failed to connect: stay on the picker and say so.
  useEffect(() => {
    const onError = (e: Event) => setWalletError((e as CustomEvent<string>).detail);
    window.addEventListener(WALLET_ERROR_EVENT, onError);
    return () => window.removeEventListener(WALLET_ERROR_EVENT, onError);
  }, []);

  // 4. Verified: continue inside Presign (external returns stay a user click).
  useEffect(() => {
    if (state !== "WALLET_VERIFIED" || ctx?.request.returnUrl) return;
    const t = setTimeout(() => router.push(next), 1_200);
    return () => clearTimeout(t);
  }, [state, ctx, next, router]);

  function restart() {
    setError(null);
    setCtx(null);
    setState((s) => (canTransition(s, "PRE_CONNECT_CHECK") ? "PRE_CONNECT_CHECK" : s));
    setRunId((r) => r + 1);
  }

  function cancel() {
    recordEvent("USER_CANCELLED", "Cancelled the secure connect flow");
    go("CONNECT_CANCELLED");
  }

  // 3. Ownership verification.
  async function verifyOwnership() {
    if (!address) return;
    setError(null);
    go("OWNERSHIP_VERIFICATION");
    try {
      const ch = await api<OwnershipChallenge>("/api/presign/nonce", { json: { walletAddress: address } });
      setChallenge(ch);
      if (!signMessage) {
        setError("This wallet cannot sign messages, so ownership cannot be verified. You can still use read-only tools.");
        setState("TECHNICAL_VALIDATION_FAILED");
        return;
      }
      let sig: Uint8Array;
      try {
        sig = await signMessage(new TextEncoder().encode(ch.message));
      } catch {
        setError("You declined the verification in your wallet. Nothing was signed.");
        setState("SIGN_REJECTED");
        return;
      }
      const v = await api<VerifiedWallet>("/api/presign/connect/verify", { json: { walletAddress: address, message: ch.message, signature: bs58.encode(sig), nonceToken: ch.nonceToken } });
      setVerified(v);
      recordEvent("WALLET_VERIFIED", `Verified ownership of ${v.wallet}`);
      window.dispatchEvent(new Event("presign-session"));
      setState("WALLET_VERIFIED");
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Ownership could not be verified.");
      setState(reasonOf(e) === "NONCE_EXPIRED" ? "REQUEST_EXPIRED" : "TECHNICAL_VALIDATION_FAILED");
    }
  }

  const stepIndex = STEPS.findIndex((s) => s.states.includes(state));
  const req = ctx?.request;
  const domain = ctx?.domain ?? null;
  const risky = domain?.status === "HIGH" || domain?.status === "CRITICAL";

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-violet-300">Presign Secure Connect</p>
        <h2 className="text-2xl font-bold">Before connecting your wallet, Presign checks the connection context.</h2>
        <p className="text-sm text-zinc-400">Only your public address is used. Presign never asks for your seed phrase or private key, and it never signs for you.</p>
      </div>

      <ol className="grid grid-cols-3 gap-2 text-xs" aria-label="Progress">
        {STEPS.map((s, i) => (
          <li key={s.title} aria-current={i === stepIndex ? "step" : undefined} className={cn("rounded-lg border px-3 py-2", i === stepIndex ? "border-violet-400/60 bg-violet-500/10 text-violet-100" : i < stepIndex ? "border-emerald-500/30 text-emerald-300" : "border-zinc-800 text-zinc-500")}>
            <span className="font-mono">{i + 1}.</span> {s.title}
          </li>
        ))}
      </ol>

      {state === "PRE_CONNECT_CHECK" && (
        <div className="flex items-center gap-2 rounded-xl border border-zinc-800 p-5 text-sm text-zinc-400"><Loader2 className="size-4 animate-spin" aria-hidden /> Checking the connection context…</div>
      )}

      {ctx && (state === "PRE_CONNECT_VERIFIED" || state === "WALLET_CONNECTING" || state === "WALLET_CONNECTED" || state === "OWNERSHIP_VERIFICATION" || state === "WALLET_VERIFIED") && (
        <section className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-5" aria-labelledby="target-app">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <h3 id="target-app" className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Target application</h3>
              <p className="mt-1 text-sm text-zinc-100">{req?.targetName ? <>{req.targetName} <span className="text-xs text-zinc-500">(name as supplied by the request)</span></> : req?.targetOrigin ? "Unnamed application" : "Not provided"}</p>
            </div>
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Domain</h3>
              <p className="mt-1 flex flex-wrap items-center gap-2 font-mono text-sm text-zinc-100">{domain ? <>{domain.domain} <DomainStatusChip status={domain.status} /></> : <span className="font-sans text-zinc-400">Unknown / not provided</span>}</p>
            </div>
          </div>
          {!req?.targetOrigin && <p className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs text-zinc-400">Presign cannot verify a target application because no external dApp context was supplied. This is reported as unknown — not as safe.</p>}
          {domain && domain.reasons.length > 0 && <ul className="list-disc space-y-1 pl-5 text-xs text-zinc-400">{domain.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
          <CheckList checks={ctx.checks} />
          {risky && <p className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"><TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> Presign recommends not connecting to this application. You can still continue — the decision is yours.</p>}
        </section>
      )}

      {state === "PRE_CONNECT_VERIFIED" && (
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={cancel}><X /> Cancel</Button>
          {/* An already connected wallet skips straight to ownership (render-time check below the picker). */}
          <Button onClick={() => go("WALLET_CONNECTING")} autoFocus>
            <Wallet /> {risky ? "Continue to wallet anyway" : "Continue to wallet"} <ArrowRight />
          </Button>
        </div>
      )}

      {state === "WALLET_CONNECTING" && (
        <section className="space-y-3 rounded-xl border border-zinc-800 p-5">
          <h3 className="font-semibold">Choose your wallet</h3>
          <WalletPicker onChoose={() => setWalletError(null)} />
          {walletError && <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100" role="alert">The wallet did not connect: {walletError}. Nothing was shared. You can try again or choose another wallet.</p>}
          <div className="flex justify-end"><Button variant="outline" onClick={cancel}><X /> Cancel</Button></div>
        </section>
      )}

      {(state === "WALLET_CONNECTED" || state === "OWNERSHIP_VERIFICATION") && address && (
        <section className="space-y-3 rounded-xl border border-zinc-800 p-5">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <BadgeCheck className="size-4 text-emerald-300" aria-hidden /> Wallet connected{wallet ? ` (${wallet.adapter.name})` : ""}: <Address value={address} n={6} className="text-zinc-100" />
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-sm text-zinc-300">
            <p className="flex items-center gap-2 font-medium"><KeyRound className="size-4 text-violet-300" aria-hidden /> Verify wallet ownership</p>
            <p className="mt-1 text-xs text-zinc-400">Your wallet will ask you to sign a short text message with a one-time code. It proves you control this address. It is not a transaction and does not authorize any transfer.</p>
            {challenge && state === "OWNERSHIP_VERIFICATION" && <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-md border border-zinc-800 bg-black/40 p-2 font-mono text-[11px] text-zinc-300">{challenge.message}</pre>}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={cancel} disabled={state === "OWNERSHIP_VERIFICATION"}><X /> Cancel</Button>
            <Button onClick={() => void verifyOwnership()} disabled={state === "OWNERSHIP_VERIFICATION"}>
              {state === "OWNERSHIP_VERIFICATION" ? <><Loader2 className="animate-spin" /> Waiting for your wallet…</> : <><ShieldCheck /> Verify ownership</>}
            </Button>
          </div>
        </section>
      )}

      {state === "WALLET_VERIFIED" && verified && (
        <section className="space-y-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-5" role="status">
          <p className="flex items-center gap-2 font-semibold text-emerald-300"><BadgeCheck className="size-5" aria-hidden /> Wallet ownership verified</p>
          <p className="text-sm text-zinc-300"><Address value={verified.wallet} n={6} /> · valid for this browser session until {new Date(verified.expiresAt).toLocaleString()}.</p>
          {req?.returnUrl ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              <a href={req.returnUrl} rel="noopener noreferrer" className={buttonVariants()}>Return to {req.targetHostname} <ArrowRight /></a>
              <Link href={next} className={buttonVariants({ variant: "outline" })}>Open wallet dashboard</Link>
            </div>
          ) : (
            <p className="flex items-center gap-2 text-sm text-zinc-400"><Loader2 className="size-4 animate-spin" aria-hidden /> Opening {next === "/dashboard" ? "your wallet dashboard" : next}…</p>
          )}
        </section>
      )}

      {(state === "CONNECT_CANCELLED" || state === "REQUEST_EXPIRED" || state === "RPC_ERROR") && (
        <section className="space-y-3 rounded-xl border border-zinc-800 p-5">
          <p className="font-semibold">{state === "CONNECT_CANCELLED" ? "Connection cancelled." : state === "REQUEST_EXPIRED" ? "This request expired." : "Presign could not be reached."}</p>
          <p className="text-sm text-zinc-400">{state === "CONNECT_CANCELLED" ? "Nothing was shared and nothing was signed." : error}</p>
          <div className="flex gap-2">
            <Button onClick={restart}>Start again</Button>
            {connected && <Button variant="outline" onClick={() => void disconnect()}>Disconnect wallet</Button>}
          </div>
        </section>
      )}

      {state === "SIGN_REQUEST_INVALID" && (
        <section className="space-y-3 rounded-xl border border-red-500/40 bg-red-500/10 p-5" role="alert">
          <p className="font-semibold text-red-200">This connection request is not valid.</p>
          <p className="text-sm text-red-100/90">{error}</p>
          <p className="text-xs text-zinc-400">Presign does not follow unverified redirects or connect on behalf of an application it cannot validate.</p>
          <Link href="/connect" className={buttonVariants({ variant: "outline" })}>Connect without an external application</Link>
        </section>
      )}

      {(state === "SIGN_REJECTED" || state === "TECHNICAL_VALIDATION_FAILED") && (
        <section className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-5" role="alert">
          <p className="font-semibold text-amber-100">{state === "SIGN_REJECTED" ? "Verification declined" : "Ownership could not be verified"}</p>
          <p className="text-sm text-amber-50/90">{error}</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            {connected && <Button onClick={() => { setState("WALLET_CONNECTED"); setError(null); }}>Try again</Button>}
            <Link href={next} className={buttonVariants({ variant: "outline" })}>Continue without verifying (read-only)</Link>
          </div>
        </section>
      )}
    </div>
  );
}
