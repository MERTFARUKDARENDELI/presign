import { createHash } from "node:crypto";
import { transactionMessage } from "@/extension/src/lib/bytes";
import type { ReviewRequest } from "@/extension/src/lib/protocol";

/** The payload hash the extension's background confirms for a reviewed request (Node's SHA-256, independent of the hook's). */
export function payloadHashOf(r: Pick<ReviewRequest, "type" | "payload">): string | undefined {
  if (!r.payload) return undefined;
  const bytes = new Uint8Array(Buffer.from(r.payload, "base64"));
  const covered = r.type === "TRANSACTION" ? transactionMessage(bytes) : bytes;
  return covered ? createHash("sha256").update(covered).digest("hex") : undefined;
}

/** The decision the background relays after Presign's server confirmed an approval: it carries that payload hash. */
export const confirmedApproval = (r: ReviewRequest, id = "rid-1") => ({ approved: true as const, id, payloadHash: payloadHashOf(r) });
