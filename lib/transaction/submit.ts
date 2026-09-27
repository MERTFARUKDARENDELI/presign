import "server-only";
import { VersionedTransaction } from "@solana/web3.js";
import { AppError } from "@/lib/api/errors";
import { logger } from "@/lib/api/logger";
import { DEMO } from "@/lib/demo/scenario";
import { sendSignedAndConfirm, type SendResult } from "@/lib/solana/send";
import { messageHashOfTx, verifyTransactionSignatures } from "@/lib/wallet/signing";

/**
 * Relays a user-signed, previously analyzed transaction. The client proves the
 * bytes match the analysis and the user's confirmation through the message
 * hash; the server re-checks it plus every required ed25519 signature. The RPC
 * runs a fresh preflight simulation before accepting it. Nothing is signed here.
 */
export async function submitAnalyzedTransaction(signedBase64: string, expectedMessageHash: string): Promise<SendResult> {
  let bytes: Uint8Array;
  let tx: VersionedTransaction;
  try {
    bytes = Uint8Array.from(atob(signedBase64), (c) => c.charCodeAt(0));
    tx = VersionedTransaction.deserialize(bytes);
  } catch {
    throw new AppError("INVALID_TRANSACTION", "Signed transaction could not be parsed.");
  }
  if (tx.message.version === 1) {
    // v1 is analysis-only: signing/relaying v1 has never been verified end to end.
    throw new AppError("UNSUPPORTED_TRANSACTION", "Submitting v1 transactions is not supported by this app yet. It was not submitted.");
  }
  if ((await messageHashOfTx(bytes)) !== expectedMessageHash) {
    logger.warn("tx.security_block", { reason: "message_hash_mismatch" });
    throw new AppError("SECURITY_BLOCK", "Signed transaction differs from the one that was analyzed and confirmed. It was not submitted.");
  }
  const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).map((k) => k.toBase58());
  if (signers.includes(DEMO.wallet.toBase58())) {
    throw new AppError("SECURITY_BLOCK", "Demo transactions can never be submitted.");
  }
  const sigs = verifyTransactionSignatures(bytes);
  if (!sigs.ok) {
    throw new AppError("SECURITY_BLOCK", sigs.missing.length ? "Not all required signatures are present." : "A signature is invalid.", {
      missing: sigs.missing.length,
      invalid: sigs.invalid.length,
    });
  }
  logger.info("tx.submit_attempt", { signers: signers.length, version: tx.message.version });
  const result = await sendSignedAndConfirm(signedBase64);
  logger.info("tx.submit_result", { status: result.status });
  return result;
}
