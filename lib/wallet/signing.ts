import { ed25519 } from "@noble/curves/ed25519.js";
import { Transaction, VersionedTransaction } from "@solana/web3.js";

/**
 * Client-side signing pipeline shared by every flow that asks a wallet to sign.
 * The wallet is the ONLY signer; this module never holds keys. It guarantees
 * that the bytes the user confirmed are exactly the bytes that were signed:
 *   1. hash(message) before signing must equal the confirmed hash
 *   2. hash(message) returned by the wallet must equal the confirmed hash
 *      (a wallet that adds/changes instructions is blocked, not trusted)
 *   3. the signer's signature must be present and cryptographically valid
 */

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The serialized message the signatures cover, for every transaction version.
 * A v1 transaction is `message ‖ signatures` and web3.js cannot re-serialize a
 * v1 message, so it is sliced from the original bytes (verified against real
 * mainnet v1 signatures). Legacy and v0 keep the existing re-serialization.
 */
export function messageBytesOf(bytes: Uint8Array, tx: VersionedTransaction = VersionedTransaction.deserialize(bytes)): Uint8Array {
  if (tx.message.version === 1) return bytes.slice(0, bytes.length - tx.message.header.numRequiredSignatures * 64);
  return tx.message.serialize();
}

export async function messageHashOfTx(bytes: Uint8Array): Promise<string> {
  return sha256Hex(messageBytesOf(bytes));
}

export interface SignatureCheck {
  ok: boolean;
  missing: string[];
  invalid: string[];
}

/** Verifies ed25519 signatures of all (or the listed) required signers. */
export function verifyTransactionSignatures(bytes: Uint8Array, only?: string[]): SignatureCheck {
  const tx = VersionedTransaction.deserialize(bytes);
  const message = messageBytesOf(bytes, tx);
  const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
  const missing: string[] = [];
  const invalid: string[] = [];
  signers.forEach((key, i) => {
    const addr = key.toBase58();
    if (only && !only.includes(addr)) return;
    const sig = tx.signatures[i];
    if (!sig || sig.every((b) => b === 0)) {
      missing.push(addr);
      return;
    }
    let valid = false;
    try {
      valid = ed25519.verify(sig, message, key.toBytes());
    } catch {
      valid = false;
    }
    if (!valid) invalid.push(addr);
  });
  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid };
}

type Signable = Transaction | VersionedTransaction;

const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The parts of a message a wallet must not change, with Compute Budget instructions left out. */
function shapeWithoutComputeBudget(bytes: Uint8Array): string {
  const m = VersionedTransaction.deserialize(bytes).message;
  const keys = m.staticAccountKeys.map((k) => k.toBase58());
  const account = (i: number) => `${i < keys.length ? keys[i] : `lookup:${i - keys.length}`}${m.isAccountWritable(i) ? ":w" : ""}`;
  return JSON.stringify({
    version: m.version,
    blockhash: m.recentBlockhash,
    payer: keys[0],
    signers: keys.slice(0, m.header.numRequiredSignatures),
    instructions: m.compiledInstructions.filter((ix) => keys[ix.programIdIndex] !== COMPUTE_BUDGET_PROGRAM).map((ix) => [keys[ix.programIdIndex], ix.accountKeyIndexes.map(account), hex(ix.data)]),
    lookups: m.addressTableLookups.map((l) => [l.accountKey.toBase58(), [...l.writableIndexes], [...l.readonlyIndexes]]),
  });
}

/**
 * True when two transactions differ only in their Compute Budget instructions
 * (priority fee, compute limit) — what a wallet that adjusts fees on its own
 * does. Used only to explain the refusal; the signature is withheld either way.
 */
export function onlyComputeBudgetChanged(original: Uint8Array, changed: Uint8Array): boolean {
  try {
    return shapeWithoutComputeBudget(original) === shapeWithoutComputeBudget(changed);
  } catch {
    return false;
  }
}

export const WALLET_CHANGED_FEE_REASON =
  "Your wallet changed the transaction's priority fee or compute limit after Presign reviewed it. Presign does not pass on a signature for a transaction it did not review, so nothing was submitted. If your wallet adjusts priority fees automatically, turn that off for this request and try again, or ask the application to set the fee.";
export const WALLET_CHANGED_REASON =
  "The wallet returned a different transaction than the one you reviewed (instructions or accounts changed). Presign does not pass on a signature for a transaction it did not review; it was NOT submitted.";

export type SignOutcome =
  | { ok: true; signed: Uint8Array }
  | { ok: false; kind: "SECURITY_BLOCK" | "REJECTED" | "UNSUPPORTED"; reason: string };

export interface SignRequest {
  bytes: Uint8Array;
  confirmedHash: string;
  signer: string;
  sign: <T extends Signable>(tx: T) => Promise<T>;
  /**
   * The wallet adapter's `supportedTransactionVersions`. `null` = legacy only
   * (wallet-adapter semantics for an undeclared set); omit to skip the check.
   */
  supportedVersions?: ReadonlySet<unknown> | null;
}

export async function signExactly(req: SignRequest): Promise<SignOutcome> {
  let vtx: VersionedTransaction;
  try {
    vtx = VersionedTransaction.deserialize(req.bytes);
  } catch {
    return { ok: false, kind: "SECURITY_BLOCK", reason: "Transaction bytes could not be parsed." };
  }
  if (vtx.message.version === 1) {
    // web3.js cannot serialize v1 messages for a wallet, and no wallet flow here has been verified with v1.
    return { ok: false, kind: "UNSUPPORTED", reason: "Signing v1 transactions is not supported by this app yet. Nothing was signed." };
  }
  if ((await sha256Hex(vtx.message.serialize())) !== req.confirmedHash) {
    return { ok: false, kind: "SECURITY_BLOCK", reason: "Transaction changed after you confirmed it. Nothing was signed." };
  }
  const requiredSigners = vtx.message.staticAccountKeys.slice(0, vtx.message.header.numRequiredSignatures).map((k) => k.toBase58());
  if (!requiredSigners.includes(req.signer)) {
    return { ok: false, kind: "SECURITY_BLOCK", reason: "The connected wallet is not a required signer of this transaction." };
  }
  const version = vtx.message.version;
  const supported = req.supportedVersions;
  if (version === 0 && supported !== undefined && (supported === null || !supported.has(0))) {
    return { ok: false, kind: "UNSUPPORTED", reason: "This wallet does not declare support for versioned (v0) transactions." };
  }

  let signedBytes: Uint8Array;
  try {
    if (version === "legacy") {
      const signed = await req.sign(Transaction.from(req.bytes));
      signedBytes = new Uint8Array(signed.serialize({ requireAllSignatures: false, verifySignatures: false }));
    } else {
      const signed = await req.sign(vtx);
      signedBytes = new Uint8Array(signed.serialize());
    }
  } catch {
    return { ok: false, kind: "REJECTED", reason: "Signing was cancelled or failed in your wallet. Nothing was sent." };
  }

  let signedHash: string;
  try {
    signedHash = await messageHashOfTx(signedBytes);
  } catch {
    return { ok: false, kind: "SECURITY_BLOCK", reason: "The wallet returned an unreadable transaction." };
  }
  if (signedHash !== req.confirmedHash) {
    return { ok: false, kind: "SECURITY_BLOCK", reason: onlyComputeBudgetChanged(req.bytes, signedBytes) ? WALLET_CHANGED_FEE_REASON : WALLET_CHANGED_REASON };
  }
  const sigs = verifyTransactionSignatures(signedBytes, [req.signer]);
  if (!sigs.ok) {
    return { ok: false, kind: "SECURITY_BLOCK", reason: "The wallet's signature is missing or invalid." };
  }
  return { ok: true, signed: signedBytes };
}
