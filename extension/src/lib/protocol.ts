/**
 * Messages between the page hook, the extension and Presign's review page.
 * Pure data + validation, shared by the extension and the Presign web app
 * (`/extension/review`), so both sides agree on one shape.
 *
 *   page hook (MAIN world) ──port──▶ content script ──runtime──▶ background
 *   background ──opens──▶ Presign /extension/review?rid=…&ext=…
 *   review page ──externally_connectable──▶ background ──▶ content ──port──▶ page hook
 *
 * The page hook only ever receives "approved" or "cancelled": it signs the
 * bytes it captured itself, never bytes handed back to it.
 */

export type ReviewMethod = "signTransaction" | "signAndSendTransaction" | "signAllTransactions" | "signAndSendAllTransactions" | "signMessage" | "signOffchainMessage" | "signIn";

export const REVIEW_METHOD_LABEL: Record<ReviewMethod, string> = {
  signTransaction: "Sign a transaction",
  signAllTransactions: "Sign several transactions",
  signAndSendTransaction: "Sign and send a transaction",
  signAndSendAllTransactions: "Sign and send several transactions",
  signMessage: "Sign a message",
  signOffchainMessage: "Sign an off-chain message",
  signIn: "Sign in with Solana",
};

export interface ReviewRequest {
  /** UNREADABLE: Presign could not obtain the exact bytes; only Cancel is offered. */
  type: "TRANSACTION" | "MESSAGE" | "UNREADABLE";
  /** base64 of the serialized transaction (signature slots included) or of the message bytes. */
  payload: string | null;
  walletAddress: string | null;
  /** Wallet Standard chain, e.g. "solana:mainnet" / "solana:devnet"; null when the API does not say. */
  chain: string | null;
  method: ReviewMethod;
  walletName: string | null;
  /** Position in a batch (signAllTransactions / several inputs); each is reviewed separately. */
  index: number;
  total: number;
  /** The sign-in text was rebuilt from the request fields (SIWS standard). */
  reconstructed?: boolean;
  /**
   * Sign-in whose account was chosen in the wallet: the wallet has already signed
   * this exact text, and the site receives the signature only if the user approves.
   */
  signedFirst?: boolean;
  /** Why the request is UNREADABLE. */
  reason?: string;
}

/**
 * An approval from a review carries the payload hash Presign's server confirmed: the page hook sends the
 * wallet only bytes with that hash. `pass` marks the extension's own switches (protection off, or off for
 * this site), where nothing was reviewed and there is nothing to compare.
 */
export type Decision = { approved: true; payloadHash?: string; pass?: true } | { approved: false; reason: string };

/** "verifying": approved on the review page, being confirmed with the Presign server before the wallet is asked. */
export type ReviewState = "pending" | "verifying" | "forwarded" | "signed" | "rejected" | "blocked" | "cancelled" | "expired";

/** What the review page receives for a request id. `origin` is observed by the extension (the browser's sender origin), not claimed by the page. */
export interface ReviewTicket {
  rid: string;
  origin: string;
  request: ReviewRequest;
  state: ReviewState;
  detail: string | null;
  createdAt: number;
}

export type ExternalMessage =
  | { kind: "presign:get"; rid: string }
  | { kind: "presign:status"; rid: string }
  | { kind: "presign:approve"; rid: string; payload: string; payloadHash: string; approvalToken: string; riskLevel: string; choice: string }
  | { kind: "presign:cancel"; rid: string; reason?: string; riskLevel?: string }
  | { kind: "presign:close"; rid: string };

export const REVIEW_TTL_MS = 15 * 60_000;

declare const __PRESIGN_DEV__: boolean | undefined;

/**
 * Development build (npm run build:extension:dev, which sets __PRESIGN_DEV__):
 * also works with a Presign on localhost:3000. A production build never does —
 * any other local project could be listening there.
 */
export const DEV_BUILD = typeof __PRESIGN_DEV__ !== "undefined" && __PRESIGN_DEV__ === true;

/** Presign instances (must match `externally_connectable`: the build adds localhost only with --dev). */
export const PRESIGN_ORIGINS = {
  mainnet: "https://presign-app.vercel.app",
  devnet: "https://presign-devnet.vercel.app",
  local: "http://localhost:3000",
} as const;

export function allowedPresignOrigins(dev: boolean = DEV_BUILD): readonly string[] {
  return dev ? Object.values(PRESIGN_ORIGINS) : [PRESIGN_ORIGINS.mainnet, PRESIGN_ORIGINS.devnet];
}

export type Instance = "production" | "local";

/** Which Presign instance reviews a request: by its chain, so a devnet request is simulated on devnet. "local" counts only in a development build. */
export function presignBaseFor(chain: string | null, instance: Instance, dev: boolean = DEV_BUILD): string {
  if (instance === "local" && dev) return PRESIGN_ORIGINS.local;
  return chain === "solana:devnet" ? PRESIGN_ORIGINS.devnet : PRESIGN_ORIGINS.mainnet;
}

const METHODS = new Set<ReviewMethod>(Object.keys(REVIEW_METHOD_LABEL) as ReviewMethod[]);
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** Same bound as the analysis API (MAX_PAYLOAD_CHARS). */
export const MAX_PAYLOAD_CHARS = 8_000;

/** Validates a request coming from a web page (untrusted). Returns a clean copy or null. */
export function validateReviewRequest(raw: unknown): ReviewRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.type !== "TRANSACTION" && r.type !== "MESSAGE" && r.type !== "UNREADABLE") return null;
  if (typeof r.method !== "string" || !METHODS.has(r.method as ReviewMethod)) return null;
  const index = Number(r.index);
  const total = Number(r.total);
  if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || total > 50 || index < 1 || index > total) return null;
  const payload = typeof r.payload === "string" ? r.payload : null;
  if (r.type !== "UNREADABLE" && (!payload || payload.length > MAX_PAYLOAD_CHARS || !BASE64.test(payload) || payload.length % 4 !== 0)) return null;
  const walletAddress = typeof r.walletAddress === "string" && ADDRESS.test(r.walletAddress) ? r.walletAddress : null;
  const chain = typeof r.chain === "string" && /^solana:[a-z]{1,20}$/.test(r.chain) ? r.chain : null;
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max) : null);
  return {
    type: r.type,
    payload: r.type === "UNREADABLE" ? null : payload,
    walletAddress,
    chain,
    method: r.method as ReviewMethod,
    walletName: text(r.walletName, 40),
    index,
    total,
    ...(r.reconstructed === true ? { reconstructed: true } : {}),
    ...(r.signedFirst === true && r.method === "signIn" ? { signedFirst: true } : {}),
    ...(r.type === "UNREADABLE" ? { reason: text(r.reason, 200) ?? "Presign could not read this request." } : {}),
  };
}

const MAX_REVIEW_BYTES = (MAX_PAYLOAD_CHARS / 4) * 3;
const MAX_BATCH = 50;

/** Why a page's request cannot be reviewed as sent, in words for the review page. */
function unreviewableReason(r: Record<string, unknown>): string {
  const total = Number(r.total);
  if (Number.isInteger(total) && total > MAX_BATCH) return `The site asked for ${total} signatures at once; Presign reviews at most ${MAX_BATCH} in one request.`;
  if (typeof r.payload === "string" && r.payload.length > MAX_PAYLOAD_CHARS) return `This request is larger than Presign can review (${MAX_REVIEW_BYTES.toLocaleString("en-US")} bytes at most).`;
  return "The request is malformed, so Presign cannot read it.";
}

/**
 * What the extension reviews for a request from a page. A readable request is
 * reviewed as sent. One that cannot be reviewed as sent (too large, too many
 * signatures, malformed) is still reviewed — as UNREADABLE, where Cancel is
 * the only choice — so a site cannot turn "cannot review" into "continue
 * without a review". Null only when not even the method is known.
 */
export function reviewableRequest(raw: unknown): ReviewRequest | null {
  const valid = validateReviewRequest(raw);
  if (valid) return valid;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.method !== "string" || !METHODS.has(r.method as ReviewMethod)) return null;
  const total = Number.isInteger(Number(r.total)) ? Math.min(Math.max(Number(r.total), 1), 10_000) : 1;
  const index = Number.isInteger(Number(r.index)) ? Math.min(Math.max(Number(r.index), 1), total) : 1;
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max) : null);
  return {
    type: "UNREADABLE",
    payload: null,
    walletAddress: typeof r.walletAddress === "string" && ADDRESS.test(r.walletAddress) ? r.walletAddress : null,
    chain: typeof r.chain === "string" && /^solana:[a-z]{1,20}$/.test(r.chain) ? r.chain : null,
    method: r.method as ReviewMethod,
    walletName: text(r.walletName, 40),
    index,
    total,
    reason: unreviewableReason(r),
  };
}

/** What the page hook is told after the extension received a request: wallet now, wait for the review, or refuse. */
export type ReviewAnswer = { kind: "approve" } | { kind: "wait" } | { kind: "deny"; reason: string };

const TURN_OFF_HINT = "To use this site without Presign, turn Presign off for it in the extension's menu.";

/**
 * The content script's reading of the extension's reply. Only an explicit pass
 * (protection off, or off for this site — the user's own setting) goes
 * straight to the wallet. Anything that keeps Presign from reviewing is a
 * refusal: protection on never fails open.
 */
export function answerFor(res: { ok?: boolean; mode?: string; error?: string } | undefined, failed: boolean): ReviewAnswer {
  if (failed) return { kind: "deny", reason: `the Presign extension was updated or reloaded; reload this page to use your wallet with Presign. ${TURN_OFF_HINT}` };
  if (res?.ok && res.mode === "pass") return { kind: "approve" };
  if (res?.ok && res.mode === "review") return { kind: "wait" };
  return { kind: "deny", reason: `Presign could not review this request${res?.error ? ` (${res.error.slice(0, 80)})` : ""}, so it was not sent to your wallet. ${TURN_OFF_HINT}` };
}

export function isAllowedPresignOrigin(origin: string | undefined | null, dev: boolean = DEV_BUILD): boolean {
  return typeof origin === "string" && allowedPresignOrigins(dev).includes(origin);
}
