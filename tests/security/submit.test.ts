import { createBurnCheckedInstruction, createCloseAccountInstruction } from "@solana/spl-token";
import { SystemProgram, Transaction, VersionedTransaction } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/api/errors";
import { buildCleanupInstructions, messageHashOf, type CleanupIntent } from "@/lib/cleanup/intent";
import { submitSignedCleanup } from "@/lib/cleanup/submit";
import { getParsedAccounts } from "@/lib/solana/accounts";
import { rpcCall, RpcRequestError } from "@/lib/solana/client";
import { TOKEN_PROGRAM_ID } from "@/lib/solana/constants";
import { sendSignedAndConfirm } from "@/lib/solana/send";
import { bytesToBase64 } from "@/lib/transaction/input";
import { submitAnalyzedTransaction } from "@/lib/transaction/submit";
import { messageHashOfTx } from "@/lib/wallet/signing";
import { ATTACKER, BLOCKHASH, buildTx, keypair, MINT, parsedTokenAccount, WALLET, WALLET_ATA } from "../helpers/fixtures";

// Only the network edge is mocked; every verification step runs for real.
vi.mock("@/lib/solana/client", async (importOriginal) => ({ ...(await importOriginal<object>()), rpcCall: vi.fn() }));
vi.mock("@/lib/solana/accounts", () => ({ getParsedAccounts: vi.fn() }));

const rpc = vi.mocked(rpcCall);
const accounts = vi.mocked(getParsedAccounts);

const OWNER = keypair(1); // === WALLET
const OTHER = keypair(2); // === ATTACKER
const W = WALLET.toBase58();
const SIG = "5".repeat(64);

type Status = { err: unknown; confirmationStatus?: string } | null;

/** RPC double: sendTransaction returns SIG; each getSignatureStatuses call consumes the next scripted status. */
function scriptRpc(statuses: Array<Status | Error>, sendError?: Error) {
  let poll = 0;
  rpc.mockImplementation((async (method: string) => {
    if (method === "sendTransaction") {
      if (sendError) throw sendError;
      return { result: SIG, source: "helius", fallbackUsed: false };
    }
    if (method === "getSignatureStatuses") {
      const s = statuses[Math.min(poll++, statuses.length - 1)];
      if (s instanceof Error) throw s;
      return { result: { value: [s] }, source: "helius", fallbackUsed: false };
    }
    throw new Error(`unexpected rpc ${method}`);
  }) as unknown as typeof rpcCall);
}

const sendCalls = () => rpc.mock.calls.filter(([m]) => m === "sendTransaction");

/**
 * Runs a send/submit promise to completion while fake timers drive the
 * confirmation polling. Hashing (crypto.subtle) settles on the real event loop,
 * so timers are advanced step by step with real setImmediate yields in between.
 */
async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false;
  const guarded = p.then(
    (v) => ({ v }),
    (e: unknown) => ({ e }),
  ).finally(() => {
    done = true;
  });
  while (!done) {
    await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(1_500);
  }
  const r = await guarded;
  if ("e" in r) throw r.e;
  return r.v;
}

function signedBase64(tx: Transaction, ...signers: typeof OWNER[]): string {
  if (signers.length) tx.partialSign(...signers);
  return bytesToBase64(new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false })));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  rpc.mockReset();
  accounts.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("sendSignedAndConfirm", () => {
  it("relays the exact signed bytes with preflight simulation enabled and reports confirmation", async () => {
    scriptRpc([null, { err: null, confirmationStatus: "processed" }, { err: null, confirmationStatus: "confirmed" }]);
    const b64 = signedBase64(buildTx([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 1 })]).tx, OWNER);
    const r = await settle(sendSignedAndConfirm(b64));
    expect(r).toEqual({ signature: SIG, status: "confirmed", error: null });
    const [[, params]] = sendCalls();
    expect(params).toEqual([b64, expect.objectContaining({ encoding: "base64", skipPreflight: false })]);
  });

  it("reports an on-chain failure after submit as failed (confirmation failure)", async () => {
    scriptRpc([{ err: { InstructionError: [0, { Custom: 1 }] }, confirmationStatus: "confirmed" }]);
    const r = await settle(sendSignedAndConfirm("AA=="));
    expect(r.status).toBe("failed");
    expect(r.error).toContain("InstructionError");
  });

  it("reports unconfirmed (never 'confirmed') when the network never confirms", async () => {
    scriptRpc([null]);
    const r = await settle(sendSignedAndConfirm("AA=="));
    expect(r).toEqual({ signature: SIG, status: "unconfirmed", error: null });
  });

  it("keeps polling through transient status errors", async () => {
    scriptRpc([new Error("socket hang up"), { err: null, confirmationStatus: "finalized" }]);
    expect((await settle(sendSignedAndConfirm("AA=="))).status).toBe("confirmed");
  });

  it("propagates a preflight rejection (e.g. expired blockhash) without polling", async () => {
    scriptRpc([], new RpcRequestError("Transaction simulation failed: Blockhash not found", false, -32002));
    await expect(settle(sendSignedAndConfirm("AA=="))).rejects.toThrow(/Blockhash not found/);
    expect(rpc.mock.calls.some(([m]) => m === "getSignatureStatuses")).toBe(false);
  });
});

describe("submitSignedCleanup — prepared = signed = sent", () => {
  const intent: CleanupIntent = {
    action: "BURN_AND_CLOSE", owner: W, tokenAccount: WALLET_ATA.toBase58(), mint: MINT.toBase58(),
    tokenProgram: TOKEN_PROGRAM_ID, amountRaw: "1000", decimals: 6, destination: W, cluster: "devnet",
  };
  const prepare = () => buildTx(buildCleanupInstructions(intent));
  const confirmedHash = () => messageHashOf(prepare().bytes);

  async function expectBlocked(p: Promise<unknown>) {
    const err = await settle(p).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("SECURITY_BLOCK");
    expect(sendCalls()).toHaveLength(0);
  }

  it("relays exactly the prepared-and-signed bytes and verifies the closed account on-chain", async () => {
    scriptRpc([{ err: null, confirmationStatus: "confirmed" }]);
    accounts.mockResolvedValue({ accounts: new Map() } as never);
    const b64 = signedBase64(prepare().tx, OWNER);
    const r = await settle(submitSignedCleanup(b64, await confirmedHash(), intent));
    expect(r.status).toBe("confirmed");
    expect(r.postVerification).toMatchObject({ checked: true, accountClosed: true });
    expect(sendCalls()).toHaveLength(1);
    expect(sendCalls()[0][1]).toEqual([b64, expect.anything()]);
  });

  it("blocks a signed transaction that differs from the prepared one (message hash mismatch)", async () => {
    const other = buildTx([createBurnCheckedInstruction(WALLET_ATA, MINT, WALLET, 999_999n, 6), createCloseAccountInstruction(WALLET_ATA, WALLET, WALLET)]);
    await expectBlocked(submitSignedCleanup(signedBase64(other.tx, OWNER), await confirmedHash(), intent));
  });

  it("blocks a tampered transaction even when the attacker supplies its matching hash (intent mismatch)", async () => {
    const tampered = buildTx([...buildCleanupInstructions(intent), SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 1_000_000 })]);
    await expectBlocked(submitSignedCleanup(signedBase64(tampered.tx, OWNER), await messageHashOf(tampered.bytes), intent));
  });

  it("blocks a transaction signed by the wrong key (fee payer is not the owner)", async () => {
    const foreign = buildTx(buildCleanupInstructions({ ...intent, owner: ATTACKER.toBase58(), destination: ATTACKER.toBase58() }), ATTACKER);
    await expectBlocked(submitSignedCleanup(signedBase64(foreign.tx, OTHER), await messageHashOf(foreign.bytes), intent));
  });

  it("blocks an unsigned transaction", async () => {
    await expectBlocked(submitSignedCleanup(signedBase64(prepare().tx), await confirmedHash(), intent));
  });

  it("blocks an invalid signature in the owner's slot", async () => {
    const tx = VersionedTransaction.deserialize(prepare().bytes);
    tx.sign([OWNER]);
    tx.signatures[0][0] ^= 0xff;
    await expectBlocked(submitSignedCleanup(bytesToBase64(tx.serialize()), await confirmedHash(), intent));
  });

  it("reports a failed confirmation and skips post-state verification", async () => {
    scriptRpc([{ err: { InstructionError: [0, "InvalidAccountData"] } }]);
    const r = await settle(submitSignedCleanup(signedBase64(prepare().tx, OWNER), await confirmedHash(), intent));
    expect(r.status).toBe("failed");
    expect(r.postVerification.checked).toBe(false);
    expect(accounts).not.toHaveBeenCalled();
  });

  it("does not claim success when the transaction stays unconfirmed", async () => {
    scriptRpc([null]);
    const r = await settle(submitSignedCleanup(signedBase64(prepare().tx, OWNER), await confirmedHash(), intent));
    expect(r.status).toBe("unconfirmed");
    expect(r.postVerification).toMatchObject({ checked: false, accountClosed: null });
  });

  it("post-verifies REVOKE against on-chain delegate state", async () => {
    const revoke: CleanupIntent = { ...intent, action: "REVOKE", amountRaw: "0", delegate: ATTACKER.toBase58() };
    const prepared = buildTx(buildCleanupInstructions(revoke));
    scriptRpc([{ err: null, confirmationStatus: "confirmed" }]);
    accounts.mockResolvedValue({ accounts: new Map([[WALLET_ATA.toBase58(), parsedTokenAccount({ amount: "5" })]]) } as never);
    const r = await settle(submitSignedCleanup(signedBase64(prepared.tx, OWNER), await messageHashOf(prepared.bytes), revoke));
    expect(r.postVerification).toMatchObject({ checked: true, delegateRemoved: true });
  });
});

describe("submitAnalyzedTransaction — analyzed = signed = sent", () => {
  const prepared = () => buildTx([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 1 })]);

  async function expectCode(p: Promise<unknown>, code: string) {
    const err = await settle(p).catch((e: unknown) => e);
    expect((err as AppError).code).toBe(code);
    expect(sendCalls()).toHaveLength(0);
  }

  it("relays the exact bytes that were analyzed and signed", async () => {
    scriptRpc([{ err: null, confirmationStatus: "confirmed" }]);
    const p = prepared();
    const b64 = signedBase64(p.tx, OWNER);
    expect((await settle(submitAnalyzedTransaction(b64, await messageHashOfTx(p.bytes)))).status).toBe("confirmed");
    expect(sendCalls()[0][1]).toEqual([b64, expect.anything()]);
  });

  it("blocks bytes that differ from the analyzed transaction", async () => {
    const changed = buildTx([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 2 })]);
    await expectCode(submitAnalyzedTransaction(signedBase64(changed.tx, OWNER), await messageHashOfTx(prepared().bytes)), "SECURITY_BLOCK");
  });

  it("blocks missing and invalid signatures", async () => {
    const p = prepared();
    const hash = await messageHashOfTx(p.bytes);
    await expectCode(submitAnalyzedTransaction(signedBase64(p.tx), hash), "SECURITY_BLOCK");
    const tx = VersionedTransaction.deserialize(p.bytes);
    tx.sign([OWNER]);
    tx.signatures[0][5] ^= 0x01;
    await expectCode(submitAnalyzedTransaction(bytesToBase64(tx.serialize()), hash), "SECURITY_BLOCK");
  });

  it("blocks when a co-signer's signature is missing", async () => {
    const t = new Transaction({ feePayer: WALLET, recentBlockhash: BLOCKHASH }).add(
      SystemProgram.transfer({ fromPubkey: ATTACKER, toPubkey: WALLET, lamports: 1 }),
    );
    const bytes = new Uint8Array(t.serialize({ requireAllSignatures: false, verifySignatures: false }));
    await expectCode(submitAnalyzedTransaction(signedBase64(t, OWNER), await messageHashOfTx(bytes)), "SECURITY_BLOCK");
  });

  it("rejects unparseable input", async () => {
    await expectCode(submitAnalyzedTransaction("AAEC", "x"), "INVALID_TRANSACTION");
  });
});
