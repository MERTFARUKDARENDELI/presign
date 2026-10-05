import { installInterceptor, type HookWindow } from "./lib/intercept";
import type { Decision, ReviewRequest } from "./lib/protocol";

/**
 * Runs in the page's own JavaScript world (MAIN) at document_start, before any
 * site script.
 *
 * Channel to the extension: a random secret is exchanged with the content
 * script SYNCHRONOUSLY during start-up (no site script can run in between),
 * and all later messages travel as DOM events whose type contains that
 * secret. A site cannot listen for or forge an event type it does not know,
 * and every DOM / JSON function used here is captured before site scripts can
 * replace it.
 */

(() => {
  const w = window as unknown as HookWindow & Window & { __presignHook?: boolean };
  if (w.__presignHook) return;
  Object.defineProperty(w, "__presignHook", { value: true });

  // Captured before any site script can replace them.
  const nativeConfirm = window.confirm.bind(window);
  const dispatch = EventTarget.prototype.dispatchEvent;
  const listen = EventTarget.prototype.addEventListener;
  const unlisten = EventTarget.prototype.removeEventListener;
  const NativeCustomEvent = CustomEvent;
  const detailOf = Object.getOwnPropertyDescriptor(CustomEvent.prototype, "detail")!.get!;
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const doc = document;
  const REVIEW_TIMEOUT_MS = 16 * 60_000;

  const secret = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  const TO_CONTENT = `presign:${secret}:to-content`;
  const TO_PAGE = `presign:${secret}:to-page`;
  let ready = false;
  let seq = 0;
  const waiting = new Map<string, (d: Decision & { id?: string }) => void>();

  const send = (msg: unknown) => dispatch.call(doc, new NativeCustomEvent(TO_CONTENT, { detail: stringify(msg) }));

  listen.call(doc, `presign:${secret}:ack`, () => {
    ready = true;
  });
  listen.call(doc, TO_PAGE, (e: Event) => {
    let m: { kind?: string; id?: string; approved?: boolean; reason?: string; rid?: string } | null = null;
    try {
      m = parse(detailOf.call(e) as string);
    } catch {
      return;
    }
    if (m?.kind !== "decision" || typeof m.id !== "string") return;
    const resolve = waiting.get(m.id);
    if (!resolve) return;
    waiting.delete(m.id);
    resolve(m.approved === true ? { approved: true, id: m.rid } : { approved: false, reason: typeof m.reason === "string" ? m.reason : "the request was cancelled after the security review." });
  });

  const hello = () => dispatch.call(doc, new NativeCustomEvent("presign:hello", { detail: secret }));
  // The content script may start after this script: it announces itself and gets the hello then.
  const onContentReady = () => {
    if (!ready) hello();
  };
  listen.call(doc, "presign:content-ready", onContentReady);
  hello();
  // Only during start-up: once site scripts run, nobody may (re)start the handshake.
  setTimeout(() => unlisten.call(doc, "presign:content-ready", onContentReady), 0);

  function review(request: ReviewRequest): Promise<Decision & { id?: string }> {
    if (!ready) {
      const ok = nativeConfirm("Presign could not review this signing request: the extension is not connected on this page.\n\nIt has NOT been checked. Press OK to continue to your wallet without a Presign review, or Cancel to stop.");
      return Promise.resolve(ok ? { approved: true } : { approved: false, reason: "cancelled (no Presign review available)." });
    }
    const id = `${Date.now().toString(36)}-${++seq}-${Math.random().toString(36).slice(2, 10)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (waiting.delete(id)) resolve({ approved: false, reason: "the security review timed out." });
      }, REVIEW_TIMEOUT_MS);
      waiting.set(id, (d) => {
        clearTimeout(timer);
        resolve(d);
      });
      send({ kind: "review", id, request });
    });
  }

  const hook = installInterceptor(w, {
    review,
    report: (rid, outcome) => {
      if (ready) send({ kind: "outcome", rid: rid ?? null, outcome });
    },
    host: () => window.location.host,
  });

  // Injected providers can appear after this script: wrap them as they show up.
  hook.scanProviders();
  let scans = 0;
  const timer = setInterval(() => {
    hook.scanProviders();
    if (++scans >= 40) clearInterval(timer);
  }, 250);
  window.addEventListener("load", () => hook.scanProviders(), { once: true });
})();
