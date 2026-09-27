import "server-only";
import { rpcCall } from "./client";

export interface SendResult {
  signature: string;
  status: "confirmed" | "failed" | "unconfirmed";
  error: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Relays ALREADY-SIGNED transaction bytes and polls for confirmation.
 * Preflight (a fresh simulation by the RPC) stays enabled. The server never
 * signs; callers must verify signatures/intent before calling this.
 */
export async function sendSignedAndConfirm(signedBase64: string): Promise<SendResult> {
  const sent = await rpcCall<string>(
    "sendTransaction",
    [signedBase64, { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 }],
    { timeoutMs: 20_000, retries: 1 },
  );
  const signature = sent.result;

  for (let i = 0; i < 25; i++) {
    await sleep(1_500);
    try {
      const st = await rpcCall<{ value: Array<{ err: unknown; confirmationStatus?: string } | null> }>("getSignatureStatuses", [[signature]]);
      const s = st.result.value[0];
      if (s?.err) return { signature, status: "failed", error: JSON.stringify(s.err).slice(0, 200) };
      if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) {
        return { signature, status: "confirmed", error: null };
      }
    } catch {
      // transient — keep polling
    }
  }
  return { signature, status: "unconfirmed", error: null };
}
