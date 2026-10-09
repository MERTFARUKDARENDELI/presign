import { bare, hasOwn, JSONParse, jsonText, own, promise, ReflectApply } from "./primordials";
import type { Decision, ReviewRequest } from "./protocol";

/**
 * The page hook's side of a review over the channel to the extension. It fails
 * closed: without a connected channel the request is refused at once, and a
 * review that gets no decision in time is refused too. Only an explicit
 * "approved" decision for this request's id lets the hook go on to the wallet.
 *
 * It runs in the page's own JavaScript world, so nothing here looks up a
 * built-in a site could have replaced after the hook loaded (./primordials):
 * pending reviews live in a record with no prototype (not a Map whose `set`
 * or `has` a site could hook), decisions are records with no prototype (no
 * `then` to look up when the promise resolves), and the promise comes from
 * the captured constructor, never the global `Promise`.
 */

export const NOT_CONNECTED =
  "the Presign extension is not connected on this page, so the request was not sent to your wallet. Reload the page, or turn Presign off for this site in the extension's menu.";
export const TIMED_OUT = "the security review timed out.";
const CANCELLED = "the request was cancelled after the security review.";
const DUPLICATE = "Presign could not start a separate review for this request.";

export interface ReviewerDeps {
  ready(): boolean;
  send(message: unknown): void;
  newId(): string;
  timeoutMs: number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
}

type Settled = Decision & { id?: string };
const refused = (reason: string): Settled => bare({ approved: false as const, reason });

export function createReviewer(deps: ReviewerDeps) {
  const { ready, send, newId, timeoutMs, setTimer, clearTimer } = deps;
  const waiting: Record<string, (d: Settled) => void> = bare({});

  function review(request: ReviewRequest): Promise<Settled> {
    return promise<Settled>((resolve) => {
      if (!ready()) return resolve(refused(NOT_CONNECTED));
      const id = newId();
      // One pending review per id: a decision must never settle a request it was not given for.
      if (typeof id !== "string" || id in waiting) return resolve(refused(DUPLICATE));
      const timer = setTimer(() => {
        if (!(id in waiting)) return;
        delete waiting[id];
        resolve(refused(TIMED_OUT));
      }, timeoutMs);
      waiting[id] = (d) => {
        clearTimer(timer);
        resolve(d);
      };
      send(bare({ kind: "review", id, request }));
    });
  }

  /** A decision message from the content script (already parsed); anything else is ignored. Only its own fields count. */
  function settle(m: unknown): void {
    if (own(m, "kind") !== "decision") return;
    const id = own(m, "id");
    if (typeof id !== "string" || !(id in waiting)) return;
    const resolve = waiting[id];
    delete waiting[id];
    const rid = own(m, "rid");
    const reason = own(m, "reason");
    resolve(own(m, "approved") === true ? bare({ approved: true as const, id: typeof rid === "string" ? rid : undefined }) : refused(typeof reason === "string" ? reason : CANCELLED));
  }

  return { review, settle };
}

/**
 * The DOM transport between the page hook and the content script: events on
 * `doc` whose type contains the channel secret. A site that knows no secret
 * can neither listen for nor forge them — so the secret must never reach site
 * code. The event is built and dispatched only with functions captured at
 * document_start (never Function.prototype.call, which a site could replace
 * to receive the event), and its text is built without JSON.stringify on an
 * object (which would call a `toJSON` a site added to Object.prototype).
 */
export interface PageTransportDeps {
  doc: EventTarget;
  secret: string;
  dispatch: EventTarget["dispatchEvent"];
  listen: EventTarget["addEventListener"];
  CustomEvent: typeof CustomEvent;
  /** The captured CustomEvent.prototype.detail getter. */
  detailOf: () => unknown;
}

export function pageTransport(deps: PageTransportDeps) {
  const { doc, secret, dispatch, listen, CustomEvent: NativeCustomEvent, detailOf } = deps;
  const TO_CONTENT = `presign:${secret}:to-content`;
  const TO_PAGE = `presign:${secret}:to-page`;
  return {
    send(message: unknown): void {
      const event = new NativeCustomEvent(TO_CONTENT, bare({ detail: jsonText(message) }));
      ReflectApply(dispatch, doc, [event]);
    },
    onMessage(handler: (message: unknown) => void): void {
      const listener = (e: Event) => {
        let m: unknown;
        try {
          const text = ReflectApply(detailOf, e, []);
          if (typeof text !== "string") return;
          m = JSONParse(text);
        } catch {
          return; // not a message from the content script
        }
        if (m !== null && typeof m === "object" && hasOwn(m, "kind")) handler(m);
      };
      ReflectApply(listen, doc, [TO_PAGE, listener]);
    },
  };
}
