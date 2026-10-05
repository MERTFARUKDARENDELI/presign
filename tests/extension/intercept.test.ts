import { SystemProgram, type Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64 } from "@/extension/src/lib/bytes";
import { installInterceptor, PresignRejection, type HookWindow, type InterceptorDeps } from "@/extension/src/lib/intercept";
import type { ReviewRequest } from "@/extension/src/lib/protocol";
import { createSignInMessageText } from "@/extension/src/lib/siws";
import { ATTACKER, buildTx, WALLET } from "../helpers/fixtures";

const W = WALLET.toBase58();

// ---- Faithful copies of the Wallet Standard event classes (they forbid stopping propagation).
class RegisterWalletEvent extends Event {
  readonly #detail: (api: { register: (...w: unknown[]) => unknown }) => void;
  get detail() {
    return this.#detail;
  }
  constructor(callback: (api: { register: (...w: unknown[]) => unknown }) => void) {
    super("wallet-standard:register-wallet", { bubbles: false, cancelable: false, composed: false });
    this.#detail = callback;
  }
  stopImmediatePropagation(): never {
    throw new Error("stopImmediatePropagation cannot be called");
  }
  stopPropagation(): never {
    throw new Error("stopPropagation cannot be called");
  }
}
class AppReadyEvent extends Event {
  readonly #detail: { register: (...w: unknown[]) => unknown };
  get detail() {
    return this.#detail;
  }
  constructor(api: { register: (...w: unknown[]) => unknown }) {
    super("wallet-standard:app-ready", { bubbles: false, cancelable: false, composed: false });
    this.#detail = api;
  }
  stopImmediatePropagation(): never {
    throw new Error("stopImmediatePropagation cannot be called");
  }
}
/** @wallet-standard/app getWallets(): listens for wallets, announces itself. */
function app(win: EventTarget) {
  const wallets: unknown[] = [];
  const api = Object.freeze({ register: (...ws: unknown[]) => (wallets.push(...ws), () => undefined) });
  win.addEventListener("wallet-standard:register-wallet", (e) => (e as unknown as { detail: (a: typeof api) => void }).detail(api));
  win.dispatchEvent(new AppReadyEvent(api));
  return wallets;
}
/** @wallet-standard/wallet registerWallet(). */
function registerWallet(win: EventTarget, wallet: unknown) {
  const callback = ({ register }: { register: (...w: unknown[]) => unknown }) => register(wallet);
  win.dispatchEvent(new RegisterWalletEvent(callback));
  win.addEventListener("wallet-standard:app-ready", (e) => callback((e as unknown as { detail: { register: (...w: unknown[]) => unknown } }).detail));
}

type TxIn = { transaction: Uint8Array; account: { address: string }; chain?: string };

/** A wallet written like real ones: class with private fields, features as a getter. */
class FakeWallet {
  readonly version = "1.0.0";
  readonly name = "Fake Wallet";
  readonly icon = "data:image/svg+xml;base64,";
  #accounts: Array<{ address: string }>;
  #mode: "honest" | "tamper";
  calls: unknown[][] = [];
  constructor(accounts = [{ address: W }], mode: "honest" | "tamper" = "honest") {
    this.#accounts = accounts;
    this.#mode = mode;
  }
  get chains() {
    return ["solana:mainnet", "solana:devnet"];
  }
  get accounts() {
    return this.#accounts;
  }
  get features() {
    return {
      "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: this.#accounts }) },
      "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0], signTransaction: this.#signTransaction },
      "solana:signAndSendTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0], signAndSendTransaction: this.#signAndSend },
      "solana:signMessage": { version: "1.0.0", signMessage: this.#signMessage },
      "solana:signIn": { version: "1.0.0", signIn: this.#signIn },
    };
  }
  #signTransaction = async (...inputs: TxIn[]) => {
    this.calls.push(["signTransaction", ...inputs]);
    return inputs.map((i) => {
      const signed = Uint8Array.from(i.transaction);
      signed.fill(7, 1, 65); // the signature slot
      if (this.#mode === "tamper") signed[signed.length - 1] ^= 1; // changes an instruction byte
      return { signedTransaction: signed };
    });
  };
  #signAndSend = async (...inputs: TxIn[]) => {
    this.calls.push(["signAndSendTransaction", ...inputs]);
    return inputs.map(() => ({ signature: new Uint8Array(64).fill(9) }));
  };
  #signMessage = async (...inputs: Array<{ message: Uint8Array }>) => {
    this.calls.push(["signMessage", ...inputs]);
    return inputs.map((i) => ({ signedMessage: this.#mode === "tamper" ? new TextEncoder().encode("something else") : i.message, signature: new Uint8Array(64) }));
  };
  #signIn = async (...inputs: Array<Record<string, string>>) => {
    this.calls.push(["signIn", ...inputs]);
    return inputs.map((i) => {
      const text = createSignInMessageText({ ...i, domain: i.domain ?? "dapp.example", address: i.address ?? this.#accounts[0].address });
      return { account: this.#accounts[0], signedMessage: new TextEncoder().encode(this.#mode === "tamper" ? `${text}\nextra` : text), signature: new Uint8Array(64) };
    });
  };
}

const txBytes = (lamports = 1) => buildTx([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports })]).bytes;

let win: HookWindow;
let deps: InterceptorDeps & { review: ReturnType<typeof vi.fn>; report: ReturnType<typeof vi.fn> };
let hook: ReturnType<typeof installInterceptor>;
const approveAll = () => deps.review.mockImplementation(async () => ({ approved: true, id: "rid-1" }));
const cancelAll = () => deps.review.mockImplementation(async () => ({ approved: false, reason: "you cancelled the request after the security review." }));
const reviewed = () => deps.review.mock.calls.map((c) => c[0] as ReviewRequest);

beforeEach(() => {
  win = new EventTarget() as HookWindow;
  deps = { review: vi.fn(), report: vi.fn(), host: () => "dapp.example" } as never;
  hook = installInterceptor(win, deps);
});

function connectedWallet(wallet: object = new FakeWallet()) {
  const wallets = app(win);
  registerWallet(win, wallet);
  return wallets[0] as FakeWallet;
}

describe("Wallet Standard interception", () => {
  it("a wallet registering after the app reaches the site only wrapped", () => {
    const raw = new FakeWallet();
    const wallets = app(win);
    registerWallet(win, raw);
    expect(wallets).toHaveLength(1);
    expect(wallets[0]).not.toBe(raw);
    expect((wallets[0] as FakeWallet).name).toBe("Fake Wallet");
    expect((wallets[0] as FakeWallet).accounts).toEqual([{ address: W }]);
  });

  it("a wallet registered before the app is wrapped too (app-ready path)", () => {
    const raw = new FakeWallet();
    registerWallet(win, raw);
    const wallets = app(win);
    expect(wallets).toHaveLength(1);
    expect(wallets[0]).not.toBe(raw);
  });

  it("wallets for other chains are left alone", () => {
    const evm = { version: "1.0.0", name: "EVM", icon: "", chains: ["eip155:1"], accounts: [], features: { "standard:connect": {} } };
    const wallets = app(win);
    registerWallet(win, evm);
    expect(wallets[0]).toBe(evm);
  });

  it("a frozen wallet object is wrapped through a delegating object", async () => {
    const calls: unknown[] = [];
    const frozen = Object.freeze({
      version: "1.0.0", name: "Frozen", icon: "", chains: ["solana:mainnet"], accounts: [{ address: W }],
      features: Object.freeze({ "solana:signMessage": { version: "1.0.0", signMessage: async (...i: Array<{ message: Uint8Array }>) => (calls.push(i), i.map((x) => ({ signedMessage: x.message, signature: new Uint8Array(64) }))) } }),
    });
    const w = connectedWallet(frozen) as unknown as typeof frozen;
    approveAll();
    await w.features["solana:signMessage"].signMessage({ message: new TextEncoder().encode("hi"), account: { address: W } } as never);
    expect(deps.review).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });
});

describe("signTransaction: review first, the wallet only after the user's decision", () => {
  it("analysis happens BEFORE the wallet is asked, for exactly the site's bytes", async () => {
    const w = connectedWallet();
    const order: string[] = [];
    deps.review.mockImplementation(async (r: ReviewRequest) => (order.push(`review:${r.type}`), { approved: true, id: "rid-1" }));
    const input = { transaction: txBytes(), account: { address: W }, chain: "solana:devnet" };
    const raw = w as unknown as { features: Record<string, { signTransaction: (...i: TxIn[]) => Promise<Array<{ signedTransaction: Uint8Array }>> }> };
    const out = await raw.features["solana:signTransaction"].signTransaction(input);
    const inner = (deps.review.mock.calls[0][0] as ReviewRequest);
    expect(inner).toMatchObject({ type: "TRANSACTION", payload: bytesToBase64(input.transaction), walletAddress: W, chain: "solana:devnet", method: "signTransaction", walletName: "Fake Wallet", index: 1, total: 1 });
    expect(order).toEqual(["review:TRANSACTION"]);
    expect(out[0].signedTransaction.subarray(1, 65).every((b) => b === 7)).toBe(true);
    expect(deps.report).toHaveBeenCalledWith("rid-1", expect.objectContaining({ status: "SIGNED" }));
  });

  it("Cancel: the wallet is never asked and the site gets a user-rejected error", async () => {
    const raw = new FakeWallet();
    const w = connectedWallet(raw) as unknown as { features: Record<string, { signTransaction: (...i: TxIn[]) => Promise<unknown> }> };
    cancelAll();
    const err = await w.features["solana:signTransaction"].signTransaction({ transaction: txBytes(), account: { address: W } }).catch((e: unknown) => e) as PresignRejection;
    expect(err).toBeInstanceOf(PresignRejection);
    expect(err.code).toBe(4001);
    expect(raw.calls).toEqual([]);
  });

  it("Sign anyway: the wallet receives the very same input object the site passed", async () => {
    const raw = new FakeWallet();
    const w = connectedWallet(raw) as unknown as { features: Record<string, { signTransaction: (...i: TxIn[]) => Promise<unknown> }> };
    approveAll();
    const input = { transaction: txBytes(), account: { address: W } };
    await w.features["solana:signTransaction"].signTransaction(input);
    expect(raw.calls[0][1]).toBe(input);
  });

  it("a wallet that changes the transaction does not get its signature to the site", async () => {
    const raw = new FakeWallet([{ address: W }], "tamper");
    const w = connectedWallet(raw) as unknown as { features: Record<string, { signTransaction: (...i: TxIn[]) => Promise<unknown> }> };
    approveAll();
    const err = await w.features["solana:signTransaction"].signTransaction({ transaction: txBytes(), account: { address: W } }).catch((e: unknown) => e) as PresignRejection;
    expect(err).toBeInstanceOf(PresignRejection);
    expect(String(err.message)).toMatch(/differs from the one Presign reviewed/);
    expect(deps.report).toHaveBeenCalledWith("rid-1", expect.objectContaining({ status: "BLOCKED" }));
  });

  it("several transactions are reviewed one by one; cancelling one stops all before the wallet", async () => {
    const raw = new FakeWallet();
    const w = connectedWallet(raw) as unknown as { features: Record<string, { signTransaction: (...i: TxIn[]) => Promise<unknown> }> };
    deps.review.mockResolvedValueOnce({ approved: true, id: "a" }).mockResolvedValueOnce({ approved: false, reason: "no" });
    await expect(w.features["solana:signTransaction"].signTransaction({ transaction: txBytes(1), account: { address: W } }, { transaction: txBytes(2), account: { address: W } })).rejects.toBeInstanceOf(PresignRejection);
    expect(reviewed().map((r) => `${r.index}/${r.total}`)).toEqual(["1/2", "2/2"]);
    expect(raw.calls).toEqual([]);
  });

  it("bytes Presign cannot read are sent as UNREADABLE (no sign path is offered for them)", async () => {
    const w = connectedWallet() as unknown as { features: Record<string, { signTransaction: (...i: unknown[]) => Promise<unknown> }> };
    cancelAll();
    await expect(w.features["solana:signTransaction"].signTransaction({ transaction: "not bytes", account: { address: W } })).rejects.toBeInstanceOf(PresignRejection);
    expect(reviewed()[0]).toMatchObject({ type: "UNREADABLE", payload: null });
  });

  it("signAndSendTransaction is reviewed before the wallet broadcasts it", async () => {
    const raw = new FakeWallet();
    const w = connectedWallet(raw) as unknown as { features: Record<string, { signAndSendTransaction: (...i: TxIn[]) => Promise<unknown> }> };
    cancelAll();
    await expect(w.features["solana:signAndSendTransaction"].signAndSendTransaction({ transaction: txBytes(), account: { address: W } })).rejects.toBeInstanceOf(PresignRejection);
    expect(reviewed()[0].method).toBe("signAndSendTransaction");
    expect(raw.calls).toEqual([]);
  });
});

describe("messages and Sign-In With Solana", () => {
  it("signMessage is reviewed as the exact bytes; a wallet signing other bytes is blocked", async () => {
    approveAll();
    const honest = connectedWallet() as unknown as { features: Record<string, { signMessage: (...i: unknown[]) => Promise<unknown> }> };
    const message = new TextEncoder().encode("Sign in to dapp.example\nNonce: 123");
    await honest.features["solana:signMessage"].signMessage({ message, account: { address: W } });
    expect(reviewed()[0]).toMatchObject({ type: "MESSAGE", payload: bytesToBase64(message), method: "signMessage" });

    win = new EventTarget() as HookWindow;
    hook = installInterceptor(win, deps);
    const tamper = connectedWallet(new FakeWallet([{ address: W }], "tamper")) as unknown as { features: Record<string, { signMessage: (...i: unknown[]) => Promise<unknown> }> };
    await expect(tamper.features["solana:signMessage"].signMessage({ message, account: { address: W } })).rejects.toBeInstanceOf(PresignRejection);
  });

  it("sign-in text is rebuilt with the standard's format and must be what the wallet signs", async () => {
    approveAll();
    const w = connectedWallet() as unknown as { features: Record<string, { signIn: (...i: unknown[]) => Promise<unknown> }> };
    const input = { statement: "Welcome", nonce: "abc12345", issuedAt: "2026-10-04T00:00:00Z" };
    await w.features["solana:signIn"].signIn(input);
    const r = reviewed()[0];
    expect(r).toMatchObject({ type: "MESSAGE", method: "signIn", reconstructed: true, walletAddress: W });
    expect(new TextDecoder().decode(Uint8Array.from(atob(r.payload!), (c) => c.charCodeAt(0)))).toBe(`dapp.example wants you to sign in with your Solana account:\n${W}\n\nWelcome\n\nNonce: abc12345\nIssued At: 2026-10-04T00:00:00Z`);

    win = new EventTarget() as HookWindow;
    hook = installInterceptor(win, deps);
    const tamper = connectedWallet(new FakeWallet([{ address: W }], "tamper")) as unknown as { features: Record<string, { signIn: (...i: unknown[]) => Promise<unknown> }> };
    await expect(tamper.features["solana:signIn"].signIn(input)).rejects.toBeInstanceOf(PresignRejection);
  });

  it("a sign-in whose account is chosen in the wallet goes to the wallet unreviewed, and says so", async () => {
    const raw = new FakeWallet([]);
    const w = connectedWallet(raw) as unknown as { features: Record<string, { signIn: (...i: unknown[]) => Promise<unknown> }> };
    await w.features["solana:signIn"].signIn({ statement: "hi" }).catch(() => undefined);
    expect(deps.review).not.toHaveBeenCalled();
    expect(deps.report).toHaveBeenCalledWith(undefined, expect.objectContaining({ status: "PASSED" }));
  });
});

describe("injected providers (window.phantom.solana style)", () => {
  // A fresh class per provider: patches live on the prototype, as with real wallets.
  const makeProvider = () => new (class LegacyProvider {
    publicKey = { toBase58: () => W };
    calls: string[] = [];
    async signTransaction(tx: Transaction) {
      this.calls.push("signTransaction");
      return tx;
    }
    async signAllTransactions(txs: Transaction[]) {
      this.calls.push("signAllTransactions");
      return txs;
    }
    async signMessage() {
      this.calls.push("signMessage");
      return { signature: new Uint8Array(64), publicKey: this.publicKey };
    }
    async request(args: { method: string }) {
      this.calls.push(`request:${args.method}`);
      return { ok: true };
    }
  })();

  it("wraps the methods where they are defined (the prototype), so the original cannot be reached around the hook", async () => {
    const provider = makeProvider();
    (win as Record<string, unknown>).phantom = { solana: provider };
    expect(hook.scanProviders()).toBe(1);
    cancelAll();
    const { tx } = buildTx([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 5 })]);
    await expect(Object.getPrototypeOf(provider).signTransaction.call(provider, tx)).rejects.toBeInstanceOf(PresignRejection);
    expect(provider.calls).toEqual([]);
    expect(reviewed()[0]).toMatchObject({ type: "TRANSACTION", walletAddress: W, walletName: "Phantom", method: "signTransaction" });
  });

  it("approval passes the site's own transaction object to the wallet", async () => {
    const provider = makeProvider();
    hook.patchProvider(provider, "Test");
    approveAll();
    const { tx } = buildTx([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 5 })]);
    await expect(provider.signTransaction(tx)).resolves.toBe(tx);
    await provider.signAllTransactions([tx, tx]);
    expect(reviewed().map((r) => r.method)).toEqual(["signTransaction", "signAllTransactions", "signAllTransactions"]);
  });

  it("request({ method: 'signTransaction', params: { message } }) is reviewed; other methods pass", async () => {
    const provider = makeProvider();
    hook.patchProvider(provider, "Test");
    cancelAll();
    const { tx } = buildTx([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 5 })]);
    await expect(provider.request({ method: "signTransaction", params: { message: bs58.encode(tx.serializeMessage()) } } as never)).rejects.toBeInstanceOf(PresignRejection);
    expect(reviewed()[0].type).toBe("TRANSACTION");
    await expect(provider.request({ method: "connect" })).resolves.toEqual({ ok: true });
  });

  it("a Wallet Standard wallet built on its injected provider is reviewed once, not twice", async () => {
    const provider = makeProvider();
    hook.patchProvider(provider, "Phantom");
    approveAll();
    const { tx, bytes } = buildTx([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 5 })]);
    const standard = {
      version: "1.0.0", name: "Phantom", icon: "", chains: ["solana:mainnet"], accounts: [{ address: W }],
      features: {
        "solana:signTransaction": {
          version: "1.0.0",
          // Like real wallets: the standard feature delegates to the injected provider.
          signTransaction: async (...inputs: TxIn[]) => {
            await provider.signTransaction(tx);
            return inputs.map((i) => ({ signedTransaction: i.transaction }));
          },
        },
      },
    };
    const w = connectedWallet(standard) as unknown as typeof standard;
    await w.features["solana:signTransaction"].signTransaction({ transaction: bytes, account: { address: W } });
    expect(deps.review).toHaveBeenCalledTimes(1);
    expect(provider.calls).toEqual(["signTransaction"]);
  });
});
