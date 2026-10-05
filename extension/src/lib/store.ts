import { isAllowedPresignOrigin, REVIEW_TTL_MS, type ExternalMessage, type Instance, type ReviewRequest, type ReviewState, type ReviewTicket } from "./protocol";

/**
 * The background's decision logic, free of chrome.* so it is unit-tested:
 * which requests are pending, who may answer them, and what a valid answer is.
 */

export interface PendingReview extends ReviewTicket {
  /** Where the request came from — the browser's sender, not the page's word. */
  tabId: number;
  frameId: number;
  /** Request id inside the page hook. */
  hookId: string;
  /** Presign origin the review was opened on; only it may answer. */
  presignOrigin: string;
  windowId: number | null;
  riskLevel: string | null;
}

export interface Settings {
  enabled: boolean;
  instance: Instance;
  /** Sites the user chose to skip (exact origins). */
  skipSites: string[];
}

export const DEFAULT_SETTINGS: Settings = { enabled: true, instance: "production", skipSites: [] };

export interface LogEntry {
  at: number;
  origin: string;
  method: string;
  type: string;
  state: ReviewState | "passed";
  riskLevel: string | null;
  detail: string | null;
}

/** Whether a request from `origin` is reviewed or passed straight to the wallet. */
export function modeFor(origin: string, settings: Settings): { mode: "review" } | { mode: "pass"; why: string } {
  if (isAllowedPresignOrigin(origin)) return { mode: "pass", why: "Presign's own pages review requests themselves." };
  if (!settings.enabled) return { mode: "pass", why: "Presign protection is turned off." };
  if (settings.skipSites.includes(origin)) return { mode: "pass", why: "You turned Presign off for this site." };
  return { mode: "review" };
}

export type ExternalResult =
  | { reply: unknown; effect?: undefined }
  | { reply: unknown; effect: { kind: "forward"; approved: boolean; reason?: string; review: PendingReview } }
  | { reply: unknown; effect: { kind: "close"; review: PendingReview } };

const terminal = (s: ReviewState) => s === "signed" || s === "rejected" || s === "blocked" || s === "cancelled" || s === "expired";

/**
 * Handles a message from a Presign page. Only the Presign origin the review
 * was opened on may read or answer it; an approval must be for exactly the
 * captured payload and only once.
 */
export function handleExternal(msg: ExternalMessage | null | undefined, senderOrigin: string | undefined, reviews: Map<string, PendingReview>, now: number): ExternalResult {
  if (!msg || typeof msg !== "object" || typeof msg.rid !== "string") return { reply: { ok: false, error: "BAD_MESSAGE" } };
  const r = reviews.get(msg.rid);
  if (!r) return { reply: { ok: false, error: "UNKNOWN_REQUEST" } };
  if (!senderOrigin || senderOrigin !== r.presignOrigin) return { reply: { ok: false, error: "FORBIDDEN_ORIGIN" } };
  if (!terminal(r.state) && now - r.createdAt > REVIEW_TTL_MS) {
    r.state = "expired";
    r.detail = "The review expired.";
    return { reply: { ok: false, error: "EXPIRED" }, effect: { kind: "forward", approved: false, reason: "the security review expired.", review: r } };
  }

  switch (msg.kind) {
    case "presign:get":
      return { reply: { ok: true, ticket: ticketOf(r) } };
    case "presign:status":
      return { reply: { ok: true, state: r.state, detail: r.detail } };
    case "presign:approve": {
      if (r.state !== "pending") return { reply: { ok: false, error: "NOT_PENDING", state: r.state } };
      if (r.request.type === "UNREADABLE" || r.request.payload === null) return { reply: { ok: false, error: "UNVERIFIABLE" } };
      if (msg.payload !== r.request.payload) return { reply: { ok: false, error: "PAYLOAD_MISMATCH" } };
      if (typeof msg.payloadHash !== "string" || !/^[0-9a-f]{64}$/.test(msg.payloadHash) || typeof msg.approvalToken !== "string" || msg.approvalToken.length < 20) return { reply: { ok: false, error: "APPROVAL_MISSING" } };
      r.state = "forwarded";
      r.riskLevel = typeof msg.riskLevel === "string" ? msg.riskLevel.slice(0, 16) : null;
      r.detail = "Sent to your wallet. Confirm or reject it in the wallet window.";
      return { reply: { ok: true }, effect: { kind: "forward", approved: true, review: r } };
    }
    case "presign:cancel": {
      if (r.state !== "pending") return { reply: { ok: false, error: "NOT_PENDING", state: r.state } };
      r.state = "cancelled";
      r.riskLevel = typeof msg.riskLevel === "string" ? msg.riskLevel.slice(0, 16) : r.riskLevel;
      r.detail = "Cancelled in Presign. The wallet was not asked.";
      return { reply: { ok: true }, effect: { kind: "forward", approved: false, reason: typeof msg.reason === "string" && msg.reason ? msg.reason.slice(0, 120) : "you cancelled the request after the security review.", review: r } };
    }
    case "presign:close":
      return { reply: { ok: true }, effect: { kind: "close", review: r } };
    default:
      return { reply: { ok: false, error: "BAD_MESSAGE" } };
  }
}

export function ticketOf(r: PendingReview): ReviewTicket {
  return { rid: r.rid, origin: r.origin, request: r.request, state: r.state, detail: r.detail, createdAt: r.createdAt };
}

/** The page hook's report after an approved wallet call. */
export function applyOutcome(r: PendingReview, outcome: unknown): boolean {
  const o = outcome as { status?: string; detail?: string } | null;
  if (!o || r.state !== "forwarded") return false;
  const map: Record<string, ReviewState> = { SIGNED: "signed", REJECTED: "rejected", BLOCKED: "blocked" };
  const next = typeof o.status === "string" ? map[o.status] : undefined;
  if (!next) return false;
  r.state = next;
  r.detail = typeof o.detail === "string" ? o.detail.slice(0, 200) : null;
  return true;
}

export function newPending(input: { rid: string; origin: string; request: ReviewRequest; tabId: number; frameId: number; hookId: string; presignOrigin: string; now: number }): PendingReview {
  return { rid: input.rid, origin: input.origin, request: input.request, state: "pending", detail: null, createdAt: input.now, tabId: input.tabId, frameId: input.frameId, hookId: input.hookId, presignOrigin: input.presignOrigin, windowId: null, riskLevel: null };
}

export function logEntryOf(r: PendingReview): LogEntry {
  return { at: Date.now(), origin: r.origin, method: r.request.method, type: r.request.type, state: r.state, riskLevel: r.riskLevel, detail: r.detail };
}
