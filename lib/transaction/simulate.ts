import "server-only";
import { AddressLookupTableAccount, PublicKey, type VersionedTransaction } from "@solana/web3.js";
import { AppError } from "@/lib/api/errors";
import { logger } from "@/lib/api/logger";
import { getParsedAccounts } from "@/lib/solana/accounts";
import { rpcCall } from "@/lib/solana/client";
import { BASE_FEE_LAMPORTS_PER_SIGNATURE } from "@/lib/solana/constants";
import { estimatePriorityFeeLamports } from "./decoder";
import { messageBytesOf } from "@/lib/wallet/signing";
import { bytesToBase64 } from "./input";
import { diffSnapshots } from "./effects";
import type { DecodedTransaction, TransactionEffects } from "./types";

/** Max slots between pre-state snapshot and simulation before results are marked stale (~1 min). */
export const MAX_SLOT_DRIFT = 150;
const MAX_LOG_LINES = 60;

interface SimulateResponse {
  context: { slot: number };
  value: {
    err: unknown;
    logs: string[] | null;
    accounts: Array<unknown | null> | null;
    unitsConsumed?: number;
    innerInstructions?: unknown;
  };
}

/** Resolve v0 address lookup tables from chain. Returns null if any table cannot be loaded. */
export async function resolveLookupTables(tx: VersionedTransaction): Promise<{ writable: string[]; readonly: string[] } | null> {
  const lookups = "addressTableLookups" in tx.message ? tx.message.addressTableLookups : [];
  if (lookups.length === 0) return { writable: [], readonly: [] };
  try {
    const writable: string[] = [];
    const readonly: string[] = [];
    for (const l of lookups) {
      const res = await rpcCall<{ value: { data: [string, string] } | null }>("getAccountInfo", [
        l.accountKey.toBase58(),
        { encoding: "base64", commitment: "confirmed" },
      ]);
      if (!res.result?.value) return null;
      const data = Uint8Array.from(atob(res.result.value.data[0]), (c) => c.charCodeAt(0));
      const table = new AddressLookupTableAccount({ key: new PublicKey(l.accountKey), state: AddressLookupTableAccount.deserialize(data) });
      for (const i of l.writableIndexes) {
        const k = table.state.addresses[i];
        if (!k) return null;
        writable.push(k.toBase58());
      }
      for (const i of l.readonlyIndexes) {
        const k = table.state.addresses[i];
        if (!k) return null;
        readonly.push(k.toBase58());
      }
    }
    return { writable, readonly };
  } catch {
    return null;
  }
}

function errToString(err: unknown): string | null {
  if (err === null || err === undefined) return null;
  try {
    return JSON.stringify(err).slice(0, 300);
  } catch {
    return "Unknown error";
  }
}

export interface SimulationOutput {
  effects: TransactionEffects;
  /** token account → owner from the pre-state snapshot. */
  tokenAccountOwners: Record<string, string>;
  tokenAccountMints: Record<string, { mint: string; decimals: number }>;
  /** Raw inner (CPI) instructions reported by the simulation (untrusted shape; see inner.ts). */
  innerInstructions: unknown;
}

/**
 * Simulates an (unsigned or signed) transaction against current state.
 * Pre-state is snapshotted just before simulation so diffs reflect the
 * transaction's effect; slot drift beyond MAX_SLOT_DRIFT marks results stale.
 */
export async function simulateTransaction(tx: VersionedTransaction, decoded: DecodedTransaction, extraAddresses: string[] = [], bytes?: Uint8Array): Promise<SimulationOutput> {
  const writable = decoded.accounts.filter((a) => a.writable && a.address).map((a) => a.address as string);
  const addresses = [...new Set([...writable, ...extraAddresses])].slice(0, 64);
  // `bytes` = the original serialized transaction; required for v1, which web3.js cannot re-serialize.
  if (tx.message.version === 1 && !bytes) throw new AppError("SIMULATION_FAILED", "A v1 transaction can only be simulated from its original bytes.");
  const raw = bytes ?? tx.serialize();
  const txBase64 = bytesToBase64(raw);

  const pre = await getParsedAccounts(addresses);
  let sim: SimulateResponse;
  try {
    const res = await rpcCall<SimulateResponse>("simulateTransaction", [
      txBase64,
      {
        encoding: "base64",
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "confirmed",
        accounts: { encoding: "jsonParsed", addresses },
        innerInstructions: true,
      },
    ], { timeoutMs: 15_000, retries: 1 });
    sim = res.result;
  } catch (error) {
    logger.warn("tx.simulation_unavailable", { code: error instanceof AppError ? error.code : "UNKNOWN" });
    throw new AppError("SIMULATION_FAILED", "Transaction simulation could not be performed.");
  }

  const [blockhashValid, feeQuoted] = await Promise.all([
    rpcCall<{ value: boolean }>("isBlockhashValid", [decoded.recentBlockhash, { commitment: "confirmed" }])
      .then((r) => r.result.value)
      .catch(() => null),
    rpcCall<{ value: number | null }>("getFeeForMessage", [bytesToBase64(messageBytesOf(raw, tx)), { commitment: "confirmed" }])
      .then((r) => (typeof r.result.value === "number" ? BigInt(r.result.value).toString() : null))
      .catch(() => null),
  ]);

  // getFeeForMessage returns null for expired blockhashes; fall back to a clearly-labeled estimate.
  const fee = feeQuoted ?? (BASE_FEE_LAMPORTS_PER_SIGNATURE * BigInt(tx.message.header.numRequiredSignatures) + estimatePriorityFeeLamports(decoded)).toString();

  const success = sim.value.err === null || sim.value.err === undefined;
  const post = sim.value.accounts ?? [];
  const diff = success && post.length === addresses.length
    ? diffSnapshots(addresses, addresses.map((a) => pre.accounts.get(a) ?? null), post)
    : { solChanges: [], tokenChanges: [], accountChanges: [], unparsed: [] };
  const slot = sim.context?.slot ?? null;
  const stale = slot === null || Math.abs(slot - pre.slot) > MAX_SLOT_DRIFT;

  const notes: string[] = [
    "Simulated with a fresh blockhash against current chain state; results can differ if state changes before signing.",
  ];
  if (blockhashValid === false && !decoded.usesDurableNonce) notes.push("The transaction's own blockhash has expired — submitted as-is it would be rejected.");
  if (feeQuoted === null) notes.push("Network fee could not be quoted by the RPC; an estimate (base + priority fee) is shown.");
  if (diff.unparsed.length) notes.push(`${diff.unparsed.length} account(s) could not be parsed; their changes are not shown.`);
  if (stale) notes.push("Pre-state snapshot and simulation slot differ significantly; balance diffs may be stale.");
  if (success && post.length !== addresses.length) notes.push("Simulation did not return post-state for all accounts.");

  const logs = sim.value.logs ?? [];
  const tokenAccountOwners: Record<string, string> = {};
  const tokenAccountMints: Record<string, { mint: string; decimals: number }> = {};
  for (const [addr, raw] of pre.accounts) {
    const info = (raw as { data?: { parsed?: { type?: string; info?: { owner?: string; mint?: string; tokenAmount?: { decimals?: number } } } } } | null)?.data?.parsed;
    if (info?.type === "account" && info.info?.owner && info.info.mint) {
      tokenAccountOwners[addr] = info.info.owner;
      tokenAccountMints[addr] = { mint: info.info.mint, decimals: info.info.tokenAmount?.decimals ?? 0 };
    }
  }

  logger.info("tx.simulated", { success, slot, stale, accounts: addresses.length });

  return {
    effects: {
      source: "SIMULATION",
      success,
      error: errToString(sim.value.err),
      logs: logs.slice(0, MAX_LOG_LINES).map((l) => l.slice(0, 300)),
      logsTruncated: logs.length > MAX_LOG_LINES,
      unitsConsumed: sim.value.unitsConsumed ?? null,
      slot,
      preStateSlot: pre.slot,
      stale,
      blockhashValid,
      feeLamports: fee,
      ...diff,
      notes,
    },
    tokenAccountOwners,
    tokenAccountMints,
    innerInstructions: success ? (sim.value.innerInstructions ?? null) : null,
  };
}

interface GetTransactionResponse {
  slot: number;
  blockTime: number | null;
  transaction: [string, string];
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: Array<{ accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string; decimals: number } }>;
    postTokenBalances?: Array<{ accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string; decimals: number } }>;
    logMessages?: string[] | null;
    loadedAddresses?: { writable: string[]; readonly: string[] };
    computeUnitsConsumed?: number;
    innerInstructions?: unknown;
  } | null;
}

/** Highest transaction version the decoder understands (web3.js 1.99: legacy, v0, v1). */
export const SUPPORTED_TX_VERSION = 1;

/** Solana JSON-RPC: transaction version above maxSupportedTransactionVersion. */
export const RPC_UNSUPPORTED_TX_VERSION = -32015;

export async function fetchExecutedTransaction(signature: string) {
  let res: Awaited<ReturnType<typeof rpcCall<GetTransactionResponse | null>>>;
  try {
    res = await rpcCall<GetTransactionResponse | null>("getTransaction", [
      signature,
      { encoding: "base64", maxSupportedTransactionVersion: SUPPORTED_TX_VERSION, commitment: "confirmed" },
    ]);
  } catch (error) {
    // A version above SUPPORTED_TX_VERSION is reported as unsupported, not as an RPC outage.
    if (error instanceof AppError && error.details?.rpcCode === RPC_UNSUPPORTED_TX_VERSION) {
      throw new AppError("UNSUPPORTED_TRANSACTION", "This transaction uses a newer transaction format (above v1) that this analyzer cannot decode yet. It was not analyzed.");
    }
    throw error;
  }
  const t = res.result;
  if (!t) throw new AppError("TRANSACTION_NOT_FOUND", "Transaction not found on this cluster.");
  if (!t.meta || !Array.isArray(t.transaction) || typeof t.transaction[0] !== "string") {
    throw new AppError("RPC_ERROR", "RPC returned an incomplete transaction.");
  }
  const bytes = Uint8Array.from(atob(t.transaction[0]), (c) => c.charCodeAt(0));
  return { bytes, meta: t.meta, slot: t.slot, blockTime: t.blockTime };
}

export function effectsFromMeta(
  keys: string[],
  meta: NonNullable<GetTransactionResponse["meta"]>,
  slot: number,
): { effects: TransactionEffects; tokenAccountOwners: Record<string, string> } {
  const solChanges = keys.flatMap((address, i) => {
    const pre = meta.preBalances[i];
    const post = meta.postBalances[i];
    if (typeof pre !== "number" || typeof post !== "number" || pre === post) return [];
    return [{ address, preLamports: String(pre), postLamports: String(post), deltaLamports: String(BigInt(post) - BigInt(pre)) }];
  });

  const tokenAccountOwners: Record<string, string> = {};
  const byIndex = new Map<number, { mint: string; owner: string | null; decimals: number; pre: string; post: string }>();
  for (const b of meta.preTokenBalances ?? []) {
    byIndex.set(b.accountIndex, { mint: b.mint, owner: b.owner ?? null, decimals: b.uiTokenAmount.decimals, pre: b.uiTokenAmount.amount, post: "0" });
  }
  for (const b of meta.postTokenBalances ?? []) {
    const cur = byIndex.get(b.accountIndex) ?? { mint: b.mint, owner: b.owner ?? null, decimals: b.uiTokenAmount.decimals, pre: "0", post: "0" };
    cur.post = b.uiTokenAmount.amount;
    cur.owner = cur.owner ?? b.owner ?? null;
    byIndex.set(b.accountIndex, cur);
  }
  const tokenChanges = [...byIndex.entries()].flatMap(([i, v]) => {
    const address = keys[i];
    if (!address) return [];
    if (v.owner) tokenAccountOwners[address] = v.owner;
    if (v.pre === v.post) return [];
    return [{ tokenAccount: address, owner: v.owner, mint: v.mint, decimals: v.decimals, preRaw: v.pre, postRaw: v.post, deltaRaw: (BigInt(v.post) - BigInt(v.pre)).toString() }];
  });

  const accountChanges = keys.flatMap((address, i) =>
    (meta.preBalances[i] ?? 0) > 0 && meta.postBalances[i] === 0
      ? [{ address, ownerBefore: null, ownerAfter: null, created: false, closed: true }]
      : [],
  );

  const logs = meta.logMessages ?? [];
  return {
    effects: {
      source: "EXECUTED",
      success: meta.err === null || meta.err === undefined,
      error: errToString(meta.err),
      logs: logs.slice(0, MAX_LOG_LINES).map((l) => l.slice(0, 300)),
      logsTruncated: logs.length > MAX_LOG_LINES,
      unitsConsumed: meta.computeUnitsConsumed ?? null,
      slot,
      preStateSlot: null,
      stale: false,
      blockhashValid: null,
      feeLamports: String(meta.fee),
      solChanges,
      tokenChanges,
      accountChanges,
      notes: ["This transaction was already executed on-chain; balances come from the confirmed transaction record, not a simulation."],
    },
    tokenAccountOwners,
  };
}
