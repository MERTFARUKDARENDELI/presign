import { describeTransactionError } from "@/lib/cleanup/reclaim";
import { formatLamports, formatRawAmount } from "@/lib/token/amount";
import type { DecodedInstruction, TransactionAnalysis } from "./types";

/**
 * Deterministic, plain-language explanation of an analysis. It restates the
 * decoded instructions, simulated effects and risk signals — it adds no facts
 * and makes no signing recommendation. The AI agent is an optional layer on top.
 */
export interface TransactionExplanation {
  headline: string;
  whatHappens: string[];
  assetMovements: string[];
  programs: string[];
  accountChanges: string[];
  whyRisky: string[];
  simulation: string;
  completeness: string;
  decisionNote: string;
}

const short = (a: string | null | undefined) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "unknown");

function describeSquads(i: DecodedInstruction): string {
  const f = i.info;
  switch (i.type.slice("squads:".length)) {
    case "vaultTransactionCreate":
    case "vaultTransactionCreateFromBuffer":
      return `Create a multisig transaction for vault ${f.vaultIndex ?? "?"}${f.vaultInstructions ? ` (${f.vaultInstructions} instruction(s) inside)` : ""}.`;
    case "proposalCreate":
      return `Create multisig proposal #${f.transactionIndex ?? "?"}.`;
    case "proposalActivate":
      return `Open proposal ${short(f.proposal)} for voting.`;
    case "proposalApprove":
      return `Vote YES on proposal ${short(f.proposal)}.`;
    case "proposalReject":
      return `Vote NO on proposal ${short(f.proposal)}.`;
    case "proposalCancel":
    case "proposalCancelV2":
      return `Vote to cancel proposal ${short(f.proposal)}.`;
    case "vaultTransactionExecute":
      return "Execute the multisig transaction: the vault performs its instructions now.";
    case "configTransactionCreate":
      return `Propose a multisig configuration change (${f.configActions ?? "?"}).`;
    case "configTransactionExecute":
      return "Execute a multisig configuration change.";
    case "batchExecuteTransaction":
      return "Execute one transaction of a multisig batch.";
    default:
      return `Squads multisig: ${i.type.slice("squads:".length)}.`;
  }
}

export function describeInstruction(i: DecodedInstruction, symbols: Record<string, string> = {}): string {
  const f = i.info;
  const sym = (mint: string | null | undefined) => (mint ? (symbols[mint] ?? `token ${short(mint)}`) : "tokens");
  if (i.type.startsWith("squads:")) return describeSquads(i);
  if (i.type.startsWith("anchor:")) {
    const args = Object.entries(f).filter(([k]) => !k.startsWith("_")).map(([k, v]) => `${k} = ${v === null ? "?" : v.length > 44 ? `${v.slice(0, 41)}…` : v}`);
    return `${i.programName}: ${i.type.slice("anchor:".length)}(${args.join(", ")}) — named from the program's own on-chain IDL.`;
  }
  switch (i.type) {
    case "bpfLoader:upgrade":
      return `Replace the code of program ${short(f.program)} with the contents of buffer ${short(f.buffer)}.`;
    case "bpfLoader:setAuthority":
    case "bpfLoader:setAuthorityChecked":
      return f.newAuthority ? `Hand the upgrade authority of ${short(f.account)} to ${short(f.newAuthority)}.` : `Remove the upgrade authority of ${short(f.account)} — it can never be upgraded again.`;
    case "bpfLoader:close":
      return `Close program/buffer account ${short(f.account)}; its SOL goes to ${short(f.recipient)}.`;
    case "system:transfer":
    case "system:transferWithSeed":
      return `Send ${formatLamports(f.lamports ?? "0")} SOL from ${short(f.from)} to ${short(f.to)}.`;
    case "system:createAccount":
      return `Create account ${short(f.newAccount)} funded with ${formatLamports(f.lamports ?? "0")} SOL.`;
    case "system:assign":
      return `Reassign account ${short(f.account)} to program ${short(f.newOwnerProgram)}.`;
    case "system:advanceNonce":
      return "Use a durable nonce — this signed transaction would not expire.";
    case "computeBudget:setComputeUnitPrice":
      return `Set a priority fee (${f.microLamports} micro-lamports per compute unit).`;
    case "computeBudget:setComputeUnitLimit":
      return `Set the compute limit to ${f.units} units.`;
    case "ata:create":
    case "ata:createIdempotent":
      return "Create an associated token account if needed.";
    case "memo":
      return "Attach a memo (untrusted text).";
  }
  const [, op] = i.type.split(":");
  if (i.type.startsWith("token")) {
    const dec = f.decimals ? Number(f.decimals) : null;
    const amt = f.amount && dec !== null ? formatRawAmount(f.amount, dec) : f.amount;
    switch (op) {
      case "transfer":
      case "transferChecked":
        return `Transfer ${amt ?? "?"} ${sym(f.mint)} from ${short(f.source)} to ${short(f.destination)}.`;
      case "approve":
      case "approveChecked":
        return `Allow ${short(f.delegate)} to spend ${f.amount === "18446744073709551615" ? "an UNLIMITED amount" : `up to ${f.amount}`} from token account ${short(f.account)}.`;
      case "revoke":
        return `Remove the delegate from token account ${short(f.account)}.`;
      case "setAuthority":
        return `Change ${f.authorityType} of ${short(f.account)} to ${f.newAuthority ? short(f.newAuthority) : "nobody"}.`;
      case "closeAccount":
        return `Close token account ${short(f.account)}; rent goes to ${short(f.destination)}.`;
      case "burn":
      case "burnChecked":
        return `Burn ${amt ?? "?"} ${sym(f.mint)} from ${short(f.account)}.`;
      case "mintTo":
      case "mintToChecked":
        return `Mint new ${sym(f.mint)} to ${short(f.destination)}.`;
    }
  }
  // Token-2022 extension instructions (decoded byte-exactly; never reached for SPL Token).
  if (i.type.startsWith("token-2022:") && i.parsed) {
    const dec = f.decimals ? Number(f.decimals) : null;
    const fmt = (raw: string | null) => (raw && dec !== null ? formatRawAmount(raw, dec) : raw ?? "?");
    switch (op) {
      case "transferCheckedWithFee":
        return `Transfer ${fmt(f.amount)} ${sym(f.mint)} from ${short(f.source)} to ${short(f.destination)} (Token-2022 transfer fee up to ${fmt(f.fee)} withheld).`;
      case "disableCpiGuard":
        return `Turn OFF CPI Guard on token account ${short(f.account)} — other programs could then move its tokens on your behalf.`;
      case "enableCpiGuard":
        return `Turn on CPI Guard for token account ${short(f.account)}.`;
      case "disableRequiredMemoTransfers":
      case "enableRequiredMemoTransfers":
        return `${op.startsWith("disable") ? "Stop requiring" : "Require"} a memo on incoming transfers to ${short(f.account)}.`;
      case "updateTransferHook":
        return `Change the transfer-hook program of mint ${short(f.mint)} to ${f.programId ? short(f.programId) : "none"}.`;
      case "updateDefaultAccountState":
        return `Set the default state of new ${short(f.mint)} accounts to ${f.accountState ?? "an unknown state"}.`;
      case "pause":
      case "resume":
        return `${op === "pause" ? "Pause" : "Resume"} all transfers of mint ${short(f.mint)}.`;
      case "setTransferFee":
        return `Set the transfer fee of mint ${short(f.mint)} to ${Number(f.transferFeeBasisPoints) / 100}% (maximum ${f.maximumFee} base units).`;
      case "initializePermanentDelegate":
        return `Give ${f.delegate ? short(f.delegate) : "nobody"} permanent-delegate power over every holder's ${sym(f.mint)} balance.`;
      case "withdrawExcessLamports":
        return `Withdraw excess SOL from ${short(f.source)} to ${short(f.destination)}.`;
    }
  }
  if (!i.parsed) return `Call ${i.programTrust === "unknown" ? "an unverified program" : i.programName} (${short(i.programId)}) — its intent cannot be decoded; only simulation shows its effect.`;
  return `${i.programName}: ${i.type}.`;
}

export function explainTransaction(a: TransactionAnalysis, symbols: Record<string, string> = {}): TransactionExplanation {
  const wallet = a.perspectiveWallet;
  const e = a.effects;
  const whatHappens = a.decoded.instructions.map((i) => describeInstruction(i, symbols));
  // v1 sets its compute budget in the message, not through ComputeBudget instructions.
  const cfg = a.decoded.transactionConfig;
  if (cfg) {
    const parts = [
      cfg.computeUnitLimit !== null ? `compute limit ${cfg.computeUnitLimit} units` : null,
      cfg.priorityFeeLamports !== null ? `priority fee ${formatLamports(cfg.priorityFeeLamports)} SOL (total)` : null,
      cfg.loadedAccountsDataSizeLimit !== null ? `loaded-account data limit ${cfg.loadedAccountsDataSizeLimit} bytes` : null,
      cfg.heapSize !== null ? `heap ${cfg.heapSize} bytes` : null,
    ].filter(Boolean);
    whatHappens.unshift(parts.length ? `Transaction settings (v1 message): ${parts.join(", ")}.` : "Transaction settings (v1 message): none set.");
  }
  const cpiCount = a.decoded.innerInstructions.length;
  if (cpiCount > 0) whatHappens.push(`Programs make ${cpiCount} further internal call(s) (CPI), listed under the instructions.`);
  // Multisig: what the vault itself would do if the proposal executes.
  for (const p of a.multisig?.payloads ?? []) {
    if (p.source === "EXECUTION_CPI") continue;
    const label = p.transactionIndex ? `proposal #${p.transactionIndex}` : "the proposal";
    if (!p.decoded) {
      whatHappens.push(`The contents of ${label} could not be loaded (${p.detail ?? p.status}) — you would be authorizing something that could not be verified.`);
      continue;
    }
    const steps = p.decoded.instructions.filter((i) => !i.type.startsWith("computeBudget:")).map((i) => describeInstruction(i, symbols));
    whatHappens.push(`If ${label} executes, vault ${short(p.vault)} will: ${steps.join(" ")}`);
  }

  const assetMovements: string[] = [];
  if (e) {
    for (const c of e.solChanges.filter((x) => x.address === wallet)) {
      const d = BigInt(c.deltaLamports);
      assetMovements.push(`${d < 0n ? "Your wallet loses" : "Your wallet receives"} ${formatLamports((d < 0n ? -d : d).toString())} SOL (including the network fee).`);
    }
    for (const c of e.tokenChanges.filter((x) => x.owner === wallet)) {
      const d = BigInt(c.deltaRaw);
      assetMovements.push(`${d < 0n ? "You send" : "You receive"} ${formatRawAmount((d < 0n ? -d : d).toString(), c.decimals)} ${symbols[c.mint] ?? `token ${short(c.mint)}`}.`);
    }
    for (const c of e.tokenChanges.filter((x) => x.owner !== wallet && BigInt(x.deltaRaw) > 0n)) {
      assetMovements.push(`${short(c.owner)} (unverified address) receives ${formatRawAmount(c.deltaRaw, c.decimals)} ${symbols[c.mint] ?? `token ${short(c.mint)}`}.`);
    }
    if (assetMovements.length === 0 && e.success) assetMovements.push("No balance change for your wallet was observed besides possible fees.");
  } else {
    assetMovements.push("Unknown — the transaction could not be simulated, so asset movements are not known.");
  }

  const accountChanges = (e?.accountChanges ?? []).map((c) => {
    if (c.closed) return `Account ${short(c.address)} is closed.`;
    if (c.created) return `Account ${short(c.address)} is created.`;
    if (c.tokenOwnerAfter && c.tokenOwnerBefore !== c.tokenOwnerAfter) return `Token account ${short(c.address)} changes owner to ${short(c.tokenOwnerAfter)}.`;
    if (c.delegateAfter !== c.delegateBefore) return `Token account ${short(c.address)} delegate becomes ${c.delegateAfter ? short(c.delegateAfter) : "none"}.`;
    return `Account ${short(c.address)} owner program changes.`;
  });

  const programs = a.decoded.programs.map((p) => `${p.name}${p.trust === "unknown" ? " (unverified — not necessarily malicious)" : ""}`);
  const whyRisky = a.risk.signals.map((s) => `${s.severity}: ${s.title} — ${s.description}`);

  let simulation: string;
  if (!e) simulation = "Simulation could not be performed.";
  else if (e.source === "EXECUTED") simulation = `Already executed on-chain (${e.success ? "succeeded" : "failed"}). Figures come from the confirmed transaction record.`;
  else if (e.source === "DEMO") simulation = "DEMO data — synthetic effects, not a real simulation.";
  else {
    const err = describeTransactionError(e.error);
    simulation = e.success
      ? `Simulation succeeded at slot ${e.slot ?? "?"}. This only means it would execute against the state at that moment — it is not a guarantee of the future result and not a safety verdict.`
      : `Simulation failed${err ? `: ${err}` : e.error ? ` (${e.error})` : ""}.`;
  }

  const completeness =
    a.risk.status === "COMPLETE"
      ? "Analysis complete: all required checks ran."
      : `Analysis ${a.risk.status.replace("_", " ").toLowerCase()}: some data was missing, so additional risks may exist.`;

  const headline =
    a.risk.level === "UNKNOWN"
      ? "Risk could not be rated — not enough data."
      : a.risk.level === "SAFE"
        ? "No evidence of risk found by the completed checks (not a guarantee)."
        : `${a.risk.level} risk: ${a.risk.signals[0]?.title ?? ""}`;

  return {
    headline,
    whatHappens,
    assetMovements,
    programs,
    accountChanges,
    whyRisky,
    simulation,
    completeness,
    decisionNote: "This explanation restates the evidence. Whether to sign is your decision.",
  };
}
