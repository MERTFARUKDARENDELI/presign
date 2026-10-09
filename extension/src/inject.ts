import { createReviewer, pageTransport } from "./lib/channel";
import { ed25519Verifier } from "./lib/ed25519";
import { installInterceptor, type HookWindow } from "./lib/intercept";
import { randomHex, ReflectApply } from "./lib/primordials";

/**
 * Runs in the page's own JavaScript world (MAIN) at document_start, before any
 * site script.
 *
 * Channel to the extension: a random secret, and all messages travel as DOM
 * events whose type contains it. A site cannot listen for or forge an event
 * type it does not know. Every DOM / JSON function used here is captured
 * before site scripts can replace it, and called through Reflect.apply — never
 * `fn.call(...)`, since a site that replaced Function.prototype.call would
 * receive the event, and with it the secret (lib/channel.ts pageTransport).
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
  const doc = document;
  const createElement = Document.prototype.createElement;
  const attachShadow = Element.prototype.attachShadow;
  const appendChild = Node.prototype.appendChild;
  const removeElement = Element.prototype.remove;
  const setAttribute = Element.prototype.setAttribute;
  const setText = Object.getOwnPropertyDescriptor(Node.prototype, "textContent")!.set!;
  const startTimer = setTimeout;
  const stopTimer = clearTimeout;
  const stopInterval = clearInterval;
  // Web Crypto exists only on secure pages; elsewhere message signatures cannot be checked.
  const subtle = globalThis.crypto?.subtle;
  const verifySignature = subtle ? ed25519Verifier(subtle) : undefined;
  const REVIEW_TIMEOUT_MS = 16 * 60_000;

  const secret = randomHex(16);
  let ready = false;
  let seq = 0;

  // The secret's hiding place: a closed shadow root page scripts cannot open.
  const channel = ReflectApply(createElement, doc, ["presign-channel"]) as HTMLElement;
  ReflectApply(setAttribute, channel, ["hidden", ""]);
  ReflectApply(setAttribute, channel, ["aria-hidden", "true"]);
  ReflectApply(setText, ReflectApply(attachShadow, channel, [{ mode: "closed" }]), [secret]);
  let channelPlaced = false;
  const dropChannel = () => {
    if (channelPlaced) ReflectApply(removeElement, channel, []);
    channelPlaced = false;
  };

  ReflectApply(listen, doc, [
    `presign:${secret}:ack`,
    () => {
      ready = true;
      dropChannel();
    },
  ]);
  const transport = pageTransport({ doc, secret, dispatch, listen, CustomEvent: NativeCustomEvent, detailOf });
  // Fails closed (lib/channel.ts): no channel → refused at once; no decision in time → refused.
  const reviewer = createReviewer({
    ready: () => ready,
    send: transport.send,
    // Unpredictable and unique: Date / Math.random / Number.prototype.toString are the site's to replace.
    newId: () => `${++seq}-${randomHex(12)}`,
    timeoutMs: REVIEW_TIMEOUT_MS,
    setTimer: (fn, ms) => startTimer(fn, ms),
    clearTimer: (t) => stopTimer(t as ReturnType<typeof setTimeout>),
  });
  transport.onMessage(reviewer.settle);

  // "Look now": carries nothing. The content script may already be listening (it reads the
  // secret synchronously inside this dispatch) or start later (it looks on its own, and asks).
  const announce = () => ReflectApply(dispatch, doc, [new NativeCustomEvent("presign:hook-ready")]);
  const onContentReady = () => {
    if (!ready) announce();
  };
  if (doc.documentElement) {
    ReflectApply(appendChild, doc.documentElement, [channel]);
    channelPlaced = true;
  }
  ReflectApply(listen, doc, ["presign:content-ready", onContentReady]);
  announce();
  // Only during start-up: afterwards nobody may (re)start the handshake, and the element goes.
  startTimer(() => {
    ReflectApply(unlisten, doc, ["presign:content-ready", onContentReady]);
    dropChannel();
  }, 0);

  const hook = installInterceptor(w, {
    review: reviewer.review,
    report: (rid, outcome) => {
      if (ready) transport.send({ kind: "outcome", rid: rid ?? null, outcome });
    },
    host: () => window.location.host,
    verifySignature,
  });

  // Injected providers can appear after this script: wrap them as they show up.
  hook.scanProviders();
  let scans = 0;
  const timer = setInterval(() => {
    hook.scanProviders();
    if (++scans >= 40) stopInterval(timer);
  }, 250);
  ReflectApply(listen, w, ["load", () => hook.scanProviders(), { once: true }]);
})();
