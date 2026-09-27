import "server-only";
import { VersionedTransaction } from "@solana/web3.js";
import { enrichWithAnchorIdl } from "@/lib/anchor/source";
import { AppError, isAppError } from "@/lib/api/errors";
import { analyzeMultisig } from "@/lib/multisig/analyze";
import { logger } from "@/lib/api/logger";
import { evaluateTransactionRisk } from "@/lib/security/rules/transaction";
import type { AnalysisStatus } from "@/lib/security/types";
import { getCluster } from "@/lib/solana/config";
import { messageHashOfTx } from "@/lib/wallet/signing";
import { decodeTransaction } from "./decoder";
import { applyInnerInstructions } from "./inner";
import { parseTransactionInput } from "./input";
import { effectsFromMeta, fetchExecutedTransaction, resolveLookupTables, simulateTransaction } from "./simulate";
import type { DecodedTransaction, TransactionAnalysis, TransactionEffects } from "./types";

function fillTransferMints(decoded: DecodedTransaction, mints: Record<string, { mint: string; decimals: number }>) {
  for (const t of decoded.tokenTransfers) {
    if (t.mint === null && mints[t.source]) {
      t.mint = mints[t.source].mint;
      t.decimals = mints[t.source].decimals;
    }
  }
}

/**
 * Full pipeline: input → decode → simulate (or load executed result) →
 * deterministic risk. Simulation failure to RUN yields INSUFFICIENT_DATA,
 * never SAFE.
 */
export async function analyzeTransaction(rawInput: string, walletAddress?: string): Promise<TransactionAnalysis> {
  const parsed = parseTransactionInput(rawInput);
  if (parsed.kind === "invalid") throw new AppError("INVALID_TRANSACTION", parsed.reason);

  let tx: VersionedTransaction;
  let decoded: DecodedTransaction;
  let effects: TransactionEffects | null = null;
  let effectsStatus: AnalysisStatus = "COMPLETE";
  let owners: Record<string, string> = {};
  let signature: string | null = null;
  let messageHash: string | null = null;

  if (parsed.kind === "signature") {
    signature = parsed.signature;
    const executed = await fetchExecutedTransaction(parsed.signature);
    tx = VersionedTransaction.deserialize(executed.bytes);
    decoded = decodeTransaction(tx, { loadedAddresses: executed.meta.loadedAddresses });
    applyInnerInstructions(decoded, executed.meta.innerInstructions, "EXECUTED");
    const keys = decoded.accounts.map((a) => a.address ?? "");
    const fromMeta = effectsFromMeta(keys, executed.meta, executed.slot);
    effects = fromMeta.effects;
    owners = fromMeta.tokenAccountOwners;
  } else {
    tx = parsed.transaction;
    messageHash = await messageHashOfTx(parsed.bytes);
    const lookups = await resolveLookupTables(tx);
    decoded = decodeTransaction(tx, lookups ? { loadedAddresses: lookups } : {});
    try {
      const sim = await simulateTransaction(tx, decoded, walletAddress ? [walletAddress] : [], parsed.bytes);
      effects = sim.effects;
      owners = sim.tokenAccountOwners;
      applyInnerInstructions(decoded, sim.innerInstructions, "SIMULATION");
      fillTransferMints(decoded, sim.tokenAccountMints);
      if (sim.effects.stale) effectsStatus = "PARTIAL";
    } catch (error) {
      if (!isAppError(error) || error.code !== "SIMULATION_FAILED") throw error;
      effectsStatus = "INSUFFICIENT_DATA";
    }
  }

  // Name undecoded calls from their programs' on-chain IDLs, then load what any multisig action authorizes.
  const anchorIdl = await enrichWithAnchorIdl(decoded);
  const perspectiveWallet = walletAddress ?? decoded.feePayer;
  const multisig = await analyzeMultisig(tx, decoded, perspectiveWallet);

  const risk = evaluateTransactionRisk({ decoded, effects, wallet: perspectiveWallet, tokenAccountOwners: owners, effectsStatus, multisig });

  logger.info("tx.analyzed", { kind: parsed.kind, level: risk.level, status: risk.status, instructions: decoded.instructions.length, multisig: multisig !== null });

  return {
    inputKind: parsed.kind,
    signature,
    messageHash,
    cluster: getCluster(),
    perspectiveWallet,
    perspectiveSource: walletAddress ? "provided" : "fee-payer",
    decoded,
    effects,
    effectsStatus,
    risk,
    multisig,
    anchorIdl,
    demo: false,
  };
}
