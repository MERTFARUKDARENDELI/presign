import type { Decision, ReviewRequest } from "./protocol";

/**
 * The page hook's side of a review over the channel to the extension. It fails
 * closed: without a connected channel the request is refused at once, and a
 * review that gets no decision in time is refused too. Only an explicit
 * "approved" decision for this request's id lets the hook go on to the wallet.
 */

export const NOT_CONNECTED =
  "the Presign extension is not connected on this page, so the request was not sent to your wallet. Reload the page, or turn Presign off for this site in the extension's menu.";
export const TIMED_OUT = "the security review timed out.";
const CANCELLED = "the request was cancelled after the security review.";

export interface ReviewerDeps {
  ready(): boolean;
  send(message: unknown): void;
  newId(): string;
  timeoutMs: number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
}

export function createReviewer(deps: ReviewerDeps) {
  const waiting = new Map<string, (d: Decision & { id?: string }) => void>();

  function review(request: ReviewRequest): Promise<Decision & { id?: string }> {
    if (!deps.ready()) return Promise.resolve({ approved: false, reason: NOT_CONNECTED });
    const id = deps.newId();
    return new Promise((resolve) => {
      const timer = deps.setTimer(() => {
        if (waiting.delete(id)) resolve({ approved: false, reason: TIMED_OUT });
      }, deps.timeoutMs);
      waiting.set(id, (d) => {
        deps.clearTimer(timer);
        resolve(d);
      });
      deps.send({ kind: "review", id, request });
    });
  }

  /** A decision message from the content script (already parsed); anything else is ignored. */
  function settle(m: { kind?: unknown; id?: unknown; approved?: unknown; reason?: unknown; rid?: unknown } | null): void {
    if (m?.kind !== "decision" || typeof m.id !== "string") return;
    const resolve = waiting.get(m.id);
    if (!resolve) return;
    waiting.delete(m.id);
    resolve(m.approved === true ? { approved: true, id: typeof m.rid === "string" ? m.rid : undefined } : { approved: false, reason: typeof m.reason === "string" ? m.reason : CANCELLED });
  }

  return { review, settle };
}
