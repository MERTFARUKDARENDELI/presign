import { createHash } from "node:crypto";
import { createMintToInstruction } from "@solana/spl-token";
import { ComputeBudgetProgram, PublicKey, StakeAuthorizationLayout, StakeProgram, SystemProgram, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { evaluateTransactionRisk } from "@/lib/security/rules/transaction";
import { BPF_LOADER_UPGRADEABLE_ID, BUBBLEGUM_PROGRAM_ID, METAPLEX_CORE_PROGRAM_ID } from "@/lib/solana/constants";
import { BUBBLEGUM_DISCRIMINATORS, decodeTransaction } from "@/lib/transaction/decoder";
import { describeInstruction } from "@/lib/transaction/explain";
import type { TransactionEffects } from "@/lib/transaction/types";
import { ATTACKER, ATTACKER_ATA, buildTx, key, MINT, WALLET, WALLET_ATA } from "../helpers/fixtures";

const W = WALLET.toBase58();
const A = ATTACKER.toBase58();
const STAKE = key(60);
const UNKNOWN_PROGRAM = key(61);
const TREE = key(62);

function decode(...ixs: TransactionInstruction[]) {
  return decodeTransaction(VersionedTransaction.deserialize(buildTx(ixs).bytes));
}
type Decoded = ReturnType<typeof decode>;
function effects(o: Partial<TransactionEffects> = {}): TransactionEffects {
  return { source: "SIMULATION", success: true, error: null, logs: [], logsTruncated: false, unitsConsumed: 1, slot: 2, preStateSlot: 1, stale: false, blockhashValid: true, feeLamports: "5000", solChanges: [{ address: W, preLamports: "1000000000", postLamports: "999995000", deltaLamports: "-5000" }], tokenChanges: [], accountChanges: [], notes: [], ...o };
}
const risk = (d: Decoded, e: TransactionEffects | null = null, owners: Record<string, string> = {}) =>
  evaluateTransactionRisk({ decoded: d, effects: e, wallet: W, effectsStatus: "COMPLETE", tokenAccountOwners: owners });
const codes = (d: Decoded, e: TransactionEffects | null = null, owners: Record<string, string> = {}) => risk(d, e, owners).signals.map((s) => s.code);
const signal = (d: Decoded, code: string, e: TransactionEffects | null = null) => risk(d, e).signals.find((s) => s.code === code);

function raw(programId: string | PublicKey, keys: Array<[PublicKey, { signer?: boolean; writable?: boolean }?]>, data: number[]) {
  return new TransactionInstruction({ programId: new PublicKey(programId), keys: keys.map(([pubkey, f]) => ({ pubkey, isSigner: !!f?.signer, isWritable: !!f?.writable })), data: Buffer.from(data) });
}
const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
/** Bubblegum v1 args after the discriminator: root, data hash, creator hash (32 each), nonce u64, index u32. */
const CNFT_ARGS = new Array(32 * 3 + 8 + 4).fill(7);
function cnft(name: keyof typeof BUBBLEGUM_DISCRIMINATORS, accounts: PublicKey[], owner = WALLET) {
  return raw(BUBBLEGUM_PROGRAM_ID, accounts.map((k) => [k, { signer: k.equals(owner), writable: k.equals(TREE) }]), [...BUBBLEGUM_DISCRIMINATORS[name], ...CNFT_ARGS]);
}
const cnftTransfer = (to: PublicKey) => cnft("transfer", [key(63), WALLET, WALLET, to, TREE]);

describe("staked SOL (stake accounts are not in the wallet balance)", () => {
  it("a withdraw-authority change to another address is CRITICAL and explained", () => {
    const d = decode(StakeProgram.authorize({ stakePubkey: STAKE, authorizedPubkey: WALLET, newAuthorizedPubkey: ATTACKER, stakeAuthorizationType: StakeAuthorizationLayout.Withdrawer }).instructions[0]);
    expect(d.instructions[0]).toMatchObject({ type: "stake:authorize", parsed: true });
    expect(d.instructions[0].info).toMatchObject({ stakeAccount: STAKE.toBase58(), authority: W, newAuthority: A, authorityType: "Withdrawer" });
    expect(signal(d, "TX_STAKE_WITHDRAW_AUTHORITY_CHANGE")?.severity).toBe("CRITICAL");
    expect(risk(d).level).toBe("CRITICAL");
    expect(describeInstruction(d.instructions[0])).toMatch(/withdraw authority of stake account/);
  });

  it("a stake-authority change is HIGH; handing it to yourself is not a signal", () => {
    const toOther = decode(StakeProgram.authorize({ stakePubkey: STAKE, authorizedPubkey: WALLET, newAuthorizedPubkey: ATTACKER, stakeAuthorizationType: StakeAuthorizationLayout.Staker }).instructions[0]);
    expect(signal(toOther, "TX_STAKE_AUTHORITY_CHANGE")?.severity).toBe("HIGH");
    expect(codes(toOther)).not.toContain("TX_STAKE_WITHDRAW_AUTHORITY_CHANGE");
    const toSelf = decode(StakeProgram.authorize({ stakePubkey: STAKE, authorizedPubkey: WALLET, newAuthorizedPubkey: WALLET, stakeAuthorizationType: StakeAuthorizationLayout.Withdrawer }).instructions[0]);
    expect(codes(toSelf).filter((c) => c.startsWith("TX_STAKE"))).toEqual([]);
  });

  it("AuthorizeChecked (new authority as an account) is decoded and flagged", () => {
    const clock = new PublicKey("SysvarC1ock11111111111111111111111111111111");
    const d = decode(raw(StakeProgram.programId, [[STAKE, { writable: true }], [clock], [WALLET, { signer: true }], [ATTACKER, { signer: true }]], [...u32(10), ...u32(1)]));
    expect(d.instructions[0].info).toMatchObject({ authority: W, newAuthority: A, authorityType: "Withdrawer" });
    expect(codes(d)).toContain("TX_STAKE_WITHDRAW_AUTHORITY_CHANGE");
  });

  it("withdrawing staked SOL to another address is HIGH; to the wallet it is not", () => {
    const out = decode(StakeProgram.withdraw({ stakePubkey: STAKE, authorizedPubkey: WALLET, toPubkey: ATTACKER, lamports: 5_000_000_000 }).instructions[0]);
    expect(out.instructions[0].info).toMatchObject({ to: A, lamports: "5000000000" });
    expect(signal(out, "TX_STAKE_WITHDRAW_TO_OTHER")?.severity).toBe("HIGH");
    expect(describeInstruction(out.instructions[0])).toMatch(/Withdraw 5 SOL from stake account/);
    const home = decode(StakeProgram.withdraw({ stakePubkey: STAKE, authorizedPubkey: WALLET, toPubkey: WALLET, lamports: 5_000_000_000 }).instructions[0]);
    expect(codes(home)).not.toContain("TX_STAKE_WITHDRAW_TO_OTHER");
  });

  it("a lockup change is MEDIUM", () => {
    const d = decode(raw(StakeProgram.programId, [[STAKE, { writable: true }], [WALLET, { signer: true }]], [...u32(6), 0, 0, 0]));
    expect(d.instructions[0].type).toBe("stake:setLockup");
    expect(signal(d, "TX_STAKE_LOCKUP_CHANGE")?.severity).toBe("MEDIUM");
  });

  it("ordinary staking (delegate, deactivate) is decoded without risk signals", () => {
    const d = decode(StakeProgram.delegate({ stakePubkey: STAKE, authorizedPubkey: WALLET, votePubkey: key(64) }).instructions[0], StakeProgram.deactivate({ stakePubkey: STAKE, authorizedPubkey: WALLET }).instructions[0]);
    expect(d.instructions.map((i) => i.type)).toEqual(["stake:delegate", "stake:deactivate"]);
    expect(d.undecodedInstructions).toEqual([]);
    expect(codes(d).filter((c) => c.startsWith("TX_STAKE"))).toEqual([]);
  });
});

describe("compressed NFTs (Bubblegum) never appear in token balances", () => {
  it("discriminators are the Anchor sha256('global:<name>') prefixes", () => {
    for (const [name, disc] of Object.entries(BUBBLEGUM_DISCRIMINATORS)) {
      const snake = name.replace(/V2$/, "_v2");
      expect([...createHash("sha256").update(`global:${snake}`).digest().subarray(0, 8)]).toEqual(disc);
    }
  });

  it("one cNFT leaving the wallet is HIGH; two or more is a CRITICAL drain", () => {
    const one = decode(cnftTransfer(ATTACKER));
    expect(one.instructions[0].info).toMatchObject({ leafOwner: W, newLeafOwner: A, merkleTree: TREE.toBase58() });
    expect(signal(one, "TX_CNFT_TRANSFER")?.severity).toBe("HIGH");
    expect(describeInstruction(one.instructions[0])).toMatch(/compressed NFT/);
    const many = decode(cnftTransfer(ATTACKER), cnftTransfer(ATTACKER), cnftTransfer(key(65)));
    expect(signal(many, "TX_CNFT_DRAIN")?.severity).toBe("CRITICAL");
    expect(codes(many)).not.toContain("TX_CNFT_TRANSFER");
  });

  it("receiving a cNFT is not a signal", () => {
    const d = decode(cnft("transfer", [key(63), ATTACKER, ATTACKER, WALLET, TREE], ATTACKER));
    expect(codes(d).filter((c) => c.startsWith("TX_CNFT"))).toEqual([]);
  });

  it("delegating a cNFT to another address is HIGH; burning one is MEDIUM", () => {
    const del = decode(cnft("delegate", [key(63), WALLET, WALLET, ATTACKER, TREE]));
    expect(signal(del, "TX_CNFT_DELEGATE")?.severity).toBe("HIGH");
    const burn = decode(cnft("burn", [key(63), WALLET, WALLET, TREE]));
    expect(signal(burn, "TX_CNFT_BURN")?.severity).toBe("MEDIUM");
  });

  it("Bubblegum v2 involving the wallet is identified and flagged as not fully decoded", () => {
    const d = decode(cnft("transferV2", [key(63), WALLET, ATTACKER, TREE]));
    expect(d.instructions[0]).toMatchObject({ type: "bubblegum:transferV2", parsed: false });
    expect(signal(d, "TX_CNFT_UNDECODED")?.severity).toBe("HIGH");
  });

  it("Metaplex Core instructions involving the wallet are flagged as undecoded NFT movement", () => {
    const d = decode(raw(METAPLEX_CORE_PROGRAM_ID, [[key(66), { writable: true }], [WALLET, { signer: true }], [ATTACKER]], [14, 0]));
    expect(signal(d, "TX_NFT_PROGRAM_UNDECODED")?.severity).toBe("MEDIUM");
  });
});

describe("priority fee drains", () => {
  const fee = (microLamports: number, units = 200_000) => [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports }), SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: WALLET, lamports: 1 })];

  it("normal fees are not a signal", () => {
    expect(codes(decode(...fee(100_000)))).not.toContain("TX_EXCESSIVE_PRIORITY_FEE");
  });

  it("≥ 0.01 SOL is MEDIUM, ≥ 0.1 SOL is HIGH", () => {
    expect(signal(decode(...fee(50_000_000)), "TX_EXCESSIVE_PRIORITY_FEE")?.severity).toBe("MEDIUM");
    expect(signal(decode(...fee(500_000_000)), "TX_EXCESSIVE_PRIORITY_FEE")?.severity).toBe("HIGH");
  });

  it("a fee of half the wallet's SOL or more is CRITICAL", () => {
    const d = decode(...fee(50_000_000));
    const poor = effects({ solChanges: [{ address: W, preLamports: "15000000", postLamports: "0", deltaLamports: "-15000000" }] });
    expect(signal(d, "TX_EXCESSIVE_PRIORITY_FEE", poor)?.severity).toBe("CRITICAL");
  });

  it("a fee paid by someone else is not the signer's risk", () => {
    const tx = buildTx(fee(500_000_000), ATTACKER);
    expect(codes(decodeTransaction(VersionedTransaction.deserialize(tx.bytes)))).not.toContain("TX_EXCESSIVE_PRIORITY_FEE");
  });
});

describe("programs and accounts the wallet controls", () => {
  const loader = new PublicKey(BPF_LOADER_UPGRADEABLE_ID);
  const sysvar = (s: string) => new PublicKey(s);

  it("a program upgrade with the wallet's authority is HIGH", () => {
    const d = decode(raw(loader, [[key(70), { writable: true }], [key(71), { writable: true }], [key(72), { writable: true }], [WALLET, { writable: true }], [sysvar("SysvarRent111111111111111111111111111111111")], [sysvar("SysvarC1ock11111111111111111111111111111111")], [WALLET, { signer: true }]], u32(3)));
    expect(signal(d, "TX_PROGRAM_UPGRADE")?.severity).toBe("HIGH");
  });

  it("closing a program with the wallet's authority is HIGH", () => {
    const d = decode(raw(loader, [[key(71), { writable: true }], [ATTACKER, { writable: true }], [WALLET, { signer: true }], [key(72), { writable: true }]], u32(5)));
    expect(signal(d, "TX_PROGRAM_CLOSE")?.description).toMatch(/SOL goes to/);
  });

  it("allocating data on the wallet account itself is HIGH", () => {
    const d = decode(SystemProgram.allocate({ accountPubkey: WALLET, space: 128 }));
    expect(d.instructions[0]).toMatchObject({ type: "system:allocate", parsed: true });
    expect(signal(d, "TX_WALLET_ALLOCATE")?.severity).toBe("HIGH");
    expect(describeInstruction(d.instructions[0])).toMatch(/128 bytes/);
  });

  it("minting with the wallet's authority to another owner is MEDIUM; to its own account it is not", () => {
    const d = decode(createMintToInstruction(MINT, ATTACKER_ATA, WALLET, 1_000n));
    expect(signal(d, "TX_MINT_TO_OTHER")?.severity).toBe("MEDIUM");
    expect(codes(decode(createMintToInstruction(MINT, WALLET_ATA, WALLET, 1_000n)), null, { [WALLET_ATA.toBase58()]: W })).not.toContain("TX_MINT_TO_OTHER");
  });
});

describe("what a simulation cannot prove", () => {
  const unknownIx = (accounts: Array<[PublicKey, { signer?: boolean; writable?: boolean }?]>) => raw(UNKNOWN_PROGRAM, accounts, [1, 2, 3]);

  it("a durable-nonce signature for an unverified program is HIGH", () => {
    const nonce = key(80);
    const d = decode(SystemProgram.nonceAdvance({ noncePubkey: nonce, authorizedPubkey: WALLET }), unknownIx([[WALLET, { signer: true, writable: true }]]));
    expect(d.usesDurableNonce).toBe(true);
    expect(signal(d, "TX_UNKNOWN_PROGRAM_DURABLE_NONCE")?.severity).toBe("HIGH");
    expect(codes(decode(unknownIx([[WALLET, { signer: true, writable: true }]])))).not.toContain("TX_UNKNOWN_PROGRAM_DURABLE_NONCE");
  });

  it("an unverified program with the wallet's signature and write access to its tokens, but no simulated change, is flagged", () => {
    const owners = { [WALLET_ATA.toBase58()]: W };
    const d = decode(unknownIx([[WALLET, { signer: true, writable: true }], [WALLET_ATA, { writable: true }]]));
    expect(codes(d, effects(), owners)).toContain("TX_SIMULATION_EVASION_RISK");
    // A visible change to the same account is ordinary behavior, not evasion.
    const moved = effects({ tokenChanges: [{ tokenAccount: WALLET_ATA.toBase58(), owner: W, mint: MINT.toBase58(), decimals: 6, preRaw: "10", postRaw: "5", deltaRaw: "-5" }] });
    expect(codes(d, moved, owners)).not.toContain("TX_SIMULATION_EVASION_RISK");
    // Without the wallet's signature the program cannot spend the tokens.
    const unsigned = decode(unknownIx([[WALLET_ATA, { writable: true }]]));
    expect(codes(unsigned, effects(), owners)).not.toContain("TX_SIMULATION_EVASION_RISK");
  });
});
