import { USDC_MINT, USDT_MINT } from "@/lib/solana/constants";
import { impersonatedToken } from "@/lib/token/well-known";
import { isMetaplexEditionControlled } from "@/lib/solana/metaplex";
import { describeAge, isConclusivelyEstablished, TOKEN_AGE_THRESHOLDS, type TokenAge } from "@/lib/token/age";
import type { RugcheckData, RugcheckResult } from "@/lib/token/rugcheck-types";
import type { MintInfo, TokenMetadata } from "@/lib/token/types";
import { buildAssessment } from "../engine";
import type { RiskAssessment, RiskSignal } from "../risk";
import { hasLink, scanText } from "../text-signals";
import { assessLinksInText, urlEvidenceText, worstUrlLevel } from "../url-reputation";
import type { AnalysisStatus, DataSourceStatus, Evidence } from "../types";

/**
 * Deterministic token risk rules. Every signal references evidence with a
 * named data source. Thresholds are constants so results are reproducible.
 */

export const TOKEN_THRESHOLDS = {
  liquidityHighUsd: 1_000,
  liquidityMediumUsd: 10_000,
  minHolders: 50,
  top1HighPct: 50,
  top10MediumPct: 90,
  transferFeeHighBps: 1_000,
} as const;

/** Centrally-issued stablecoins whose authorities are documented issuer controls. */
const ISSUER_CONTROLLED = new Set([USDC_MINT, USDT_MINT]);

export interface HolderConcentration {
  top1Pct: number;
  top10Pct: number;
}

export interface TokenRuleInput {
  mintAddress: string;
  mint: MintInfo | null;
  mintStatus: "OK" | "NOT_FOUND" | "NOT_A_MINT" | "FAILED";
  rugcheck: RugcheckResult | null;
  concentration: HolderConcentration | null;
  concentrationStatus: "OK" | "FAILED" | "SKIPPED";
  metadata: TokenMetadata | null;
  metadataStatus: "OK" | "FAILED" | "NOT_CONFIGURED" | "SKIPPED";
  /** Token age (deep scan). Undefined = not checked (wallet scan), which leaves the status unchanged. */
  age?: TokenAge;
  now?: Date;
}

class Collector {
  evidence: Evidence[] = [];
  signals: RiskSignal[] = [];
  constructor(private readonly prefix: string) {}

  ev(key: string, e: Omit<Evidence, "id">): string {
    const id = `${this.prefix}:${key}`;
    if (!this.evidence.some((x) => x.id === id)) this.evidence.push({ id, ...e });
    return id;
  }

  signal(s: RiskSignal): void {
    this.signals.push(s);
  }
}

function slug(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
}

function rugcheckSignals(c: Collector, data: RugcheckData) {
  if (data.rugged === true) {
    const id = c.ev("rugcheck.rugged", { source: "RUGCHECK", label: "RugCheck rugged flag", observed: true, condition: "rugged = true" });
    c.signal({ code: "TOKEN_RUGCHECK_RUGGED", title: "Reported as rugged by RugCheck", description: "RugCheck (external provider) marks this token as rugged.", severity: "CRITICAL", evidenceIds: [id] });
  }

  if (data.liquidityUsd !== null) {
    const id = c.ev("rugcheck.liquidity", { source: "RUGCHECK", label: "Total market liquidity (USD, RugCheck)", observed: data.liquidityUsd.toFixed(2), condition: `< ${TOKEN_THRESHOLDS.liquidityMediumUsd}` });
    if (data.liquidityUsd < TOKEN_THRESHOLDS.liquidityHighUsd) {
      c.signal({ code: "TOKEN_LIQUIDITY_VERY_LOW", title: "Very low liquidity", description: `Reported liquidity is below $${TOKEN_THRESHOLDS.liquidityHighUsd}; the token may be impossible to sell.`, severity: "HIGH", evidenceIds: [id] });
    } else if (data.liquidityUsd < TOKEN_THRESHOLDS.liquidityMediumUsd) {
      c.signal({ code: "TOKEN_LIQUIDITY_LOW", title: "Low liquidity", description: `Reported liquidity is below ${TOKEN_THRESHOLDS.liquidityMediumUsd}.`, severity: "MEDIUM", evidenceIds: [id] });
    }
  } else if (data.liquidityReportedZero) {
    // CLAUDE.md rule 3: a reported $0 is missing market data, not proof of a dead token — no signal, and the analysis stays PARTIAL.
    c.ev("rugcheck.liquidity", { source: "RUGCHECK", label: "Total market liquidity (USD, RugCheck)", observed: "0 — treated as unknown", condition: "a reported $0 is not used as a signal" });
  }

  if (data.totalHolders !== null && data.totalHolders < TOKEN_THRESHOLDS.minHolders) {
    const id = c.ev("rugcheck.holders", { source: "RUGCHECK", label: "Holder count (RugCheck)", observed: String(data.totalHolders), condition: `< ${TOKEN_THRESHOLDS.minHolders}` });
    c.signal({ code: "TOKEN_FEW_HOLDERS", title: "Very few holders", description: "Very small holder base; typical of new or spam tokens.", severity: "MEDIUM", evidenceIds: [id] });
  }

  // Authority checks are done from on-chain data; skip provider duplicates.
  const dup = /(mint authority|freeze authority|permanent delegate)/i;
  for (const r of data.risks) {
    if (dup.test(r.name) || (r.level !== "danger" && r.level !== "warn")) continue;
    const key = slug(r.name);
    const id = c.ev(`rugcheck.risk.${key}`, { source: "RUGCHECK", label: `RugCheck risk: ${r.name}`, observed: r.level, condition: "level in {danger, warn}" });
    c.signal({
      code: `TOKEN_RUGCHECK_${key}`,
      title: `RugCheck: ${r.name}`,
      description: r.description || "Risk reported by RugCheck.",
      severity: r.level === "danger" ? "HIGH" : "LOW",
      evidenceIds: [id],
    });
  }
}

export function evaluateTokenRisk(input: TokenRuleInput): RiskAssessment {
  const c = new Collector(`token:${input.mintAddress}`);
  const statuses: AnalysisStatus[] = [];
  const sources: DataSourceStatus[] = [];
  const m = input.mint;

  // --- On-chain mint state (required) ---
  if (!m) {
    statuses.push("INSUFFICIENT_DATA");
    sources.push({ source: "ONCHAIN_RPC", status: "FAILED", detail: input.mintStatus === "FAILED" ? "Mint account could not be fetched" : "Account is not a valid SPL/Token-2022 mint" });
  } else {
    statuses.push("COMPLETE");
    sources.push({ source: "ONCHAIN_RPC", status: "OK", detail: `Mint account (${m.program})` });
    const issuer = ISSUER_CONTROLLED.has(m.address);

    c.ev("program", { source: "ONCHAIN_RPC", label: "Token program", observed: m.program });

    const editionControlled = isMetaplexEditionControlled(m);
    if (editionControlled) {
      // Standard (programmable) NFT: both authorities are the mint's own Master
      // Edition PDA (derived, not trusted from metadata) — protocol control, not an issuer freeze.
      c.ev("nftEdition", { source: "DETERMINISTIC_RULE", label: "Authorities held by Metaplex Master Edition PDA", observed: m.freezeAuthority, condition: "freeze/mint authority = derived edition PDA" });
    } else if (m.mintAuthority) {
      const id = c.ev("mintAuthority", { source: "ONCHAIN_RPC", label: "Mint Authority", observed: m.mintAuthority, condition: "not null" });
      c.signal({ code: "TOKEN_MINT_AUTHORITY_ACTIVE", title: "Mint Authority active", description: issuer ? "Issuer can mint new supply (documented issuer control for this stablecoin)." : "The authority can mint unlimited new tokens and dilute holders.", severity: issuer ? "LOW" : "MEDIUM", evidenceIds: [id] });
    } else {
      c.ev("mintAuthority", { source: "ONCHAIN_RPC", label: "Mint Authority", observed: null, condition: "not null" });
    }

    if (editionControlled) {
      // covered by the nftEdition evidence above
    } else if (m.freezeAuthority) {
      const id = c.ev("freezeAuthority", { source: "ONCHAIN_RPC", label: "Freeze Authority", observed: m.freezeAuthority, condition: "not null" });
      c.signal({ code: "TOKEN_FREEZE_AUTHORITY_ACTIVE", title: "Freeze Authority active", description: issuer ? "Issuer can freeze token accounts (documented issuer control for this stablecoin)." : "The authority can freeze your token account so you cannot sell or transfer.", severity: issuer ? "MEDIUM" : "HIGH", evidenceIds: [id] });
    } else {
      c.ev("freezeAuthority", { source: "ONCHAIN_RPC", label: "Freeze Authority", observed: null, condition: "not null" });
    }

    const x = m.extensions;
    if (x.permanentDelegate) {
      const id = c.ev("permanentDelegate", { source: "ONCHAIN_RPC", label: "Token-2022 Permanent Delegate", observed: x.permanentDelegate, condition: "not null" });
      c.signal({ code: "TOKEN_PERMANENT_DELEGATE", title: "Permanent Delegate", description: "A permanent delegate can transfer or burn tokens from ANY holder's account at any time.", severity: "CRITICAL", evidenceIds: [id] });
    }
    if (x.transferHookProgramId) {
      const id = c.ev("transferHook", { source: "ONCHAIN_RPC", label: "Token-2022 Transfer Hook program", observed: x.transferHookProgramId, condition: "not null" });
      c.signal({ code: "TOKEN_TRANSFER_HOOK", title: "Transfer hook", description: "Every transfer invokes a custom program that can block or alter transfers.", severity: "MEDIUM", evidenceIds: [id] });
    }
    if (x.transferFeeBasisPoints !== null && x.transferFeeBasisPoints > 0) {
      const id = c.ev("transferFee", { source: "ONCHAIN_RPC", label: "Token-2022 transfer fee (bps)", observed: String(x.transferFeeBasisPoints), condition: "> 0" });
      const high = x.transferFeeBasisPoints >= TOKEN_THRESHOLDS.transferFeeHighBps;
      c.signal({ code: high ? "TOKEN_TRANSFER_FEE_HIGH" : "TOKEN_TRANSFER_FEE", title: high ? "High transfer fee" : "Transfer fee", description: `${(x.transferFeeBasisPoints / 100).toFixed(2)}% of every transfer is withheld.`, severity: high ? "HIGH" : "LOW", evidenceIds: [id] });
    }
    if (x.nonTransferable) {
      const id = c.ev("nonTransferable", { source: "ONCHAIN_RPC", label: "Token-2022 NonTransferable", observed: true });
      c.signal({ code: "TOKEN_NON_TRANSFERABLE", title: "Non-transferable", description: "This token cannot be transferred or sold.", severity: "MEDIUM", evidenceIds: [id] });
    }
    if (x.defaultAccountState === "frozen") {
      const id = c.ev("defaultState", { source: "ONCHAIN_RPC", label: "Token-2022 default account state", observed: "frozen", condition: "= frozen" });
      c.signal({ code: "TOKEN_DEFAULT_FROZEN", title: "New accounts frozen by default", description: "Holders are frozen unless the authority thaws them.", severity: "HIGH", evidenceIds: [id] });
    }
    if (x.paused) {
      const id = c.ev("paused", { source: "ONCHAIN_RPC", label: "Token-2022 pausable state", observed: "paused", condition: "paused = true" });
      c.signal({ code: "TOKEN_PAUSED", title: "Token paused", description: "Transfers are currently paused by the authority.", severity: "HIGH", evidenceIds: [id] });
    }

    if (m.onchainMetadata) {
      metadataTextSignals(c, `${m.onchainMetadata.name ?? ""} ${m.onchainMetadata.symbol ?? ""}`, "ONCHAIN_RPC", "onchainMeta");
    }
  }

  // --- RugCheck (external opinion, optional) ---
  if (!input.rugcheck) {
    sources.push({ source: "RUGCHECK", status: "SKIPPED" });
    statuses.push("PARTIAL");
  } else if (input.rugcheck.ok) {
    sources.push({ source: "RUGCHECK", status: "OK", detail: `RugCheck ${input.rugcheck.data.detail} report` });
    rugcheckSignals(c, input.rugcheck.data);
    // Full report with market data is required for liquidity/holder checks.
    const complete = input.rugcheck.data.detail === "full" && input.rugcheck.data.liquidityUsd !== null && input.rugcheck.data.totalHolders !== null;
    if (input.rugcheck.data.detail === "full" && !complete) {
      sources.push({ source: "RUGCHECK", status: "FAILED", detail: input.rugcheck.data.liquidityReportedZero ? "RugCheck reports $0 liquidity — treated as unknown, not as very low" : "No market/holder data from RugCheck — liquidity unknown" });
    }
    statuses.push(complete ? "COMPLETE" : "PARTIAL");
  } else if (input.rugcheck.reason === "UNSUPPORTED_CLUSTER") {
    // Not a failure, but the liquidity/holder checks still did not run: stays PARTIAL.
    sources.push({ source: "RUGCHECK", status: "UNSUPPORTED", detail: "RugCheck indexes mainnet only; not used on this cluster" });
    statuses.push("PARTIAL");
  } else {
    sources.push({ source: "RUGCHECK", status: "FAILED", detail: input.rugcheck.reason === "NOT_FOUND" ? "Token not indexed by RugCheck" : "RugCheck unavailable" });
    statuses.push("PARTIAL");
  }

  // --- Holder concentration (on-chain, getTokenLargestAccounts) ---
  if (input.concentration) {
    sources.push({ source: "ONCHAIN_RPC", status: "OK", detail: "Largest token accounts" });
    const { top1Pct, top10Pct } = input.concentration;
    const id1 = c.ev("top1", { source: "ONCHAIN_RPC", label: "Largest account share of supply (%)", observed: top1Pct.toFixed(2), condition: `>= ${TOKEN_THRESHOLDS.top1HighPct}` });
    const id10 = c.ev("top10", { source: "ONCHAIN_RPC", label: "Top 10 accounts share of supply (%)", observed: top10Pct.toFixed(2), condition: `>= ${TOKEN_THRESHOLDS.top10MediumPct}` });
    if (top1Pct >= TOKEN_THRESHOLDS.top1HighPct) {
      c.signal({ code: "TOKEN_HOLDER_CONCENTRATION_HIGH", title: "Single account holds most supply", description: "One token account holds at least half of the supply (could be a pool or exchange; verify).", severity: "HIGH", evidenceIds: [id1] });
    } else if (top10Pct >= TOKEN_THRESHOLDS.top10MediumPct) {
      c.signal({ code: "TOKEN_HOLDER_CONCENTRATION", title: "Concentrated supply", description: "Top 10 accounts hold most of the supply (pools/exchanges included).", severity: "MEDIUM", evidenceIds: [id10] });
    }
    statuses.push("COMPLETE");
  } else if (input.concentrationStatus === "FAILED") {
    sources.push({ source: "ONCHAIN_RPC", status: "FAILED", detail: "Largest token accounts unavailable" });
    statuses.push("PARTIAL");
  }

  // --- Metadata (Helius DAS, untrusted text) ---
  if (input.metadata) {
    sources.push({ source: "HELIUS_DAS", status: "OK", detail: "Token metadata" });
    metadataTextSignals(c, `${input.metadata.name ?? ""} ${input.metadata.symbol ?? ""}`, "HELIUS_DAS", "meta");
    // Links in a description are normal; only links matching phishing patterns are flagged.
    const desc = scanText(input.metadata.description);
    if (hasLink(desc)) urlReputationEvidence(c, assessLinksInText([...desc.urls, ...desc.domains]), "HELIUS_DAS", "meta.descriptionLinkReputation");
  } else if (input.metadataStatus !== "SKIPPED") {
    sources.push({ source: "HELIUS_DAS", status: input.metadataStatus === "NOT_CONFIGURED" ? "NOT_CONFIGURED" : "FAILED", detail: "Token metadata" });
    statuses.push("PARTIAL");
  }

  // --- Impersonation of a widely held token (symbol / name of USDC, SOL, JUP… on another mint) ---
  const labels = [input.metadata, m?.onchainMetadata].filter((x): x is { name?: string; symbol?: string } => !!x);
  for (const l of labels) {
    const claimed = impersonatedToken(input.mintAddress, l.symbol, l.name);
    if (!claimed) continue;
    const id = c.ev("impersonation", { source: "DETERMINISTIC_RULE", label: "Token symbol / name", observed: `${l.symbol ?? ""} ${l.name ?? ""}`.trim().slice(0, 60), condition: `claims ${claimed} but is not its canonical mint` });
    c.signal({ code: "TOKEN_IMPERSONATION", title: `Pretends to be ${claimed}`, description: `This token uses the ${claimed} symbol or name, but it is not the real ${claimed} mint. Fake copies of popular tokens are used in honeypot swaps and address-poisoning dust; they are usually worthless.`, severity: "HIGH", evidenceIds: [id] });
    break;
  }

  // --- Token age (evaluated last: the combined signal looks at the factors above) ---
  if (m) ageSignals(c, input.age, statuses, sources);

  const status = m ? reduceStatus(statuses) : "INSUFFICIENT_DATA";
  return buildAssessment({ category: "token", signals: c.signals, evidence: c.evidence, sources, status, now: input.now });
}

function reduceStatus(statuses: AnalysisStatus[]): AnalysisStatus {
  if (statuses.includes("INSUFFICIENT_DATA")) return "INSUFFICIENT_DATA";
  return statuses.every((s) => s === "COMPLETE") ? "COMPLETE" : "PARTIAL";
}

function metadataTextSignals(c: Collector, text: string, source: "HELIUS_DAS" | "ONCHAIN_RPC", key: string) {
  const s = scanText(text);
  if (hasLink(s)) {
    const links = assessLinksInText([...s.urls, ...s.domains]);
    // Defanged hosts only: raw URLs/paths from untrusted metadata are never echoed.
    const id = c.ev(`${key}.link`, { source, label: "Link embedded in token name/symbol", observed: links.map((a) => a.displayHost).join(", ").slice(0, 200), condition: "name/symbol contains URL or domain" });
    c.signal({ code: "TOKEN_METADATA_LINK", title: "Link in token name", description: "Legitimate tokens do not put website links in their name/symbol; this is a common phishing lure.", severity: "HIGH", evidenceIds: [id] });
    urlReputationEvidence(c, links, source, `${key}.linkReputation`);
  }
  if (s.lureKeywords.length > 0 && hasLink(s)) {
    const id = c.ev(`${key}.lure`, { source, label: "Lure keywords in token name", observed: s.lureKeywords.join(", "), condition: "claim/airdrop/reward style wording with a link" });
    c.signal({ code: "TOKEN_METADATA_LURE", title: "Airdrop/claim lure", description: "Name combines a link with claim/reward wording, a known scam pattern.", severity: "HIGH", evidenceIds: [id] });
  }
}

/** Pattern-based link reputation as evidence (+ a signal only when a phishing pattern matched). */
function urlReputationEvidence(c: Collector, links: ReturnType<typeof assessLinksInText>, source: "HELIUS_DAS" | "ONCHAIN_RPC", key: string) {
  const flagged = links.filter((a) => a.level === "MEDIUM" || a.level === "HIGH");
  if (flagged.length === 0) return;
  const id = c.ev(key, { source: "DETERMINISTIC_RULE", label: `Link pattern checks (${source === "HELIUS_DAS" ? "DAS metadata" : "on-chain metadata"})`, observed: flagged.map(urlEvidenceText).join("; ").slice(0, 300), condition: "obfuscation / impersonation / shortener patterns; no external reputation service" });
  const level = worstUrlLevel(flagged);
  c.signal({
    code: level === "HIGH" ? "TOKEN_METADATA_PHISHING_URL" : "TOKEN_METADATA_SUSPICIOUS_URL",
    title: level === "HIGH" ? "Phishing-pattern link in metadata" : "Suspicious link in metadata",
    description: "The link matches deterministic phishing patterns (look-alike brand, hidden destination or obfuscation). Do not open it.",
    severity: level === "HIGH" ? "HIGH" : "MEDIUM",
    evidenceIds: [id],
  });
}

/**
 * Token age. Age alone is weak evidence (max MEDIUM); a KNOWN very new token
 * combined with an independent risk factor raises a HIGH combined signal.
 * Unknown or inconclusive age is reported, never guessed, and keeps the
 * analysis PARTIAL.
 */
function ageSignals(c: Collector, age: TokenAge | undefined, statuses: AnalysisStatus[], sources: DataSourceStatus[]) {
  if (!age) {
    sources.push({ source: "ONCHAIN_RPC", status: "SKIPPED", detail: "Token age not checked in wallet scan (deep scan only)" });
    return;
  }
  const src = age.source ?? "ONCHAIN_RPC";
  if (age.status === "UNAVAILABLE" || age.ageSeconds === null) {
    c.ev("age", { source: "ONCHAIN_RPC", label: "Token age", observed: "unavailable", condition: `age < ${TOKEN_AGE_THRESHOLDS.newSeconds / 86_400} d` });
    sources.push({ source: "ONCHAIN_RPC", status: "FAILED", detail: `Token age unavailable (${age.cluster})` });
    statuses.push("PARTIAL");
    return;
  }
  const observed = `${describeAge(age)} (first seen ${age.firstSeenAt}${age.status === "LOWER_BOUND" ? ", lower bound" : ""})`;
  const id = c.ev("age", { source: src, label: age.status === "KNOWN" ? "Token age (mint creation)" : "Token age (minimum)", observed, condition: `age < ${TOKEN_AGE_THRESHOLDS.newSeconds / 86_400} d` });
  sources.push({ source: src, status: "OK", detail: `Token age ${age.status === "KNOWN" ? "from mint creation" : "lower bound"} (${age.cluster})` });

  if (age.status === "LOWER_BOUND") {
    // A lower bound under the threshold cannot tell whether the token is new.
    statuses.push(isConclusivelyEstablished(age) ? "COMPLETE" : "PARTIAL");
    return;
  }
  statuses.push("COMPLETE");
  if (age.ageSeconds >= TOKEN_AGE_THRESHOLDS.newSeconds) return;

  const veryNew = age.ageSeconds < TOKEN_AGE_THRESHOLDS.veryNewSeconds;
  c.signal(veryNew
    ? { code: "TOKEN_VERY_NEW", title: "Created less than a day ago", description: "Brand-new token. New is not the same as malicious, but most rug pulls happen within the first days.", severity: "MEDIUM", evidenceIds: [id] }
    : { code: "TOKEN_NEW", title: "Created this week", description: "Token is less than 7 days old; its track record is short.", severity: "LOW", evidenceIds: [id] });

  const factors = c.signals.filter((s) => ["TOKEN_MINT_AUTHORITY_ACTIVE", "TOKEN_LIQUIDITY_VERY_LOW", "TOKEN_LIQUIDITY_LOW", "TOKEN_FEW_HOLDERS", "TOKEN_HOLDER_CONCENTRATION_HIGH"].includes(s.code) && s.severity !== "LOW");
  if (factors.length > 0) {
    c.signal({
      code: "TOKEN_NEW_WITH_RISK_FACTORS",
      title: "New token with independent risk factors",
      description: `A token under ${TOKEN_AGE_THRESHOLDS.newSeconds / 86_400} days old that also has: ${factors.map((f) => f.title.toLowerCase()).join(", ")}. This combination matches common rug-pull setups.`,
      severity: "HIGH",
      evidenceIds: [id, ...new Set(factors.flatMap((f) => f.evidenceIds))],
    });
  }
}

/** Holder concentration from getTokenLargestAccounts amounts (raw strings) and supply. */
export function computeConcentration(largestRaw: string[], supplyRaw: string): HolderConcentration | null {
  const supply = BigInt(supplyRaw);
  if (supply === 0n || largestRaw.length === 0) return null;
  const amounts = largestRaw.map((a) => BigInt(a)).sort((a, b) => (b > a ? 1 : b < a ? -1 : 0));
  const pct = (v: bigint) => Number((v * 1_000_000n) / supply) / 10_000;
  return {
    top1Pct: pct(amounts[0]),
    top10Pct: pct(amounts.slice(0, 10).reduce((s, v) => s + v, 0n)),
  };
}
