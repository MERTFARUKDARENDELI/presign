import { VersionedTransaction } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/api/errors";
import { verifyCleanupTransaction } from "@/lib/cleanup/intent";
import { prepareCleanup } from "@/lib/cleanup/prepare";
import { DEMO } from "@/lib/demo/scenario";
import { getParsedAccounts } from "@/lib/solana/accounts";
import { rpcCall } from "@/lib/solana/client";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@/lib/solana/constants";
import { simulateTransaction, type SimulationOutput } from "@/lib/transaction/simulate";
import type { TransactionEffects } from "@/lib/transaction/types";
import { messageHashOfTx } from "@/lib/wallet/signing";
import { ATTACKER, BLOCKHASH, MINT, parsedMint, parsedTokenAccount, systemAccount, WALLET, WALLET_ATA } from "../helpers/fixtures";

// Only the network edge (accounts, RPC, simulation RPC) is mocked; building,
// integrity self-check, eligibility, blockers and fee checks run for real.
vi.mock("@/lib/solana/client", async (importOriginal) => ({ ...(await importOriginal<object>()), rpcCall: vi.fn() }));
vi.mock("@/lib/solana/accounts", () => ({ getParsedAccounts: vi.fn() }));
vi.mock("@/lib/transaction/simulate", async (importOriginal) => ({ ...(await importOriginal<object>()), simulateTransaction: vi.fn() }));

const rpc = vi.mocked(rpcCall);
const accounts = vi.mocked(getParsedAccounts);
const simulate = vi.mocked(simulateTransaction);

const W = WALLET.toBase58();
const ATA = WALLET_ATA.toBase58();
const RENT = 2_039_280;
const base64ToBytes = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));

function chain(state: Record<string, unknown>) {
  accounts.mockImplementation(async (addresses: string[]) => ({
    accounts: new Map(addresses.map((a) => [a, state[a] ?? null])),
    slot: 100,
    source: "HELIUS_RPC" as const,
    fallbackUsed: false,
  }));
}

function effects(overrides: Partial<TransactionEffects> = {}): TransactionEffects {
  return {
    source: "SIMULATION", success: true, error: null, logs: [], logsTruncated: false, unitsConsumed: 3_000,
    slot: 101, preStateSlot: 100, stale: false, blockhashValid: true, feeLamports: "5000",
    solChanges: [
      { address: W, preLamports: "1000000000", postLamports: String(1_000_000_000 + RENT - 5000), deltaLamports: String(RENT - 5000) },
      { address: ATA, preLamports: String(RENT), postLamports: "0", deltaLamports: String(-RENT) },
    ],
    tokenChanges: [],
    accountChanges: [{ address: ATA, ownerBefore: TOKEN_PROGRAM_ID, ownerAfter: null, created: false, closed: true }],
    notes: [],
    ...overrides,
  };
}

function simReturns(e: TransactionEffects, innerInstructions: unknown = []) {
  simulate.mockResolvedValue({ effects: e, tokenAccountOwners: {}, tokenAccountMints: {}, innerInstructions } satisfies SimulationOutput);
}

beforeEach(() => {
  rpc.mockReset();
  accounts.mockReset();
  simulate.mockReset();
  rpc.mockImplementation((async (method: string) => {
    if (method === "getLatestBlockhash") return { result: { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1234 } }, source: "HELIUS_RPC", fallbackUsed: false };
    if (method === "getMinimumBalanceForRentExemption") return { result: 890_880, source: "HELIUS_RPC", fallbackUsed: false };
    throw new Error(`unexpected rpc ${method}`);
  }) as unknown as typeof rpcCall);
});

const withBalance = (opts: Parameters<typeof parsedTokenAccount>[0] = {}, walletLamports = 1_000_000_000, mint: unknown = parsedMint({})) =>
  chain({ [ATA]: parsedTokenAccount({ amount: "5000000", ...opts }), [W]: systemAccount(walletLamports), [MINT.toBase58()]: mint });

describe("prepareCleanup — builds exactly the displayed intent, never signs", () => {
  it("BURN_AND_CLOSE: unsigned tx whose bytes, hash and intent all agree; canSign when every check passes", async () => {
    withBalance();
    simReturns(effects());
    const p = await prepareCleanup(W, ATA, "BURN_AND_CLOSE");

    expect(p.canSign).toBe(true);
    expect(p.blockers).toEqual([]);
    expect(p.intent).toMatchObject({ action: "BURN_AND_CLOSE", owner: W, tokenAccount: ATA, mint: MINT.toBase58(), tokenProgram: TOKEN_PROGRAM_ID, amountRaw: "5000000", destination: W });

    const bytes = base64ToBytes(p.transaction);
    const vtx = VersionedTransaction.deserialize(bytes);
    // The server never signs: every signature slot is empty.
    expect(vtx.signatures.every((s) => s.every((b) => b === 0))).toBe(true);
    expect(vtx.message.staticAccountKeys[0].toBase58()).toBe(W); // fee payer = owner
    expect(verifyCleanupTransaction(bytes, p.intent).ok).toBe(true);
    expect(p.messageHash).toBe(await messageHashOfTx(bytes));
    expect(p.lastValidBlockHeight).toBe(1234);
    expect(p.reclaim?.grossLamports).toBe(String(RENT));
    expect(p.feeCheck.sufficient).toBe(true);
  });

  it("simulates the prepared bytes with the owner in the snapshot", async () => {
    withBalance();
    simReturns(effects());
    const p = await prepareCleanup(W, ATA, "BURN_AND_CLOSE");
    const [simTx, , extra] = simulate.mock.calls[0];
    expect(Buffer.from(simTx.serialize()).toString("base64")).toBe(p.transaction);
    expect(extra).toEqual([W]);
  });

  it("CLOSE on a zero-balance account burns nothing (amountRaw 0)", async () => {
    withBalance({ amount: "0" });
    simReturns(effects());
    const p = await prepareCleanup(W, ATA, "CLOSE");
    expect(p.intent.amountRaw).toBe("0");
    expect(p.canSign).toBe(true);
  });

  it("REVOKE: targets the account delegate, no reclaim, needs the delegate-removed effect", async () => {
    const delegate = ATTACKER.toBase58();
    withBalance({ delegate, delegatedAmount: "5000000" });
    simReturns(effects({
      solChanges: [{ address: W, preLamports: "1000000000", postLamports: "999995000", deltaLamports: "-5000" }],
      accountChanges: [{ address: ATA, ownerBefore: TOKEN_PROGRAM_ID, ownerAfter: TOKEN_PROGRAM_ID, created: false, closed: false, delegateBefore: delegate, delegateAfter: null }],
    }));
    const p = await prepareCleanup(W, ATA, "REVOKE");
    expect(p.intent).toMatchObject({ action: "REVOKE", delegate, amountRaw: "0" });
    expect(p.reclaim).toBeNull();
    expect(p.canSign).toBe(true);
  });

  it("uses the Token-2022 program for Token-2022 accounts", async () => {
    withBalance({ program: TOKEN_2022_PROGRAM_ID }, 1_000_000_000, parsedMint({ program: TOKEN_2022_PROGRAM_ID }));
    simReturns(effects());
    const p = await prepareCleanup(W, ATA, "BURN_AND_CLOSE");
    expect(p.intent.tokenProgram).toBe(TOKEN_2022_PROGRAM_ID);
    expect(verifyCleanupTransaction(base64ToBytes(p.transaction), p.intent).ok).toBe(true);
  });
});

describe("prepareCleanup — refuses before building", () => {
  const code = async (p: Promise<unknown>) => {
    const e = await p.catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AppError);
    return (e as AppError).code;
  };

  it("rejects the synthetic demo wallet without touching the network", async () => {
    expect(await code(prepareCleanup(DEMO.wallet.toBase58(), ATA, "CLOSE"))).toBe("CLEANUP_NOT_ELIGIBLE");
    expect(accounts).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("missing account (e.g. a cNFT asset id) → ACCOUNT_NOT_FOUND", async () => {
    chain({ [W]: systemAccount(1_000_000_000) });
    expect(await code(prepareCleanup(W, ATA, "BURN_AND_CLOSE"))).toBe("ACCOUNT_NOT_FOUND");
  });

  it("non-token account → CLEANUP_NOT_ELIGIBLE", async () => {
    chain({ [ATA]: systemAccount(5), [W]: systemAccount(1_000_000_000) });
    expect(await code(prepareCleanup(W, ATA, "CLOSE"))).toBe("CLEANUP_NOT_ELIGIBLE");
  });

  it("account owned by another wallet → OWNERSHIP_MISMATCH", async () => {
    withBalance({ owner: ATTACKER.toBase58() });
    expect(await code(prepareCleanup(W, ATA, "BURN_AND_CLOSE"))).toBe("OWNERSHIP_MISMATCH");
  });

  it.each([
    ["frozen account", { state: "frozen" as const }, "BURN_AND_CLOSE" as const],
    ["CLOSE with a remaining balance", {}, "CLOSE" as const],
    ["REVOKE without a delegate", {}, "REVOKE" as const],
    ["foreign close authority", { closeAuthority: ATTACKER.toBase58() }, "BURN_AND_CLOSE" as const],
    ["Token-2022 withheld fees", { program: TOKEN_2022_PROGRAM_ID, extensions: [{ extension: "transferFeeAmount" }] }, "BURN_AND_CLOSE" as const],
  ])("%s → CLEANUP_NOT_ELIGIBLE, no transaction built", async (_label, opts, action) => {
    withBalance(opts);
    expect(await code(prepareCleanup(W, ATA, action))).toBe("CLEANUP_NOT_ELIGIBLE");
    expect(rpc.mock.calls.some(([m]) => m === "getLatestBlockhash")).toBe(false);
    expect(simulate).not.toHaveBeenCalled();
  });

  it("NFT burn requires manual review (Metaplex flow), never plain SPL burn", async () => {
    withBalance({ amount: "1", decimals: 0 }, 1_000_000_000, parsedMint({ decimals: 0, supply: "1" }));
    expect(await code(prepareCleanup(W, ATA, "BURN_AND_CLOSE"))).toBe("CLEANUP_NOT_ELIGIBLE");
  });

  it("propagates simulation unavailability instead of preparing blind", async () => {
    withBalance();
    simulate.mockRejectedValue(new AppError("SIMULATION_FAILED", "Transaction simulation could not be performed."));
    expect(await code(prepareCleanup(W, ATA, "BURN_AND_CLOSE"))).toBe("SIMULATION_FAILED");
  });
});

describe("prepareCleanup — blockers disable signing", () => {
  const prep = async (e: TransactionEffects, inner: unknown = [], walletLamports = 1_000_000_000, action: "BURN_AND_CLOSE" | "REVOKE" = "BURN_AND_CLOSE", opts = {}) => {
    withBalance(opts, walletLamports);
    simReturns(e, inner);
    return prepareCleanup(W, ATA, action);
  };

  it("failed simulation", async () => {
    const p = await prep(effects({ success: false, error: '{"InstructionError":[0,"InvalidAccountData"]}', solChanges: [], accountChanges: [] }));
    expect(p.canSign).toBe(false);
    expect(p.blockers.join()).toMatch(/Simulation failed/);
  });

  it("stale simulation", async () => {
    const p = await prep(effects({ stale: true }));
    expect(p.canSign).toBe(false);
    expect(p.blockers.join()).toMatch(/stale/);
  });

  it("unexpected CPI in the simulation", async () => {
    const p = await prep(effects(), [{ index: 0, instructions: [{ programIdIndex: 3, accounts: [], data: "" }] }]);
    expect(p.canSign).toBe(false);
    expect(p.blockers.join()).toMatch(/unexpected program invocations/);
  });

  it("token account not shown as closed", async () => {
    const p = await prep(effects({ accountChanges: [] }));
    expect(p.canSign).toBe(false);
    expect(p.blockers.join()).toMatch(/not show the token account being closed/);
  });

  it("SOL flowing to a foreign account", async () => {
    const e = effects();
    e.solChanges.push({ address: ATTACKER.toBase58(), preLamports: "0", postLamports: "1000", deltaLamports: "1000" });
    const p = await prep(e);
    expect(p.canSign).toBe(false);
    expect(p.blockers.join()).toMatch(/unexpected account/);
  });

  it("REVOKE whose simulation keeps the delegate", async () => {
    const delegate = ATTACKER.toBase58();
    const p = await prep(effects({ accountChanges: [{ address: ATA, ownerBefore: TOKEN_PROGRAM_ID, ownerAfter: TOKEN_PROGRAM_ID, created: false, closed: false, delegateBefore: delegate, delegateAfter: delegate }] }), [], 1_000_000_000, "REVOKE", { delegate });
    expect(p.canSign).toBe(false);
    expect(p.blockers.join()).toMatch(/delegate being removed/);
  });

  it("wallet with 0 SOL cannot pay the fee", async () => {
    const p = await prep(effects(), [], 0);
    expect(p.canSign).toBe(false);
    expect(p.feeCheck.reason).toBe("INSUFFICIENT_FOR_FEE");
  });

  it("REVOKE that would drop the wallet below rent-exemption", async () => {
    const delegate = ATTACKER.toBase58();
    const p = await prep(effects({ accountChanges: [{ address: ATA, ownerBefore: TOKEN_PROGRAM_ID, ownerAfter: TOKEN_PROGRAM_ID, created: false, closed: false, delegateBefore: delegate, delegateAfter: null }] }), [], 892_000, "REVOKE", { delegate });
    expect(p.canSign).toBe(false);
    expect(p.feeCheck.reason).toBe("WOULD_BREAK_RENT_EXEMPTION");
  });
});
