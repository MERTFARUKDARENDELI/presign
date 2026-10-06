import { ed25519Verifier } from "./lib/ed25519";
import { installInterceptor, type HookWindow } from "./lib/intercept";
import type { Decision, ReviewRequest } from "./lib/protocol";

/**
 * Runs in the page's own JavaScript world (MAIN) at document_start, before any
 * site script.
 *
 * Channel to the extension: a random secret, and all messages travel as DOM
 * events whose type contains it. A site cannot listen for or forge an event
 * type it does not know, and every DOM / JSON function used here is captured
 * before site scripts can replace it.
 *
 * Hand-off of the secret: it is never put in an event. It sits in a CLOSED
 * shadow root of a hidden element, which page scripts cannot read; the
 * content script reads it with chrome.dom.openOrClosedShadowRoot (an
 * extension-only API) and answers with an ack event named with the secret.
 * "presign:hook-ready" / "presign:content-ready" only say "look now", so a
 * site that fires them learns nothing. The element is removed once the
 * content script has answered, or when start-up ends.
 */

(() => {
  const w = window as unknown as HookWindow & Window & { __presignHook?: boolean };
  if (w.__presignHook) return;
  Object.defineProperty(w, "__presignHook", { value: true });

  // Captured before any site script can replace them.
  const dispatch = EventTarget.prototype.dispatchEvent;
  const listen = EventTarget.prototype.addEventListener;
  const unlisten = EventTarget.prototype.removeEventListener;
  const NativeCustomEvent = CustomEvent;
  const detailOf = Object.getOwnPropertyDescriptor(CustomEvent.prototype, "detail")!.get!;
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const doc = document;
  const createElement = Document.prototype.createElement;
  const attachShadow = Element.prototype.attachShadow;
  const appendChild = Node.prototype.appendChild;
  const removeElement = Element.prototype.remove;
  const setAttribute = Element.prototype.setAttribute;
  const setText = Object.getOwnPropertyDescriptor(Node.prototype, "textContent")!.set!;
  // Web Crypto exists only on secure pages; elsewhere message signatures cannot be checked.
  const subtle = globalThis.crypto?.subtle;
  const verifySignature = subtle ? ed25519Verifier(subtle) : undefined;
  const REVIEW_TIMEOUT_MS = 16 * 60_000;

  const secret = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  const TO_CONTENT = `presign:${secret}:to-content`;
  const TO_PAGE = `presign:${secret}:to-page`;
  let ready = false;
  let seq = 0;
  const waiting = new Map<string, (d: Decision & { id?: string }) => void>();

  const send = (msg: unknown) => dispatch.call(doc, new NativeCustomEvent(TO_CONTENT, { detail: stringify(msg) }));

  // The secret's hiding place: a closed shadow root page scripts cannot open.
  const channel = createElement.call(doc, "presign-channel") as HTMLElement;
  setAttribute.call(channel, "hidden", "");
  setAttribute.call(channel, "aria-hidden", "true");
  setText.call(attachShadow.call(channel, { mode: "closed" }), secret);
  let channelPlaced = false;
  const dropChannel = () => {
    if (channelPlaced) removeElement.call(channel);
    channelPlaced = false;
  };

  listen.call(doc, `presign:${secret}:ack`, () => {
    ready = true;
    dropChannel();
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

  // "Look now": carries nothing. The content script may already be listening (it reads the
  // secret synchronously inside this dispatch) or start later (it looks on its own, and asks).
  const announce = () => dispatch.call(doc, new NativeCustomEvent("presign:hook-ready"));
  const onContentReady = () => {
    if (!ready) announce();
  };
  if (doc.documentElement) {
    appendChild.call(doc.documentElement, channel);
    channelPlaced = true;
  }
  listen.call(doc, "presign:content-ready", onContentReady);
  announce();
  // Only during start-up: afterwards nobody may (re)start the handshake, and the element goes.
  setTimeout(() => {
    unlisten.call(doc, "presign:content-ready", onContentReady);
    dropChannel();
  }, 0);

  function review(request: ReviewRequest): Promise<Decision & { id?: string }> {
    // Protection on never fails open: without the channel to Presign, the request is refused.
    if (!ready) {
      return Promise.resolve({ approved: false, reason: "the Presign extension is not connected on this page, so the request was not sent to your wallet. Reload the page, or turn Presign off for this site in the extension's menu." });
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
    verifySignature,
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
