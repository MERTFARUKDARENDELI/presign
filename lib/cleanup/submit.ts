import "server-only";
import { VersionedTransaction } from "@solana/web3.js";
import { AppError } from "@/lib/api/errors";
import { logger, maskAddress } from "@/lib/api/logger";
import { getParsedAccounts } from "@/lib/solana/accounts";
import { parseTokenAccount } from "@/lib/solana/parsers";
import { sendSignedAndConfirm, type SendResult } from "@/lib/solana/send";
import { verifyTransactionSignatures } from "@/lib/wallet/signing";
import { messageHashOf, verifyCleanupTransaction, type CleanupIntent } from "./intent";

export interface SubmitResult extends SendResult {
  postVerification: {
    checked: boolean;
    accountClosed: boolean | null;
    delegateRemoved: boolean | null;
    detail: string;
  };
}

/**
 * Relays a transaction the USER signed in their wallet. The server holds no
 * keys and signs nothing. Before relaying it re-verifies: message hash equals
 * the one the user confirmed, instructions still match the intent, and the
 * owner's ed25519 signature is valid. Any mismatch is a SECURITY_BLOCK.
 */
export async function submitSignedCleanup(signedBase64: string, expectedMessageHash: string, intent: CleanupIntent): Promise<SubmitResult> {
  const bytes = Uint8Array.from(atob(signedBase64), (c) => c.charCodeAt(0));

  const hash = await messageHashOf(bytes).catch(() => null);
  if (hash !== expectedMessageHash) {
    logger.warn("cleanup.security_block", { reason: "message_hash_mismatch", wallet: maskAddress(intent.owner) });
    throw new AppError("SECURITY_BLOCK", "Signed transaction differs from the one you confirmed. It was not submitted.");
  }
  const integrity = verifyCleanupTransaction(bytes, intent);
  if (!integrity.ok) {
    logger.warn("cleanup.security_block", { reason: "intent_mismatch", mismatches: integrity.mismatches });
    throw new AppError("SECURITY_BLOCK", "Signed transaction does not match the confirmed cleanup.", { mismatches: integrity.mismatches });
  }

  let feePayer: string;
  try {
    feePayer = VersionedTransaction.deserialize(bytes).message.staticAccountKeys[0].toBase58();
  } catch {
    throw new AppError("INVALID_TRANSACTION", "Signed transaction could not be parsed.");
  }
  if (feePayer !== intent.owner || !verifyTransactionSignatures(bytes).ok) {
    throw new AppError("SECURITY_BLOCK", "Transaction is not validly signed by the connected wallet.");
  }

  logger.info("cleanup.submit_attempt", { action: intent.action, wallet: maskAddress(intent.owner) });
  const sent = await sendSignedAndConfirm(signedBase64);

  const postVerification: SubmitResult["postVerification"] = { checked: false, accountClosed: null, delegateRemoved: null, detail: "Not verified." };
  if (sent.status === "confirmed") {
    try {
      const { accounts } = await getParsedAccounts([intent.tokenAccount]);
      const raw = accounts.get(intent.tokenAccount) ?? null;
      if (intent.action === "REVOKE") {
        const acc = raw ? parseTokenAccount(intent.tokenAccount, raw) : null;
        postVerification.delegateRemoved = acc !== null && acc.delegate === null;
        postVerification.detail = postVerification.delegateRemoved
          ? `On-chain: delegate ${intent.delegate ?? ""} removed; token account has no delegate.`.replace("  ", " ")
          : "On-chain state does not yet show the delegate removed.";
      } else {
        // CloseAccount only succeeds on a zero balance, so a missing account proves burn → zero → close.
        postVerification.accountClosed = raw === null;
        postVerification.detail = raw === null
          ? "On-chain: token account no longer exists (balance was zero, account closed, rent returned)."
          : "On-chain state still shows the account; verify later.";
      }
      postVerification.checked = true;
    } catch {
      postVerification.detail = "Post-transaction verification failed to fetch state.";
    }
  }

  logger.info("cleanup.submit_result", { action: intent.action, status: sent.status });
  return { ...sent, postVerification };
}
