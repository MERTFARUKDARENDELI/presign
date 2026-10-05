"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { BadgeCheck, CheckCircle2, Circle, Loader2, ShieldCheck, Wallet } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SigningReview } from "@/components/presign/SigningReview";
import { CLIENT_CLUSTER } from "@/components/providers/WalletProviders";
import { api, ApiClientError } from "@/lib/client/api";
import { fetchSession, loadConnection, recordEvent, storeConnection } from "@/lib/presign/client";
import { DEMO_SCENARIO_INFO, DEMO_SCENARIOS, type DemoScenario } from "@/lib/presign/demo-scenarios";
import { canTransition, type FlowState } from "@/lib/presign/flow";
import { WebAppSigningInterceptor } from "@/lib/presign/interceptor";
import type { ConnectionContext, ExpectedEffects, PresignSession, SigningReview as Review } from "@/lib/presign/types";
import { cn } from "@/lib/utils";

interface DemoRequest {
  scenario: DemoScenario;
  title: string;
  description: string;
  type: "MESSAGE" | "TRANSACTION";
  payload: string;
  payloadEncoding: "base58" | "base64" | "utf8";
  expectedEffects?: ExpectedEffects;
}

const PIPELINE: Array<{ label: string; states: FlowState[] }> = [
  { label: "Request received", states: ["REQUEST_RECEIVED"] },
  { label: "Decode", states: ["DECODING"] },
  { label: "Simulate", states: ["SIMULATING"] },
  { label: "Deterministic risk engine", states: ["RISK_ANALYSIS"] },
  { label: "Security review", states: ["SECURITY_REVIEW"] },
];

const DEMO_APP = "Presign Demo dApp";

/** The demo dApp's own connection context: this site, validated by Presign like any other target. */
async function demoConnectionToken(): Promise<string | null> {
  const stored = loadConnection();
  if (stored && stored.request.targetOrigin === window.location.origin) return stored.token;
  try {
    const c = await api<ConnectionContext>("/api/presign/connect", { json: { target: window.location.origin, name: DEMO_APP } });
    storeConnection(c);
    return c.connectionToken;
  } catch {
    return null;
  }
}

/**
 * Controlled demo dApp. Each scenario asks the server for a REAL unsigned
 * request for the connected wallet and sends it through the same
 * /api/presign/signing/analyze pipeline any integration uses.
 */
export default function DemoSignClient() {
  const { publicKey } = useWallet();
  const router = useRouter();
  const address = publicKey?.toBase58() ?? null;
  const [session, setSession] = useState<PresignSession | null>(null);
  const [state, setState] = useState<FlowState>("WAITING_FOR_SIGN_REQUEST");
  const [active, setActive] = useState<{ request: DemoRequest; review: Review | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const go = (to: FlowState) => setState((s) => (canTransition(s, to) ? to : s));

  useEffect(() => {
    let cancelled = false;
    const load = () => fetchSession().then((s) => !cancelled && setSession(s)).catch(() => !cancelled && setSession({ sessionActive: false, verified: null }));
    void load();
    window.addEventListener("presign-session", load);
    return () => {
      cancelled = true;
      window.removeEventListener("presign-session", load);
    };
  }, [address]);

  const verified = Boolean(address && session?.verified?.wallet === address);

  async function run(scenario: DemoScenario) {
    if (!address) return;
    setError(null);
    setActive(null);
    setState("WAITING_FOR_SIGN_REQUEST");
    go("REQUEST_RECEIVED");
    try {
      const [request, connectionToken] = await Promise.all([api<DemoRequest>("/api/presign/demo/request", { json: { scenario, walletAddress: address } }), demoConnectionToken()]);
      setActive({ request, review: null });
      go("DECODING");
      if (request.type === "TRANSACTION") go("SIMULATING");
      // The demo dApp hands its request to Presign through the same interceptor boundary an extension or SDK would use.
      const interceptor = new WebAppSigningInterceptor({
        analyze: (body) => api<Review>("/api/presign/signing/analyze", { json: body }),
        present: (review) => setActive({ request, review }),
        decide: () => Promise.reject(new Error("The decision is taken in the review below.")),
        decision: { approve: () => Promise.reject(new Error("unused")), verifyMessageSignature: () => false },
      });
      const incoming = interceptor.receiveRequest({ type: request.type, payload: request.payload, payloadEncoding: request.payloadEncoding, walletAddress: address, application: DEMO_APP, origin: window.location.origin, ...(connectionToken ? { connectionToken } : {}), ...(request.expectedEffects ? { expectedEffects: request.expectedEffects } : {}) });
      const review = await interceptor.analyze(incoming);
      go("RISK_ANALYSIS");
      interceptor.presentSecurityReview(review);
      recordEvent("REQUEST_ANALYZED", `${request.title}: ${review.decision.technicalValidation === "VALID" ? review.decision.risk.level : "cannot be verified"}`);
      setState((s) => (canTransition(s, "SECURITY_REVIEW") ? "SECURITY_REVIEW" : s));
    } catch (e) {
      const code = e instanceof ApiClientError ? e.code : "";
      setError(e instanceof ApiClientError ? e.message : "The request could not be analyzed.");
      setState(code === "RPC_ERROR" || code === "NETWORK_ERROR" ? "RPC_ERROR" : "TECHNICAL_VALIDATION_FAILED");
    }
  }

  const pipelineIndex = PIPELINE.findIndex((p) => p.states.includes(state));

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-violet-300">Demo dApp · real signing requests</p>
        <h2 className="text-2xl font-bold">Before you sign, Presign shows you what it does.</h2>
        <p className="max-w-3xl text-sm text-zinc-400">
          Each button below makes this demo dApp ask your wallet to sign a real, unsigned request on {CLIENT_CLUSTER}. Presign analyzes the exact bytes with the same pipeline used everywhere else, then <strong className="text-zinc-200">you</strong> decide. Presign warns; the user decides — except when a request cannot be verified.
        </p>
        <p className="max-w-3xl text-xs text-zinc-500">
          Safety of the samples: risky transactions act on a brand-new, empty token account (never one holding funds), the &quot;delegate&quot; is an address nobody holds a key for, and only the safe memo can be submitted from this page. Simulation needs a little SOL in the wallet for fees and rent; nothing is spent unless you submit.
        </p>
      </div>

      {!address || !verified ? (
        <section className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
          <p className="flex items-center gap-2 font-semibold"><ShieldCheck className="size-5 text-violet-300" aria-hidden /> {address ? "Verify ownership of your wallet first" : "Connect your wallet through Presign first"}</p>
          <p className="text-sm text-zinc-400">The demo starts with Presign Secure Connect: connection checks → wallet → ownership signature (authorizes nothing).</p>
          <Button onClick={() => router.push(`/connect?target=${encodeURIComponent(window.location.origin)}&name=${encodeURIComponent(DEMO_APP)}&next=/demo/sign`)}>
            <Wallet /> {address ? "Verify ownership" : "Connect wallet"}
          </Button>
        </section>
      ) : (
        <p className="flex items-center gap-2 text-sm text-emerald-300"><BadgeCheck className="size-4" aria-hidden /> Wallet verified for this session.</p>
      )}

      <section className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" aria-label="Demo scenarios">
        {DEMO_SCENARIOS.map((s) => (
          <button
            key={s}
            type="button"
            disabled={!verified || state === "REQUEST_RECEIVED" || state === "DECODING" || state === "SIMULATING" || state === "RISK_ANALYSIS"}
            onClick={() => void run(s)}
            className={cn("rounded-xl border border-zinc-800 bg-zinc-900/50 p-3 text-left text-sm transition hover:border-violet-400/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 disabled:cursor-not-allowed disabled:opacity-50", active?.request.scenario === s && "border-violet-400/60")}
          >
            <span className="block font-semibold text-zinc-100">{DEMO_SCENARIO_INFO[s].label}</span>
            <span className="block text-xs text-zinc-500">{DEMO_SCENARIO_INFO[s].expectation}</span>
          </button>
        ))}
      </section>

      {state !== "WAITING_FOR_SIGN_REQUEST" && (
        <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Analysis pipeline">
          {PIPELINE.map((p, i) => {
            const done = pipelineIndex > i || state === "SECURITY_REVIEW";
            const current = pipelineIndex === i;
            return (
              <li key={p.label} className={cn("flex items-center gap-1", done ? "text-emerald-300" : current ? "text-violet-200" : "text-zinc-600")}>
                {done ? <CheckCircle2 className="size-3.5" aria-hidden /> : current ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Circle className="size-3.5" aria-hidden />} {p.label}
              </li>
            );
          })}
        </ol>
      )}

      {error && <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200" role="alert">{error}</div>}

      {active?.request && (
        <div className="space-y-2">
          <p className="text-sm text-zinc-400"><span className="font-semibold text-zinc-200">{active.request.title}.</span> {active.request.description}</p>
          {active.review && <SigningReview key={active.review.request.requestId} review={active.review} allowSubmit={active.request.scenario === "safe-transaction"} onClose={() => setActive(null)} />}
        </div>
      )}
    </div>
  );
}
