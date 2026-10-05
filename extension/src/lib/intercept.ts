import { asTransactionBytes, base58ToBytes, bytesToBase64, copyBytes, onlySignaturesChanged, requestKey, sameBytes, toBytes, transactionMessage } from "./bytes";
import type { Decision, ReviewMethod, ReviewRequest } from "./protocol";
import { createSignInMessageText, type SignInInput } from "./siws";

/**
 * The page hook: wraps the wallet APIs a website uses so every signing request
 * is reviewed by Presign BEFORE the wallet is asked.
 *
 *  - Wallet Standard (Phantom, Solflare, Backpack and most wallets today): the
 *    `wallet-standard:register-wallet` / `wallet-standard:app-ready` handshake
 *    is intercepted so the site only ever receives wrapped wallets.
 *  - Injected providers (`window.phantom.solana`, `window.solana`, …): their
 *    signing methods are wrapped where the wallet allows it.
 *
 * The bytes are copied the moment the site calls, and after approval the
 * wallet gets that copy — never the site's own array or object, which the site
 * could change while the user reads the review. Injected providers take a
 * transaction object, so the wallet gets a view of it whose serialization is
 * fixed to the reviewed bytes, and the site gets its own object back. When the
 * wallet returns, the signed transaction / message is compared with the
 * reviewed copy; if the wallet changed anything, the signature is withheld
 * from the site.
 *
 * Limits (documented): a page written specifically to evade a page-level hook
 * can bypass it; `signAndSendTransaction` is broadcast by the wallet, so only
 * its input can be checked.
 */

export interface ReviewOutcome {
  status: "SIGNED" | "REJECTED" | "BLOCKED" | "PASSED";
  detail: string;
}

export interface InterceptorDeps {
  /** Ask Presign for a decision on one request. */
  review(request: ReviewRequest): Promise<Decision & { id?: string }>;
  /** Tell Presign what happened after an approval (shown on the review page and in the log). */
  report?(id: string | undefined, outcome: ReviewOutcome): void;
  /** Host of the page (for the sign-in text when the site does not set a domain). */
  host(): string;
}

export interface HookWindow extends EventTarget {
  [key: string]: unknown;
}

/** Error a site receives when the user cancels after the review (4001 = user rejected, as wallets use). */
export class PresignRejection extends Error {
  readonly code = 4001;
  constructor(reason: string) {
    super(`Presign: ${reason}`);
    this.name = "PresignRejection";
  }
}

const REGISTER = "wallet-standard:register-wallet";
const READY = "wallet-standard:app-ready";
/**
 * Wallet Standard events override stopPropagation / stopImmediatePropagation
 * to throw. The native methods still work on them; the instance gets the
 * native stopPropagation back first, for engines whose
 * stopImmediatePropagation calls it.
 */
const stopAll = (e: Event) => {
  try {
    Object.defineProperty(e, "stopPropagation", { value: Event.prototype.stopPropagation, configurable: true });
  } catch {
    // not configurable: the native call below still works in browsers
  }
  Event.prototype.stopImmediatePropagation.call(e);
};

const CHANGED = "Your wallet returned a transaction that differs from the one Presign reviewed. The signature was not given to the site.";
const MSG_CHANGED = "Your wallet signed different bytes than the ones Presign reviewed. The signature was not given to the site.";
const UNREADABLE_TX = "The site passed a transaction Presign cannot read.";
const UNREADABLE_MSG = "The site passed a message Presign cannot read.";

type Fn = (...args: unknown[]) => unknown;
type Feature = Record<string, unknown> & { version?: string };
interface StandardWallet {
  name?: string;
  chains?: readonly string[];
  accounts?: ReadonlyArray<{ address?: string }>;
  features?: Record<string, Feature>;
}
interface TxInput {
  transaction?: unknown;
  account?: { address?: string };
  chain?: string;
}
interface MsgInput {
  message?: unknown;
  account?: { address?: string };
}

export function installInterceptor(win: HookWindow, deps: InterceptorDeps) {
  const wrappedWallets = new WeakMap<object, object>();
  const ownEvents = new WeakSet<Event>();
  const patched = new WeakSet<object>();
  /**
   * Requests already approved whose wallet call is running. A wallet that
   * implements one API on top of another (Wallet Standard → injected provider,
   * signTransaction → request) re-enters the hook with the same request: that
   * is the approved call's internals, not a new request.
   */
  const inFlight = new Map<string, number>();

  async function reviewAll(requests: ReviewRequest[]): Promise<Array<string | undefined>> {
    const ids: Array<string | undefined> = [];
    for (const r of requests) {
      const d = await deps.review(r);
      if (!d.approved) throw new PresignRejection(d.reason);
      ids.push(d.id);
    }
    return ids;
  }

  async function withInFlight<T>(keys: string[], run: () => Promise<T>): Promise<T> {
    keys.forEach((k) => inFlight.set(k, (inFlight.get(k) ?? 0) + 1));
    try {
      return await run();
    } finally {
      keys.forEach((k) => {
        const n = (inFlight.get(k) ?? 1) - 1;
        if (n <= 0) inFlight.delete(k);
        else inFlight.set(k, n);
      });
    }
  }

  const keyOf = (type: "TRANSACTION" | "MESSAGE", bytes: Uint8Array | null) => (bytes ? requestKey(type, bytes) : null);
  const allInFlight = (keys: Array<string | null>) => keys.length > 0 && keys.every((k) => k !== null && inFlight.has(k));

  function report(ids: Array<string | undefined>, outcome: ReviewOutcome) {
    for (const id of ids) deps.report?.(id, outcome);
  }

  /**
   * Review every request, call the wallet with the reviewed copies, check what it
   * returned, then hand the site its result (`restore` maps a view back to the
   * site's own object).
   */
  async function reviewed<T>(requests: ReviewRequest[], keys: Array<string | null>, call: () => Promise<T>, verify?: (out: T) => string | null, restore: (out: T) => T = (out) => out): Promise<T> {
    const ids = await reviewAll(requests);
    // Presign offers no sign path for a request it could not read; an approval for one is not trusted.
    if (requests.some((r) => r.type === "UNREADABLE")) throw new PresignRejection("Presign could not read this request, so it cannot be sent to your wallet.");
    return withInFlight(keys.filter((k): k is string => k !== null), async () => {
      let out: T;
      try {
        out = await call();
      } catch (error) {
        report(ids, { status: "REJECTED", detail: error instanceof Error ? error.message.slice(0, 160) : "The wallet did not sign." });
        throw error;
      }
      const problem = verify?.(out) ?? null;
      if (problem) {
        report(ids, { status: "BLOCKED", detail: problem });
        throw new PresignRejection(problem);
      }
      report(ids, { status: "SIGNED", detail: "Signed in the wallet and returned to the site." });
      return restore(out);
    });
  }

  /**
   * What the wallet receives for one Wallet Standard input: the site's fields as
   * they were at call time, with the reviewed bytes as a copy of their own.
   */
  function walletInput<T>(input: T, field: string, bytes: Uint8Array | null): T {
    if (!input || typeof input !== "object") return input;
    const copy: Record<string, unknown> = { ...(input as Record<string, unknown>) };
    if (bytes) copy[field] = Uint8Array.from(bytes);
    return copy as T;
  }

  const req = (type: ReviewRequest["type"], payload: Uint8Array | null, method: ReviewMethod, wallet: string | null, chain: string | null, walletName: string | null, index: number, total: number, extra: Partial<ReviewRequest> = {}): ReviewRequest => ({
    type: payload || type === "UNREADABLE" ? type : "UNREADABLE",
    payload: payload ? bytesToBase64(payload) : null,
    walletAddress: wallet,
    chain,
    method,
    walletName,
    index,
    total,
    ...(payload ? {} : { reason: type === "MESSAGE" ? UNREADABLE_MSG : UNREADABLE_TX }),
    ...extra,
  });

  const signedTxMatches = (original: Uint8Array | null, signed: unknown) => {
    const s = toBytes(signed);
    return original !== null && s !== null && onlySignaturesChanged(original, s);
  };

  // ------------------------------------------------------------------ Wallet Standard

  function wrapFeatures(features: Record<string, Feature>, wallet: StandardWallet): Record<string, Feature> {
    const out: Record<string, Feature> = { ...features };
    const name = typeof wallet.name === "string" ? wallet.name : null;

    const signTx = features["solana:signTransaction"];
    if (signTx && typeof signTx.signTransaction === "function") {
      const orig = (signTx.signTransaction as Fn).bind(signTx);
      out["solana:signTransaction"] = {
        ...signTx,
        signTransaction: (...inputs: TxInput[]) => {
          const txs = inputs.map((i) => copyBytes(i?.transaction));
          const forWallet = inputs.map((i, k) => walletInput(i, "transaction", txs[k]));
          return reviewed(
            inputs.map((i, k) => req("TRANSACTION", txs[k], "signTransaction", i?.account?.address ?? null, i?.chain ?? null, name, k + 1, inputs.length)),
            txs.map((t) => keyOf("TRANSACTION", t)),
            () => orig(...forWallet) as Promise<Array<{ signedTransaction?: unknown }>>,
            (res) => (Array.isArray(res) && res.length === txs.length && res.every((r, k) => signedTxMatches(txs[k], r?.signedTransaction)) ? null : CHANGED),
          );
        },
      };
    }

    const signSend = features["solana:signAndSendTransaction"];
    if (signSend && typeof signSend.signAndSendTransaction === "function") {
      const orig = (signSend.signAndSendTransaction as Fn).bind(signSend);
      out["solana:signAndSendTransaction"] = {
        ...signSend,
        signAndSendTransaction: (...inputs: TxInput[]) => {
          const txs = inputs.map((i) => copyBytes(i?.transaction));
          const forWallet = inputs.map((i, k) => walletInput(i, "transaction", txs[k]));
          return reviewed(
            inputs.map((i, k) => req("TRANSACTION", txs[k], "signAndSendTransaction", i?.account?.address ?? null, i?.chain ?? null, name, k + 1, inputs.length)),
            txs.map((t) => keyOf("TRANSACTION", t)),
            () => orig(...forWallet) as Promise<unknown>,
          );
        },
      };
    }

    const signMsg = features["solana:signMessage"];
    if (signMsg && typeof signMsg.signMessage === "function") {
      const orig = (signMsg.signMessage as Fn).bind(signMsg);
      out["solana:signMessage"] = {
        ...signMsg,
        signMessage: (...inputs: MsgInput[]) => {
          const msgs = inputs.map((i) => copyBytes(i?.message));
          const forWallet = inputs.map((i, k) => walletInput(i, "message", msgs[k]));
          return reviewed(
            inputs.map((i, k) => req("MESSAGE", msgs[k], "signMessage", i?.account?.address ?? null, null, name, k + 1, inputs.length)),
            msgs.map((m) => keyOf("MESSAGE", m)),
            () => orig(...forWallet) as Promise<Array<{ signedMessage?: unknown }>>,
            (res) =>
              Array.isArray(res) && res.every((r, k) => {
                const signed = toBytes(r?.signedMessage);
                return signed === null || (msgs[k] !== null && sameBytes(msgs[k]!, signed));
              })
                ? null
                : MSG_CHANGED,
          );
        },
      };
    }

    const signIn = features["solana:signIn"];
    if (signIn && typeof signIn.signIn === "function") {
      const orig = (signIn.signIn as Fn).bind(signIn);
      out["solana:signIn"] = {
        ...signIn,
        signIn: (...inputs: SignInInput[]) => {
          // The fields as they are now: the site may change its own objects while the user reads the review.
          const list: SignInInput[] = (inputs.length ? inputs : [{}]).map((i) => (i && typeof i === "object" ? { ...i, ...(Array.isArray(i.resources) ? { resources: [...i.resources] } : {}) } : i));
          const accounts = Array.isArray(wallet.accounts) ? wallet.accounts : [];
          const addressFor = (i: SignInInput) => i?.address ?? (accounts.length === 1 ? accounts[0]?.address : undefined);
          const texts = list.map((i) => {
            const address = addressFor(i);
            return address ? createSignInMessageText({ ...i, domain: i?.domain ?? deps.host(), address }) : null;
          });
          // Without a known account the wallet chooses it while signing, so the exact text cannot be
          // reviewed in advance. A sign-in cannot move funds and wallets verify its domain themselves.
          if (texts.some((t) => t === null)) {
            deps.report?.(undefined, { status: "PASSED", detail: "Sign-in passed to the wallet unreviewed: the account is chosen in the wallet, so the exact text is not known in advance." });
            return orig(...inputs);
          }
          const bytes = texts.map((t) => new TextEncoder().encode(t!));
          return reviewed(
            list.map((i, k) => req("MESSAGE", bytes[k], "signIn", addressFor(i) ?? null, null, name, k + 1, list.length, { reconstructed: true })),
            bytes.map((b) => keyOf("MESSAGE", b)),
            () => orig(...(inputs.length ? list : inputs)) as Promise<Array<{ signedMessage?: unknown }>>,
            (res) => (Array.isArray(res) && res.every((r, k) => {
              const signed = toBytes(r?.signedMessage);
              return signed !== null && sameBytes(bytes[k], signed);
            })
              ? null
              : MSG_CHANGED),
          );
        },
      };
    }
    return out;
  }

  function isSolanaWallet(w: StandardWallet): boolean {
    try {
      const chains = Array.isArray(w.chains) ? w.chains : [];
      return chains.some((c) => typeof c === "string" && c.startsWith("solana:")) || Object.keys(w.features ?? {}).some((k) => k.startsWith("solana:"));
    } catch {
      return false;
    }
  }

  function wrapWallet<T>(wallet: T): T {
    if (!wallet || typeof wallet !== "object") return wallet;
    const existing = wrappedWallets.get(wallet as object);
    if (existing) return existing as T;
    if (!isSolanaWallet(wallet as StandardWallet)) return wallet;
    const target = wallet as object;
    let source: Record<string, Feature> | undefined;
    let wrapped: Record<string, Feature> | undefined;
    const features = () => {
      const f = Reflect.get(target, "features", target) as Record<string, Feature>;
      if (f !== source) {
        source = f;
        wrapped = f && typeof f === "object" ? wrapFeatures(f, target as StandardWallet) : f;
      }
      return wrapped;
    };
    const frozenFeatures = (() => {
      const d = Object.getOwnPropertyDescriptor(target, "features");
      return !!d && !d.configurable && "value" in d && !d.writable;
    })();
    let result: object;
    if (frozenFeatures) {
      // A Proxy may not change a frozen property: hand out a delegating object instead.
      result = Object.freeze({
        get version() { return Reflect.get(target, "version", target); },
        get name() { return Reflect.get(target, "name", target); },
        get icon() { return Reflect.get(target, "icon", target); },
        get chains() { return Reflect.get(target, "chains", target); },
        get accounts() { return Reflect.get(target, "accounts", target); },
        get features() { return features(); },
      });
    } else {
      // Getters run on the real wallet (receiver = target), so private class fields keep working.
      result = new Proxy(target, {
        get(t, prop) {
          if (prop === "features") return features();
          const d = Object.getOwnPropertyDescriptor(t, prop);
          const v = Reflect.get(t, prop, t);
          if (d && !d.configurable && "value" in d && !d.writable) return v;
          return typeof v === "function" ? (v as Fn).bind(t) : v;
        },
      });
    }
    wrappedWallets.set(target, result);
    return result as T;
  }

  // A wallet registering after the app: its callback receives a register() that wraps.
  win.addEventListener(
    REGISTER,
    (event) => {
      if (ownEvents.has(event)) return;
      const callback = (event as CustomEvent).detail;
      if (typeof callback !== "function") return;
      stopAll(event);
      const replacement = new CustomEvent(REGISTER, {
        detail: (api: { register: (...w: unknown[]) => unknown }) => callback({ ...api, register: (...wallets: unknown[]) => api.register(...wallets.map(wrapWallet)) }),
      });
      ownEvents.add(replacement);
      win.dispatchEvent(replacement);
    },
    true,
  );
  // The app announcing itself to wallets registered before it: they register through a wrapping API.
  win.addEventListener(
    READY,
    (event) => {
      if (ownEvents.has(event)) return;
      const api = (event as CustomEvent).detail as { register?: (...w: unknown[]) => unknown } | undefined;
      if (!api || typeof api.register !== "function") return;
      stopAll(event);
      const register = api.register.bind(api);
      const replacement = new CustomEvent(READY, { detail: Object.freeze({ ...api, register: (...wallets: unknown[]) => register(...wallets.map(wrapWallet)) }) });
      ownEvents.add(replacement);
      win.dispatchEvent(replacement);
    },
    true,
  );

  // ------------------------------------------------------------------ Injected providers

  /** The serialized transaction behind `tx` (raw bytes or a transaction object), as a private copy. */
  function serializeTx(tx: unknown): Uint8Array | null {
    const raw = copyBytes(tx);
    if (raw) return asTransactionBytes(raw);
    const t = tx as { serialize?: (o?: unknown) => unknown; version?: unknown } | null;
    if (!t || typeof t.serialize !== "function") return null;
    try {
      const out = "version" in t ? t.serialize() : t.serialize({ requireAllSignatures: false, verifySignatures: false });
      return copyBytes(out);
    } catch {
      return null;
    }
  }

  /** Views handed to wallets → the site's own objects they stand for. */
  const views = new WeakMap<object, object>();
  const siteObject = (out: unknown) => (out && typeof out === "object" ? (views.get(out) ?? out) : out);
  const isView = (out: unknown) => !!out && typeof out === "object" && views.has(out);

  /**
   * A view of the site's transaction object for the wallet: everything reads
   * through to the object (so the wallet can add its signature to it), except
   * serialization, which always yields the reviewed bytes. A site that changes
   * its object — or an object that serializes differently the second time —
   * cannot change what the wallet signs.
   */
  function sealedView(target: object, bytes: Uint8Array): object {
    const message = transactionMessage(bytes);
    const fixed = (prop: PropertyKey): (() => Uint8Array) | undefined =>
      prop === "serialize" ? () => Uint8Array.from(bytes) : prop === "serializeMessage" && message ? () => Uint8Array.from(message) : undefined;
    // A Proxy may not change a non-configurable, read-only property: those read through unchanged.
    const locked = (o: object, prop: PropertyKey) => {
      const d = Object.getOwnPropertyDescriptor(o, prop);
      return !!d && !d.configurable && "value" in d && !d.writable;
    };
    let messageView: object | undefined;
    const view = new Proxy(target, {
      get(t, prop) {
        const isLocked = locked(t, prop);
        const own = fixed(prop);
        if (own && !isLocked) return own;
        const v = Reflect.get(t, prop, t);
        // Versioned transactions: `message.serialize()` is the signed message.
        if (prop === "message" && message && !isLocked && v && typeof v === "object" && typeof (v as { serialize?: unknown }).serialize === "function") {
          messageView ??= new Proxy(v, {
            get(m, mp) {
              if (mp === "serialize" && !locked(m, mp)) return () => Uint8Array.from(message);
              const mv = Reflect.get(m, mp, m);
              return typeof mv === "function" && !locked(m, mp) ? (mv as Fn).bind(m) : mv;
            },
          });
          return messageView;
        }
        return typeof v === "function" && !isLocked ? (v as Fn).bind(t) : v;
      },
    });
    views.set(view, target);
    return view;
  }

  /** One transaction argument, captured at call time: the reviewed bytes, and what the wallet gets for them. */
  function sealTx(tx: unknown): { bytes: Uint8Array | null; forWallet: unknown } {
    const raw = copyBytes(tx);
    if (raw) return { bytes: asTransactionBytes(Uint8Array.from(raw)), forWallet: raw };
    const bytes = serializeTx(tx);
    return { bytes, forWallet: bytes && tx && typeof tx === "object" ? sealedView(tx, bytes) : tx };
  }

  /** A byte argument for the wallet: a string as is (immutable), bytes as a copy of their own. */
  const forWalletBytes = (m: unknown) => (typeof m === "string" ? m : (copyBytes(m) ?? m));

  function providerAddress(p: Record<string, unknown>): string | null {
    try {
      const pk = p.publicKey as { toBase58?: () => string } | null | undefined;
      const s = pk && typeof pk.toBase58 === "function" ? pk.toBase58() : null;
      return typeof s === "string" ? s : null;
    } catch {
      return null;
    }
  }

  /** Replaces `method` where it is defined (own property or prototype), if the wallet allows it. */
  function hook(provider: Record<string, unknown>, method: string, make: (orig: Fn) => Fn): boolean {
    let owner: object | null = provider;
    while (owner && !Object.prototype.hasOwnProperty.call(owner, method)) owner = Object.getPrototypeOf(owner);
    if (!owner || owner === Object.prototype) return false;
    const desc = Object.getOwnPropertyDescriptor(owner, method);
    if (!desc || typeof desc.value !== "function" || patched.has(desc.value)) return false;
    const replacement = make(desc.value as Fn);
    patched.add(replacement);
    try {
      if (desc.configurable) Object.defineProperty(owner, method, { ...desc, value: replacement });
      else if (desc.writable) (owner as Record<string, unknown>)[method] = replacement;
      else return false;
      return (owner as Record<string, unknown>)[method] === replacement;
    } catch {
      return false;
    }
  }

  function patchProvider(provider: unknown, label: string): boolean {
    if (!provider || typeof provider !== "object" || patched.has(provider)) return false;
    const p = provider as Record<string, unknown>;
    if (typeof p.signTransaction !== "function" && typeof p.signMessage !== "function") return false;
    patched.add(provider);

    // Every wallet call below gets the captured copy (or a sealed view), also when a wallet's
    // own approved call re-enters the hook: the caller's object is never handed on.
    hook(p, "signTransaction", (orig) => function (this: unknown, tx: unknown, ...rest: unknown[]) {
      const s = sealTx(tx);
      const key = keyOf("TRANSACTION", s.bytes);
      const call = async () => siteObject(await (orig.call(this, s.forWallet, ...rest) as Promise<unknown>));
      if (allInFlight([key])) return call();
      return reviewed([req("TRANSACTION", s.bytes, "signTransaction", providerAddress(p), null, label, 1, 1)], [key], () => orig.call(this, s.forWallet, ...rest) as Promise<unknown>, (out) => (isView(out) || signedTxMatches(s.bytes, serializeTx(out)) ? null : CHANGED), siteObject);
    });
    hook(p, "signAllTransactions", (orig) => function (this: unknown, txs: unknown, ...rest: unknown[]) {
      const sealed = (Array.isArray(txs) ? txs : []).map(sealTx);
      const keys = sealed.map((s) => keyOf("TRANSACTION", s.bytes));
      const forWallet = sealed.map((s) => s.forWallet);
      const back = (out: unknown[]) => (Array.isArray(out) ? out.map(siteObject) : out);
      if (allInFlight(keys)) return (orig.call(this, forWallet, ...rest) as Promise<unknown[]>).then(back);
      return reviewed(
        sealed.map((s, k) => req("TRANSACTION", s.bytes, "signAllTransactions", providerAddress(p), null, label, k + 1, sealed.length)),
        keys,
        () => orig.call(this, forWallet, ...rest) as Promise<unknown[]>,
        (out) => (Array.isArray(out) && out.length === sealed.length && out.every((o, k) => isView(o) || signedTxMatches(sealed[k].bytes, serializeTx(o))) ? null : CHANGED),
        back,
      );
    });
    hook(p, "signAndSendTransaction", (orig) => function (this: unknown, tx: unknown, ...rest: unknown[]) {
      const s = sealTx(tx);
      const key = keyOf("TRANSACTION", s.bytes);
      if (allInFlight([key])) return orig.call(this, s.forWallet, ...rest);
      return reviewed([req("TRANSACTION", s.bytes, "signAndSendTransaction", providerAddress(p), null, label, 1, 1)], [key], () => orig.call(this, s.forWallet, ...rest) as Promise<unknown>);
    });
    hook(p, "signMessage", (orig) => function (this: unknown, message: unknown, ...rest: unknown[]) {
      const bytes = copyBytes(message);
      const forWallet = bytes ? Uint8Array.from(bytes) : message;
      const key = keyOf("MESSAGE", bytes);
      if (allInFlight([key])) return orig.call(this, forWallet, ...rest);
      return reviewed([req("MESSAGE", bytes, "signMessage", providerAddress(p), null, label, 1, 1)], [key], () => orig.call(this, forWallet, ...rest) as Promise<unknown>);
    });
    // Generic RPC-style entry point some sites (and wallets internally) use: { method, params: { message: base58 } }.
    hook(p, "request", (orig) => function (this: unknown, args: unknown, ...rest: unknown[]) {
      const a = args as { method?: unknown; params?: { message?: unknown; messages?: unknown } } | null;
      const method = typeof a?.method === "string" ? a.method : "";
      if (!["signTransaction", "signAllTransactions", "signAndSendTransaction", "signMessage"].includes(method)) return orig.call(this, args, ...rest);
      const params = a?.params && typeof a.params === "object" ? a.params : {};
      const decode = (m: unknown) => (typeof m === "string" ? base58ToBytes(m) : toBytes(m));
      if (method === "signMessage") {
        const m = forWalletBytes(params.message);
        const bytes = decode(m);
        const forWallet = { ...a, params: { ...params, message: forWalletBytes(m) } };
        const key = keyOf("MESSAGE", bytes);
        if (allInFlight([key])) return orig.call(this, forWallet, ...rest);
        return reviewed([req("MESSAGE", bytes, "signMessage", providerAddress(p), null, label, 1, 1)], [key], () => orig.call(this, forWallet, ...rest) as Promise<unknown>);
      }
      const raw = (method === "signAllTransactions" ? (Array.isArray(params.messages) ? (params.messages as unknown[]) : []) : [params.message]).map(forWalletBytes);
      const bytes = raw.map((m) => {
        const b = decode(m);
        return b ? asTransactionBytes(Uint8Array.from(b)) : null;
      });
      const forWallet = { ...a, params: method === "signAllTransactions" ? { ...params, messages: raw.map(forWalletBytes) } : { ...params, message: forWalletBytes(raw[0]) } };
      const keys = bytes.map((b) => keyOf("TRANSACTION", b));
      if (allInFlight(keys)) return orig.call(this, forWallet, ...rest);
      return reviewed(bytes.map((b, k) => req("TRANSACTION", b, method as ReviewMethod, providerAddress(p), null, label, k + 1, bytes.length)), keys, () => orig.call(this, forWallet, ...rest) as Promise<unknown>);
    });
    return true;
  }

  const PROVIDER_PATHS: Array<[string, string]> = [
    ["phantom.solana", "Phantom"],
    ["solana", "window.solana"],
    ["solflare", "Solflare"],
    ["backpack", "Backpack"],
    ["exodus.solana", "Exodus"],
    ["glowSolana", "Glow"],
    ["braveSolana", "Brave Wallet"],
    ["trustwallet.solana", "Trust Wallet"],
    ["okxwallet.solana", "OKX Wallet"],
    ["coinbaseSolana", "Coinbase Wallet"],
    ["bitkeep.solana", "Bitget Wallet"],
  ];

  /** Wraps every injected provider present now; call again later for wallets that inject late. */
  function scanProviders(): number {
    let n = 0;
    for (const [path, label] of PROVIDER_PATHS) {
      try {
        const value = path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), win);
        if (patchProvider(value, label)) n++;
      } catch {
        // a hostile getter: skip it
      }
    }
    return n;
  }

  return { wrapWallet, patchProvider, scanProviders };
}
