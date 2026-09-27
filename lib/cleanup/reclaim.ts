import { formatLamports } from "@/lib/token/amount";

export const INSUFFICIENT_SOL_MESSAGE = "İşlem yapmak için cüzdanınızda yeterli SOL bulunmamaktadır.";

export interface ReclaimEstimate {
  grossLamports: string;
  estimatedFeeLamports: string;
  /** May be negative when the fee exceeds the reclaimable rent. */
  estimatedNetLamports: string;
  display: { gross: string; fee: string; net: string };
  disclaimer: string;
}

/**
 * Estimated reclaim is not guaranteed: it only materializes if the close
 * succeeds, and the fee is paid even if the transaction fails.
 */
export function estimateReclaim(grossLamports: string | null, feeLamports: string): ReclaimEstimate {
  const gross = BigInt(grossLamports ?? "0");
  const fee = BigInt(feeLamports);
  const net = gross - fee;
  return {
    grossLamports: gross.toString(),
    estimatedFeeLamports: fee.toString(),
    estimatedNetLamports: net.toString(),
    display: { gross: formatLamports(gross), fee: formatLamports(fee), net: formatLamports(net) },
    disclaimer: "Estimated reclaim is not guaranteed profit. It is only received if the transaction succeeds; network fees are paid even if it fails.",
  };
}

/** Rent-exempt minimum of a 0-byte system account (wallet), used when the RPC value is unavailable. */
export const DEFAULT_WALLET_RENT_EXEMPT_MINIMUM = 890_880n;

export interface FeeCheck {
  sufficient: boolean;
  balanceLamports: string;
  requiredLamports: string;
  /** Lamports usable without dropping the wallet below its rent-exempt minimum. */
  spendableLamports: string;
  reason: "INSUFFICIENT_FOR_FEE" | "WOULD_BREAK_RENT_EXEMPTION" | null;
  message: string | null;
  detail: string | null;
}

/**
 * "Is there enough SPENDABLE SOL?" — not just "is the balance zero?".
 *  - The fee is charged before anything is credited back, so balance ≥ fee.
 *  - After the transaction the fee payer must hold 0 lamports or at least the
 *    rent-exempt minimum; anything in between is rejected by the runtime.
 * `creditLamports` is SOL the same transaction returns to the payer (e.g. closed-account rent).
 */
export function checkFeeBalance(
  balanceLamports: string,
  feeLamports: string,
  opts: { rentExemptMinimum?: string; creditLamports?: string } = {},
): FeeCheck {
  const balance = BigInt(balanceLamports);
  const fee = BigInt(feeLamports);
  const rentMin = BigInt(opts.rentExemptMinimum ?? DEFAULT_WALLET_RENT_EXEMPT_MINIMUM.toString());
  const credit = BigInt(opts.creditLamports ?? "0");
  const spendable = balance > rentMin ? balance - rentMin : 0n;
  const after = balance - fee + credit;

  let reason: FeeCheck["reason"] = null;
  let detail: string | null = null;
  if (balance === 0n || balance < fee) {
    reason = "INSUFFICIENT_FOR_FEE";
    detail = "Balance does not cover the network fee, which is charged before anything is returned.";
  } else if (after > 0n && after < rentMin) {
    reason = "WOULD_BREAK_RENT_EXEMPTION";
    detail = "After the fee the wallet would fall below its rent-exempt minimum, so the network would reject the transaction.";
  }

  return {
    sufficient: reason === null,
    balanceLamports: balance.toString(),
    requiredLamports: fee.toString(),
    spendableLamports: spendable.toString(),
    reason,
    message: reason ? INSUFFICIENT_SOL_MESSAGE : null,
    detail,
  };
}

/** Maps well-known runtime errors to user-facing text (the raw error stays available as evidence). */
export function describeTransactionError(error: string | null): string | null {
  if (!error) return null;
  if (/InsufficientFundsForFee|AccountNotFound/.test(error)) return `${INSUFFICIENT_SOL_MESSAGE} (network fee cannot be paid)`;
  if (/InsufficientFundsForRent/.test(error)) return `${INSUFFICIENT_SOL_MESSAGE} (an account would fall below its rent-exempt minimum)`;
  if (/BlockhashNotFound/.test(error)) return "The transaction's blockhash has expired. It must be re-created before signing.";
  if (/"Custom":1\b/.test(error) || /insufficient funds/i.test(error)) return "A program reported insufficient funds (token or SOL balance too low).";
  if (/AlreadyProcessed/.test(error)) return "This transaction was already processed.";
  return null;
}
