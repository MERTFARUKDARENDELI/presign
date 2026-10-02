import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { GATE_MEANING } from "@/lib/agent/gate";
import { CONTROL_TEXT } from "@/lib/multisig/brief";
import type { InspectResult, MultisigOverview, ProposalInspection } from "@/lib/multisig/types";
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
  /** Squads proposal, multisig or Presign Guard inspection, with the same signer and team policy the page used. */
  inspect(input: string): Promise<InspectResult>;
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
      usesDurableNonce: a.decoded.usesDurableNonce,
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

export function proposalView(i: ProposalInspection) {
  const account = i.analysis.account;
  const proposal = i.analysis.proposals.find((p) => p.transactionIndex === i.transactionIndex)?.account ?? null;
  return {
    kind: "SQUADS_PROPOSAL",
    cluster: i.cluster,
    multisig: i.multisig,
    transactionIndex: i.transactionIndex,
    transactionKind: i.transactionKind,
    stale: i.stale,
    proposal: proposal ? { status: proposal.status, approvals: proposal.approved.length, rejections: proposal.rejected.length } : "NOT FOUND",
    multisigSetup: account
      ? { threshold: account.threshold, members: account.members.length, timeLockSeconds: account.timeLock, configAuthority: account.configAuthority ?? "none (autonomous)" }
      : "UNAVAILABLE",
    gate: i.gate,
    gateMeaning: GATE_MEANING[i.gate],
    signerBrief: i.brief,
    authorityChanges: i.analysis.payloads.flatMap((p) =>
      p.privileged.map((a) => ({
        action: a.action,
        program: a.programName,
        target: a.target,
        newAuthority: a.newAuthority,
        whoControlsItAfterwards: a.control ? CONTROL_TEXT[a.control] : "unknown",
        nameSource: a.source === "ANCHOR_IDL" ? "IDL name chosen by the program author (states intent, not verified behavior)" : "decoded by Presign",
      })),
    ),
    payloads: i.analysis.payloads.map((p) => ({ status: p.status, detail: p.detail, simulation: p.effectsStatus ?? "NOT RUN", simulationNote: p.simulationNote ?? null, foreignSigners: p.foreignSigners ?? [] })),
    configActions: i.analysis.configActions,
    teamPolicy: i.policy ? { name: i.policy.name, status: i.policy.status, checks: i.policy.checks } : "NO POLICY SUPPLIED",
    risk: riskView(i.risk),
  };
}

export function multisigView(o: MultisigOverview) {
  return {
    kind: "SQUADS_MULTISIG",
    cluster: o.cluster,
    multisig: o.multisig,
    setup: o.account
      ? { threshold: o.account.threshold, members: o.account.members.length, timeLockSeconds: o.account.timeLock, configAuthority: o.account.configAuthority ?? "none (autonomous)" }
      : "UNAVAILABLE",
    posture: riskView(o.posture),
    teamPolicy: o.policy ? { name: o.policy.name, status: o.policy.status, checks: o.policy.checks } : "NO POLICY SUPPLIED",
    recentProposals: o.proposals,
    inspectedLimit: o.inspectedLimit,
  };
}

function inspectView(r: InspectResult) {
  if (r.kind === "proposal") return proposalView(r.inspection);
  if (r.kind === "multisig") return multisigView(r.overview);
  if (r.kind === "guard") return { kind: "PRESIGN_GUARD", guard: r.overview.guard, account: r.overview.account, posture: riskView(r.overview.posture), actions: r.overview.actions };
  const g = r.inspection;
  return { kind: "PRESIGN_GUARD_ACTION", guard: g.guard, address: g.address, action: g.action, scheduled: g.scheduled, gate: g.gate, gateMeaning: GATE_MEANING[g.gate], now: g.now, risk: riskView(g.risk) };
}

type ToolInput = Record<string, unknown>;

interface ToolSpec {
  description: string;
  properties: Record<string, { type: "string"; description: string }>;
  input: z.ZodType<ToolInput>;
  execute(input: ToolInput): Promise<unknown>;
}

export interface SecurityTools {
  definitions: Anthropic.Beta.BetaTool[];
  /** Runs a tool by name. Invalid names or inputs return an error object, never throw. */
  run(name: string, input: unknown): Promise<{ output: unknown; isError: boolean }>;
}

export function createSecurityTools(provider: SecurityDataProvider, traces: ToolTrace[]): SecurityTools {
  const record = (name: string, output: unknown): unknown => {
    traces.push({ tool: name, output });
    return sanitizeForAi(output, { maskWallet: provider.wallet ?? undefined });
  };
  const needWallet = () => (provider.wallet ? null : { error: "No wallet is connected or selected. Ask the user to connect a wallet or open Demo Mode." });
  const none = z.object({}).strict();

  const specs: Record<string, ToolSpec> = {
    inspect_multisig_or_proposal: {
      description:
        "Load and analyze a Squads v4 proposal, a Squads multisig, or a Presign Guard from chain: decoded vault instructions, who controls each authority afterwards, simulation, setup risks, team policy and the deterministic gate. Input: a Squads link, a proposal / multisig / guard address, or '<multisig> #<index>'.",
      properties: { input: { type: "string", description: "Squads link, address, or '<multisig> #<index>'" } },
      input: z.object({ input: z.string().trim().min(1).max(500) }).strict(),
      execute: async ({ input }) => record("inspect_multisig_or_proposal", inspectView(await provider.inspect(input as string))),
    },
    analyze_transaction: {
      description: "Decode, simulate and risk-analyze a transaction (signature or base64/base58 serialized transaction). Squads approvals include the proposal they approve. Use input 'demo' in demo mode.",
      properties: { input: { type: "string", description: "Transaction signature or serialized transaction" } },
      input: z.object({ input: z.string().max(2000) }).strict(),
      execute: async ({ input }) => record("analyze_transaction", transactionView(await provider.analyzeTransaction(input as string))),
    },
    get_wallet_security_overview: {
      description: "Scan the user's wallet: SOL balance, tokens, NFTs/cNFTs, deterministic risk levels, analysis status and evidence.",
      properties: {},
      input: none,
      execute: async () => needWallet() ?? record("get_wallet_security_overview", walletOverview(await provider.getWalletScan())),
    },
    find_scam_tokens: {
      description: "List holdings and NFTs/cNFTs whose deterministic risk is MEDIUM, HIGH or CRITICAL, with evidence.",
      properties: {},
      input: none,
      execute: async () => {
        const missing = needWallet();
        if (missing) return missing;
        const o = walletOverview(await provider.getWalletScan());
        const risky = (l: string) => l === "MEDIUM" || l === "HIGH" || l === "CRITICAL";
        return record("find_scam_tokens", { dataMode: o.dataMode, tokens: o.tokens.filter((t) => risky(t.level)), nftsAndCnfts: o.nftsAndCnfts.filter((a) => risky(a.level)) });
      },
    },
    analyze_token: {
      description: "Deep security analysis of one token mint (authorities, Token-2022 extensions, liquidity, holders, RugCheck).",
      properties: { mint: { type: "string", description: "Token mint address (base58)" } },
      input: z.object({ mint: z.string() }).strict(),
      execute: async ({ mint }) => {
        if (!isValidPublicKey(mint as string)) return { error: "Invalid mint address." };
        const r = await provider.analyzeToken(mint as string);
        return record("analyze_token", {
          ...tokenLabel(r, mint as string),
          authorities: r.mintInfo ? { mintAuthority: r.mintInfo.mintAuthority, freezeAuthority: r.mintInfo.freezeAuthority, program: r.mintInfo.program, extensions: r.mintInfo.extensionNames } : "UNAVAILABLE",
          risk: riskView(r.risk),
        });
      },
    },
    get_cleanup_options: {
      description: "List burn/close/revoke eligibility per token account and cNFT from the capability matrix. Does NOT prepare or sign anything.",
      properties: {},
      input: none,
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
    },
  };

  const definitions: Anthropic.Beta.BetaTool[] = Object.entries(specs).map(([name, s]) => ({
    name,
    description: s.description,
    strict: true,
    input_schema: { type: "object", properties: s.properties, required: Object.keys(s.properties), additionalProperties: false },
  }));

  return {
    definitions,
    async run(name, input) {
      const spec = Object.hasOwn(specs, name) ? specs[name] : undefined;
      if (!spec) return { output: { error: `Unknown tool: ${name}` }, isError: true };
      const parsed = spec.input.safeParse(input ?? {});
      if (!parsed.success) return { output: { error: "Invalid tool input." }, isError: true };
      try {
        return { output: await spec.execute(parsed.data), isError: false };
      } catch (error) {
        // Tool failures reach the model as data; it must then say the analysis is unavailable.
        const message = error instanceof Error ? error.message.slice(0, 300) : "Tool failed.";
        return { output: { error: `Analysis unavailable: ${message}` }, isError: true };
      }
    },
  };
}
