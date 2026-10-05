/**
 * Isolated-world bridge between the page hook and the extension.
 *
 * Handshake (synchronous, at document_start, before site scripts run): the
 * page hook dispatches `presign:hello` with a random secret; the first one
 * received is kept and acknowledged, every later hello is ignored. Messages
 * then travel as DOM events named with that secret.
 */

(() => {
  let secret: string | null = null;

  const toPage = (msg: unknown) => {
    if (secret) document.dispatchEvent(new CustomEvent(`presign:${secret}:to-page`, { detail: JSON.stringify(msg) }));
  };

  const onHello = (e: Event) => {
    const s = (e as CustomEvent).detail;
    if (secret || typeof s !== "string" || !/^[0-9a-f]{32}$/.test(s)) return;
    secret = s;
    document.removeEventListener("presign:hello", onHello);
    document.addEventListener(`presign:${secret}:to-content`, onHookMessage);
    document.dispatchEvent(new CustomEvent(`presign:${secret}:ack`));
  };
  document.addEventListener("presign:hello", onHello);
  document.dispatchEvent(new CustomEvent("presign:content-ready"));

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
      try {
        chrome.runtime.sendMessage({ kind: "presign:review", id, request: m.request }, (res?: { ok?: boolean; mode?: string; error?: string }) => {
          if (chrome.runtime.lastError || !res?.ok) {
            // The extension cannot run the review (reloaded, invalid request): the user decides, warned.
            const ok = window.confirm(`Presign could not review this signing request${res?.error ? ` (${res.error})` : ""}.\n\nIt has NOT been checked. Press OK to continue to your wallet anyway, or Cancel to stop.`);
            decide(id, ok, ok ? undefined : "cancelled (no Presign review available).");
          } else if (res.mode === "pass") {
            decide(id, true);
          }
          // mode "review": the decision arrives later from the background.
        });
      } catch {
        const ok = window.confirm("Presign is unavailable on this page (the extension was reloaded). Continue to your wallet without a review?");
        decide(id, ok, ok ? undefined : "cancelled (Presign unavailable).");
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
