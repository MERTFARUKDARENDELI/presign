import { useMemo, useSyncExternalStore } from "react";
import { parsePolicyText, type TeamPolicy } from "@/lib/policy/schema";

/**
 * The team policy lives in this browser only (a per-viewer convenience): it is
 * sent with each check and never stored server-side. If storage is blocked it
 * still works for the current page.
 */

const KEY = "presign.teamPolicy.v1";
const EVENT = "presign:policy";
let memory = "";

function read(): string {
  try {
    return window.localStorage.getItem(KEY) ?? memory;
  } catch {
    return memory;
  }
}

export function saveStoredPolicy(text: string) {
  memory = text;
  try {
    if (text) window.localStorage.setItem(KEY, text);
    else window.localStorage.removeItem(KEY);
  } catch {
    // Storage unavailable (private mode, blocked): the in-memory copy is used.
  }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

/** The saved policy right now (null on the server, when none is saved, or when it is invalid). */
export function currentStoredPolicy(): TeamPolicy | null {
  if (typeof window === "undefined") return null;
  const text = read();
  if (!text) return null;
  const r = parsePolicyText(text);
  return r.ok ? r.policy : null;
}

export function useStoredPolicy(): { text: string; policy: TeamPolicy | null; errors: string[] } {
  const text = useSyncExternalStore(subscribe, read, () => "");
  return useMemo(() => {
    if (!text) return { text, policy: null, errors: [] };
    const r = parsePolicyText(text);
    return r.ok ? { text, policy: r.policy, errors: [] } : { text, policy: null, errors: r.errors };
  }, [text]);
}
