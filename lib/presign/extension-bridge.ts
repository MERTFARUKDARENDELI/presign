import type { ExternalMessage, ReviewTicket } from "@/extension/src/lib/protocol";
import type { ForwardOutcome } from "./controller";
import type { SigningApproval } from "./types";

/**
 * Presign page ↔ Presign browser extension (Chrome `externally_connectable`).
 * Only pages on Presign's own origins can reach the extension, and the
 * extension only answers for requests it opened on this exact origin.
 */

interface RuntimeLike {
  sendMessage(extensionId: string, message: unknown, callback: (response: unknown) => void): void;
  lastError?: { message?: string };
}

function runtime(): RuntimeLike | null {
  const c = (globalThis as { chrome?: { runtime?: RuntimeLike } }).chrome;
  return c?.runtime && typeof c.runtime.sendMessage === "function" ? c.runtime : null;
}

export function extensionAvailable(): boolean {
  return runtime() !== null;
}

export const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

export function sendToExtension<T>(extensionId: string, message: ExternalMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const rt = runtime();
    if (!rt || !EXTENSION_ID_PATTERN.test(extensionId)) return reject(new Error("The Presign extension is not reachable from this page."));
    try {
      rt.sendMessage(extensionId, message, (response) => {
        if (rt.lastError) return reject(new Error(rt.lastError.message ?? "The Presign extension did not answer."));
        resolve(response as T);
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error("The Presign extension did not answer."));
    }
  });
}

type Reply = { ok: boolean; error?: string };

export async function getTicket(extensionId: string, rid: string): Promise<ReviewTicket> {
  const r = await sendToExtension<Reply & { ticket?: ReviewTicket }>(extensionId, { kind: "presign:get", rid });
  if (!r?.ok || !r.ticket) throw new Error(r?.error === "UNKNOWN_REQUEST" ? "This review is no longer open in the extension." : r?.error === "EXPIRED" ? "This review expired." : "The extension refused to share this request.");
  return r.ticket;
}

export async function cancelInExtension(extensionId: string, rid: string, riskLevel?: string): Promise<void> {
  await sendToExtension<Reply>(extensionId, { kind: "presign:cancel", rid, riskLevel }).catch(() => undefined);
}

export async function closeReview(extensionId: string, rid: string): Promise<void> {
  await sendToExtension<Reply>(extensionId, { kind: "presign:close", rid }).catch(() => undefined);
}

const WAIT_MS = 10 * 60_000;

/** Sends the approval, then follows the request until the wallet has answered in the application's tab. */
export async function forwardToExtension(extensionId: string, rid: string, approval: SigningApproval, payload: string, riskLevel: string, choice: string, wait = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<ForwardOutcome> {
  const sent = await sendToExtension<Reply>(extensionId, { kind: "presign:approve", rid, payload, payloadHash: approval.payloadHash, approvalToken: approval.approvalToken, riskLevel, choice });
  if (!sent?.ok) return { status: "BLOCKED", reason: sent?.error === "PAYLOAD_MISMATCH" ? "The request in the extension differs from the one Presign analyzed. Nothing was signed." : `The extension did not accept the approval (${sent?.error ?? "no answer"}). Nothing was signed.` };
  const started = Date.now();
  while (Date.now() - started < WAIT_MS) {
    await wait(800);
    const s = await sendToExtension<Reply & { state?: string; detail?: string | null }>(extensionId, { kind: "presign:status", rid }).catch(() => null);
    if (!s?.ok) continue;
    if (s.state === "signed") return { status: "SIGNED", detail: s.detail ?? "Signed in your wallet and returned to the application." };
    if (s.state === "rejected") return { status: "REJECTED", reason: s.detail ? `Your wallet did not sign: ${s.detail}` : "Your wallet did not sign." };
    if (s.state === "blocked") return { status: "BLOCKED", reason: s.detail ?? "Presign withheld the signature from the site." };
    if (s.state === "cancelled" || s.state === "expired") return { status: "REJECTED", reason: s.detail ?? "The request ended before it was signed." };
  }
  return { status: "REJECTED", reason: "No answer from your wallet within 10 minutes." };
}
