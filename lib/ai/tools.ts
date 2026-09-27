import { tool } from "ai";
import { z } from "zod";
import type { RiskAssessment } from "@/lib/security/risk";
import type { TokenSecurityReport } from "@/lib/token/report";
import type { TransactionAnalysis } from "@/lib/transaction/types";
import { isValidPublicKey } from "@/lib/validation/schemas";
import type { WalletSecurityScan } from "@/lib/wallet/scan-core";
import { sanitizeForAi } from "./sanitize";

/**
 * Deterministic backend tools exposed to the model. Tools only READ and
 * ANALYZE; none of them prepares, signs or sends a transaction.
 */

export interface SecurityDataProvider {
  mode: "live" | "demo";
  wallet: string | null;
  getWalletScan(): Promise<WalletSecurityScan>;
  analyzeToken(mint: string): Promise<TokenSecurityReport>;
  analyzeTransaction(input: string): Promise<TransactionAnalysis>;
}

export interface ToolTrace {
  tool: string;
  output: unknown;
}

function riskView(r: RiskAssessment) {
  return {
    level: r.level,
    status: r.status,
    score: r.score,
    summary: r.summary,
    signals: r.signals.map((s) => ({ code: s.code, title: s.title, severity: s.severity, description: s.description, evidenceIds: s.evidenceIds })),
    evidence: r.evidence,
    sources: r.sources,
  };
}

function tokenLabel(r: TokenSecurityReport | null, mint: string) {
  return { mint, name: r?.metadata?.name ?? null, symbol: r?.metadata?.symbol ?? null };
}

export function walletOverview(scan: WalletSecurityScan) {
  return {
    dataMode: scan.demo ? "DEMO (synthetic, not blockchain data)" : "LIVE",
    wallet: scan.snapshot.address,
    snapshotStatus: scan.snapshot.status,
    metrics: scan.metrics,
    portfolio: scan.portfolio,
    walletRisk: riskView(scan.walletRisk),
    tokens: scan.tokens.map((t) => ({
      ...tokenLabel(t.report, t.holding.mint),
      balance: t.holding.uiAmount,
      level: t.report?.risk.level ?? "UNKNOWN",
      status: t.report?.risk.status ?? "UNAVAILABLE",
      signals: t.report?.risk.signals.map((s) => ({ code: s.code, title: s.title, severity: s.severity, evidenceIds: s.evidenceIds })) ?? [],
      evidence: t.report?.risk.evidence ?? [],
    })),
    nftsAndCnfts: scan.assets.map((a) => ({
      id: a.asset.id,
      name: a.asset.name,
      description: a.asset.description,
      compressed: a.asset.compressed,
      level: a.risk.level,
      status: a.risk.status,
      signals: a.risk.signals.map((s) => ({ code: s.code, title: s.title, severity: s.severity, evidenceIds: s.evidenceIds })),
      evidence: a.risk.evidence,
    })),
  };
}

export function transactionView(a: TransactionAnalysis) {
  return {
    dataMode: a.demo ? "DEMO (synthetic, not a real simulation)" : "LIVE",
    inputKind: a.inputKind,
    perspectiveWallet: a.perspectiveWallet,
    decoded: {
      version: a.decoded.version,
      feePayer: a.decoded.feePayer,
      signers: a.decoded.signers,
      programs: a.decoded.programs,
      instructions: a.decoded.instructions.map((i) => ({ index: i.index, type: i.type, program: i.programName, info: i.info })),
      solTransfers: a.decoded.solTransfers,
      tokenTransfers: a.decoded.tokenTransfers,
      approvals: a.decoded.approvals,
      authorityChanges: a.decoded.authorityChanges,
    },
    effects: a.effects
      ? { source: a.effects.source, success: a.effects.success, error: a.effects.error, solChanges: a.effects.solChanges, tokenChanges: a.effects.tokenChanges, notes: a.effects.notes, logs: a.effects.logs }
      : "NOT AVAILABLE — simulation could not be performed; asset movements are unknown",
    risk: riskView(a.risk),
  };
}

export function createSecurityTools(provider: SecurityDataProvider, traces: ToolTrace[]) {
  const record = <T>(name: string, output: T): unknown => {
    traces.push({ tool: name, output });
    return sanitizeForAi(output, { maskWallet: provider.wallet ?? undefined });
  };
  const needWallet = () => {
    if (!provider.wallet) return { error: "No wallet is connected or selected. Ask the user to connect a wallet or open Demo Mode." };
    return null;
  };

  return {
    get_wallet_security_overview: tool({
      description: "Scan the user's wallet: SOL balance, tokens, NFTs/cNFTs, deterministic risk levels, analysis status and evidence.",
      inputSchema: z.object({}),
      execute: async () => needWallet() ?? record("get_wallet_security_overview", walletOverview(await provider.getWalletScan())),
    }),
    find_scam_tokens: tool({
      description: "List holdings and NFTs/cNFTs whose deterministic risk is MEDIUM, HIGH or CRITICAL, with evidence.",
      inputSchema: z.object({}),
      execute: async () => {
        const missing = needWallet();
        if (missing) return missing;
        const o = walletOverview(await provider.getWalletScan());
        const risky = (l: string) => l === "MEDIUM" || l === "HIGH" || l === "CRITICAL";
        return record("find_scam_tokens", { dataMode: o.dataMode, tokens: o.tokens.filter((t) => risky(t.level)), nftsAndCnfts: o.nftsAndCnfts.filter((a) => risky(a.level)) });
      },
    }),
    analyze_token: tool({
      description: "Deep security analysis of one token mint (authorities, Token-2022 extensions, liquidity, holders, RugCheck).",
      inputSchema: z.object({ mint: z.string().describe("Token mint address (base58)") }),
      execute: async ({ mint }) => {
        if (!isValidPublicKey(mint)) return { error: "Invalid mint address." };
        const r = await provider.analyzeToken(mint);
        return record("analyze_token", {
          ...tokenLabel(r, mint),
          authorities: r.mintInfo ? { mintAuthority: r.mintInfo.mintAuthority, freezeAuthority: r.mintInfo.freezeAuthority, program: r.mintInfo.program, extensions: r.mintInfo.extensionNames } : "UNAVAILABLE",
          risk: riskView(r.risk),
        });
      },
    }),
    analyze_transaction: tool({
      description: "Decode, simulate and risk-analyze a transaction (signature or base64/base58 serialized transaction). Use input 'demo' in demo mode.",
      inputSchema: z.object({ input: z.string().max(2000) }),
      execute: async ({ input }) => record("analyze_transaction", transactionView(await provider.analyzeTransaction(input))),
    }),
    get_cleanup_options: tool({
      description: "List burn/close/revoke eligibility per token account and cNFT from the capability matrix. Does NOT prepare or sign anything.",
      inputSchema: z.object({}),
      execute: async () => {
        const missing = needWallet();
        if (missing) return missing;
        const scan = await provider.getWalletScan();
        return record("get_cleanup_options", {
          dataMode: scan.demo ? "DEMO" : "LIVE",
          note: "The assistant cannot execute cleanup. The user reviews, simulates and signs in the Cleanup panel with their own wallet.",
          tokenAccounts: scan.tokens.flatMap((t) => t.cleanup.map((c) => ({ ...c, symbol: t.report?.metadata?.symbol ?? null, risk: t.report?.risk.level ?? "UNKNOWN" }))),
          cnfts: scan.assets.filter((a) => a.cleanup).map((a) => ({ id: a.asset.id, name: a.asset.name, ...a.cleanup })),
        });
      },
    }),
  };
}
