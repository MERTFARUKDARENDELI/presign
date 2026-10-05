import { METAPLEX_CORE_PROGRAM_ID } from "@/lib/solana/constants";
import { formatLamports } from "@/lib/token/amount";
import { estimatePriorityFeeLamports } from "@/lib/transaction/decoder";
import type { DecodedInstruction, DecodedTransaction, TransactionEffects } from "@/lib/transaction/types";
import type { RiskSignal } from "../risk";
import type { Evidence } from "../types";

/**
 * Transaction rules for attack classes the core rules do not see from the
 * wallet's own balance: staked SOL (lives in stake accounts), compressed and
 * Core NFTs (not token balances), fees, programs the wallet owns, and the
 * "looks harmless in simulation" pattern. Every rule cites the decoded
 * instruction or simulated state it fires on; nothing is inferred from names.
 */

export const EXTRA_THRESHOLDS = {
  priorityFeeMediumLamports: 10_000_000n, // 0.01 SOL
  priorityFeeHighLamports: 100_000_000n, // 0.1 SOL
  priorityFeeCriticalShareOfBalancePct: 50n,
} as const;

type EvFn = (e: Omit<Evidence, "id">) => string;

export interface ExtraRuleInput {
  decoded: DecodedTransaction;
  effects: TransactionEffects | null;
  wallet: string;
  ownedByWallet: (tokenAccount: string) => boolean;
  ev: EvFn;
  signals: RiskSignal[];
}

const short = (a: string | null | undefined) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "unknown");
const big = (v: string | null | undefined) => {
  try {
    return v ? BigInt(v) : 0n;
  } catch {
    return 0n;
  }
};

function allInstructions(d: DecodedTransaction): DecodedInstruction[] {
  return [...d.instructions, ...d.innerInstructions];
}

export function extraTransactionSignals({ decoded, effects, wallet, ownedByWallet, ev, signals }: ExtraRuleInput): void {
  const ixs = allInstructions(decoded);
  const at = (i: DecodedInstruction) => `Instruction #${i.parentIndex ?? i.index}${i.parentIndex !== undefined ? " (CPI)" : ""}`;

  // ---------- Fees ----------
  if (decoded.feePayer === wallet) {
    const fee = estimatePriorityFeeLamports(decoded);
    const pre = big(effects?.solChanges.find((c) => c.address === wallet)?.preLamports);
    const share = pre > 0n ? (fee * 100n) / pre : 0n;
    if (fee >= EXTRA_THRESHOLDS.priorityFeeMediumLamports) {
      const critical = pre > 0n && share >= EXTRA_THRESHOLDS.priorityFeeCriticalShareOfBalancePct;
      const severity = critical ? "CRITICAL" : fee >= EXTRA_THRESHOLDS.priorityFeeHighLamports ? "HIGH" : "MEDIUM";
      const id = ev({ source: "TRANSACTION_DECODER", label: "Priority fee (compute unit price × limit)", observed: `${formatLamports(fee.toString())} SOL${pre > 0n ? ` (${share}% of the wallet's SOL)` : ""}`, condition: `≥ ${formatLamports(EXTRA_THRESHOLDS.priorityFeeMediumLamports.toString())} SOL` });
      signals.push({ code: "TX_EXCESSIVE_PRIORITY_FEE", title: critical ? "Priority fee takes most of your SOL" : "Unusually high priority fee", description: `You would pay ${formatLamports(fee.toString())} SOL in priority fees to validators. Normal fees are a tiny fraction of this; an inflated fee is a way to drain SOL that looks like a fee.`, severity, evidenceIds: [id] });
    }
  }

  // ---------- Staked SOL ----------
  for (const i of ixs) {
    const f = i.info;
    if (i.type.startsWith("stake:authorize") && f.authority === wallet && f.newAuthority && f.newAuthority !== wallet) {
      const withdrawer = f.authorityType === "Withdrawer";
      const id = ev({ source: "TRANSACTION_DECODER", label: `${at(i)} Stake ${i.type.slice("stake:".length)}(${f.authorityType})`, observed: `${f.stakeAccount} → ${f.newAuthority}`, condition: "stake authority held by the wallet is reassigned" });
      signals.push(
        withdrawer
          ? { code: "TX_STAKE_WITHDRAW_AUTHORITY_CHANGE", title: "Control of your staked SOL is transferred", description: `The withdraw authority of stake account ${short(f.stakeAccount)} moves to ${short(f.newAuthority)}: that address could withdraw all the staked SOL. This does not show in your wallet balance.`, severity: "CRITICAL", evidenceIds: [id] }
          : { code: "TX_STAKE_AUTHORITY_CHANGE", title: "Stake authority transferred", description: `The stake authority of ${short(f.stakeAccount)} moves to ${short(f.newAuthority)}: it could deactivate or redelegate your stake.`, severity: "HIGH", evidenceIds: [id] },
      );
    }
    if (i.type === "stake:withdraw" && f.authority === wallet && f.to && f.to !== wallet) {
      const id = ev({ source: "TRANSACTION_DECODER", label: `${at(i)} Stake withdraw`, observed: `${formatLamports(f.lamports ?? "0")} SOL from ${f.stakeAccount} → ${f.to}`, condition: "staked SOL goes to an address other than the wallet" });
      signals.push({ code: "TX_STAKE_WITHDRAW_TO_OTHER", title: "Staked SOL withdrawn to another address", description: `${formatLamports(f.lamports ?? "0")} SOL leaves your stake account ${short(f.stakeAccount)} for ${short(f.to)}. Your wallet balance would not show this.`, severity: "HIGH", evidenceIds: [id] });
    }
    if (i.type.startsWith("stake:setLockup") && f.authority === wallet) {
      const id = ev({ source: "TRANSACTION_DECODER", label: `${at(i)} Stake ${i.type.slice("stake:".length)}`, observed: f.stakeAccount, condition: "lockup of a stake account changes" });
      signals.push({ code: "TX_STAKE_LOCKUP_CHANGE", title: "Stake lockup changes", description: "A lockup can prevent withdrawals from the stake account until a date or epoch, and a new custodian could change it.", severity: "MEDIUM", evidenceIds: [id] });
    }
  }

  // ---------- Compressed NFTs (Bubblegum) ----------
  const cnftOut = ixs.filter((i) => i.type === "bubblegum:transfer" && (i.info.leafOwner === wallet || i.info.leafDelegate === wallet) && i.info.newLeafOwner !== wallet);
  if (cnftOut.length > 0) {
    const id = ev({ source: "TRANSACTION_DECODER", label: "Bubblegum transfer", observed: cnftOut.map((i) => `${at(i)} → ${i.info.newLeafOwner}`).join("; "), condition: "compressed NFT leaves the wallet" });
    signals.push(
      cnftOut.length >= 2
        ? { code: "TX_CNFT_DRAIN", title: "Several compressed NFTs leave your wallet", description: `${cnftOut.length} compressed NFTs are transferred to ${[...new Set(cnftOut.map((i) => short(i.info.newLeafOwner)))].join(", ")} — a drainer pattern. Compressed NFT movements never appear in a token-balance simulation.`, severity: "CRITICAL", evidenceIds: [id] }
        : { code: "TX_CNFT_TRANSFER", title: "A compressed NFT leaves your wallet", description: `A compressed NFT is transferred to ${short(cnftOut[0].info.newLeafOwner)}. This movement does not appear in the token-balance simulation.`, severity: "HIGH", evidenceIds: [id] },
    );
  }
  for (const i of ixs) {
    if (i.type === "bubblegum:delegate" && i.info.leafOwner === wallet && i.info.newLeafDelegate && i.info.newLeafDelegate !== wallet) {
      const id = ev({ source: "TRANSACTION_DECODER", label: `${at(i)} Bubblegum delegate`, observed: `delegate → ${i.info.newLeafDelegate}`, condition: "another address may transfer the compressed NFT" });
      signals.push({ code: "TX_CNFT_DELEGATE", title: "Another address may move your compressed NFT", description: `${short(i.info.newLeafDelegate)} becomes the delegate of a compressed NFT and could transfer it at any time.`, severity: "HIGH", evidenceIds: [id] });
    }
    if (i.type === "bubblegum:burn" && i.info.leafOwner === wallet) {
      const id = ev({ source: "TRANSACTION_DECODER", label: `${at(i)} Bubblegum burn`, observed: i.info.merkleTree ?? null, condition: "compressed NFT destroyed" });
      signals.push({ code: "TX_CNFT_BURN", title: "A compressed NFT is burned", description: "A compressed NFT you own is permanently destroyed.", severity: "MEDIUM", evidenceIds: [id] });
    }
    if (/^bubblegum:(transfer|delegate|burn)V2$/.test(i.type) && i.accounts.some((a) => a.address === wallet)) {
      const id = ev({ source: "TRANSACTION_DECODER", label: `${at(i)} ${i.type}`, observed: "accounts not decoded", condition: "compressed NFT instruction involving the wallet" });
      signals.push({ code: "TX_CNFT_UNDECODED", title: "Compressed NFT transfer or delegation (not fully decoded)", description: "A Bubblegum v2 instruction can move or delegate a compressed NFT. Presign identified it but does not decode its recipient, and the movement does not appear in the simulation.", severity: "HIGH", evidenceIds: [id] });
    }
  }

  // ---------- Metaplex Core NFTs ----------
  const core = decoded.instructions.filter((i) => i.programId === METAPLEX_CORE_PROGRAM_ID && i.accounts.some((a) => a.address === wallet));
  if (core.length > 0) {
    const id = ev({ source: "TRANSACTION_DECODER", label: "Metaplex Core instructions", observed: core.map(at).join(", "), condition: "NFT program instruction involving the wallet, not decoded" });
    signals.push({ code: "TX_NFT_PROGRAM_UNDECODED", title: "NFT program instruction Presign does not decode", description: "Metaplex Core NFTs are not token balances: a transfer of one does not appear in the simulation's balance changes, and Presign does not decode this program's instructions.", severity: "MEDIUM", evidenceIds: [id] });
  }

  // ---------- Programs the wallet controls / owns ----------
  for (const i of decoded.instructions) {
    const f = i.info;
    if (i.type === "bpfLoader:upgrade" && f.authority === wallet) {
      const id = ev({ source: "TRANSACTION_DECODER", label: `${at(i)} BPF loader Upgrade`, observed: `program ${f.program} ← buffer ${f.buffer}`, condition: "program code replaced with the wallet's upgrade authority" });
      signals.push({ code: "TX_PROGRAM_UPGRADE", title: "Program code is replaced", description: `The code of program ${short(f.program)} is replaced by the contents of buffer ${short(f.buffer)}. Verify the buffer is the build you expect before signing.`, severity: "HIGH", evidenceIds: [id] });
    }
    if (i.type === "bpfLoader:close" && f.authority === wallet) {
      const id = ev({ source: "TRANSACTION_DECODER", label: `${at(i)} BPF loader Close`, observed: `${f.account} → rent to ${f.recipient}`, condition: "program or buffer closed with the wallet's authority" });
      signals.push({ code: "TX_PROGRAM_CLOSE", title: "Program or buffer is closed", description: `${short(f.account)} is closed permanently${f.recipient && f.recipient !== wallet ? ` and its SOL goes to ${short(f.recipient)}` : ""}.`, severity: "HIGH", evidenceIds: [id] });
    }
  }

  // ---------- The wallet account itself ----------
  for (const i of ixs) {
    if ((i.type === "system:allocate" || i.type === "system:allocateWithSeed") && i.info.account === wallet && big(i.info.space) > 0n) {
      const id = ev({ source: "TRANSACTION_DECODER", label: `${at(i)} System allocate`, observed: `${i.info.space} bytes on ${wallet}`, condition: "wallet account gets data space" });
      signals.push({ code: "TX_WALLET_ALLOCATE", title: "Your wallet account would get data space", description: "A wallet account with data can no longer pay fees or send SOL normally — it may become unusable.", severity: "HIGH", evidenceIds: [id] });
    }
  }

  // ---------- Mint authority held by the wallet ----------
  for (const i of ixs) {
    if (/^token(-2022)?:mintTo(Checked)?$/.test(i.type) && i.info.authority === wallet && i.info.destination && !ownedByWallet(i.info.destination)) {
      const id = ev({ source: "TRANSACTION_DECODER", label: `${at(i)} MintTo`, observed: `${i.info.amount} raw of ${i.info.mint} → ${i.info.destination}`, condition: "tokens minted with the wallet's mint authority to an account it does not own" });
      signals.push({ code: "TX_MINT_TO_OTHER", title: "Tokens minted to another address with your authority", description: `New tokens of ${short(i.info.mint)} are created with your mint authority and sent to ${short(i.info.destination)}.`, severity: "MEDIUM", evidenceIds: [id] });
    }
  }

  // ---------- Unverified programs: what simulation cannot prove ----------
  const unknown = decoded.instructions.filter((i) => i.programTrust === "unknown");
  if (unknown.length > 0 && decoded.usesDurableNonce && decoded.signers.includes(wallet)) {
    const id = ev({ source: "TRANSACTION_DECODER", label: "Durable nonce + unverified program", observed: [...new Set(unknown.map((i) => i.programId))].join(", "), condition: "transaction never expires and calls an unverified program" });
    signals.push({ code: "TX_UNKNOWN_PROGRAM_DURABLE_NONCE", title: "Never-expiring signature for an unverified program", description: "This signature stays valid indefinitely, so it can be executed later — when the program (if upgradeable) or the state may behave differently from today's simulation.", severity: "HIGH", evidenceIds: [id] });
  }
  if (effects && effects.success && effects.source === "SIMULATION") {
    const changed = new Set([...effects.tokenChanges.filter((c) => big(c.deltaRaw) !== 0n).map((c) => c.tokenAccount), ...effects.accountChanges.map((c) => c.address)]);
    for (const i of unknown) {
      if (!i.accounts.some((a) => a.address === wallet && a.signer)) continue;
      const exposed = i.accounts.filter((a) => a.writable && a.address && ownedByWallet(a.address) && !changed.has(a.address));
      if (exposed.length === 0) continue;
      const id = ev({ source: "SIMULATION", label: `${at(i)} unverified program ${i.programId}`, observed: `gets your signature and write access to ${exposed.length} token account(s) of yours; the simulation shows no change to them`, condition: "permission without visible effect" });
      signals.push({ code: "TX_SIMULATION_EVASION_RISK", title: "Program gets access to your tokens but the simulation shows nothing", description: "An unverified program receives your signature and write access to your token accounts, yet does nothing visible in the simulation. Drainers detect simulations and behave differently when the transaction really runs.", severity: "MEDIUM", evidenceIds: [id] });
      break;
    }
  }
}
