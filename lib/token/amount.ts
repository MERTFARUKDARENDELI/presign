/**
 * Precision-safe amount helpers. Raw on-chain amounts (u64 lamports / token
 * base units) are carried as decimal strings end-to-end and only formatted for
 * display — never converted to `number`.
 */

export function toBigInt(value: string | number | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("Unsafe integer amount.");
    return BigInt(value);
  }
  if (!/^-?\d+$/.test(value)) throw new Error("Invalid integer amount.");
  return BigInt(value);
}

/** Format a raw integer amount with the given decimals, e.g. ("50000000", 6) → "50". */
export function formatRawAmount(raw: string | bigint, decimals: number, maxFractionDigits = decimals): string {
  const value = toBigInt(raw);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  if (decimals <= 0) return `${negative ? "-" : ""}${abs.toString()}`;

  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let fraction = (abs % base).toString().padStart(decimals, "0");
  if (maxFractionDigits < decimals) fraction = fraction.slice(0, maxFractionDigits);
  fraction = fraction.replace(/0+$/, "");
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${wholeStr}${fraction ? `.${fraction}` : ""}`;
}

export function formatLamports(lamports: string | bigint, maxFractionDigits = 9): string {
  return formatRawAmount(lamports, 9, maxFractionDigits);
}

export function sumRaw(values: Array<string | bigint>): string {
  return values.reduce<bigint>((acc, v) => acc + toBigInt(v), 0n).toString();
}

export function isZeroRaw(value: string | bigint): boolean {
  return toBigInt(value) === 0n;
}
