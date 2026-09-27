import type { TokenAccountState } from "@/lib/token/types";
import { formatRawAmount } from "@/lib/token/amount";
import { buildAssessment } from "../engine";
import type { RiskAssessment, RiskSignal, RiskVerdict } from "../risk";
import type { AnalysisStatus, DataSourceStatus, Evidence } from "../types";

/**
 * Wallet-level aggregate risk (deterministic). Derived from per-token and
 * per-asset assessments plus account-level facts such as live delegations.
 */

export interface WalletRuleInput {
  wallet: string;
  tokenAccounts: TokenAccountState[];
  tokenRisks: Array<{ mint: string; label: string; level: RiskVerdict; status: AnalysisStatus }>;
  assetRisks: Array<{ id: string; label: string; level: RiskVerdict }>;
  snapshotStatus: AnalysisStatus;
  sources: DataSourceStatus[];
  unanalyzedTokens: number;
  /** Mints verified as Metaplex edition-controlled NFTs (pNFT accounts are frozen by design). */
  standardNftMints?: Set<string>;
  now?: Date;
}

export function evaluateWalletRisk(input: WalletRuleInput): RiskAssessment {
  const evidence: Evidence[] = [];
  const signals: RiskSignal[] = [];
  const ev = (key: string, e: Omit<Evidence, "id">) => {
    const id = `wallet:${key}`;
    evidence.push({ id, ...e });
    return id;
  };

  const critical = input.tokenRisks.filter((t) => t.level === "CRITICAL");
  const high = input.tokenRisks.filter((t) => t.level === "HIGH");
  if (critical.length) {
    const id = ev("criticalTokens", { source: "DETERMINISTIC_RULE", label: "Tokens rated CRITICAL", observed: critical.map((t) => t.label).join(", ").slice(0, 300), condition: "token risk = CRITICAL" });
    signals.push({ code: "WALLET_HOLDS_CRITICAL_TOKENS", title: `${critical.length} critical-risk token(s)`, description: "Holdings with critical signals (e.g. permanent delegate). Do not interact with their promoted sites.", severity: "HIGH", evidenceIds: [id] });
  }
  if (high.length) {
    const id = ev("highTokens", { source: "DETERMINISTIC_RULE", label: "Tokens rated HIGH", observed: high.map((t) => t.label).join(", ").slice(0, 300), condition: "token risk = HIGH" });
    signals.push({ code: "WALLET_HOLDS_HIGH_RISK_TOKENS", title: `${high.length} high-risk token(s)`, description: "Holdings with high-risk signals such as active freeze authority or phishing names.", severity: "MEDIUM", evidenceIds: [id] });
  }

  for (const acc of input.tokenAccounts) {
    if (acc.delegate && acc.delegatedAmountRaw && BigInt(acc.delegatedAmountRaw) > 0n) {
      const id = ev(`delegate:${acc.address}`, { source: "ONCHAIN_RPC", label: `Delegate on token account ${acc.address}`, observed: `${acc.delegate} may move ${formatRawAmount(acc.delegatedAmountRaw, acc.decimals)} (mint ${acc.mint})`, condition: "delegate set with remaining allowance" });
      signals.push({ code: `WALLET_ACTIVE_DELEGATION:${acc.address}`, title: "Active token delegation", description: "Another address can transfer tokens from this account without asking you. Revoke it if you don't recognize it.", severity: "HIGH", evidenceIds: [id] });
    }
  }

  const frozen = input.tokenAccounts.filter((a) => a.state === "frozen" && !input.standardNftMints?.has(a.mint));
  if (frozen.length) {
    const id = ev("frozen", { source: "ONCHAIN_RPC", label: "Frozen token accounts", observed: String(frozen.length), condition: "state = frozen" });
    signals.push({ code: "WALLET_FROZEN_ACCOUNTS", title: `${frozen.length} frozen token account(s)`, description: "These tokens cannot be moved, burned or closed until thawed by the issuer.", severity: "LOW", evidenceIds: [id] });
  }

  const phishingAssets = input.assetRisks.filter((a) => a.level === "HIGH" || a.level === "CRITICAL");
  if (phishingAssets.length) {
    const id = ev("phishingAssets", { source: "DETERMINISTIC_RULE", label: "NFT/cNFT with phishing signals", observed: phishingAssets.map((a) => a.label).join(", ").slice(0, 300), condition: "asset risk >= HIGH" });
    signals.push({ code: "WALLET_PHISHING_ASSETS", title: `${phishingAssets.length} phishing-style NFT/cNFT(s)`, description: "Unsolicited assets advertising sites. Interacting with those sites can drain your wallet.", severity: "MEDIUM", evidenceIds: [id] });
  }

  const statuses: AnalysisStatus[] = [input.snapshotStatus];
  if (input.unanalyzedTokens > 0) statuses.push("PARTIAL");
  if (input.tokenRisks.some((t) => t.status !== "COMPLETE")) statuses.push("PARTIAL");
  const status: AnalysisStatus = statuses.includes("INSUFFICIENT_DATA")
    ? "INSUFFICIENT_DATA"
    : statuses.every((s) => s === "COMPLETE")
      ? "COMPLETE"
      : "PARTIAL";

  return buildAssessment({ category: "wallet", signals, evidence, sources: input.sources, status, now: input.now });
}
