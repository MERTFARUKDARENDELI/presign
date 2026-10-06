import { SystemProgram, type Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64, transactionMessage } from "@/extension/src/lib/bytes";
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

  it("Sign anyway: the wallet receives the reviewed bytes as its own copy, with the site's other fields", async () => {
    const raw = new FakeWallet();
    const w = connectedWallet(raw) as unknown as { features: Record<string, { signTransaction: (...i: TxIn[]) => Promise<unknown> }> };
    approveAll();
    const account = { address: W };
    const input = { transaction: txBytes(), account, chain: "solana:devnet" };
    await w.features["solana:signTransaction"].signTransaction(input);
    const given = raw.calls[0][1] as TxIn;
    expect(given.transaction).toEqual(input.transaction);
    expect(given.transaction).not.toBe(input.transaction);
    expect(given.account).toBe(account);
    expect(given.chain).toBe("solana:devnet");
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

  /** A wallet with no account exposed yet: signIn lets the user pick one (W) inside the wallet. */
  const choosingWallet = (sign: (text: string) => string = (t) => t, account = W) => {
    const calls: string[] = [];
    const wallet = {
      version: "1.0.0", name: "Chooser", icon: "data:image/svg+xml;base64,", chains: ["solana:devnet"], accounts: [] as Array<{ address: string }>,
      features: {
        "solana:signIn": {
          version: "1.0.0",
          signIn: async (...inputs: Array<Record<string, string>>) => {
            calls.push("wallet:signIn");
            return inputs.map((i) => ({ account: { address: account }, signedMessage: new TextEncoder().encode(sign(createSignInMessageText({ ...i, domain: i.domain ?? "dapp.example", address: account }))), signature: new Uint8Array(64) }));
          },
        },
      },
    };
    return { calls, wallet: connectedWallet(wallet) as unknown as { features: Record<string, { signIn: (...i: unknown[]) => Promise<unknown> }> } };
  };

  it("a sign-in whose account is chosen in the wallet: signed first, then reviewed; the site gets it only after approval", async () => {
    const { calls, wallet } = choosingWallet();
    deps.review.mockImplementation(async () => {
      calls.push("review");
      return { approved: true, id: "rid-1" };
    });
    const out = (await wallet.features["solana:signIn"].signIn({ statement: "Welcome", nonce: "abc12345" })) as Array<{ account: { address: string } }>;
    expect(calls).toEqual(["wallet:signIn", "review"]);
    expect(out[0].account.address).toBe(W);
    const r = reviewed()[0];
    expect(r).toMatchObject({ type: "MESSAGE", method: "signIn", reconstructed: true, signedFirst: true, walletAddress: W });
    expect(new TextDecoder().decode(Uint8Array.from(atob(r.payload!), (c) => c.charCodeAt(0)))).toBe(`dapp.example wants you to sign in with your Solana account:\n${W}\n\nWelcome\n\nNonce: abc12345`);
  });

  it("cancelling that review withholds the signature; a wallet that signed other text is refused before any review", async () => {
    const chosen = choosingWallet();
    cancelAll();
    await expect(chosen.wallet.features["solana:signIn"].signIn({ statement: "Welcome" })).rejects.toBeInstanceOf(PresignRejection);
    expect(chosen.calls).toEqual(["wallet:signIn"]);

    deps.review.mockReset();
    win = new EventTarget() as HookWindow;
    hook = installInterceptor(win, deps);
    const tamper = choosingWallet((t) => `${t}\nResources:\n- https://evil.example`);
    await expect(tamper.wallet.features["solana:signIn"].signIn({ statement: "Welcome" })).rejects.toBeInstanceOf(PresignRejection);
    expect(deps.review).not.toHaveBeenCalled();
    expect(deps.report).toHaveBeenCalledWith(undefined, expect.objectContaining({ status: "BLOCKED" }));
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

  it("after approval the site gets its own transaction object back", async () => {
    const provider = makeProvider();
    hook.patchProvider(provider, "Test");
    approveAll();
    const { tx } = buildTx([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 5 })]);
    await expect(provider.signTransaction(tx)).resolves.toBe(tx);
    const both = await provider.signAllTransactions([tx, tx]);
    expect(both[0]).toBe(tx);
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

describe("a site cannot change a request after Presign reviewed it", () => {
  // Same length, different amount: the site swaps one for the other after the call returns.
  const benign = () => txBytes(1);
  const drainer = () => txBytes(999_000_000);
  const text = (s: string) => new TextEncoder().encode(s);
  type Std = { features: Record<string, Record<string, (...i: unknown[]) => Promise<unknown>>> };

  it("Wallet Standard signTransaction: the wallet signs the reviewed bytes, not the swapped array", async () => {
    const raw = new FakeWallet();
    const w = connectedWallet(raw) as unknown as Std;
    approveAll();
    const buf = benign();
    const p = w.features["solana:signTransaction"].signTransaction({ transaction: buf, account: { address: W } }) as Promise<Array<{ signedTransaction: Uint8Array }>>;
    buf.set(drainer());
    const out = await p;
    expect(reviewed()[0].payload).toBe(bytesToBase64(benign()));
    expect((raw.calls[0][1] as TxIn).transaction).toEqual(benign());
    expect(transactionMessage(out[0].signedTransaction)).toEqual(transactionMessage(benign()));
  });

  it("Wallet Standard signAndSendTransaction: the wallet broadcasts the reviewed bytes", async () => {
    const raw = new FakeWallet();
    const w = connectedWallet(raw) as unknown as Std;
    approveAll();
    const buf = benign();
    const p = w.features["solana:signAndSendTransaction"].signAndSendTransaction({ transaction: buf, account: { address: W }, chain: "solana:mainnet" });
    buf.set(drainer());
    await p;
    expect((raw.calls[0][1] as TxIn).transaction).toEqual(benign());
  });

  it("Wallet Standard signMessage: the wallet signs the reviewed text", async () => {
    const raw = new FakeWallet();
    const w = connectedWallet(raw) as unknown as Std;
    approveAll();
    const msg = text("Sign in to dapp.example nonce 1234");
    const p = w.features["solana:signMessage"].signMessage({ message: msg, account: { address: W } });
    msg.set(text("ATTACK: approve all my assets 99"));
    await p;
    expect(new TextDecoder().decode((raw.calls[0][1] as { message: Uint8Array }).message)).toBe("Sign in to dapp.example nonce 1234");
  });

  it("Sign-In With Solana: changing the input object after the call does not change what the wallet signs", async () => {
    const raw = new FakeWallet();
    const w = connectedWallet(raw) as unknown as Std;
    approveAll();
    const input = { statement: "Welcome", nonce: "abc12345", resources: ["https://dapp.example/terms"] };
    const p = w.features["solana:signIn"].signIn(input);
    input.statement = "Transfer all assets to the attacker";
    input.resources.push("https://evil.example");
    await p;
    expect(raw.calls[0][1]).toMatchObject({ statement: "Welcome", resources: ["https://dapp.example/terms"] });
  });

  it("an approval for a request Presign could not read never reaches the wallet", async () => {
    const raw = new FakeWallet();
    const w = connectedWallet(raw) as unknown as Std;
    approveAll();
    await expect(w.features["solana:signTransaction"].signTransaction({ transaction: "not bytes", account: { address: W } })).rejects.toBeInstanceOf(PresignRejection);
    expect(raw.calls).toEqual([]);
  });

  /** An injected provider that records the bytes it would sign, the way real ones serialize their input. */
  const recordingProvider = () =>
    new (class RecordingProvider {
      publicKey = { toBase58: () => W };
      saw: Uint8Array[] = [];
      async signTransaction(tx: { serialize: (o?: unknown) => Uint8Array }) {
        this.saw.push(Uint8Array.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })));
        return tx;
      }
      async signAndSendTransaction(tx: { serialize: (o?: unknown) => Uint8Array }) {
        this.saw.push(Uint8Array.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })));
        return { signature: "sig" };
      }
      async signMessage(message: Uint8Array) {
        this.saw.push(Uint8Array.from(message));
        return { signature: new Uint8Array(64) };
      }
      async request(args: { method: string; params?: { message?: Uint8Array } }) {
        if (args.params?.message instanceof Uint8Array) this.saw.push(Uint8Array.from(args.params.message));
        return { ok: true };
      }
    })();

  it("injected signTransaction: an instruction added after the call is not what the wallet signs", async () => {
    const provider = recordingProvider();
    hook.patchProvider(provider, "Test");
    approveAll();
    const { tx } = buildTx([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 1 })]);
    const p = provider.signTransaction(tx as never);
    tx.add(SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 999_000_000 }));
    await expect(p).resolves.toBe(tx);
    expect(bytesToBase64(provider.saw[0])).toBe(reviewed()[0].payload);
  });

  it("injected signAndSendTransaction: an object that serializes differently the second time cannot switch the bytes", async () => {
    const provider = recordingProvider();
    hook.patchProvider(provider, "Test");
    approveAll();
    let calls = 0;
    const liar = { serialize: () => (++calls === 1 ? benign() : drainer()) };
    await provider.signAndSendTransaction(liar);
    expect(provider.saw[0]).toEqual(benign());
  });

  it("a call that reuses an approved request's bytes while the wallet is open still signs exactly those bytes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const provider = new (class SlowProvider {
      publicKey = { toBase58: () => W };
      saw: Uint8Array[] = [];
      async signTransaction(tx: { serialize: (o?: unknown) => Uint8Array }) {
        this.saw.push(Uint8Array.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })));
        await gate;
        return tx;
      }
    })();
    hook.patchProvider(provider, "Test");
    approveAll();
    const first = provider.signTransaction({ serialize: () => benign() });
    await vi.waitFor(() => expect(provider.saw).toHaveLength(1));
    // Same bytes as the approved request on the first read, the drainer on every later one.
    let calls = 0;
    const second = provider.signTransaction({ serialize: () => (++calls === 1 ? benign() : drainer()) });
    release();
    await Promise.all([first, second]);
    expect(deps.review).toHaveBeenCalledTimes(1);
    expect(provider.saw[1]).toEqual(benign());
  });

  it("injected signMessage and request({ method: 'signMessage' }): the wallet signs the reviewed bytes", async () => {
    const provider = recordingProvider();
    hook.patchProvider(provider, "Test");
    approveAll();
    const a = text("Sign in to dapp.example nonce 1234");
    const p1 = provider.signMessage(a);
    a.set(text("ATTACK: approve all my assets 99"));
    await p1;
    const b = text("Sign in to dapp.example nonce 5678");
    const p2 = provider.request({ method: "signMessage", params: { message: b } });
    b.set(text("ATTACK: approve all my assets 99"));
    await p2;
    expect(provider.saw.map((m) => new TextDecoder().decode(m))).toEqual(["Sign in to dapp.example nonce 1234", "Sign in to dapp.example nonce 5678"]);
  });
});

describe("every signing entry point is reviewed or refused", () => {
  type Fns = Record<string, (...i: unknown[]) => Promise<unknown>>;
  /** A wallet with the newer Solana features and one the hook has never heard of. */
  const newerWallet = (calls: unknown[][], tamper = false) => ({
    version: "1.0.0", name: "Newer", icon: "", chains: ["solana:mainnet"], accounts: [{ address: W }],
    features: {
      "solana:signAndSendAllTransactions": {
        version: "1.0.0", supportedTransactionVersions: ["legacy", 0],
        signAndSendAllTransactions: async (inputs: TxIn[], options?: unknown) => (calls.push(["signAndSendAll", inputs, options]), inputs.map(() => ({ status: "fulfilled", value: { signature: new Uint8Array(64) } }))),
      },
      "solana:signOffchainMessage": {
        version: "1.0.0", supportedMessageVersions: [1],
        signOffchainMessage: async (...inputs: Array<{ message: string }>) => (calls.push(["signOffchain", ...inputs]), inputs.map((i) => ({ signedOffchainMessage: new TextEncoder().encode(`\u00ffsolana offchain|preamble|${tamper ? "something else" : i.message}`), signature: new Uint8Array(64) }))),
      },
      "solana:signFutureThing": { version: "1.0.0", signFutureThing: async () => (calls.push(["future"]), []) },
    },
  });
  const features = (w: unknown) => (w as { features: Record<string, Fns> }).features;

  it("Wallet Standard signAndSendAllTransactions: reviewed first, cancel never reaches the wallet, approval sends the reviewed copies", async () => {
    const calls: unknown[][] = [];
    const w = connectedWallet(newerWallet(calls));
    cancelAll();
    await expect(features(w)["solana:signAndSendAllTransactions"].signAndSendAllTransactions([{ transaction: txBytes(1), account: { address: W }, chain: "solana:mainnet" }])).rejects.toBeInstanceOf(PresignRejection);
    expect(calls).toEqual([]);
    expect(reviewed()[0]).toMatchObject({ type: "TRANSACTION", method: "signAndSendAllTransactions" });

    approveAll();
    const buf = txBytes(1);
    const p = features(w)["solana:signAndSendAllTransactions"].signAndSendAllTransactions([{ transaction: buf, account: { address: W }, chain: "solana:mainnet" }], { mode: "serial" });
    buf.set(txBytes(999_000_000));
    await p;
    expect((calls[0][1] as TxIn[])[0].transaction).toEqual(txBytes(1));
    expect(calls[0][2]).toEqual({ mode: "serial" });
  });

  it("Wallet Standard signOffchainMessage: the text is reviewed, and a wallet that signs other text is blocked", async () => {
    const calls: unknown[][] = [];
    const w = connectedWallet(newerWallet(calls));
    approveAll();
    const input = { messageVersion: 1, account: { address: W }, message: "Approve the 2026 budget", requiredSigners: [] };
    await features(w)["solana:signOffchainMessage"].signOffchainMessage(input);
    expect(reviewed()[0]).toMatchObject({ type: "MESSAGE", method: "signOffchainMessage", payload: bytesToBase64(new TextEncoder().encode("Approve the 2026 budget")) });

    win = new EventTarget() as HookWindow;
    hook = installInterceptor(win, deps);
    const w2 = connectedWallet(newerWallet([], true));
    await expect(features(w2)["solana:signOffchainMessage"].signOffchainMessage(input)).rejects.toBeInstanceOf(PresignRejection);
  });

  it("a signing feature the hook does not know is refused, never passed through", async () => {
    const calls: unknown[][] = [];
    const w = connectedWallet(newerWallet(calls));
    approveAll();
    await expect(features(w)["solana:signFutureThing"].signFutureThing()).rejects.toBeInstanceOf(PresignRejection);
    expect(calls).toEqual([]);
  });

  const injected = () =>
    new (class NewerProvider {
      publicKey = { toBase58: () => W };
      calls: string[] = [];
      async signTransaction(tx: unknown) {
        return tx;
      }
      async signAndSendAllTransactions(txs: Array<{ serialize: (o?: unknown) => Uint8Array }>) {
        this.calls.push(`signAndSendAll:${txs.map((t) => bytesToBase64(t.serialize({ requireAllSignatures: false, verifySignatures: false }))).join(",")}`);
        return { signatures: txs.map(() => "sig") };
      }
      async signIn(input: Record<string, string>) {
        this.calls.push("signIn");
        const text = createSignInMessageText({ ...input, domain: input.domain ?? "dapp.example", address: W });
        return { address: W, signedMessage: new TextEncoder().encode(input.statement === "tamper" ? `${text}!` : text), signature: new Uint8Array(64) };
      }
      async signOffchainThing() {
        this.calls.push("offchain");
        return {};
      }
      async request(args: { method: string }) {
        this.calls.push(`request:${args.method}`);
        return {};
      }
    })();

  it("injected signAndSendAllTransactions: reviewed one by one, and the wallet gets the reviewed bytes", async () => {
    const provider = injected();
    hook.patchProvider(provider, "Newer");
    cancelAll();
    const { tx } = buildTx([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 5 })]);
    await expect(provider.signAndSendAllTransactions([tx as never])).rejects.toBeInstanceOf(PresignRejection);
    expect(provider.calls).toEqual([]);
    expect(reviewed()[0]).toMatchObject({ method: "signAndSendAllTransactions", type: "TRANSACTION" });
    approveAll();
    await provider.signAndSendAllTransactions([tx as never]);
    expect(provider.calls).toEqual([`signAndSendAll:${reviewed()[1].payload}`]);
  });

  it("injected signIn without a connected account: the wallet signs first, the site gets it only after the review", async () => {
    const provider = injected();
    (provider as unknown as { publicKey: unknown }).publicKey = null;
    hook.patchProvider(provider, "Newer");
    cancelAll();
    await expect(provider.signIn({ statement: "Welcome", nonce: "abc12345" })).rejects.toBeInstanceOf(PresignRejection);
    expect(provider.calls).toEqual(["signIn"]);
    expect(reviewed()[0]).toMatchObject({ method: "signIn", signedFirst: true, walletAddress: W });
    approveAll();
    await expect(provider.signIn({ statement: "Welcome", nonce: "abc12345" })).resolves.toMatchObject({ address: W });
  });

  it("injected signIn is reviewed like the Wallet Standard one; a wallet that signs other text is blocked", async () => {
    const provider = injected();
    hook.patchProvider(provider, "Newer");
    approveAll();
    await provider.signIn({ statement: "Welcome", nonce: "abc12345" });
    expect(reviewed()[0]).toMatchObject({ type: "MESSAGE", method: "signIn", reconstructed: true, walletAddress: W });
    await expect(provider.signIn({ statement: "tamper", nonce: "abc12345" })).rejects.toBeInstanceOf(PresignRejection);
  });

  it("an unknown injected signing method, and an unknown signing method through request(), are refused", async () => {
    const provider = injected();
    hook.patchProvider(provider, "Newer");
    approveAll();
    await expect(provider.signOffchainThing()).rejects.toBeInstanceOf(PresignRejection);
    await expect(provider.request({ method: "signAndSendAllTransactions" })).rejects.toBeInstanceOf(PresignRejection);
    expect(provider.calls).toEqual([]);
    await expect(provider.request({ method: "connect" })).resolves.toEqual({});
  });
});

describe("legacy registration through window.navigator.wallets", () => {
  // Faithful copies of @wallet-standard/app DEPRECATED_getWallets() and @wallet-standard/wallet DEPRECATED_registerWallet().
  function deprecatedApp(w: HookWindow & { navigator: Record<string, unknown> }) {
    const wallets: unknown[] = [];
    const api = Object.freeze({ register: (...ws: unknown[]) => (wallets.push(...ws), () => undefined) });
    w.addEventListener("wallet-standard:register-wallet", (e) => (e as unknown as { detail: (a: typeof api) => void }).detail(api));
    w.dispatchEvent(new AppReadyEvent(api));
    const callbacks = (w.navigator.wallets as unknown[] | undefined) || [];
    if (!Array.isArray(callbacks)) return wallets;
    const push = (...cbs: Array<(a: typeof api) => void>) => cbs.forEach((cb) => cb({ register: api.register }));
    try {
      Object.defineProperty(w.navigator, "wallets", { value: Object.freeze({ push }) });
    } catch {
      return wallets;
    }
    push(...(callbacks as Array<(a: typeof api) => void>));
    return wallets;
  }
  const legacyOnly = (w: HookWindow & { navigator: Record<string, unknown> }, wallet: unknown) =>
    ((w.navigator.wallets ||= []) as Array<(a: { register: (...x: unknown[]) => unknown }) => void>).push(({ register }) => register(wallet));
  const fresh = () => Object.assign(new EventTarget(), { navigator: {} as Record<string, unknown> }) as HookWindow & { navigator: Record<string, unknown> };

  it("a wallet that registers only through navigator.wallets before the app reaches the app wrapped", () => {
    const w = fresh();
    installInterceptor(w, deps);
    const raw = new FakeWallet();
    legacyOnly(w, raw);
    const wallets = deprecatedApp(w);
    expect(wallets.length).toBeGreaterThan(0);
    expect(wallets).not.toContain(raw);
  });

  it("…and after the app", () => {
    const w = fresh();
    installInterceptor(w, deps);
    const wallets = deprecatedApp(w);
    const raw = new FakeWallet();
    legacyOnly(w, raw);
    expect(wallets.length).toBeGreaterThan(0);
    expect(wallets).not.toContain(raw);
  });

  it("…and when it was already queued before the hook started", () => {
    const w = fresh();
    const raw = new FakeWallet();
    legacyOnly(w, raw);
    installInterceptor(w, deps);
    const wallets = deprecatedApp(w);
    expect(wallets.length).toBeGreaterThan(0);
    expect(wallets).not.toContain(raw);
  });

  it("a site that replaces CustomEvent later cannot catch the raw registration callback", () => {
    const w = fresh();
    installInterceptor(w, deps);
    const leaked: unknown[] = [];
    const Original = globalThis.CustomEvent;
    globalThis.CustomEvent = class extends Original<unknown> {
      constructor(type: string, init?: CustomEventInit) {
        super(type, init);
        if (typeof init?.detail === "function") (init.detail as (a: { register: (...x: unknown[]) => void }) => void)({ register: (...x) => leaked.push(...x) });
      }
    } as typeof CustomEvent;
    try {
      const raw = new FakeWallet();
      legacyOnly(w, raw);
      expect(leaked).not.toContain(raw);
    } finally {
      globalThis.CustomEvent = Original;
    }
  });
});
