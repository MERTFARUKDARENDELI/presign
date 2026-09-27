import {
  AccountState,
  AuthorityType,
  createApproveInstruction,
  createDisableCpiGuardInstruction,
  createDisableRequiredMemoTransfersInstruction,
  createEnableCpiGuardInstruction,
  createHarvestWithheldTokensToMintInstruction,
  createInitializeMintCloseAuthorityInstruction,
  createInitializeNonTransferableMintInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeTransferFeeConfigInstruction,
  createPauseInstruction,
  createReallocateInstruction,
  createResumeInstruction,
  createSetAuthorityInstruction,
  createSetTransferFeeInstruction,
  createTransferCheckedInstruction,
  createTransferCheckedWithFeeInstruction,
  createUpdateDefaultAccountStateInstruction,
  createUpdateMetadataPointerInstruction,
  createUpdateTransferHookInstruction,
  createWithdrawWithheldTokensFromAccountsInstruction,
  createWithdrawWithheldTokensFromMintInstruction,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID as T22,
  TOKEN_PROGRAM_ID as SPL,
} from "@solana/spl-token";
import { TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { evaluateTransactionRisk } from "@/lib/security/rules/transaction";
import { TOKEN_2022_PROGRAM_ID } from "@/lib/solana/constants";
import { decodeTransaction } from "@/lib/transaction/decoder";
import { explainTransaction } from "@/lib/transaction/explain";
import { applyInnerInstructions } from "@/lib/transaction/inner";
import { authorityTypeName, decodeToken2022Extension } from "@/lib/transaction/token2022";
import type { TransactionAnalysis } from "@/lib/transaction/types";
import { ATTACKER, ATTACKER_ATA, buildTx, key, MINT, WALLET, WALLET_ATA } from "../helpers/fixtures";

const W = WALLET.toBase58();
const A = ATTACKER.toBase58();

function decode(...ixs: TransactionInstruction[]) {
  return decodeTransaction(VersionedTransaction.deserialize(buildTx(ixs).bytes));
}
const types = (d: ReturnType<typeof decode>) => d.instructions.map((i) => i.type);
const risk = (d: ReturnType<typeof decode>) => evaluateTransactionRisk({ decoded: d, effects: null, wallet: W, effectsStatus: "COMPLETE" });
const riskCodes = (d: ReturnType<typeof decode>) => risk(d).signals.map((s) => s.code);

describe("Token-2022 extension decoding (bytes from @solana/spl-token builders)", () => {
  it("transferCheckedWithFee is a real token transfer with mint, decimals and fee", () => {
    const d = decode(createTransferCheckedWithFeeInstruction(WALLET_ATA, MINT, ATTACKER_ATA, WALLET, 1_500_000n, 6, 15_000n, [], T22));
    expect(types(d)).toEqual(["token-2022:transferCheckedWithFee"]);
    expect(d.instructions[0].info).toMatchObject({ source: WALLET_ATA.toBase58(), mint: MINT.toBase58(), destination: ATTACKER_ATA.toBase58(), authority: W, amount: "1500000", decimals: "6", fee: "15000" });
    expect(d.tokenTransfers).toEqual([expect.objectContaining({ program: "token-2022", authority: W, amountRaw: "1500000", mint: MINT.toBase58(), decimals: 6 })]);
    expect(d.undecodedInstructions).toEqual([]);
  });

  it("decodes security-relevant extension instructions with their fields", () => {
    const hook = key(50);
    const d = decode(
      createDisableCpiGuardInstruction(WALLET_ATA, WALLET, [], T22),
      createEnableCpiGuardInstruction(WALLET_ATA, WALLET, [], T22),
      createUpdateTransferHookInstruction(MINT, WALLET, hook, [], T22),
      createInitializePermanentDelegateInstruction(MINT, ATTACKER, T22),
      createPauseInstruction(MINT, WALLET, [], T22),
      createResumeInstruction(MINT, WALLET, [], T22),
      createUpdateDefaultAccountStateInstruction(MINT, AccountState.Frozen, WALLET, [], T22),
      createSetTransferFeeInstruction(MINT, WALLET, [], 250, 1_000_000n, T22),
      createDisableRequiredMemoTransfersInstruction(WALLET_ATA, WALLET, [], T22),
      createInitializeMintCloseAuthorityInstruction(MINT, WALLET, T22),
      createInitializeNonTransferableMintInstruction(MINT, T22),
      createUpdateMetadataPointerInstruction(MINT, WALLET, key(51), [], T22),
    );
    expect(types(d)).toEqual([
      "token-2022:disableCpiGuard", "token-2022:enableCpiGuard", "token-2022:updateTransferHook", "token-2022:initializePermanentDelegate",
      "token-2022:pause", "token-2022:resume", "token-2022:updateDefaultAccountState", "token-2022:setTransferFee",
      "token-2022:disableRequiredMemoTransfers", "token-2022:initializeMintCloseAuthority", "token-2022:initializeNonTransferableMint", "token-2022:updateMetadataPointer",
    ]);
    const info = d.instructions.map((i) => i.info);
    expect(info[0]).toMatchObject({ account: WALLET_ATA.toBase58(), owner: W });
    expect(info[2]).toMatchObject({ mint: MINT.toBase58(), authority: W, programId: hook.toBase58() });
    expect(info[3]).toMatchObject({ delegate: A });
    expect(info[6]).toMatchObject({ accountState: "frozen" });
    expect(info[7]).toMatchObject({ transferFeeBasisPoints: "250", maximumFee: "1000000" });
    expect(info[9]).toMatchObject({ closeAuthority: W });
    expect(info[11]).toMatchObject({ address: key(51).toBase58() });
    expect(d.instructions.every((i) => i.parsed)).toBe(true);
    expect(d.undecodedInstructions).toEqual([]);
  });

  it("decodes transfer-fee administration and reallocate", () => {
    const d = decode(
      createInitializeTransferFeeConfigInstruction(MINT, WALLET, WALLET, 100, 5_000n, T22),
      createWithdrawWithheldTokensFromMintInstruction(MINT, WALLET_ATA, WALLET, [], T22),
      createWithdrawWithheldTokensFromAccountsInstruction(MINT, WALLET_ATA, WALLET, [], [ATTACKER_ATA], T22),
      createHarvestWithheldTokensToMintInstruction(MINT, [ATTACKER_ATA], T22),
      createReallocateInstruction(WALLET_ATA, WALLET, [ExtensionType.CpiGuard, ExtensionType.MemoTransfer], WALLET, [], T22),
    );
    expect(types(d)).toEqual([
      "token-2022:initializeTransferFeeConfig", "token-2022:withdrawWithheldTokensFromMint", "token-2022:withdrawWithheldTokensFromAccounts",
      "token-2022:harvestWithheldTokensToMint", "token-2022:reallocate",
    ]);
    expect(d.instructions[2].info.numTokenAccounts).toBe("1");
    expect(d.instructions[4].info.extensionTypes).toBe(`${ExtensionType.CpiGuard},${ExtensionType.MemoTransfer}`);
  });

  it("extended SetAuthority types are named on Token-2022 only", () => {
    const d = decode(createSetAuthorityInstruction(MINT, WALLET, AuthorityType.PermanentDelegate, ATTACKER, [], T22));
    expect(d.authorityChanges[0]).toMatchObject({ authorityType: "PermanentDelegate", newAuthority: A });
    expect(authorityTypeName(8, "spl-token")).toBe("Unknown(8)");
    expect(authorityTypeName(8, "token-2022")).toBe("PermanentDelegate");
    expect(authorityTypeName(2, "spl-token")).toBe("AccountOwner");
    expect(authorityTypeName(99, "token-2022")).toBe("Unknown(99)");
  });
});

describe("Token-2022 unknown / opaque / malformed", () => {
  const raw = (data: number[], programId = T22, n = 3) =>
    new TransactionInstruction({ programId, keys: [WALLET_ATA, MINT, WALLET].slice(0, n).map((pubkey, i) => ({ pubkey, isSigner: i === 2, isWritable: i === 0 })), data: Buffer.from(data) });

  it("confidential-transfer families are identified but NOT decoded (no invented meaning)", () => {
    const d = decode(raw([27, 7, 1, 2, 3]));
    expect(d.instructions[0]).toMatchObject({ type: "token-2022:confidentialTransferExtension", parsed: false, info: {} });
    expect(d.undecodedInstructions).toEqual([0]);
    const r = risk(d);
    expect(r.signals.map((s) => s.code)).toContain("TX_TOKEN2022_CONFIDENTIAL");
    expect(r.status).not.toBe("COMPLETE"); // undecoded instruction: never a complete analysis
    expect(r.level).not.toBe("SAFE");
  });

  it("unknown discriminators and unknown sub-instructions stay undecoded", () => {
    for (const data of [[200], [99, 0], [26, 9], [34, 7], [44, 5]]) {
      const d = decode(raw(data));
      expect(d.instructions[0].type, JSON.stringify(data)).toBe("SPL Token-2022:undecoded");
      expect(d.instructions[0].parsed).toBe(false);
      expect(d.undecodedInstructions).toEqual([0]);
    }
  });

  it("malformed lengths / missing accounts are undecoded — never partially parsed", () => {
    expect(decodeToken2022Extension(Uint8Array.from([26, 1, 1, 2, 3]), ["a", "b", "c", "d"])).toBeNull(); // truncated transferCheckedWithFee
    expect(decodeToken2022Extension(Uint8Array.from([34, 1, 0]), ["a", "b"])).toBeNull(); // extra byte
    expect(decodeToken2022Extension(Uint8Array.from([34, 1]), ["a"])).toBeNull(); // owner missing
    expect(decodeToken2022Extension(Uint8Array.from([36, 1, ...new Array(10).fill(1)]), ["a", "b"])).toBeNull();
    expect(decodeToken2022Extension(Uint8Array.from([26, 0, ...new Array(20).fill(0)]), ["a"])).toBeNull(); // bad COption layout
    expect(decodeToken2022Extension(Uint8Array.from([]), [])).toBeNull();
    expect(decodeToken2022Extension(Uint8Array.from([3]), [])).toBeNull(); // base instruction, not an extension
    const d = decode(raw([26, 1, 1, 2, 3], T22, 3));
    expect(d.tokenTransfers).toEqual([]);
    expect(d.undecodedInstructions).toEqual([0]);
  });
});

describe("SPL Token regression — never mixed with Token-2022", () => {
  it("classic SPL Token instructions decode exactly as before", () => {
    const d = decode(
      createTransferCheckedInstruction(WALLET_ATA, MINT, ATTACKER_ATA, WALLET, 5n, 6, [], SPL),
      createApproveInstruction(WALLET_ATA, ATTACKER, WALLET, 10n, [], SPL),
    );
    expect(types(d)).toEqual(["token:transferChecked", "token:approve"]);
    expect(d.tokenTransfers[0]).toMatchObject({ program: "spl-token", amountRaw: "5" });
  });

  it("Token-2022-only bytes sent to the classic SPL Token program are NOT decoded as extensions", () => {
    // Same bytes and accounts as the Token-2022 builders, re-targeted at the classic program.
    const toSpl = (ix: TransactionInstruction) => new TransactionInstruction({ programId: SPL, keys: ix.keys, data: ix.data });
    for (const ix of [
      createDisableCpiGuardInstruction(WALLET_ATA, WALLET, [], T22),
      createTransferCheckedWithFeeInstruction(WALLET_ATA, MINT, ATTACKER_ATA, WALLET, 1n, 6, 0n, [], T22),
    ]) {
      const d = decode(toSpl(ix));
      expect(d.instructions[0].type).toBe("SPL Token:undecoded");
      expect(d.tokenTransfers).toEqual([]);
      expect(riskCodes(d)).not.toContain("TX_CPI_GUARD_DISABLED");
    }
  });

  it("base instructions on Token-2022 keep their shared meaning, prefixed token-2022", () => {
    const d = decode(createApproveInstruction(WALLET_ATA, ATTACKER, WALLET, 2n ** 64n - 1n, [], T22));
    expect(types(d)).toEqual(["token-2022:approve"]);
    expect(riskCodes(d)).toContain("TX_UNLIMITED_APPROVAL");
  });

  it("parsed CPI 'transferCheckedWithFee' counts as a transfer only for the Token-2022 program id", () => {
    const d = decode(new TransactionInstruction({ programId: key(42), keys: [{ pubkey: WALLET, isSigner: true, isWritable: true }], data: Buffer.from([1]) }));
    const cpi = (programId: string) => ({ program: "spl-token-2022", programId, parsed: { type: "transferCheckedWithFee", info: { source: WALLET_ATA.toBase58(), destination: ATTACKER_ATA.toBase58(), authority: W, mint: MINT.toBase58(), tokenAmount: { amount: "7", decimals: 0 } } } });
    applyInnerInstructions(d, [{ index: 0, instructions: [cpi(TOKEN_2022_PROGRAM_ID), cpi(SPL.toBase58())] }], "SIMULATION");
    expect(d.tokenTransfers).toHaveLength(1);
    expect(d.tokenTransfers[0]).toMatchObject({ program: "token-2022", amountRaw: "7", cpi: true });
  });
});

describe("Token-2022 → risk engine", () => {
  it("disabling CPI Guard on the wallet's account is MEDIUM alone", () => {
    const r = risk(decode(createDisableCpiGuardInstruction(WALLET_ATA, WALLET, [], T22)));
    expect(r.signals.map((s) => s.code)).toEqual(["TX_CPI_GUARD_DISABLED"]);
    expect(r.level).toBe("MEDIUM");
  });

  it("CPI Guard disabled + an unverified program → HIGH combined signal citing both evidence ids", () => {
    const unknown = new TransactionInstruction({ programId: key(42), keys: [{ pubkey: WALLET, isSigner: true, isWritable: true }], data: Buffer.from([1]) });
    const r = risk(decode(createDisableCpiGuardInstruction(WALLET_ATA, WALLET, [], T22), unknown));
    const combo = r.signals.find((s) => s.code === "TX_CPI_GUARD_DISABLED_WITH_UNKNOWN_PROGRAM")!;
    expect(combo.severity).toBe("HIGH");
    expect(combo.evidenceIds).toHaveLength(2);
    const ids = new Set(r.evidence.map((e) => e.id));
    combo.evidenceIds.forEach((id) => expect(ids.has(id)).toBe(true));
    expect(r.level).toBe("HIGH");
  });

  it("another owner's CPI Guard change is not attributed to the wallet", () => {
    expect(riskCodes(decode(createDisableCpiGuardInstruction(ATTACKER_ATA, ATTACKER, [], T22)))).not.toContain("TX_CPI_GUARD_DISABLED");
  });

  it("a fee-bearing transfer out of the wallet feeds the normal outflow rules", () => {
    const d = decode(createTransferCheckedWithFeeInstruction(WALLET_ATA, MINT, ATTACKER_ATA, WALLET, 1_000n, 0, 10n, [], T22));
    const effects = { source: "SIMULATION" as const, success: true, error: null, logs: [], logsTruncated: false, unitsConsumed: 1, slot: 2, preStateSlot: 1, stale: false, blockhashValid: true, feeLamports: "5000", solChanges: [], accountChanges: [], notes: [],
      tokenChanges: [{ tokenAccount: WALLET_ATA.toBase58(), owner: W, mint: MINT.toBase58(), decimals: 0, preRaw: "5000", postRaw: "4000", deltaRaw: "-1000" }] };
    const r = evaluateTransactionRisk({ decoded: d, effects, wallet: W, effectsStatus: "COMPLETE" });
    expect(r.signals.map((s) => s.code)).toContain(`TX_TOKEN_OUTFLOW:${MINT.toBase58()}`);
    expect(r.signals.map((s) => s.code)).not.toContain(`TX_UNEXPECTED_TOKEN_OUTFLOW:${MINT.toBase58()}`);
  });

  it("explanations describe decoded Token-2022 instructions and never describe undecoded ones", () => {
    const d = decode(
      createDisableCpiGuardInstruction(WALLET_ATA, WALLET, [], T22),
      createTransferCheckedWithFeeInstruction(WALLET_ATA, MINT, ATTACKER_ATA, WALLET, 2_000_000n, 6, 20_000n, [], T22),
      new TransactionInstruction({ programId: T22, keys: [{ pubkey: WALLET, isSigner: true, isWritable: true }], data: Buffer.from([27, 1]) }),
    );
    const analysis = { inputKind: "serialized-base64", signature: null, messageHash: null, cluster: "devnet", perspectiveWallet: W, perspectiveSource: "provided", decoded: d, effects: null, effectsStatus: "INSUFFICIENT_DATA", risk: risk(d), demo: false } as unknown as TransactionAnalysis;
    const lines = explainTransaction(analysis).whatHappens;
    expect(lines[0]).toMatch(/Turn OFF CPI Guard/);
    expect(lines[1]).toMatch(/Transfer 2 .*transfer fee up to 0\.02 withheld/);
    expect(lines[2]).toMatch(/cannot be decoded/);
  });
});
