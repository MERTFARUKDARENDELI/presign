import { answerFor } from "./lib/protocol";

/**
 * Isolated-world bridge between the page hook and the extension.
 *
 * Handshake (at document_start, before site scripts run): the page hook keeps
 * its random secret in a closed shadow root of a <presign-channel> element.
 * Page scripts cannot open it; this script can, with
 * chrome.dom.openOrClosedShadowRoot. It reads the secret once — right away if
 * the hook started first, or when the hook says "presign:hook-ready" — and
 * acknowledges with an event named with it. Messages then travel as DOM
 * events named with that secret. No event ever carries the secret itself.
 */

(() => {
  let secret: string | null = null;

  const toPage = (msg: unknown) => {
    if (secret) document.dispatchEvent(new CustomEvent(`presign:${secret}:to-page`, { detail: JSON.stringify(msg) }));
  };

  const readChannel = (): string | null => {
    for (const el of Array.from(document.documentElement?.children ?? [])) {
      if (el.localName !== "presign-channel" || !(el instanceof HTMLElement)) continue;
      let root: ShadowRoot | null = null;
      try {
        root = chrome.dom.openOrClosedShadowRoot(el);
      } catch {
        root = null;
      }
      const s = root?.textContent ?? "";
      if (/^[0-9a-f]{32}$/.test(s)) return s;
    }
    return null;
  };
  const tryHandshake = () => {
    if (secret) return;
    const s = readChannel();
    if (!s) return;
    secret = s;
    document.removeEventListener("presign:hook-ready", tryHandshake);
    document.addEventListener(`presign:${secret}:to-content`, onHookMessage);
    document.dispatchEvent(new CustomEvent(`presign:${secret}:ack`));
  };
  document.addEventListener("presign:hook-ready", tryHandshake);
  tryHandshake(); // the hook may have started first
  if (!secret) document.dispatchEvent(new CustomEvent("presign:content-ready"));
  // Only during start-up, like the hook.
  setTimeout(() => document.removeEventListener("presign:hook-ready", tryHandshake), 0);

  function decide(id: string, approved: boolean, reason?: string, rid?: string) {
    toPage({ kind: "decision", id, approved, reason, rid });
  }

  function onHookMessage(e: Event) {
    let m: { kind?: string; id?: string; request?: unknown; rid?: string | null; outcome?: unknown } | null = null;
    try {
      m = JSON.parse((e as CustomEvent).detail as string);
    } catch {
      return;
    }
    if (!m || typeof m !== "object") return;
    if (m.kind === "review" && typeof m.id === "string") {
      const id = m.id;
      // Protection on never fails open: if Presign cannot review, the request is refused (answerFor).
      const apply = (a: ReturnType<typeof answerFor>) => {
        if (a.kind === "approve") decide(id, true);
        else if (a.kind === "deny") decide(id, false, a.reason);
        // "wait": the decision arrives later from the background.
      };
      try {
        chrome.runtime.sendMessage({ kind: "presign:review", id, request: m.request }, (res?: { ok?: boolean; mode?: string; error?: string }) => {
          apply(answerFor(res, Boolean(chrome.runtime.lastError)));
        });
      } catch {
        apply(answerFor(undefined, true));
      }
    } else if (m.kind === "outcome") {
      try {
        chrome.runtime.sendMessage({ kind: "presign:outcome", rid: m.rid ?? null, outcome: m.outcome });
      } catch {
        // extension reloaded: nothing to report to
      }
    }
  }

  chrome.runtime.onMessage.addListener((msg: { kind?: string; id?: string; approved?: boolean; reason?: string; rid?: string }) => {
    if (msg?.kind === "presign:decision" && typeof msg.id === "string") decide(msg.id, msg.approved === true, msg.reason, msg.rid);
    return false;
  });
})();
