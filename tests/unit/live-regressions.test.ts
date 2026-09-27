import { createInitializeImmutableOwnerInstruction, TOKEN_2022_PROGRAM_ID as T22, TOKEN_PROGRAM_ID as SPL } from "@solana/spl-token";
import { TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/api/errors";
import { rpcCall } from "@/lib/solana/client";
import { analyzeTransaction } from "@/lib/transaction/analyze";
import { decodeTransaction } from "@/lib/transaction/decoder";
import { defangLinks } from "@/lib/security/text-signals";
import { toAiContext } from "@/lib/ai/sanitize";
import { buildTx, MINT, WALLET_ATA } from "../helpers/fixtures";

// Regressions for gaps found during the 2026-09-25 read-only mainnet validation.
vi.mock("@/lib/solana/client", async (importOriginal) => ({ ...(await importOriginal<object>()), rpcCall: vi.fn() }));
const rpc = vi.mocked(rpcCall);

const decode = (...ixs: TransactionInstruction[]) => decodeTransaction(VersionedTransaction.deserialize(buildTx(ixs).bytes));
const raw = (programId: typeof T22, data: number[]) =>
  new TransactionInstruction({ programId, keys: [{ pubkey: MINT, isSigner: false, isWritable: false }], data: Buffer.from(data) });

describe("base token instructions seen in every mainnet ATA creation", () => {
  it("initializeImmutableOwner decodes on both programs with the right prefix", () => {
    expect(decode(createInitializeImmutableOwnerInstruction(WALLET_ATA, T22)).instructions[0]).toMatchObject({ type: "token-2022:initializeImmutableOwner", parsed: true, info: { account: WALLET_ATA.toBase58() } });
    expect(decode(createInitializeImmutableOwnerInstruction(WALLET_ATA, SPL)).instructions[0]).toMatchObject({ type: "token:initializeImmutableOwner", parsed: true });
  });

  it("getAccountDataSize: Token-2022 may list extension types, SPL Token may not", () => {
    const t22 = decode(raw(T22, [21, 7, 0, 8, 0])).instructions[0];
    expect(t22).toMatchObject({ type: "token-2022:getAccountDataSize", parsed: true, info: { mint: MINT.toBase58(), extensionTypes: "7,8" } });
    expect(decode(raw(SPL, [21])).instructions[0]).toMatchObject({ type: "token:getAccountDataSize", parsed: true });
    // extension list on the classic program, or a malformed list: undecoded, not guessed
    expect(decode(raw(SPL, [21, 7, 0])).undecodedInstructions).toEqual([0]);
    expect(decode(raw(T22, [21, 7])).undecodedInstructions).toEqual([0]);
    expect(decode(raw(T22, [22, 0])).undecodedInstructions).toEqual([0]);
  });

  it("does not affect the analysis status of a transaction built from them", () => {
    expect(decode(createInitializeImmutableOwnerInstruction(WALLET_ATA, T22), raw(T22, [21])).undecodedInstructions).toEqual([]);
  });
});

describe("transactions newer than v0 (mainnet now carries v1)", () => {
  beforeEach(() => {
    rpc.mockReset();
  });

  it("an RPC 'unsupported transaction version' is reported as UNSUPPORTED_TRANSACTION, not an RPC outage", async () => {
    rpc.mockImplementation(() => {
      throw new AppError("RPC_ERROR", "The Solana RPC rejected the request.", { method: "getTransaction", rpcCode: -32015 });
    });
    const e = await analyzeTransaction("5".repeat(88)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).code).toBe("UNSUPPORTED_TRANSACTION");
    expect((e as AppError).status).toBe(422);
  });

  it("other RPC errors are unchanged", async () => {
    rpc.mockImplementation(() => {
      throw new AppError("RPC_ERROR", "The Solana RPC rejected the request.", { method: "getTransaction", rpcCode: -32602 });
    });
    await expect(analyzeTransaction("5".repeat(88))).rejects.toMatchObject({ code: "RPC_ERROR" });
  });
});


describe("untrusted text with links (memo / description) for UI and AI", () => {
  it("defangLinks reduces links to defanged hosts and drops paths/queries", () => {
    const out = defangLinks("Claim now: https://claim-orca.info/airdrop?ref=abc or visit bonk.fun today, www.x.com");
    expect(out).toBe("Claim now: claim-orca[.]info/… or visit bonk[.]fun today, www[.]x[.]com");
    expect(out).not.toMatch(/https?:\/\//);
    expect(defangLinks("no links here")).toBe("no links here");
  });

  it("AI context never carries a raw URL from untrusted metadata", () => {
    const ctx = toAiContext({ description: "Visit https://ph4ntom.app/restore?seed=1 to claim", memo: "gm jup-claim.xyz" });
    expect(ctx).not.toMatch(/https?:\/\//);
    expect(ctx).toContain("ph4ntom[.]app/…");
    expect(ctx).toContain("jup-claim[.]xyz");
    expect(ctx).not.toContain("seed=1");
  });
});
