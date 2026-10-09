import { base64ToBytes, transactionMessage } from "./bytes";
import { isAllowedPresignOrigin, type ReviewRequest } from "./protocol";

/**
 * Before an approved request goes to the wallet, the extension confirms the
 * approval with the Presign server that issued it — the one request the
 * extension makes. A message on the approval channel proves only which page
 * sent it; the confirmation proves the server sealed an approval for exactly
 * the bytes this extension captured:
 *
 *   1. the payload hash is computed HERE, from the captured bytes, the way the
 *      server binds approvals (SHA-256 of the message bytes, or of the
 *      transaction message the signatures cover);
 *   2. the server opens its sealed approval and answers valid only if it is
 *      genuine, unexpired, for that hash, and not confirmed before;
 *   3. the approval's type, wallet and site must be this review's: the wallet
 *      the request names and the site origin the browser reported.
 *
 * Without a "valid" for this hash, type, wallet and site, nothing is sent to the wallet.
 */

export const CONFIRM_PATH = "/api/presign/signing/verify-approval";

export interface ConfirmDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  digest: (bytes: Uint8Array) => Promise<ArrayBuffer>;
}

/** `payloadHash`: the hash the server confirmed, which the page hook compares with the wallet's bytes. */
export type Confirmation = { ok: true; payloadHash: string } | { ok: false; reason: string };

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

/** The hash the server binds an approval to, computed from the bytes the extension captured. */
export async function payloadHashOfRequest(request: ReviewRequest, digest: ConfirmDeps["digest"]): Promise<string | null> {
  if (request.type === "UNREADABLE" || !request.payload) return null;
  const bytes = base64ToBytes(request.payload);
  if (!bytes) return null;
  const covered = request.type === "TRANSACTION" ? transactionMessage(bytes) : bytes;
  return covered ? hex(await digest(covered)) : null;
}

export async function confirmApproval(presignOrigin: string, siteOrigin: string, request: ReviewRequest, approvalToken: string, deps: ConfirmDeps): Promise<Confirmation> {
  // Only ever to a Presign origin this build allows — the same one the review was opened on.
  if (!isAllowedPresignOrigin(presignOrigin)) return { ok: false, reason: "the approval came from a page that is not Presign." };
  const payloadHash = await payloadHashOfRequest(request, deps.digest);
  if (!payloadHash) return { ok: false, reason: "Presign could not read this request, so it cannot be approved." };
  let body: { success?: unknown; data?: { valid?: unknown; reason?: unknown; payloadHash?: unknown; type?: unknown; walletAddress?: unknown; targetOrigin?: unknown } | null } | null = null;
  try {
    const res = await deps.fetch(`${presignOrigin}${CONFIRM_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalToken, payloadHash }),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    body = res.ok ? await res.json() : null;
  } catch {
    body = null;
  }
  if (!body || body.success !== true || !body.data) return { ok: false, reason: "Presign's server could not confirm the approval, so nothing was sent to your wallet. Try again." };
  const d = body.data;
  if (d.valid !== true) {
    const why = d.reason === "ALREADY_USED" ? "it was already used" : d.reason === "EXPIRED" ? "it expired" : d.reason === "PAYLOAD_MISMATCH" ? "it is for different bytes" : "Presign's server did not issue it";
    return { ok: false, reason: `the approval was not confirmed (${why}), so nothing was sent to your wallet.` };
  }
  if (d.payloadHash !== payloadHash || d.type !== request.type) return { ok: false, reason: "the approval is for a different request, so nothing was sent to your wallet." };
  if (request.walletAddress !== null && d.walletAddress !== request.walletAddress) return { ok: false, reason: "the approval is for another wallet, so nothing was sent to your wallet." };
  if (d.targetOrigin !== siteOrigin) return { ok: false, reason: "the approval is for another site, so nothing was sent to your wallet." };
  return { ok: true, payloadHash };
}
