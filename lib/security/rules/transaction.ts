import type { MultisigAnalysis } from "@/lib/multisig/types";
import { SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@/lib/solana/constants";
import { formatLamports, formatRawAmount } from "@/lib/token/amount";
import { estimatePriorityFeeLamports, formatTxVersion } from "@/lib/transaction/decoder";
import { walletNetChanges } from "@/lib/transaction/effects";
import type { DecodedTransaction, TransactionEffects } from "@/lib/transaction/types";
import { buildAssessment } from "../engine";
import type { RiskAssessment, RiskSignal } from "../risk";
import { hasLink, scanText } from "../text-signals";
import type { AnalysisStatus, DataSourceStatus, Evidence } from "../types";
import { assessLinksInText, urlEvidenceText, worstUrlLevel } from "../url-reputation";
import { multisigSignals } from "./multisig";

type EvFn = (e: Omit<Evidence, "id">) => string;

/**
 * Token-2022 extension instructions with direct wallet-security impact.
 * Only instructions of the Token-2022 program count; names alone never do.
 */
function token2022Signals(decoded: DecodedTransaction, wallet: string, ev: EvFn, signals: RiskSignal[], unknownProgramEvidence: string | null) {
  const all = [...decoded.instructions, ...decoded.innerInstructions].filter((i) => i.programId === TOKEN_2022_PROGRAM_ID);

  const guardOff = all.filter((i) => i.type === "token-2022:disableCpiGuard" && i.info.owner === wallet);
  if (guardOff.length > 0) {
    const id = ev({ source: "TRANSACTION_DECODER", label: "Token-2022 DisableCpiGuard", observed: guardOff.map((i) => i.info.account).join(", "), condition: "CPI Guard on a wallet token account is turned off" });
    signals.push({ code: "TX_CPI_GUARD_DISABLED", title: "CPI Guard disabled", description: "Removes a Token-2022 protection that stops other programs from moving tokens out of this account on your behalf.", severity: "MEDIUM", evidenceIds: [id] });
    if (unknownProgramEvidence) {
      signals.push({ code: "TX_CPI_GUARD_DISABLED_WITH_UNKNOWN_PROGRAM", title: "CPI Guard disabled alongside an unverified program", description: "The protection is removed in the same transaction that calls an unidentified program — a drainer pattern.", severity: "HIGH", evidenceIds: [id, unknownProgramEvidence] });
    }
  }

  const confidential = all.filter((i) => i.type.startsWith("token-2022:confidential"));
  if (confidential.length > 0) {
    const id = ev({ source: "TRANSACTION_DECODER", label: "Token-2022 confidential-transfer instructions", observed: String(confidential.length), condition: "encrypted amounts cannot be decoded or simulated as balance changes" });
    signals.push({ code: "TX_TOKEN2022_CONFIDENTIAL", title: "Confidential transfer (amounts hidden)", description: "Encrypted Token-2022 balances are involved; the amounts moved cannot be shown.", severity: "LOW", evidenceIds: [id] });
  }
}

/** Links in memo instructions: flagged only when a deterministic phishing pattern matches. */
function memoLinkSignals(decoded: DecodedTransaction, ev: EvFn, signals: RiskSignal[]) {
  const links = decoded.instructions
    .filter((i) => i.type === "memo" && i.info.memo)
    .flatMap((i) => {
      const s = scanText(i.info.memo);
      return hasLink(s) ? [...s.urls, ...s.domains] : [];
    });
  if (links.length === 0) return;
  const flagged = assessLinksInText(links).filter((a) => a.level === "MEDIUM" || a.level === "HIGH");
  if (flagged.length === 0) return;
  const id = ev({ source: "DETERMINISTIC_RULE", label: "Link in memo (pattern checks)", observed: flagged.map(urlEvidenceText).join("; ").slice(0, 300), condition: "phishing URL patterns; no external reputation service" });
  // A memo cannot move assets itself, so it stays at MEDIUM.
  signals.push({ code: "TX_MEMO_SUSPICIOUS_LINK", title: "Suspicious link in memo", description: `A memo carries a link matching phishing patterns (${worstUrlLevel(flagged)} pattern level). Do not open it.`, severity: "MEDIUM", evidenceIds: [id] });
}

/**
 * Deterministic transaction risk rules evaluated from the perspective of one
 * wallet. Simulation success is only an input here — it never implies SAFE.
 * Unknown destinations/programs are reported as "unverified", not malicious.
 */

export const TX_THRESHOLDS = {
  /** Ignore SOL dust below this (lamports). */
  solNoiseLamports: 10_000n,
  drainRatioPct: 90n,
  multiAssetDrainMints: 3,
} as const;

export interface TxRuleInput {
  decoded: DecodedTransaction;
  effects: TransactionEffects | null;
  wallet: string;
  /** token account → owner, from pre-state (lets rules attribute approvals/closes). */
  tokenAccountOwners?: Record<string, string>;
  /** Extra status for effect collection (e.g. INSUFFICIENT_DATA when simulation could not run). */
  effectsStatus: AnalysisStatus;
  /** Squads multisig layer (proposal contents, configuration), when the transaction touches a multisig. */
  multisig?: MultisigAnalysis | null;
  demo?: boolean;
  now?: Date;
}

export function evaluateTransactionRisk(input: TxRuleInput): RiskAssessment {
  const { decoded, effects, wallet } = input;
  const evidence: Evidence[] = [];
  const signals: RiskSignal[] = [];
  const statuses: AnalysisStatus[] = [];
  const sources: DataSourceStatus[] = [];
  const src = (s: Evidence["source"]) => (input.demo ? "DEMO" : s);
  let n = 0;
  const ev = (e: Omit<Evidence, "id">) => {
    const id = `tx:e${++n}`;
    evidence.push({ id, ...e, source: src(e.source) });
    return id;
  };
  const owners = input.tokenAccountOwners ?? {};
  const ownedByWallet = (tokenAccount: string) =>
    owners[tokenAccount] === wallet ||
    effects?.tokenChanges.some((t) => t.tokenAccount === tokenAccount && t.owner === wallet) === true;

  // ---------- Decoder facts ----------
  sources.push({ source: input.demo ? "DEMO" : "TRANSACTION_DECODER", status: "OK", detail: `${decoded.instructions.length} instruction(s), ${formatTxVersion(decoded.version)}` });
  if (!decoded.lookupTablesResolved) {
    statuses.push("PARTIAL");
    ev({ source: "TRANSACTION_DECODER", label: "Address lookup tables", observed: "unresolved", condition: "some accounts unknown" });
  } else if (decoded.undecodedInstructions.length > 0) {
    statuses.push("PARTIAL");
  } else {
    statuses.push("COMPLETE");
  }

  if (decoded.usesDurableNonce) {
    const id = ev({ source: "TRANSACTION_DECODER", label: "First instruction", observed: "AdvanceNonceAccount", condition: "durable nonce" });
    signals.push({ code: "TX_DURABLE_NONCE", title: "Durable nonce transaction", description: "This signed transaction never expires and could be submitted later, a technique used by drainers.", severity: "MEDIUM", evidenceIds: [id] });
  }

  for (const ch of decoded.authorityChanges) {
    if (ch.kind === "system-assign" && ch.authorityType === "ProgramOwner" && ch.account === wallet && ch.newAuthority !== SYSTEM_PROGRAM_ID) {
      const id = ev({ source: "TRANSACTION_DECODER", label: `Instruction #${ch.instruction} System assign`, observed: `${ch.account} → program ${ch.newAuthority}`, condition: "wallet reassigned to another program" });
      signals.push({ code: "TX_WALLET_OWNER_REASSIGN", title: "Wallet ownership transfer", description: "Your wallet account would be assigned to another program — you could permanently lose control of it.", severity: "CRITICAL", evidenceIds: [id] });
    }
    if (ch.kind === "system-assign" && ch.authorityType === "NonceAuthority" && ch.currentAuthority === wallet) {
      const id = ev({ source: "TRANSACTION_DECODER", label: `Instruction #${ch.instruction} nonce authority`, observed: ch.newAuthority, condition: "authority leaves wallet" });
      signals.push({ code: "TX_NONCE_AUTHORITY_CHANGE", title: "Nonce authority change", description: "Control of a durable nonce account moves to another address.", severity: "HIGH", evidenceIds: [id] });
    }
    if (ch.kind === "program-upgrade-authority" && ch.currentAuthority === wallet && ch.newAuthority !== wallet) {
      const id = ev({ source: "TRANSACTION_DECODER", label: `Instruction #${ch.instruction} BPF loader SetAuthority`, observed: `${ch.account} → ${ch.newAuthority ?? "none (immutable)"}`, condition: "upgrade authority held by wallet is reassigned" });
      signals.push({ code: "TX_UPGRADE_AUTHORITY_CHANGE", title: ch.newAuthority ? "Program upgrade authority transfer" : "Program made immutable", description: ch.newAuthority ? "Control over upgrading a program you own moves to another address — whoever holds it can replace the program's code." : "Removes the upgrade authority permanently; the program can never be upgraded again.", severity: ch.newAuthority ? "CRITICAL" : "HIGH", evidenceIds: [id] });
    }
    if (ch.kind === "token-authority" && ch.currentAuthority === wallet && ch.newAuthority !== wallet) {
      const id = ev({ source: "TRANSACTION_DECODER", label: `Instruction #${ch.instruction} SetAuthority(${ch.authorityType})`, observed: `${ch.account} → ${ch.newAuthority ?? "none"}`, condition: "authority held by wallet is reassigned" });
      if (ch.authorityType === "AccountOwner") {
        signals.push({ code: "TX_TOKEN_ACCOUNT_OWNER_CHANGE", title: "Token account ownership transfer", description: "Ownership of your token account (and all its tokens) moves to another address.", severity: "CRITICAL", evidenceIds: [id] });
      } else if (ch.authorityType === "CloseAccount") {
        signals.push({ code: "TX_CLOSE_AUTHORITY_CHANGE", title: "Close authority transfer", description: "Another address could close your token account and take its rent.", severity: "HIGH", evidenceIds: [id] });
      } else {
        signals.push({ code: "TX_MINT_AUTHORITY_CHANGE", title: `${ch.authorityType} authority change`, description: "A token authority you hold is being reassigned.", severity: "MEDIUM", evidenceIds: [id] });
      }
    }
  }

  for (const ap of decoded.approvals) {
    if (ap.delegate === wallet || (ap.owner !== wallet && !ownedByWallet(ap.account))) continue;
    const id = ev({ source: "TRANSACTION_DECODER", label: `Instruction #${ap.instruction} token approval`, observed: `delegate ${ap.delegate}, amount ${ap.unlimited ? "UNLIMITED (u64 max)" : ap.amountRaw}`, condition: "delegate is not the wallet" });
    signals.push(
      ap.unlimited
        ? { code: "TX_UNLIMITED_APPROVAL", title: "Unlimited token approval", description: "Grants another address permission to move ALL tokens in this account at any time.", severity: "CRITICAL", evidenceIds: [id] }
        : { code: "TX_TOKEN_APPROVAL", title: "Token spending approval", description: "Grants another address permission to move tokens from your account later.", severity: "HIGH", evidenceIds: [id] },
    );
  }

  for (const c of decoded.closes) {
    if (c.authority === wallet && c.destination !== wallet) {
      const id = ev({ source: "TRANSACTION_DECODER", label: `Instruction #${c.instruction} CloseAccount`, observed: `rent → ${c.destination}`, condition: "rent destination is not the wallet" });
      signals.push({ code: "TX_CLOSE_RENT_TO_OTHER", title: "Account rent sent elsewhere", description: "Closes your token account and sends its SOL rent to another address.", severity: "HIGH", evidenceIds: [id] });
    }
  }

  const unknownPrograms = decoded.programs.filter((p) => p.trust === "unknown");
  let unknownProgramEvidence: string | null = null;
  if (unknownPrograms.length > 0) {
    const id = ev({ source: "TRANSACTION_DECODER", label: "Unverified programs", observed: unknownPrograms.map((p) => p.programId).join(", "), condition: "program identity not in known list" });
    unknownProgramEvidence = id;
    signals.push({ code: "TX_UNKNOWN_PROGRAM", title: "Unverified program", description: "Calls a program this tool cannot identify. Unknown does not mean malicious, but its behavior is only visible through simulation.", severity: "LOW", evidenceIds: [id] });
  }

  token2022Signals(decoded, wallet, ev, signals, unknownProgramEvidence);
  memoLinkSignals(decoded, ev, signals);
  if (input.multisig) {
    const nonce = decoded.usesDurableNonce ? { nonce: decoded.instructions[0]?.info.nonce ?? null, authority: decoded.instructions[0]?.info.authority ?? null } : null;
    multisigSignals({ ms: input.multisig, signer: wallet, nonce }, ev, signals, statuses, sources);
  }

  // ---------- Effects (simulation / executed) ----------
  if (!effects) {
    statuses.push(input.effectsStatus === "COMPLETE" ? "INSUFFICIENT_DATA" : input.effectsStatus);
    sources.push({ source: "SIMULATION", status: "FAILED", detail: "No simulation result — asset movements are unknown" });
  } else {
    const effSource = effects.source === "EXECUTED" ? "ONCHAIN_RPC" : "SIMULATION";
    sources.push({ source: input.demo ? "DEMO" : effSource, status: "OK", detail: effects.source === "EXECUTED" ? "Executed transaction balances" : `Simulation at slot ${effects.slot ?? "?"}` });
    statuses.push(input.effectsStatus);
    if (effects.stale) statuses.push("PARTIAL");

    if (!effects.success) {
      const id = ev({ source: effSource, label: effects.source === "EXECUTED" ? "Execution result" : "Simulation result", observed: effects.error ?? "failed", condition: "transaction fails" });
      signals.push({ code: "TX_SIMULATION_FAILED", title: effects.source === "EXECUTED" ? "Transaction failed on-chain" : "Simulation failed", description: "The transaction fails; no balance changes could be observed. If signed it would likely fail and still cost a fee.", severity: "LOW", evidenceIds: [id] });
      statuses.push("PARTIAL");
    } else {
      evaluateEffects(effects, input, ev, signals, effSource);
    }
  }

  const status = reduce(statuses);
  return buildAssessment({ category: "transaction", signals, evidence, sources, status, now: input.now });
}

function reduce(statuses: AnalysisStatus[]): AnalysisStatus {
  if (statuses.includes("UNAVAILABLE") || statuses.includes("INSUFFICIENT_DATA")) return "INSUFFICIENT_DATA";
  return statuses.every((s) => s === "COMPLETE") ? "COMPLETE" : "PARTIAL";
}

/** Rent-exempt minimum (lamports) for an account of `space` bytes: (space + 128) × 3480 × 2. */
export function rentExemptMinimum(space: bigint): bigint {
  return (space + 128n) * 6960n;
}

/** Lamports the wallet deposits into accounts created by program calls, capped at each account's rent-exempt minimum. */
function rentDeposits(decoded: DecodedTransaction, wallet: string): bigint {
  let total = 0n;
  for (const i of decoded.innerInstructions) {
    if (i.type !== "system:createAccount" || (i.info.source ?? i.info.from) !== wallet) continue;
    if (!i.info.lamports || !/^\d+$/.test(i.info.lamports) || !i.info.space || !/^\d+$/.test(i.info.space)) continue;
    const lamports = BigInt(i.info.lamports);
    const cap = rentExemptMinimum(BigInt(i.info.space));
    total += lamports < cap ? lamports : cap;
  }
  return total;
}

function evaluateEffects(
  effects: TransactionEffects,
  input: TxRuleInput,
  ev: (e: Omit<Evidence, "id">) => string,
  signals: RiskSignal[],
  effSource: "ONCHAIN_RPC" | "SIMULATION",
) {
  const { decoded, wallet } = input;
  const { solDelta, tokenDeltas } = walletNetChanges(wallet, effects.solChanges, effects.tokenChanges);

  // SOL
  const fee = decoded.feePayer === wallet && effects.feeLamports ? BigInt(effects.feeLamports) : 0n;
  const outflow = -solDelta - fee;
  if (outflow > TX_THRESHOLDS.solNoiseLamports) {
    // Only top-level transfers count as "explained"; CPI transfers are moved by a program on your behalf.
    const destinations = decoded.solTransfers.filter((t) => t.from === wallet && !t.cpi);
    const cpiDestinations = decoded.solTransfers.filter((t) => t.from === wallet && t.cpi);
    // Priority fees set by the tx itself are fees, not asset outflow. Rent for accounts a program
    // creates on the wallet's behalf (e.g. a multisig proposal) is explained up to the rent-exempt
    // minimum for the account's size — anything above that is still unexplained outflow.
    const rent = rentDeposits(decoded, wallet);
    const explained = destinations.reduce((s, t) => s + BigInt(t.lamports), 0n) + (decoded.feePayer === wallet ? estimatePriorityFeeLamports(decoded) : 0n) + rent;
    const allDest = [...destinations, ...cpiDestinations];
    const destText = allDest.length
      ? [...new Set(allDest.map((d) => `${d.to}${d.cpi ? " (via program call)" : ""}`))].join(", ")
      : "not visible in instructions";
    const id = ev({ source: effSource, label: "Net SOL leaving your wallet", observed: `${formatLamports(outflow.toString())} SOL → ${destText}`, condition: "wallet SOL decreases beyond network fee" });
    if (explained >= outflow && destinations.length === 0 && rent > 0n) {
      signals.push({ code: "TX_RENT_DEPOSIT", title: "SOL deposited as account rent", description: "SOL moves into newly created account(s) as their rent-exempt deposit, not to another wallet.", severity: "LOW", evidenceIds: [id] });
    } else if (explained >= outflow) {
      signals.push({ code: "TX_SOL_OUTFLOW", title: "SOL leaves your wallet", description: "SOL is sent to the listed destination. Destination addresses without a known label are unverified, not necessarily malicious — confirm you intend to pay them.", severity: "MEDIUM", evidenceIds: [id] });
    } else {
      signals.push({ code: "TX_UNEXPECTED_SOL_OUTFLOW", title: "Unexpected SOL outflow", description: "More SOL leaves your wallet than the visible transfer instructions explain (moved by a program call).", severity: "HIGH", evidenceIds: [id] });
    }
    const pre = effects.solChanges.find((c) => c.address === wallet);
    if (pre && BigInt(pre.preLamports) > 0n && (outflow * 100n) / BigInt(pre.preLamports) >= TX_THRESHOLDS.drainRatioPct) {
      const id2 = ev({ source: effSource, label: "Share of SOL balance leaving", observed: `${((outflow * 100n) / BigInt(pre.preLamports)).toString()}%`, condition: `>= ${TX_THRESHOLDS.drainRatioPct}%` });
      signals.push({ code: "TX_SOL_DRAIN", title: "Near-total SOL drain", description: "Almost all of your SOL leaves the wallet.", severity: "CRITICAL", evidenceIds: [id, id2] });
    }
  }

  // Tokens
  const outMints: string[] = [];
  for (const [mint, { delta, decimals }] of tokenDeltas) {
    if (delta >= 0n) continue;
    outMints.push(mint);
    const amount = formatRawAmount((-delta).toString(), decimals);
    const transfers = decoded.tokenTransfers.filter((t) => t.authority === wallet && !t.cpi && (t.mint === mint || t.mint === null));
    const cpiTransfers = decoded.tokenTransfers.filter((t) => t.authority === wallet && t.cpi && (t.mint === mint || t.mint === null));
    const burns = decoded.instructions.filter((i) => /:burn/.test(i.type) && i.info.owner === wallet && i.info.mint === mint);
    const dest = [...new Set([...transfers, ...cpiTransfers].map((t) => t.destination))];
    const destOwners = dest.map((d) => effects.tokenChanges.find((c) => c.tokenAccount === d)?.owner ?? d);
    const id = ev({ source: effSource, label: `Token leaving your wallet (mint ${mint})`, observed: `${amount} → ${destOwners.length ? destOwners.join(", ") : burns.length ? "burned" : "unknown destination"}`, condition: "wallet token balance decreases" });

    if (transfers.length > 0 || burns.length > 0) {
      signals.push({ code: `TX_TOKEN_OUTFLOW:${mint}`, title: burns.length && !transfers.length ? "Tokens burned" : "Tokens leave your wallet", description: burns.length && !transfers.length ? `${amount} tokens are permanently burned.` : `${amount} tokens are sent to ${destOwners.join(", ")}. Unlabeled destinations are unverified — confirm the recipient.`, severity: "MEDIUM", evidenceIds: [id] });
    } else {
      signals.push({ code: `TX_UNEXPECTED_TOKEN_OUTFLOW:${mint}`, title: "Unexpected token outflow", description: "Tokens leave your wallet through a program call that is not a visible transfer instruction.", severity: "HIGH", evidenceIds: [id] });
    }

    const walletAccounts = effects.tokenChanges.filter((c) => c.owner === wallet && c.mint === mint);
    if (walletAccounts.length > 0 && walletAccounts.every((c) => BigInt(c.postRaw) === 0n) && transfers.length > 0) {
      const id2 = ev({ source: effSource, label: `Remaining balance of ${mint}`, observed: "0", condition: "entire balance moved" });
      signals.push({ code: `TX_FULL_BALANCE_TRANSFER:${mint}`, title: "Entire token balance moved", description: "Your whole balance of this token leaves the wallet.", severity: "HIGH", evidenceIds: [id, id2] });
    }
  }

  if (outMints.length >= TX_THRESHOLDS.multiAssetDrainMints) {
    const id = ev({ source: effSource, label: "Distinct tokens leaving wallet", observed: String(outMints.length), condition: `>= ${TX_THRESHOLDS.multiAssetDrainMints}` });
    signals.push({ code: "TX_MULTI_ASSET_DRAIN", title: "Multiple assets drained", description: "Several different tokens leave your wallet in one transaction — a typical drainer pattern.", severity: "CRITICAL", evidenceIds: [id] });
  }

  // Account state changes that happened via CPI (not visible in top-level decode)
  for (const ch of effects.accountChanges) {
    if (ch.address === wallet && ch.ownerBefore && ch.ownerAfter && ch.ownerBefore !== ch.ownerAfter) {
      const id = ev({ source: effSource, label: "Wallet account owner program", observed: `${ch.ownerBefore} → ${ch.ownerAfter}`, condition: "owner changes" });
      signals.push({ code: "TX_WALLET_OWNER_REASSIGN", title: "Wallet ownership transfer", description: "Your wallet account's owner program changes.", severity: "CRITICAL", evidenceIds: [id] });
    }
    if (ch.tokenOwnerBefore === wallet && ch.tokenOwnerAfter && ch.tokenOwnerAfter !== wallet) {
      const id = ev({ source: effSource, label: `Token account ${ch.address} owner`, observed: `${ch.tokenOwnerBefore} → ${ch.tokenOwnerAfter}`, condition: "token account owner changes" });
      signals.push({ code: "TX_TOKEN_ACCOUNT_OWNER_CHANGE", title: "Token account ownership transfer", description: "Ownership of your token account moves to another address.", severity: "CRITICAL", evidenceIds: [id] });
    }
    if (ch.tokenOwnerBefore === wallet && ch.delegateAfter && ch.delegateAfter !== ch.delegateBefore && ch.delegateAfter !== wallet) {
      const id = ev({ source: effSource, label: `Token account ${ch.address} delegate`, observed: ch.delegateAfter, condition: "new delegate set" });
      signals.push({ code: "TX_TOKEN_APPROVAL", title: "Token spending approval", description: "A new delegate can move tokens from your account.", severity: "HIGH", evidenceIds: [id] });
    }
  }
}
