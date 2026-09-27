import {
  AuthorityType,
  createApproveInstruction,
  createSetAuthorityInstruction,
  createTransferCheckedInstruction,
  TOKEN_PROGRAM_ID as SPL_TOKEN_PROGRAM,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  MessageV0,
  NONCE_ACCOUNT_LENGTH,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { evaluateTransactionRisk } from "@/lib/security/rules/transaction";
import { decodeTransaction, estimatePriorityFeeLamports, U64_MAX } from "@/lib/transaction/decoder";
import { diffSnapshots } from "@/lib/transaction/effects";
import { bytesToBase64, parseTransactionInput } from "@/lib/transaction/input";
import type { TransactionEffects } from "@/lib/transaction/types";
import { ATTACKER, ATTACKER_ATA, BLOCKHASH, buildTx, key, MINT, parsedTokenAccount, systemAccount, WALLET, WALLET_ATA } from "../helpers/fixtures";

const W = WALLET.toBase58();

function decodeOf(bytes: Uint8Array) {
  return decodeTransaction(VersionedTransaction.deserialize(bytes));
}

function effects(partial: Partial<TransactionEffects>): TransactionEffects {
  return {
    source: "SIMULATION", success: true, error: null, logs: [], logsTruncated: false, unitsConsumed: 1000,
    slot: 100, preStateSlot: 99, stale: false, blockhashValid: true, feeLamports: "5000",
    solChanges: [], tokenChanges: [], accountChanges: [], notes: [], ...partial,
  };
}

describe("transaction input parsing", () => {
  const { base64, bytes } = buildTx([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 1 })]);

  it("detects base64, base58 and signatures", () => {
    expect(parseTransactionInput(base64).kind).toBe("serialized-base64");
    expect(parseTransactionInput(bs58.encode(bytes)).kind).toBe("serialized-base58");
    expect(parseTransactionInput(bs58.encode(new Uint8Array(64).fill(3))).kind).toBe("signature");
  });

  it("rejects malformed / tampered transactions", () => {
    expect(parseTransactionInput("hello world").kind).toBe("invalid");
    expect(parseTransactionInput(bytesToBase64(bytes.slice(0, 40))).kind).toBe("invalid");
    const corrupted = bytes.slice();
    corrupted[0] = 5; // signature count no longer matches header
    expect(parseTransactionInput(bytesToBase64(corrupted)).kind).toBe("invalid");
  });
});

describe("transaction decoder", () => {
  it("decodes SOL transfers with signers and writable accounts", () => {
    const d = decodeOf(buildTx([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 2_000_000_000 })]).bytes);
    expect(d.version).toBe("legacy");
    expect(d.feePayer).toBe(W);
    expect(d.signers).toEqual([W]);
    expect(d.solTransfers[0]).toMatchObject({ from: W, to: ATTACKER.toBase58(), lamports: "2000000000" });
    expect(d.accounts.find((a) => a.address === ATTACKER.toBase58())?.writable).toBe(true);
  });

  it("decodes token transferChecked, unlimited approvals and authority changes", () => {
    const d = decodeOf(buildTx([
      createTransferCheckedInstruction(WALLET_ATA, MINT, ATTACKER_ATA, WALLET, 50_000_000n, 6),
      createApproveInstruction(WALLET_ATA, ATTACKER, WALLET, U64_MAX),
      createSetAuthorityInstruction(WALLET_ATA, WALLET, AuthorityType.AccountOwner, ATTACKER),
    ]).bytes);
    expect(d.tokenTransfers[0]).toMatchObject({ amountRaw: "50000000", mint: MINT.toBase58(), decimals: 6, destination: ATTACKER_ATA.toBase58() });
    expect(d.approvals[0]).toMatchObject({ delegate: ATTACKER.toBase58(), unlimited: true });
    expect(d.authorityChanges[0]).toMatchObject({ authorityType: "AccountOwner", newAuthority: ATTACKER.toBase58() });
    expect(d.undecodedInstructions).toEqual([]);
  });

  it("lists unknown programs without guessing their intent", () => {
    const unknown = key(77);
    const d = decodeOf(buildTx([new TransactionInstruction({ programId: unknown, keys: [{ pubkey: WALLET, isSigner: true, isWritable: true }], data: Buffer.from([1, 2, 3]) })]).bytes);
    expect(d.instructions[0]).toMatchObject({ type: "unknown", parsed: false, programTrust: "unknown", dataLength: 3 });
    expect(d.programs[0].trust).toBe("unknown");
  });

  it("detects durable-nonce and wallet reassign patterns", () => {
    const nonce = key(40);
    const d = decodeOf(buildTx([
      SystemProgram.nonceAdvance({ noncePubkey: nonce, authorizedPubkey: WALLET }),
      SystemProgram.assign({ accountPubkey: WALLET, programId: key(41) }),
    ]).bytes);
    expect(d.usesDurableNonce).toBe(true);
    expect(d.authorityChanges[0]).toMatchObject({ kind: "system-assign", account: W });
    expect(NONCE_ACCOUNT_LENGTH).toBeGreaterThan(0);
  });

  it("marks v0 transactions with unresolved lookup tables as partial", () => {
    const lut = key(50);
    const msg = new MessageV0({
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
      staticAccountKeys: [WALLET, SystemProgram.programId],
      recentBlockhash: BLOCKHASH,
      compiledInstructions: [{ programIdIndex: 1, accountKeyIndexes: [0, 2], data: SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 5 }).data }],
      addressTableLookups: [{ accountKey: lut, writableIndexes: [0], readonlyIndexes: [] }],
    });
    const tx = new VersionedTransaction(msg);
    const d = decodeTransaction(tx);
    expect(d.version).toBe(0);
    expect(d.lookupTablesResolved).toBe(false);
    const resolved = decodeTransaction(tx, { loadedAddresses: { writable: [ATTACKER.toBase58()], readonly: [] } });
    expect(resolved.lookupTablesResolved).toBe(true);
    expect(resolved.solTransfers[0].to).toBe(ATTACKER.toBase58());
  });
});

describe("balance diffs", () => {
  it("computes SOL/token changes and closures from snapshots", () => {
    const d = diffSnapshots(
      [W, WALLET_ATA.toBase58()],
      [systemAccount(3_000_000_000), parsedTokenAccount({ amount: "100000000" })],
      [systemAccount(1_000_000_000), null],
    );
    expect(d.solChanges[0].deltaLamports).toBe("-2000000000");
    expect(d.tokenChanges[0]).toMatchObject({ owner: W, deltaRaw: "-100000000" });
    expect(d.accountChanges[0]).toMatchObject({ closed: true });
  });

  it("detects delegate and token owner changes", () => {
    const d = diffSnapshots([WALLET_ATA.toBase58()], [parsedTokenAccount({ amount: "1" })], [parsedTokenAccount({ amount: "1", owner: ATTACKER.toBase58(), delegate: ATTACKER.toBase58() })]);
    expect(d.accountChanges[0]).toMatchObject({ tokenOwnerAfter: ATTACKER.toBase58(), delegateAfter: ATTACKER.toBase58() });
  });
});

describe("transaction risk analysis", () => {
  const transfer50Usdc = decodeOf(buildTx([createTransferCheckedInstruction(WALLET_ATA, MINT, ATTACKER_ATA, WALLET, 50_000_000n, 6)]).bytes);
  const usdcOut = effects({
    tokenChanges: [
      { tokenAccount: WALLET_ATA.toBase58(), owner: W, mint: MINT.toBase58(), decimals: 6, preRaw: "80000000", postRaw: "30000000", deltaRaw: "-50000000" },
      { tokenAccount: ATTACKER_ATA.toBase58(), owner: ATTACKER.toBase58(), mint: MINT.toBase58(), decimals: 6, preRaw: "0", postRaw: "50000000", deltaRaw: "50000000" },
    ],
  });

  it("shows the 50 USDC outgoing effect with destination evidence", () => {
    const r = evaluateTransactionRisk({ decoded: transfer50Usdc, effects: usdcOut, wallet: W, effectsStatus: "COMPLETE" });
    const s = r.signals.find((x) => x.code.startsWith("TX_TOKEN_OUTFLOW"))!;
    expect(s).toBeDefined();
    const e = r.evidence.find((x) => x.id === s.evidenceIds[0])!;
    expect(e.observed).toContain("50");
    expect(e.observed).toContain(ATTACKER.toBase58());
    expect(r.level).toBe("MEDIUM");
  });

  it("simulation success alone never yields SAFE when simulation is missing", () => {
    const r = evaluateTransactionRisk({ decoded: transfer50Usdc, effects: null, wallet: W, effectsStatus: "INSUFFICIENT_DATA" });
    expect(r.status).toBe("INSUFFICIENT_DATA");
    expect(r.level).not.toBe("SAFE");
  });

  it("does not call unknown programs malicious but keeps analysis partial", () => {
    const d = decodeOf(buildTx([new TransactionInstruction({ programId: key(88), keys: [], data: Buffer.from([]) })]).bytes);
    const r = evaluateTransactionRisk({ decoded: d, effects: effects({}), wallet: W, effectsStatus: "COMPLETE" });
    expect(r.level).toBe("LOW");
    expect(r.status).toBe("PARTIAL");
  });

  it("flags unlimited approval and token-account takeover as CRITICAL", () => {
    const d = decodeOf(buildTx([
      createApproveInstruction(WALLET_ATA, ATTACKER, WALLET, U64_MAX, [], SPL_TOKEN_PROGRAM),
      createSetAuthorityInstruction(WALLET_ATA, WALLET, AuthorityType.AccountOwner, ATTACKER),
    ]).bytes);
    const r = evaluateTransactionRisk({ decoded: d, effects: effects({}), wallet: W, effectsStatus: "COMPLETE" });
    expect(r.level).toBe("CRITICAL");
    expect(r.signals.map((s) => s.code)).toEqual(expect.arrayContaining(["TX_UNLIMITED_APPROVAL", "TX_TOKEN_ACCOUNT_OWNER_CHANGE"]));
  });

  it("flags unexpected outflow caused by an unknown program and SOL drains", () => {
    const d = decodeOf(buildTx([new TransactionInstruction({ programId: key(90), keys: [{ pubkey: WALLET, isSigner: true, isWritable: true }], data: Buffer.from([9]) })]).bytes);
    const r = evaluateTransactionRisk({
      decoded: d,
      effects: effects({ solChanges: [{ address: W, preLamports: "10000000000", postLamports: "5000", deltaLamports: "-9999995000" }] }),
      wallet: W,
      effectsStatus: "COMPLETE",
    });
    expect(r.signals.map((s) => s.code)).toEqual(expect.arrayContaining(["TX_UNEXPECTED_SOL_OUTFLOW", "TX_SOL_DRAIN"]));
    expect(r.level).toBe("CRITICAL");
  });

  it("reports simulation failure without claiming safety", () => {
    const r = evaluateTransactionRisk({ decoded: transfer50Usdc, effects: effects({ success: false, error: '{"InstructionError":[0,"Custom"]}' }), wallet: W, effectsStatus: "COMPLETE" });
    expect(r.signals.map((s) => s.code)).toContain("TX_SIMULATION_FAILED");
    expect(r.status).toBe("PARTIAL");
  });

  it("regression: a plain SOL transfer is not 'unexpected' when fee/priority fee are included", () => {
    const d = decodeOf(buildTx([
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 10_000 }),
      SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 1_000_000 }),
    ]).bytes);
    expect(estimatePriorityFeeLamports(d)).toBe(1000n);
    // wallet pays 1_000_000 + 5_000 base + 1_000 priority
    const r = evaluateTransactionRisk({ decoded: d, effects: effects({ solChanges: [{ address: W, preLamports: "10000000000", postLamports: "9998994000", deltaLamports: "-1006000" }] }), wallet: W, effectsStatus: "COMPLETE" });
    const codes = r.signals.map((s) => s.code);
    expect(codes).toContain("TX_SOL_OUTFLOW");
    expect(codes).not.toContain("TX_UNEXPECTED_SOL_OUTFLOW");
  });

  it("marks stale simulations as partial", () => {
    const r = evaluateTransactionRisk({ decoded: transfer50Usdc, effects: { ...usdcOut, stale: true }, wallet: W, effectsStatus: "PARTIAL" });
    expect(r.status).toBe("PARTIAL");
  });

  it("uses the Demo source label in demo mode", () => {
    const r = evaluateTransactionRisk({ decoded: transfer50Usdc, effects: usdcOut, wallet: W, effectsStatus: "COMPLETE", demo: true });
    expect(r.evidence.every((e) => e.source === "DEMO")).toBe(true);
  });

  it("keeps PublicKey round-trips stable", () => {
    expect(new PublicKey(W).toBase58()).toBe(W);
  });
});
