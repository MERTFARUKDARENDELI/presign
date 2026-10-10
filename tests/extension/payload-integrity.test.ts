import { SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64, transactionMessage } from "@/extension/src/lib/bytes";
import { createReviewer, pageTransport } from "@/extension/src/lib/channel";
import { installInterceptor, PresignRejection, type HookWindow, type InterceptorDeps } from "@/extension/src/lib/intercept";
import type { ReviewRequest } from "@/extension/src/lib/protocol";
import { createSignInMessageText } from "@/extension/src/lib/siws";
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

describe("an approval confirmed for other bytes is refused on every other entry point too", () => {
  // The cases above cover signTransaction / signMessage; these are the remaining entry points of both kinds of wallet.
  const OTHER = { TRANSACTION: { type: "TRANSACTION" as const, payload: b64(txBytes(42)) }, MESSAGE: { type: "MESSAGE" as const, payload: b64(text("something else")) } };
  const otherApproval = async (r: ReviewRequest) => ({ approved: true, id: "rid-1", payloadHash: payloadHashOf(r.type === "TRANSACTION" ? OTHER.TRANSACTION : OTHER.MESSAGE) });
  const record = <T,>(name: string, out: T): T => (calls.push([name]), out);

  const fullWallet = () =>
    hook.wrapWallet({
      version: "1.0.0", name: "Test", icon: "", chains: ["solana:mainnet"], accounts: [{ address: W }],
      features: {
        "solana:signAndSendTransaction": { version: "1.0.0", signAndSendTransaction: async (...i: unknown[]) => record("signAndSendTransaction", i.map(() => ({ signature: new Uint8Array(64) }))) },
        "solana:signAndSendAllTransactions": { version: "1.0.0", signAndSendAllTransactions: async (i: unknown[]) => record("signAndSendAllTransactions", i.map(() => ({ status: "fulfilled" }))) },
        "solana:signOffchainMessage": { version: "1.0.0", signOffchainMessage: async (...i: Array<{ message: string }>) => record("signOffchainMessage", i.map((x) => ({ signedOffchainMessage: text(x.message), signature: new Uint8Array(64) }))) },
        "solana:signIn": { version: "1.0.0", signIn: async (...i: unknown[]) => record("signIn", i.map(() => ({ account: { address: W }, signedMessage: text("x"), signature: new Uint8Array(64) }))) },
      },
    }) as unknown as { features: Fns };

  const fullProvider = () => {
    const p = new (class Provider {
      publicKey = { toBase58: () => W };
      async signMessage() {
        return record("signMessage", {});
      }
      async signAllTransactions(t: unknown) {
        return record("signAllTransactions", t);
      }
      async signAndSendTransaction() {
        return record("signAndSendTransaction", {});
      }
      async signIn() {
        return record("signIn", {});
      }
      async request(a: { method: string }) {
        return record(`request:${a.method}`, {});
      }
    })();
    hook.patchProvider(p, "Test");
    return p as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  };

  const ENTRY_POINTS: Array<[string, () => Promise<unknown>]> = [
    ["Wallet Standard signAndSendTransaction", () => fullWallet().features["solana:signAndSendTransaction"].signAndSendTransaction({ transaction: txBytes(1), account: { address: W } })],
    ["Wallet Standard signAndSendAllTransactions", () => fullWallet().features["solana:signAndSendAllTransactions"].signAndSendAllTransactions([{ transaction: txBytes(1), account: { address: W } }])],
    ["Wallet Standard signOffchainMessage", () => fullWallet().features["solana:signOffchainMessage"].signOffchainMessage({ message: "hello", account: { address: W } })],
    ["Wallet Standard signIn (account known in advance)", () => fullWallet().features["solana:signIn"].signIn({ statement: "hi", nonce: "abc12345" })],
    ["injected signAllTransactions", () => fullProvider().signAllTransactions([txBytes(1), txBytes(2)])],
    ["injected signAndSendTransaction", () => fullProvider().signAndSendTransaction(txBytes(1))],
    ["injected signIn", () => fullProvider().signIn({ statement: "hi", nonce: "abc12345" })],
    ["request signAllTransactions", () => fullProvider().request({ method: "signAllTransactions", params: { messages: [transactionMessage(txBytes(1)), transactionMessage(txBytes(2))] } })],
    ["request signAndSendTransaction", () => fullProvider().request({ method: "signAndSendTransaction", params: { message: transactionMessage(txBytes(1)) } })],
  ];

  it.each(ENTRY_POINTS)("%s: reviewed, refused before the wallet, and the site is told why", async (_name, start) => {
    deps.review.mockImplementation(otherApproval);
    await expect(start()).rejects.toThrow(CHANGED);
    expect(deps.review).toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("a sign-in whose account the wallet chooses (signed first, by design): an approval for other text withholds the signature", async () => {
    deps.review.mockImplementation(otherApproval);
    const w = hook.wrapWallet({
      version: "1.0.0", name: "Test", icon: "", chains: ["solana:mainnet"], accounts: [],
      features: {
        "solana:signIn": {
          version: "1.0.0",
          signIn: async (...i: Array<Record<string, string>>) =>
            record("signIn", i.map((x) => ({ account: { address: W }, signedMessage: text(createSignInMessageText({ ...x, domain: x.domain ?? "dapp.example", address: W })), signature: new Uint8Array(64) }))),
        },
      },
    }) as unknown as { features: Fns };
    await expect(w.features["solana:signIn"].signIn({ statement: "hi", nonce: "abc12345" })).rejects.toThrow(CHANGED);
    expect(calls).toEqual([["signIn"]]);
  });
});

describe("re-entrancy and replayed decisions, over the real page channel", () => {
  const tick = () => new Promise<void>((r) => setImmediate(r));
  function channel() {
    const doc = new EventTarget();
    const secret = "cd".repeat(16);
    const sent: Array<{ id: string; request: ReviewRequest }> = [];
    const transport = pageTransport({ doc, secret, dispatch: EventTarget.prototype.dispatchEvent, listen: EventTarget.prototype.addEventListener, CustomEvent, detailOf: Object.getOwnPropertyDescriptor(CustomEvent.prototype, "detail")!.get! });
    let n = 0;
    const reviewer = createReviewer({ ready: () => true, send: transport.send, newId: () => `id-${++n}`, timeoutMs: 60_000, setTimer: () => 0, clearTimer: () => undefined });
    transport.onMessage(reviewer.settle);
    doc.addEventListener(`presign:${secret}:to-content`, (e) => {
      const m = JSON.parse((e as CustomEvent).detail);
      if (m.kind === "review") sent.push(m);
    });
    /** The decision the content script relays, as the DOM event it really is. */
    const decide = (i: number) =>
      doc.dispatchEvent(new CustomEvent(`presign:${secret}:to-page`, { detail: JSON.stringify({ kind: "decision", id: sent[i].id, approved: true, rid: "r", payloadHash: payloadHashOf(sent[i].request) }) }));
    const h = installInterceptor(new EventTarget() as HookWindow, { review: reviewer.review, host: () => "dapp.example" });
    return { sent, decide, hook: h };
  }

  it("while an approved call is in the wallet, a call with other bytes opens a new review and does not reach the wallet", async () => {
    const { sent, decide, hook: h } = channel();
    let release!: () => void;
    const inWallet = new Promise<void>((r) => (release = r));
    const got: string[] = [];
    const p = {
      publicKey: { toBase58: () => W },
      async signTransaction(t: Uint8Array) {
        got.push(bytesToBase64(t));
        await inWallet;
        return t;
      },
    };
    h.patchProvider(p, "Test");
    const first = p.signTransaction(txBytes(1));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    decide(0);
    await vi.waitFor(() => expect(got).toHaveLength(1)); // the approved call is now in the wallet
    void p.signTransaction(txBytes(999_000_000)).catch(() => undefined);
    await tick();
    await tick();
    expect(sent).toHaveLength(2); // reviewed, not passed through as the wallet's own re-entry
    expect(got).toHaveLength(1);
    release();
    await first;
    expect(got).toEqual([bytesToBase64(txBytes(1))]);
  });

  it("a decision replayed after it was used changes nothing: the wallet is asked once", async () => {
    const { sent, decide, hook: h } = channel();
    const got: Uint8Array[] = [];
    const p = {
      publicKey: { toBase58: () => W },
      async signTransaction(t: Uint8Array) {
        got.push(t);
        return t;
      },
    };
    h.patchProvider(p, "Test");
    const one = p.signTransaction(txBytes(1));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    decide(0);
    await one;
    decide(0);
    decide(0);
    await tick();
    expect(got).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });
});
