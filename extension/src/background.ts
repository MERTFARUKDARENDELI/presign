import { confirmApproval } from "./lib/approval";
import { presignBaseFor, reviewableRequest, type ExternalMessage } from "./lib/protocol";
import { applyConfirmation, applyOutcome, DEFAULT_SETTINGS, handleExternal, logEntryForUnreviewed, logEntryOf, modeFor, newPending, type LogEntry, type PendingReview, type Settings } from "./lib/store";

/**
 * Service worker: opens a Presign review for every signing request a page
 * hook reports, accepts answers only from that Presign page, and relays the
 * decision to the page hook. Pending reviews are mirrored to session storage
 * so a restarted worker can still answer them.
 */

const reviews = new Map<string, PendingReview>();
let loaded: Promise<void> | null = null;

function load(): Promise<void> {
  loaded ??= chrome.storage.session.get("reviews").then((v) => {
    for (const r of (v.reviews as PendingReview[] | undefined) ?? []) reviews.set(r.rid, r);
  });
  return loaded;
}

function persist(): Promise<void> {
  const keep = [...reviews.values()].filter((r) => Date.now() - r.createdAt < 60 * 60_000);
  return chrome.storage.session.set({ reviews: keep });
}

async function settings(): Promise<Settings> {
  const v = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...((v.settings as Partial<Settings> | undefined) ?? {}) };
}

async function log(entry: LogEntry): Promise<void> {
  const v = await chrome.storage.local.get("log");
  const list = [entry, ...((v.log as LogEntry[] | undefined) ?? [])].slice(0, 50);
  await chrome.storage.local.set({ log: list });
}

function relay(r: PendingReview, approved: boolean, reason?: string) {
  chrome.tabs.sendMessage(r.tabId, { kind: "presign:decision", id: r.hookId, approved, reason, rid: r.rid }, { frameId: r.frameId }).catch(() => {
    // the tab navigated away or closed: the page hook times out on its own
  });
}

function closeWindow(r: PendingReview) {
  if (r.windowId !== null) chrome.windows.remove(r.windowId).catch(() => undefined);
  r.windowId = null;
}

async function focusTab(tabId: number) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    // tab gone
  }
}

chrome.runtime.onMessage.addListener((msg: { kind?: string; id?: string; request?: unknown; rid?: string | null; outcome?: unknown }, sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void) => {
  void (async () => {
    await load();
    const origin = sender.origin ?? (sender.url ? new URL(sender.url).origin : undefined);
    const tabId = sender.tab?.id;
    if (msg?.kind === "presign:review") {
      // A request that cannot be reviewed as sent is still reviewed, as UNREADABLE (Cancel only).
      const request = reviewableRequest(msg.request);
      if (!origin || tabId === undefined || typeof msg.id !== "string" || !request) return sendResponse({ ok: false, error: "invalid request" });
      const s = await settings();
      const m = modeFor(origin, s);
      if (m.mode === "pass") {
        await log({ at: Date.now(), origin, method: request.method, type: request.type, state: "passed", riskLevel: null, detail: m.why });
        return sendResponse({ ok: true, mode: "pass" });
      }
      const base = presignBaseFor(request.chain, s.instance);
      const rid = crypto.randomUUID();
      const r = newPending({ rid, origin, request, tabId, frameId: sender.frameId ?? 0, hookId: msg.id, presignOrigin: base, now: Date.now() });
      reviews.set(rid, r);
      const url = `${base}/extension/review?rid=${encodeURIComponent(rid)}&ext=${encodeURIComponent(chrome.runtime.id)}`;
      try {
        const win = await chrome.windows.create({ url, type: "popup", width: 600, height: 860, focused: true });
        r.windowId = win?.id ?? null;
      } catch {
        reviews.delete(rid);
        return sendResponse({ ok: false, error: "could not open the review window" });
      }
      await persist();
      return sendResponse({ ok: true, mode: "review" });
    }
    if (msg?.kind === "presign:outcome") {
      const r = typeof msg.rid === "string" ? reviews.get(msg.rid) : undefined;
      if (!r || r.tabId !== tabId) {
        const entry = origin ? logEntryForUnreviewed(origin, msg.outcome, Date.now()) : null;
        if (entry) await log(entry);
        return sendResponse({ ok: false });
      }
      if (applyOutcome(r, msg.outcome)) {
        await log(logEntryOf(r));
        await persist();
      }
      return sendResponse({ ok: true });
    }
    sendResponse({ ok: false });
  })();
  return true;
});

chrome.runtime.onMessageExternal.addListener((msg: ExternalMessage, sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void) => {
  void (async () => {
    await load();
    let result = handleExternal(msg, sender.origin ?? (sender.url ? new URL(sender.url).origin : undefined), reviews, Date.now());
    if (result.effect?.kind === "confirm") {
      // The one request the extension makes: is this approval genuine and for exactly these bytes?
      await persist();
      const r = result.effect.review;
      const confirmation = await confirmApproval(r.presignOrigin, r.request, result.effect.approvalToken, {
        fetch: (url, init) => fetch(url, init),
        digest: (bytes) => crypto.subtle.digest("SHA-256", bytes as BufferSource),
      });
      result = applyConfirmation(r, confirmation);
    }
    const effect = result.effect;
    if (effect?.kind === "forward") {
      relay(effect.review, effect.approved, effect.reason);
      if (effect.approved) await focusTab(effect.review.tabId);
      else {
        await log(logEntryOf(effect.review));
        closeWindow(effect.review);
      }
      await persist();
    } else if (effect?.kind === "close") {
      closeWindow(effect.review);
      await persist();
    }
    sendResponse(result.reply);
  })();
  return true;
});

// Closing the review window without deciding cancels the request.
chrome.windows.onRemoved.addListener((windowId: number) => {
  void (async () => {
    await load();
    for (const r of reviews.values()) {
      if (r.windowId !== windowId) continue;
      r.windowId = null;
      if (r.state === "pending") {
        r.state = "cancelled";
        r.detail = "The review window was closed before a decision.";
        relay(r, false, "the review window was closed before a decision.");
        await log(logEntryOf(r));
      }
    }
    await persist();
  })();
});

chrome.tabs.onRemoved.addListener((tabId: number) => {
  void (async () => {
    await load();
    for (const r of [...reviews.values()]) {
      if (r.tabId !== tabId) continue;
      if (r.state === "pending") closeWindow(r);
      reviews.delete(r.rid);
    }
    await persist();
  })();
});
