import { executeDecision, type DecisionDeps, type DecisionResult, type UserDecision } from "./controller";
import type { ExpectedEffects, PayloadEncoding, PresignSigningRequest, SigningRequestType, SigningReview } from "./types";

/**
 * Boundary for intercepting signing requests BEFORE they reach a wallet.
 *
 * A standalone website cannot observe signing requests other websites send
 * to a wallet — the wallet talks to the page that called it. Presign
 * therefore exposes its engine behind this boundary. Today it is implemented
 * by the Presign web app itself (/demo/sign and integrations that hand
 * Presign a request). Future implementations plug in here without changing
 * the security engine:
 *
 *   - a browser extension / injected provider that wraps `window.solana` or
 *     the Wallet Standard transaction- and message-signing features,
 *   - a wallet-provider wrapper or SDK a dApp ships (it forwards requests to
 *     Presign's HTTP API: /api/presign/signing/analyze → /approve),
 *   - a Wallet Standard wallet that delegates review to Presign.
 *
 * Every implementation must keep the same order: receive → analyze (server)
 * → present the review → user decision → approval bound to the exact payload
 * hash → forward exactly those bytes to the wallet.
 */

export interface IncomingSigningRequest {
  type: SigningRequestType;
  payload: string;
  payloadEncoding?: PayloadEncoding;
  walletAddress: string;
  /** Origin of the page that asked to sign — only meaningful when the interceptor itself observed it. */
  origin?: string;
  application?: string;
  connectionToken?: string;
  /** What the requesting application says the request does (compared with the simulation). */
  expectedEffects?: ExpectedEffects;
}

export interface SigningInterceptor {
  receiveRequest(input: IncomingSigningRequest): IncomingSigningRequest;
  analyze(request: IncomingSigningRequest): Promise<SigningReview>;
  presentSecurityReview(review: SigningReview): void;
  requestUserDecision(review: SigningReview): Promise<UserDecision>;
  forwardToWallet(review: SigningReview, decision: UserDecision): Promise<DecisionResult>;
}

const TYPES = new Set<SigningRequestType>(["MESSAGE", "TRANSACTION"]);
const ENCODINGS = new Set<PayloadEncoding>(["base58", "base64", "utf8"]);

/** Shape validation shared by every interceptor (the server validates again). */
export function normalizeIncomingRequest(input: IncomingSigningRequest): IncomingSigningRequest {
  if (!TYPES.has(input.type)) throw new Error("Unsupported signing request type.");
  if (input.payloadEncoding && !ENCODINGS.has(input.payloadEncoding)) throw new Error("Unsupported payload encoding.");
  if (typeof input.payload !== "string" || !input.payload) throw new Error("Empty signing payload.");
  if (typeof input.walletAddress !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input.walletAddress)) throw new Error("Invalid wallet address.");
  return { ...input, application: input.application?.slice(0, 64) };
}

/** What the review screen shows as "request": a short, honest label. */
export function requestLabel(request: Pick<PresignSigningRequest, "type">): string {
  return request.type === "TRANSACTION" ? "Sign a transaction" : "Sign a message";
}

/** Body of POST /api/presign/signing/analyze for an incoming request. */
export function analyzeBody(r: IncomingSigningRequest) {
  return {
    type: r.type,
    payload: r.payload,
    ...(r.payloadEncoding ? { payloadEncoding: r.payloadEncoding } : {}),
    walletAddress: r.walletAddress,
    ...(r.application ? { application: r.application } : {}),
    // An origin only counts as verified through a connection token; otherwise it is sent as a claim.
    ...(r.connectionToken ? { connectionToken: r.connectionToken } : r.origin ? { domain: r.origin } : {}),
    ...(r.expectedEffects ? { expectedEffects: r.expectedEffects } : {}),
  };
}

export interface WebAppInterceptorDeps {
  /** POST /api/presign/signing/analyze. */
  analyze: (body: ReturnType<typeof analyzeBody>) => Promise<SigningReview>;
  present: (review: SigningReview) => void;
  decide: (review: SigningReview) => Promise<UserDecision>;
  decision: DecisionDeps;
}

/**
 * The interceptor implemented by the Presign web app (demo dApp, integrations
 * that hand Presign their requests). An extension or SDK implements the same
 * interface with its own transport and wallet bridge.
 */
export class WebAppSigningInterceptor implements SigningInterceptor {
  constructor(private readonly deps: WebAppInterceptorDeps) {}

  receiveRequest(input: IncomingSigningRequest): IncomingSigningRequest {
    return normalizeIncomingRequest(input);
  }

  analyze(request: IncomingSigningRequest): Promise<SigningReview> {
    return this.deps.analyze(analyzeBody(request));
  }

  presentSecurityReview(review: SigningReview): void {
    this.deps.present(review);
  }

  requestUserDecision(review: SigningReview): Promise<UserDecision> {
    return this.deps.decide(review);
  }

  forwardToWallet(review: SigningReview, decision: UserDecision): Promise<DecisionResult> {
    return executeDecision(review, decision, this.deps.decision);
  }

  /** The whole order in one call: receive → analyze → present → user decision → (approval) → wallet. */
  async handle(input: IncomingSigningRequest): Promise<{ review: SigningReview; result: DecisionResult }> {
    const request = this.receiveRequest(input);
    const review = await this.analyze(request);
    this.presentSecurityReview(review);
    const decision = await this.requestUserDecision(review);
    return { review, result: await this.forwardToWallet(review, decision) };
  }
}
