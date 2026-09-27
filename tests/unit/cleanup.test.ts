import { createBurnCheckedInstruction, createCloseAccountInstruction, createRevokeInstruction } from "@solana/spl-token";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { CAPABILITY_MATRIX, evaluateAssetCleanup, evaluateTokenAccountCleanup } from "@/lib/cleanup/capabilities";
import { buildCleanupInstructions, messageHashOf, verifyCleanupTransaction, type CleanupIntent } from "@/lib/cleanup/intent";
import { checkFeeBalance, estimateReclaim, INSUFFICIENT_SOL_MESSAGE } from "@/lib/cleanup/reclaim";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@/lib/solana/constants";
import { parseDasAsset } from "@/lib/solana/das";
import { parseMintAccount, parseTokenAccount } from "@/lib/solana/parsers";
import { ATTACKER, ATTACKER_ATA, buildTx, MINT, OTHER_MINT, parsedMint, parsedTokenAccount, WALLET, WALLET_ATA } from "../helpers/fixtures";

const W = WALLET.toBase58();
const acct = (o: Parameters<typeof parsedTokenAccount>[0]) => parseTokenAccount(WALLET_ATA.toBase58(), parsedTokenAccount(o))!;
const mint = parseMintAccount(MINT.toBase58(), parsedMint({}));

describe("capability matrix", () => {
  it("never routes cNFTs into SPL burn/close", () => {
    expect(CAPABILITY_MATRIX.COMPRESSED_NFT.BURN_AND_CLOSE.status).toBe("UNSUPPORTED");
    const asset = parseDasAsset({ id: MINT.toBase58(), interface: "V1_NFT", compression: { compressed: true } })!;
    const e = evaluateAssetCleanup(asset)!;
    expect(e.assetClass).toBe("COMPRESSED_NFT");
    expect(e.grossReclaimLamports).toBeNull();
    expect(e.labels).not.toContain("burnable");
    expect(e.labels).not.toContain("closeable");
  });

  it("supports burn & close for a normal SPL account", () => {
    const e = evaluateTokenAccountCleanup(acct({ amount: "100" }), W, { mint });
    expect(e.actions.BURN_AND_CLOSE.status).toBe("SUPPORTED");
    expect(e.actions.CLOSE.status).toBe("NOT_APPLICABLE");
    expect(e.grossReclaimLamports).toBe("2039280");
  });

  it("supports close for zero balance accounts", () => {
    const e = evaluateTokenAccountCleanup(acct({ amount: "0" }), W, { mint });
    expect(e.actions.CLOSE.status).toBe("SUPPORTED");
    expect(e.actions.BURN_AND_CLOSE.status).toBe("NOT_APPLICABLE");
  });

  it("blocks frozen accounts", () => {
    const e = evaluateTokenAccountCleanup(acct({ amount: "5", state: "frozen", delegate: ATTACKER.toBase58() }), W, { mint });
    expect(Object.values(e.actions).every((a) => a.status === "UNSUPPORTED")).toBe(true);
    expect(e.grossReclaimLamports).toBeNull();
  });

  it("blocks unauthorized cleanup (wallet ownership mismatch)", () => {
    const e = evaluateTokenAccountCleanup(acct({ amount: "5", owner: ATTACKER.toBase58() }), W, { mint });
    expect(Object.values(e.actions).every((a) => a.status === "UNSUPPORTED")).toBe(true);
  });

  it("allows revoke only for real delegations", () => {
    expect(evaluateTokenAccountCleanup(acct({ delegate: ATTACKER.toBase58(), delegatedAmount: "5" }), W, { mint }).actions.REVOKE.status).toBe("SUPPORTED");
    expect(evaluateTokenAccountCleanup(acct({}), W, { mint }).actions.REVOKE.status).toBe("NOT_APPLICABLE");
  });

  it("marks non-closeable accounts (foreign close authority)", () => {
    const e = evaluateTokenAccountCleanup(acct({ amount: "0", closeAuthority: ATTACKER.toBase58() }), W, { mint });
    expect(e.actions.CLOSE.status).toBe("UNSUPPORTED");
  });

  it("requires manual review for Token-2022 blocking extensions and unknown mint state", () => {
    const t22 = acct({ amount: "0", program: TOKEN_2022_PROGRAM_ID, extensions: [{ extension: "transferFeeAmount" }] });
    expect(evaluateTokenAccountCleanup(t22, W, { mint }).actions.CLOSE.status).toBe("REQUIRES_MANUAL_REVIEW");
    const t22b = acct({ amount: "10", program: TOKEN_2022_PROGRAM_ID });
    expect(evaluateTokenAccountCleanup(t22b, W, { mint: null }).actions.BURN_AND_CLOSE.status).toBe("REQUIRES_MANUAL_REVIEW");
  });

  it("never burns wrapped SOL and requires manual review for NFTs", () => {
    expect(evaluateTokenAccountCleanup(acct({ amount: "10", isNative: true }), W, { mint }).actions.BURN_AND_CLOSE.status).toBe("UNSUPPORTED");
    expect(evaluateTokenAccountCleanup(acct({ amount: "1", decimals: 0 }), W, { mint, isNft: true }).actions.BURN_AND_CLOSE.status).toBe("REQUIRES_MANUAL_REVIEW");
  });
});

describe("prepared transaction integrity (confirmation → signing)", () => {
  const intent: CleanupIntent = {
    action: "BURN_AND_CLOSE", owner: W, tokenAccount: WALLET_ATA.toBase58(), mint: MINT.toBase58(),
    tokenProgram: TOKEN_PROGRAM_ID, amountRaw: "1000", decimals: 6, destination: W, cluster: "devnet",
  };
  const good = buildTx(buildCleanupInstructions(intent)).bytes;

  it("accepts the exact transaction that was confirmed", () => {
    expect(verifyCleanupTransaction(good, intent)).toEqual({ ok: true, mismatches: [] });
  });

  const tamper = (ixs: Parameters<typeof buildTx>[0], payer = WALLET) => verifyCleanupTransaction(buildTx(ixs, payer).bytes, intent);

  it("blocks changed destination", () => {
    const r = tamper([createBurnCheckedInstruction(WALLET_ATA, MINT, WALLET, 1000n, 6), createCloseAccountInstruction(WALLET_ATA, ATTACKER, WALLET)]);
    expect(r.ok).toBe(false);
  });
  it("blocks changed amount", () => {
    expect(tamper([createBurnCheckedInstruction(WALLET_ATA, MINT, WALLET, 999n, 6), createCloseAccountInstruction(WALLET_ATA, WALLET, WALLET)]).ok).toBe(false);
  });
  it("blocks changed token mint", () => {
    expect(tamper([createBurnCheckedInstruction(WALLET_ATA, OTHER_MINT, WALLET, 1000n, 6), createCloseAccountInstruction(WALLET_ATA, WALLET, WALLET)]).ok).toBe(false);
  });
  it("blocks changed token account", () => {
    expect(tamper([createBurnCheckedInstruction(ATTACKER_ATA, MINT, WALLET, 1000n, 6), createCloseAccountInstruction(ATTACKER_ATA, WALLET, WALLET)]).ok).toBe(false);
  });
  it("blocks changed program (Token-2022 swap)", () => {
    expect(tamper([createBurnCheckedInstruction(WALLET_ATA, MINT, WALLET, 1000n, 6, [], new PublicKey(TOKEN_2022_PROGRAM_ID)), createCloseAccountInstruction(WALLET_ATA, WALLET, WALLET)]).ok).toBe(false);
  });
  it("blocks injected extra instructions (e.g. SOL transfer to attacker)", () => {
    const r = tamper([...buildCleanupInstructions(intent), SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 1 })]);
    expect(r.ok).toBe(false);
  });
  it("blocks a swapped instruction type (revoke instead of burn)", () => {
    expect(tamper([createRevokeInstruction(WALLET_ATA, WALLET)]).ok).toBe(false);
  });
  it("blocks a different fee payer (transaction owner mismatch)", () => {
    expect(tamper(buildCleanupInstructions(intent), ATTACKER).ok).toBe(false);
  });
  it("rejects intents with a foreign rent destination", () => {
    expect(() => buildCleanupInstructions({ ...intent, destination: ATTACKER.toBase58() })).toThrow();
    expect(() => buildCleanupInstructions({ ...intent, action: "CLOSE" })).toThrow(); // non-zero balance close
  });
  it("produces a stable message hash that changes on tampering", async () => {
    const h1 = await messageHashOf(good);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(await messageHashOf(good)).toBe(h1);
    const bad = buildTx([createBurnCheckedInstruction(WALLET_ATA, MINT, WALLET, 1001n, 6), createCloseAccountInstruction(WALLET_ATA, WALLET, WALLET)]).bytes;
    expect(await messageHashOf(bad)).not.toBe(h1);
  });
});

describe("fees and reclaim", () => {
  it("stops on zero SOL and insufficient SOL for fee", () => {
    expect(checkFeeBalance("0", "5000")).toMatchObject({ sufficient: false, message: INSUFFICIENT_SOL_MESSAGE });
    expect(checkFeeBalance("4999", "5000").sufficient).toBe(false);
    expect(checkFeeBalance("5000", "5000").sufficient).toBe(true);
  });

  it("estimates reclaim as not guaranteed and allows negative net", () => {
    const r = estimateReclaim("2039280", "5000");
    expect(r.estimatedNetLamports).toBe("2034280");
    expect(r.disclaimer).toMatch(/not guaranteed/);
    expect(estimateReclaim("1000", "5000").estimatedNetLamports).toBe("-4000");
    expect(estimateReclaim(null, "5000").grossLamports).toBe("0");
  });
});
