import { SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { transactionMessage } from "@/extension/src/lib/bytes";
import { createReviewer } from "@/extension/src/lib/channel";
import { installInterceptor, PresignRejection, type HookWindow, type InterceptorDeps } from "@/extension/src/lib/intercept";
import type { ReviewRequest } from "@/extension/src/lib/protocol";
import { confirmedApproval, payloadHashOf } from "../helpers/approval";
import { ATTACKER, buildTx, WALLET } from "../helpers/fixtures";

/**
 * The last check before the wallet is asked (P0-2): the page hook hashes what it
 * is about to hand the wallet — read from the very arguments the wallet gets —
 * and compares it with the payload hash Presign's server confirmed for that
 * request, which the background relays with the decision. Only the extension's
 * own pass (protection off, or off for this site) goes without one.
 */

const W = WALLET.toBase58();
const txBytes = (lamports: number) => buildTx([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports })]).bytes;
const text = (s: string) => new TextEncoder().encode(s);
const CHANGED = /changed after the security review/;
type Fns = Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>>;

let deps: InterceptorDeps & { review: ReturnType<typeof vi.fn>; report: ReturnType<typeof vi.fn> };
let hook: ReturnType<typeof installInterceptor>;
let calls: unknown[][];

beforeEach(() => {
  deps = { review: vi.fn(), report: vi.fn(), host: () => "dapp.example" } as never;
  hook = installInterceptor(new EventTarget() as HookWindow, deps);
  calls = [];
});

const wallet = () =>
  hook.wrapWallet({
    version: "1.0.0", name: "Test", icon: "", chains: ["solana:mainnet"], accounts: [{ address: W }],
    features: {
      "solana:signTransaction": { version: "1.0.0", signTransaction: async (...i: Array<{ transaction: Uint8Array }>) => (calls.push(["signTransaction", ...i]), i.map((x) => ({ signedTransaction: x.transaction }))) },
      "solana:signMessage": { version: "1.0.0", signMessage: async (...i: Array<{ message: Uint8Array }>) => (calls.push(["signMessage", ...i]), i.map((x) => ({ signedMessage: x.message, signature: new Uint8Array(64) }))) },
    },
  }) as unknown as { features: Fns };

const provider = () => {
  const p = new (class Provider {
    publicKey = { toBase58: () => W };
    async signTransaction(tx: unknown) {
      calls.push(["signTransaction", tx]);
      return tx;
    }
    async signMessage(m: Uint8Array) {
      calls.push(["signMessage", m]);
      return { signature: new Uint8Array(64) };
    }
    async request(args: unknown) {
      calls.push(["request", args]);
      return { ok: true };
    }
  })();
  hook.patchProvider(p, "Test");
  return p;
};

/** An approval Presign's server confirmed — for these other bytes. */
const approvalFor = (other: Pick<ReviewRequest, "type" | "payload">) => async () => ({ approved: true, id: "rid-1", payloadHash: payloadHashOf(other) });
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

describe("the wallet receives only bytes whose hash Presign's server approved", () => {
  it("with the confirmed hash, every kind of request reaches the wallet", async () => {
    deps.review.mockImplementation(async (r: ReviewRequest) => confirmedApproval(r));
    await wallet().features["solana:signTransaction"].signTransaction({ transaction: txBytes(1), account: { address: W } });
    await wallet().features["solana:signMessage"].signMessage({ message: text("hello"), account: { address: W } });
    const p = provider();
    await p.signMessage(text("hello"));
    // A bare transaction message (no signature slots): reviewed and hashed as the transaction it stands for.
    await p.signTransaction(transactionMessage(txBytes(2)));
    await p.request({ method: "signTransaction", params: { message: bs58.encode(transactionMessage(txBytes(3))!) } });
    expect(calls.map((c) => c[0])).toEqual(["signTransaction", "signMessage", "signMessage", "signTransaction", "request"]);
  });

  it("an approval confirmed for other bytes never reaches the wallet, and says why", async () => {
    deps.review.mockImplementation(approvalFor({ type: "TRANSACTION", payload: b64(txBytes(1)) }));
    const err = (await wallet().features["solana:signTransaction"].signTransaction({ transaction: txBytes(999_000_000), account: { address: W } }).catch((e: unknown) => e)) as PresignRejection;
    expect(err).toBeInstanceOf(PresignRejection);
    expect(err.message).toMatch(CHANGED);
    expect(deps.report).toHaveBeenCalledWith("rid-1", expect.objectContaining({ status: "BLOCKED", detail: expect.stringMatching(CHANGED) }));

    deps.review.mockImplementation(approvalFor({ type: "MESSAGE", payload: b64(text("sign in")) }));
    const p = provider();
    await expect(p.signMessage(text("approve all my tokens"))).rejects.toThrow(CHANGED);
    await expect(p.request({ method: "signMessage", params: { message: bs58.encode(text("approve all my tokens")) } })).rejects.toThrow(CHANGED);
    expect(calls).toEqual([]);
  });

  it("an approval without a confirmed hash is not trusted", async () => {
    deps.review.mockResolvedValue({ approved: true, id: "rid-1" });
    await expect(wallet().features["solana:signMessage"].signMessage({ message: text("hello"), account: { address: W } })).rejects.toThrow(/could not confirm which bytes you approved/);
    await expect(provider().signTransaction(txBytes(1))).rejects.toThrow(/could not confirm which bytes you approved/);
    expect(calls).toEqual([]);
  });

  it("in a batch, one request approved for other bytes stops them all", async () => {
    const good = txBytes(1);
    deps.review
      .mockImplementationOnce(async (r: ReviewRequest) => confirmedApproval(r))
      .mockImplementationOnce(approvalFor({ type: "TRANSACTION", payload: b64(txBytes(5)) }));
    await expect(wallet().features["solana:signTransaction"].signTransaction({ transaction: good, account: { address: W } }, { transaction: txBytes(6), account: { address: W } })).rejects.toThrow(CHANGED);
    expect(deps.review).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([]);
  });

  it("the extension's own pass (protection off for this site) needs no hash: nothing was reviewed", async () => {
    deps.review.mockResolvedValue({ approved: true, pass: true });
    await provider().signMessage(text("hello"));
    expect(calls).toHaveLength(1);
  });

  it("over the real channel: the hash comes with the decision, and a malformed one counts as none", async () => {
    const sent: Array<{ id: string; request: ReviewRequest }> = [];
    const reviewer = createReviewer({ ready: () => true, send: (m) => void sent.push(m as never), newId: () => `id-${sent.length + 1}`, timeoutMs: 60_000, setTimer: () => 0, clearTimer: () => undefined });
    const h = installInterceptor(new EventTarget() as HookWindow, { review: reviewer.review, host: () => "dapp.example" });
    const signed: Uint8Array[] = [];
    const p = { publicKey: { toBase58: () => W }, async signMessage(m: Uint8Array) { signed.push(m); return { signature: new Uint8Array(64) }; } };
    h.patchProvider(p, "Channel");

    const ok = p.signMessage(text("hello"));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    reviewer.settle({ kind: "decision", id: sent[0].id, approved: true, rid: "r1", payloadHash: payloadHashOf(sent[0].request) });
    await ok;
    expect(signed).toHaveLength(1);

    const bad = p.signMessage(text("hello again"));
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    reviewer.settle({ kind: "decision", id: sent[1].id, approved: true, rid: "r2", payloadHash: payloadHashOf(sent[1].request)!.toUpperCase() });
    await expect(bad).rejects.toThrow(/could not confirm which bytes you approved/);
    expect(signed).toHaveLength(1);
  });
});
