import "server-only";
import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { AppError } from "@/lib/api/errors";
import { logger, maskAddress } from "@/lib/api/logger";
import { DEMO } from "@/lib/demo/scenario";
import { getParsedAccounts } from "@/lib/solana/accounts";
import { rpcCall } from "@/lib/solana/client";
import { getCluster } from "@/lib/solana/config";
import { BASE_FEE_LAMPORTS_PER_SIGNATURE, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@/lib/solana/constants";
import { parseMintAccount, parseTokenAccount } from "@/lib/solana/parsers";
import { decodeTransaction } from "@/lib/transaction/decoder";
import { bytesToBase64 } from "@/lib/transaction/input";
import { simulateTransaction } from "@/lib/transaction/simulate";
import type { TransactionEffects } from "@/lib/transaction/types";
import { evaluateTokenAccountCleanup, type CleanupAction, type CleanupEligibility } from "./capabilities";
import { buildCleanupInstructions, sha256Hex, verifyCleanupTransaction, type CleanupIntent } from "./intent";
import { checkFeeBalance, DEFAULT_WALLET_RENT_EXEMPT_MINIMUM, estimateReclaim, type FeeCheck, type ReclaimEstimate } from "./reclaim";

/** Seed-derived public key of the synthetic demo wallet — demo data must never reach the chain. */
const DEMO_WALLET = DEMO.wallet.toBase58();

let rentMinCache: { value: string; at: number } | null = null;
async function getWalletRentExemptMinimum(): Promise<string> {
  if (rentMinCache && Date.now() - rentMinCache.at < 3_600_000) return rentMinCache.value;
  try {
    const res = await rpcCall<number>("getMinimumBalanceForRentExemption", [0]);
    if (typeof res.result === "number" && Number.isSafeInteger(res.result)) {
      rentMinCache = { value: String(res.result), at: Date.now() };
      return rentMinCache.value;
    }
  } catch {
    // fall through to the protocol default
  }
  return DEFAULT_WALLET_RENT_EXEMPT_MINIMUM.toString();
}

export interface PreparedCleanup {
  intent: CleanupIntent;
  /** Unsigned legacy transaction, base64. The server never signs it. */
  transaction: string;
  messageHash: string;
  lastValidBlockHeight: number;
  eligibility: CleanupEligibility;
  simulation: TransactionEffects;
  feeCheck: FeeCheck;
  reclaim: ReclaimEstimate | null;
  /** True only if eligibility, simulation, expected effects and fee checks all pass. */
  canSign: boolean;
  blockers: string[];
  preparedAt: string;
}

function lamportsOf(raw: unknown): string | null {
  const l = (raw as { lamports?: unknown } | null)?.lamports;
  return typeof l === "number" && Number.isSafeInteger(l) ? String(l) : null;
}

export async function prepareCleanup(owner: string, tokenAccount: string, action: CleanupAction): Promise<PreparedCleanup> {
  if (owner === DEMO_WALLET) {
    throw new AppError("CLEANUP_NOT_ELIGIBLE", "The demo wallet is synthetic and can never be used for on-chain cleanup.");
  }
  const { accounts } = await getParsedAccounts([tokenAccount, owner]);
  const rawAccount = accounts.get(tokenAccount) ?? null;
  if (!rawAccount) {
    // cNFT asset ids are not accounts; they must never reach the SPL pipeline.
    throw new AppError("ACCOUNT_NOT_FOUND", "No token account exists at this address. Compressed NFTs have no token account — cNFT cleanup is UNSUPPORTED.");
  }
  const account = parseTokenAccount(tokenAccount, rawAccount);
  if (!account) throw new AppError("CLEANUP_NOT_ELIGIBLE", "Account is not a supported SPL Token / Token-2022 account.");
  if (account.owner !== owner) {
    throw new AppError("OWNERSHIP_MISMATCH", "This token account is not owned by the connected wallet.");
  }
  const ownerLamports = lamportsOf(accounts.get(owner) ?? null) ?? "0";

  const mintRes = await getParsedAccounts([account.mint]);
  const rawMint = mintRes.accounts.get(account.mint) ?? null;
  const mint = rawMint ? parseMintAccount(account.mint, rawMint) : null;
  const isNft = mint !== null && mint.decimals === 0 && mint.supplyRaw === "1";

  const eligibility = evaluateTokenAccountCleanup(account, owner, { mint, isNft });
  const capability = eligibility.actions[action];
  if (capability.status !== "SUPPORTED" && capability.status !== "PARTIALLY_SUPPORTED") {
    throw new AppError("CLEANUP_NOT_ELIGIBLE", capability.reason, { capability: capability.status });
  }

  const tokenProgram = account.program === "token-2022" ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const intent: CleanupIntent = {
    action,
    owner,
    tokenAccount,
    mint: account.mint,
    tokenProgram,
    amountRaw: action === "BURN_AND_CLOSE" ? account.amountRaw : "0",
    decimals: account.decimals,
    destination: owner,
    cluster: getCluster(),
    ...(action === "REVOKE" ? { delegate: account.delegate } : {}),
  };
  if (action === "REVOKE" && !account.delegate) {
    throw new AppError("CLEANUP_NOT_ELIGIBLE", "No account-level delegate is set on this token account.");
  }

  const bh = await rpcCall<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
  const tx = new Transaction({
    feePayer: new PublicKey(owner),
    blockhash: bh.result.value.blockhash,
    lastValidBlockHeight: bh.result.value.lastValidBlockHeight,
  }).add(...buildCleanupInstructions(intent));
  const bytes = new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));

  // Self-check: the bytes we hand out must match the intent we display.
  const integrity = verifyCleanupTransaction(bytes, intent);
  if (!integrity.ok) {
    logger.error("cleanup.self_integrity_failed", { mismatches: integrity.mismatches });
    throw new AppError("SECURITY_BLOCK", "Prepared transaction failed integrity verification.");
  }

  const vtx = VersionedTransaction.deserialize(bytes);
  const decoded = decodeTransaction(vtx);
  const sim = await simulateTransaction(vtx, decoded, [owner]);
  const simulation = sim.effects;

  const blockers: string[] = [];
  if (!simulation.success) blockers.push(`Simulation failed: ${simulation.error ?? "unknown error"}`);
  if (simulation.stale) blockers.push("Simulation result is stale; prepare again.");
  // Burn/close/revoke never invoke other programs; any CPI means something unexpected ran.
  if (Array.isArray(sim.innerInstructions) && sim.innerInstructions.some((g) => Array.isArray((g as { instructions?: unknown[] }).instructions) && ((g as { instructions: unknown[] }).instructions.length > 0))) {
    blockers.push("Simulation shows unexpected program invocations (CPI).");
  }

  // Expected effects: account closed for close actions; delegate removed for revoke.
  if (simulation.success) {
    const change = simulation.accountChanges.find((c) => c.address === tokenAccount);
    if (action !== "REVOKE" && !change?.closed) blockers.push("Simulation did not show the token account being closed.");
    if (action === "REVOKE" && !(change?.delegateBefore && change.delegateAfter === null)) {
      blockers.push("Simulation did not show the delegate being removed.");
    }
    const foreignOutflow = simulation.solChanges.some((c) => c.address !== owner && c.address !== tokenAccount && BigInt(c.deltaLamports) > 0n);
    if (foreignOutflow) blockers.push("Simulation shows SOL moving to an unexpected account.");
  }

  const fee = simulation.feeLamports ?? BASE_FEE_LAMPORTS_PER_SIGNATURE.toString();
  const rentExemptMinimum = await getWalletRentExemptMinimum();
  const credit = action === "REVOKE" ? "0" : (account.lamports ?? "0");
  const feeCheck = checkFeeBalance(ownerLamports, fee, { rentExemptMinimum, creditLamports: credit });
  if (!feeCheck.sufficient) blockers.push(`${feeCheck.message} ${feeCheck.detail ?? ""}`.trim());

  const reclaim = action === "REVOKE" ? null : estimateReclaim(eligibility.grossReclaimLamports ?? account.lamports, fee);

  logger.info("cleanup.prepared", { action, wallet: maskAddress(owner), canSign: blockers.length === 0, simSuccess: simulation.success });

  return {
    intent,
    transaction: bytesToBase64(bytes),
    messageHash: await sha256Hex(vtx.message.serialize()),
    lastValidBlockHeight: bh.result.value.lastValidBlockHeight,
    eligibility,
    simulation,
    feeCheck,
    reclaim,
    canSign: blockers.length === 0,
    blockers,
    preparedAt: new Date().toISOString(),
  };
}
