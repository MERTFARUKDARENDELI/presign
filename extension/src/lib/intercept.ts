import { asTransactionBytes, base58ToBytes, bytesToBase64, copyBytes, endsWithBytes, onlySignaturesChanged, requestKey, sameBytes, toBytes, transactionMessage } from "./bytes";
import type { SignatureVerifier } from "./ed25519";
import {
  ArrayIsArray,
  bare,
  byteCount,
  containsSign,
  containsWord,
  copyList,
  copyOf,
  hasOwn,
  mapList,
  NativeProxy,
  ObjectDefineProperty,
  ObjectFreeze,
  ObjectGetOwnPropertyDescriptor,
  ObjectGetOwnPropertyNames,
  ObjectGetPrototypeOf,
  ObjectKeys,
  ObjectPrototype,
  own,
  pin,
  prepend,
  promise,
  push,
  ReflectApply,
  ReflectGet,
  setOwn,
  settle,
  snapshot,
  startsWith,
  startsWithSign,
  utf8,
  weakGet,
  weakHas,
  weakSet,
  weakSetAddValue,
  weakSetHasValue,
} from "./primordials";
import type { Decision, ReviewMethod, ReviewRequest } from "./protocol";
import { isHash, sha256Hex } from "./sha256";
import { createSignInMessageText, signInSnapshot, type SignInInput } from "./siws";

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
 * The site runs in the same JavaScript world as this hook. Nothing on the path
 * from the site's call to the wallet's looks up a built-in the site could have
 * replaced after the hook loaded (./primordials): replacing btoa, Map / Set /
 * Array / Promise methods, Function.prototype.call, the global Promise or
 * Proxy, or a getter / setter / `then` on Object.prototype changes neither
 * what the user reviews, nor the bytes the wallet receives, nor the decision
 * the hook acts on. Fields of the site's objects are read once (a snapshot)
 * and pinned, so an accessor cannot answer Presign one way and the wallet
 * another.
 *
 * Limits (documented): a page written specifically to evade a page-level hook
 * can still reach a wallet around it — through the wallet's own internals or
 * its transport to the wallet extension, which run in the same world and which
 * Presign does not control. The wallet's own confirmation window stays the
 * final check. `signAndSendTransaction` is broadcast by the wallet, so only
 * its input can be checked; and a wallet's result passes through the wallet's
 * own code before Presign's after-signing checks, so withholding a result from
 * a hostile site is best effort.
 */

export interface ReviewOutcome {
  /** UNPROTECTED: a wallet method the hook could not wrap (the wallet locked it); requests through it are not reviewed. */
  status: "SIGNED" | "REJECTED" | "BLOCKED" | "PASSED" | "UNPROTECTED";
  detail: string;
  /** For outcomes without a review (UNPROTECTED, a refused sign-in): the method concerned. */
  method?: string;
}

export interface InterceptorDeps {
  /** Ask Presign for a decision on one request. */
  review(request: ReviewRequest): Promise<Decision & { id?: string }>;
  /** Tell Presign what happened after an approval (shown on the review page and in the log). */
  report?(id: string | undefined, outcome: ReviewOutcome): void;
  /** Host of the page (for the sign-in text when the site does not set a domain). */
  host(): string;
  /** Ed25519 check of a message signature the wallet returned (null: this browser cannot check). */
  verifySignature?: SignatureVerifier;
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
const NativeCustomEvent = CustomEvent;
const customEventDetail = ObjectGetOwnPropertyDescriptor(CustomEvent.prototype, "detail")?.get;
const eventStopPropagation = Event.prototype.stopPropagation;
const eventStopImmediatePropagation = Event.prototype.stopImmediatePropagation;
const eventDispatch = EventTarget.prototype.dispatchEvent;
const eventListen = EventTarget.prototype.addEventListener;

/**
 * Wallet Standard events override stopPropagation / stopImmediatePropagation
 * to throw. The native methods still work on them; the instance gets the
 * native stopPropagation back first, for engines whose
 * stopImmediatePropagation calls it.
 */
const stopAll = (e: Event) => {
  try {
    ObjectDefineProperty(e, "stopPropagation", bare({ value: eventStopPropagation, configurable: true }));
  } catch {
    // not configurable: the native call below still works in browsers
  }
  ReflectApply(eventStopImmediatePropagation, e, []);
};

/** An event's detail: the native CustomEvent accessor, or the Wallet Standard event class's own getter. */
function detailOf(e: Event): unknown {
  if (customEventDetail) {
    try {
      return ReflectApply(customEventDetail, e, []);
    } catch {
      // not a CustomEvent (the Wallet Standard classes extend Event)
    }
  }
  return ReflectGet(e, "detail", e);
}

const CHANGED = "Your wallet returned a transaction that differs from the one Presign reviewed (some wallets add a priority fee or other instructions before signing; if yours does, turn that off for this request). The signature was not given to the site.";
const MSG_CHANGED = "Your wallet signed different bytes than the ones Presign reviewed. The signature was not given to the site.";
const BAD_SIGNATURE = "Your wallet's signature does not match the message Presign reviewed and the account it was reviewed for. The signature was not given to the site.";
const UNREADABLE_TX = "The site passed a transaction Presign cannot read.";
const UNREADABLE_MSG = "The site passed a message Presign cannot read.";
const CANCELLED = "the request was cancelled after the security review.";
const CHANGED_AFTER_REVIEW = "the signing request changed after the security review, so it was not sent to your wallet: Presign does not let a wallet sign bytes it did not verify.";
const UNCONFIRMED = "Presign could not confirm which bytes you approved, so nothing was sent to your wallet.";

type Fn = (...args: unknown[]) => unknown;
type Feature = Record<string, unknown> & { version?: string };

/** Wallet Standard features this hook reviews; any other `solana:` signing feature is refused. */
const REVIEWED_FEATURES: Record<string, true> = bare({ "solana:signTransaction": true, "solana:signAndSendTransaction": true, "solana:signAndSendAllTransactions": true, "solana:signMessage": true, "solana:signOffchainMessage": true, "solana:signIn": true });
/** Injected-provider methods this hook reviews; any other `sign…` method is refused. */
const REVIEWED_METHODS: Record<string, true> = bare({ signTransaction: true, signAllTransactions: true, signAndSendTransaction: true, signAndSendAllTransactions: true, signMessage: true, signIn: true });
const refusal = (what: string) => new PresignRejection(`Presign cannot review requests made through ${what} yet, so it refused this one. Nothing was sent to your wallet.`);
const refuse = (what: string) => () => promise<never>((_, reject) => reject(refusal(what)));

/** The first `n` characters of a string (for log text). */
function clip(s: string, n: number): string {
  let out = "";
  for (let i = 0; i < n && i < s.length; i++) out += s[i];
  return out;
}

const errorDetail = (error: unknown): string => {
  const m = own(error, "message");
  return typeof m === "string" ? clip(m, 160) : "The wallet did not sign.";
};

/** fn bound to `self`, without Function.prototype.bind. */
const bindTo = (fn: unknown, self: unknown) => (...args: unknown[]) => ReflectApply(fn as Fn, self, args);

/** A property of a wallet / site object (its own code decides what it returns). */
const field = (o: unknown, key: string): unknown => (o !== null && typeof o === "object" ? ReflectGet(o, key, o) : undefined);

/** A non-configurable, read-only data property: a Proxy must hand it out unchanged. */
function isLockedValue(o: object, prop: PropertyKey): boolean {
  const d = ObjectGetOwnPropertyDescriptor(o, prop);
  return !!d && own(d, "configurable") === false && hasOwn(d, "value") && own(d, "writable") === false;
}

const addressOf = (account: unknown): string | null => {
  const a = field(account, "address");
  return typeof a === "string" ? a : null;
};

const PROVIDER_PATHS: Array<[string[], string]> = [
  [["phantom", "solana"], "Phantom"],
  [["solana"], "window.solana"],
  [["solflare"], "Solflare"],
  [["backpack"], "Backpack"],
  [["exodus", "solana"], "Exodus"],
  [["glowSolana"], "Glow"],
  [["braveSolana"], "Brave Wallet"],
  [["trustwallet", "solana"], "Trust Wallet"],
  [["okxwallet", "solana"], "OKX Wallet"],
  [["coinbaseSolana"], "Coinbase Wallet"],
  [["bitkeep", "solana"], "Bitget Wallet"],
];

export function installInterceptor(win: HookWindow, deps: InterceptorDeps) {
  // Captured now (document_start), before a site could replace them; `deps` is the hook's own object.
  const review = deps.review;
  const reportFn = deps.report;
  const host = deps.host;
  const wrappedWallets = new WeakMap<object, object>();
  const ownEvents = new WeakSet<Event>();
  const patched = new WeakSet<object>();
  /** Views handed to wallets → the site's own objects they stand for. */
  const views = new WeakMap<object, object>();
  /**
   * Requests already approved whose wallet call is running. A wallet that
   * implements one API on top of another (Wallet Standard → injected provider,
   * signTransaction → request) re-enters the hook with the same request: that
   * is the approved call's internals, not a new request. A record without a
   * prototype: a site cannot make a key look present.
   */
  const inFlight: Record<string, number> = bare({});

  const verifier = (): SignatureVerifier | undefined => own(deps, "verifySignature") as SignatureVerifier | undefined;

  function enter(keys: string[]) {
    for (let i = 0; i < keys.length; i++) inFlight[keys[i]] = (inFlight[keys[i]] ?? 0) + 1;
  }

  function leave(keys: string[]) {
    for (let i = 0; i < keys.length; i++) {
      const n = (inFlight[keys[i]] ?? 1) - 1;
      if (n <= 0) delete inFlight[keys[i]];
      else inFlight[keys[i]] = n;
    }
  }

  const keyOf = (type: "TRANSACTION" | "MESSAGE", bytes: Uint8Array | null) => (bytes ? requestKey(type, bytes) : null);

  function allInFlight(keys: Array<string | null>): boolean {
    if (keys.length === 0) return false;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k === null || !(k in inFlight)) return false;
    }
    return true;
  }

  function report(ids: Array<string | undefined>, outcome: ReviewOutcome) {
    if (!reportFn) return;
    for (let i = 0; i < ids.length; i++) reportFn(ids[i], outcome);
  }

  interface Approval {
    id: string | undefined;
    /** The payload hash Presign's server confirmed for this request. */
    payloadHash: string | undefined;
    /** The extension's own switch (protection off, or off for this site): nothing was reviewed. */
    pass: boolean;
  }

  /** Only the decision's own `approved: true` approves. */
  function decisionOf(d: unknown): ({ ok: true } & Approval) | { ok: false; reason: string } {
    if (own(d, "approved") === true) {
      const id = own(d, "id");
      const payloadHash = own(d, "payloadHash");
      return { ok: true, id: typeof id === "string" ? id : undefined, payloadHash: isHash(payloadHash) ? payloadHash : undefined, pass: own(d, "pass") === true };
    }
    const reason = own(d, "reason");
    return { ok: false, reason: typeof reason === "string" ? reason : CANCELLED };
  }

  /**
   * The last check before the wallet is asked: for each request, the bytes the
   * wallet is about to receive (`bound`, read from the very arguments the wallet
   * gets) must hash to what Presign's server approved — the same transform the
   * extension's background confirmed (the transaction message for a
   * transaction, the bytes of a message). Approvals without a confirmed hash are
   * not trusted, except the extension's own pass.
   */
  function boundProblem(requests: ReviewRequest[], approvals: Approval[], bound: () => Array<Uint8Array | null>): string | null {
    let wallet: Array<Uint8Array | null>;
    try {
      wallet = bound();
    } catch {
      return CHANGED_AFTER_REVIEW;
    }
    if (wallet.length !== requests.length || approvals.length !== requests.length) return CHANGED_AFTER_REVIEW;
    for (let k = 0; k < requests.length; k++) {
      const a = approvals[k];
      if (a.pass) continue;
      if (!a.payloadHash) return UNCONFIRMED;
      const b = wallet[k];
      const covered = b === null ? null : requests[k].type === "TRANSACTION" ? transactionMessage(b) : b;
      if (!covered || sha256Hex(covered) !== a.payloadHash) return CHANGED_AFTER_REVIEW;
    }
    return null;
  }

  interface Review<T> {
    requests: ReviewRequest[];
    /** Request keys held while the wallet call runs (re-entrancy, see `inFlight`). */
    keys: Array<string | null>;
    /** For each request, what the wallet is about to receive, in the request's own form (a whole transaction, or the message bytes). */
    bound: () => Array<Uint8Array | null>;
    call: () => unknown;
    /** A problem with what the wallet returned, or null. */
    verify?: (out: T) => unknown;
    /** Maps a view back to the site's own object. */
    restore?: (out: T) => unknown;
  }

  /**
   * Review every request, check that the wallet is about to receive exactly
   * what was approved, call the wallet, check what it returned, then hand the
   * site its result. Each step continues from the captured `then` of the
   * previous one's promise, never from `await` / `.then`, whose lookups a site
   * could have replaced to hand the hook a decision of its own.
   */
  function reviewed<T>({ requests, keys, bound, call, verify, restore }: Review<T>): Promise<T> {
    return promise<T>((resolveSite, rejectSite) => {
      const ids: Array<string | undefined> = [];
      const approvals: Approval[] = [];
      let k = 0;
      const next = (): void => {
        if (k === requests.length) return approved();
        const r = requests[k++];
        let pending: unknown;
        try {
          pending = review(r);
        } catch (error) {
          return rejectSite(error);
        }
        settle<unknown>(
          pending,
          (d) => {
            const decision = decisionOf(d);
            if (!decision.ok) return rejectSite(new PresignRejection(decision.reason));
            push(ids, decision.id);
            push(approvals, { id: decision.id, payloadHash: decision.payloadHash, pass: decision.pass });
            next();
          },
          rejectSite,
          true,
        );
      };
      const approved = (): void => {
        // Presign offers no sign path for a request it could not read; an approval for one is not trusted.
        for (let i = 0; i < requests.length; i++) if (requests[i].type === "UNREADABLE") return rejectSite(new PresignRejection("Presign could not read this request, so it cannot be sent to your wallet."));
        const changed = boundProblem(requests, approvals, bound);
        if (changed) {
          report(ids, { status: "BLOCKED", detail: changed });
          return rejectSite(new PresignRejection(changed));
        }
        const held: string[] = [];
        for (let i = 0; i < keys.length; i++) if (keys[i] !== null) push(held, keys[i] as string);
        enter(held);
        let left = false;
        const done = () => {
          if (!left) leave(held);
          left = true;
        };
        const walletFailed = (error: unknown) => {
          done();
          report(ids, { status: "REJECTED", detail: errorDetail(error) });
          rejectSite(error);
        };
        let pending: unknown;
        try {
          pending = call();
        } catch (error) {
          return walletFailed(error);
        }
        settle<T>(
          pending,
          (out) => {
            let check: unknown = null;
            try {
              check = verify ? verify(out) : null;
            } catch (error) {
              done();
              return rejectSite(error);
            }
            settle<unknown>(
              check,
              (problem) => {
                done();
                if (typeof problem === "string" && problem) {
                  report(ids, { status: "BLOCKED", detail: problem });
                  return rejectSite(new PresignRejection(problem));
                }
                report(ids, { status: "SIGNED", detail: "Signed in the wallet and returned to the site." });
                try {
                  resolveSite((restore ? restore(out) : out) as T);
                } catch (error) {
                  rejectSite(error);
                }
              },
              (error) => {
                done();
                rejectSite(error);
              },
            );
          },
          walletFailed,
        );
      };
      next();
    });
  }

  /** A call an approved request makes while its wallet call runs: straight to the wallet (`restore` maps views back). */
  function passThrough(call: () => unknown, restore: (out: unknown) => unknown): Promise<unknown> {
    return promise((resolve, reject) => {
      let pending: unknown;
      try {
        pending = call();
      } catch (error) {
        return reject(error);
      }
      settle<unknown>(
        pending,
        (out) => {
          try {
            resolve(restore(out));
          } catch (error) {
            reject(error);
          }
        },
        reject,
      );
    });
  }

  /** The signature must be valid for `signed` and the account the request was reviewed for. */
  function signatureProblem(signed: Uint8Array, signature: unknown, address: string | null): string | null | Promise<string | null> {
    const verifySignature = verifier();
    if (!verifySignature || !address) return null;
    const sig = typeof signature === "string" ? base58ToBytes(signature) : toBytes(signature);
    const publicKey = base58ToBytes(address);
    if (!sig || !publicKey) return BAD_SIGNATURE;
    let pending: unknown;
    try {
      pending = verifySignature(signed, sig, publicKey);
    } catch {
      return BAD_SIGNATURE;
    }
    // null: this browser cannot check Ed25519; the wallet still signed the reviewed copy.
    return promise<string | null>((resolve) => settle<unknown>(pending, (valid) => resolve(valid === false ? BAD_SIGNATURE : null), () => resolve(BAD_SIGNATURE), true));
  }

  /**
   * A wallet's message results: one per input, the signed bytes present and equal to the
   * reviewed ones (an off-chain message: ending with the reviewed text, after the
   * wallet's preamble), and each signature valid for them and the reviewing account.
   */
  function messageResultsProblem(res: unknown, reviewedBytes: Array<Uint8Array | null>, addresses: Array<string | null>, signedField: "signedMessage" | "signedOffchainMessage"): string | null | Promise<string | null> {
    if (!ArrayIsArray(res)) return MSG_CHANGED;
    const list = copyList(res);
    if (list.length !== reviewedBytes.length) return MSG_CHANGED;
    return promise<string | null>((resolve) => {
      let k = 0;
      const next = (): void => {
        if (k === list.length) return resolve(null);
        const r = list[k];
        const want = reviewedBytes[k];
        const address = addresses[k];
        k++;
        const signed = toBytes(field(r, signedField));
        if (!signed || !want || !(signedField === "signedOffchainMessage" ? endsWithBytes(signed, want) : sameBytes(want, signed))) return resolve(MSG_CHANGED);
        settle<string | null>(signatureProblem(signed, field(r, "signature"), address), (bad) => (bad ? resolve(bad) : next()), () => resolve(BAD_SIGNATURE));
      };
      next();
    });
  }

  /** The account a sign-in result names: Wallet Standard { account: { address } } or an injected provider's { address }. */
  function signInAccount(r: unknown): string | null {
    const account = field(r, "account");
    let a: unknown = account !== null && typeof account === "object" ? field(account, "address") : field(r, "address");
    if (a !== null && typeof a === "object") {
      const toBase58 = field(a, "toBase58");
      if (typeof toBase58 !== "function") return null;
      try {
        a = ReflectApply(toBase58 as Fn, a, []);
      } catch {
        return null;
      }
    }
    if (typeof a !== "string") return null;
    const decoded = base58ToBytes(a);
    return decoded && byteCount(decoded) === 32 ? a : null;
  }

  /** The sign-in text for a snapshot (./siws signInSnapshot) and an account. */
  const signInText = (i: SignInInput, address: string) => createSignInMessageText({ ...i, domain: typeof i.domain === "string" ? i.domain : host(), address });

  /**
   * Sign-In With Solana when the account is chosen in the wallet: the exact text
   * is not known until the wallet picks the account, so the wallet signs first.
   * Presign then rebuilds the text for the returned account, requires the wallet
   * to have signed exactly that (signature checked), and reviews it; the site
   * receives the signature only after the user approves. Cancel, a failed review
   * or any mismatch withholds it.
   */
  function signInSignedFirst(list: SignInInput[], walletName: string | null, call: () => unknown, results: (out: unknown) => unknown[] | null): Promise<unknown> {
    return promise((resolveSite, rejectSite) => {
      let pending: unknown;
      try {
        pending = call();
      } catch (error) {
        return rejectSite(error);
      }
      settle<unknown>(
        pending,
        (out) => {
          const res = results(out);
          const addresses = res ? mapList(res, signInAccount) : [];
          let valid = res !== null && res.length === list.length;
          for (let k = 0; valid && k < addresses.length; k++) {
            const a = addresses[k];
            const wanted = list[k].address;
            valid = a !== null && (!wanted || wanted === a);
          }
          const texts = valid ? mapList(list, (i, k) => utf8(signInText(i, addresses[k]!))) : [];
          const problem = valid ? messageResultsProblem(res, texts, addresses, "signedMessage") : MSG_CHANGED;
          settle<string | null>(
            problem,
            (bad) => {
              if (bad) {
                reportFn?.(undefined, { status: "BLOCKED", method: "signIn", detail: `Sign-in signed in the wallet, withheld from the site: ${bad}` });
                return rejectSite(new PresignRejection(bad));
              }
              const requests = mapList(list, (_, k) => req("MESSAGE", texts[k], "signIn", addresses[k], null, walletName, k + 1, list.length, { reconstructed: true, signedFirst: true }));
              // The wallet already signed these texts; the approval must be for exactly them.
              settle<unknown>(reviewed({ requests, keys: [], bound: () => texts, call: () => out }), resolveSite, rejectSite, true);
            },
            rejectSite,
          );
        },
        rejectSite,
      );
    });
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

  /**
   * One Wallet Standard input, as Presign reviews it and the wallet receives it:
   * a snapshot of the site's object with the fields Presign reads pinned, and
   * the reviewed bytes as the wallet's own copy.
   */
  function standardInput(input: unknown, bytesField: "transaction" | "message") {
    const snap = snapshot(input);
    if (!snap) return { forWallet: input, bytes: null, address: null, chain: null };
    const bytes = copyBytes(pin(snap, bytesField));
    if (bytes) setOwn(snap, bytesField, copyOf(bytes));
    const address = addressOf(pin(snap, "account"));
    const chain = pin(snap, "chain");
    return { forWallet: snap as unknown, bytes, address, chain: typeof chain === "string" ? chain : null };
  }

  /** The `bytesField` of each Wallet Standard input the wallet receives, read from those very inputs. */
  const walletBytes = (forWallet: unknown[], bytesField: "transaction" | "message") => () => mapList(forWallet, (w) => copyBytes(own(w, bytesField)));

  function signedTransactionsProblem(res: unknown, txs: Array<Uint8Array | null>): string | null {
    if (!ArrayIsArray(res)) return CHANGED;
    const list = copyList(res);
    if (list.length !== txs.length) return CHANGED;
    for (let k = 0; k < list.length; k++) if (!signedTxMatches(txs[k], field(list[k], "signedTransaction"))) return CHANGED;
    return null;
  }

  function wrapFeatures(features: Record<string, Feature>, wallet: object): Record<string, Feature> {
    const out: Record<string, Feature> = { ...features };
    const walletName = ReflectGet(wallet, "name", wallet);
    const name = typeof walletName === "string" ? walletName : null;
    /** A feature's method, read once on the wallet's own feature object. */
    const method = (featureName: string, methodName: string): { feature: Feature; fn: Fn } | null => {
      const feature = own(features, featureName);
      if (feature === null || typeof feature !== "object") return null;
      const fn = field(feature, methodName);
      return typeof fn === "function" ? { feature: feature as Feature, fn: fn as Fn } : null;
    };

    const signTx = method("solana:signTransaction", "signTransaction");
    if (signTx) {
      setOwn(out, "solana:signTransaction", {
        ...signTx.feature,
        signTransaction: (...inputs: unknown[]) => {
          const parts = mapList(inputs, (i) => standardInput(i, "transaction"));
          const txs = mapList(parts, (p) => p.bytes);
          const forWallet = mapList(parts, (p) => p.forWallet);
          return reviewed({
            requests: mapList(parts, (p, k) => req("TRANSACTION", p.bytes, "signTransaction", p.address, p.chain, name, k + 1, inputs.length)),
            keys: mapList(txs, (t) => keyOf("TRANSACTION", t)),
            bound: walletBytes(forWallet, "transaction"),
            call: () => ReflectApply(signTx.fn, signTx.feature, forWallet),
            verify: (res) => signedTransactionsProblem(res, txs),
          });
        },
      });
    }

    const signSend = method("solana:signAndSendTransaction", "signAndSendTransaction");
    if (signSend) {
      setOwn(out, "solana:signAndSendTransaction", {
        ...signSend.feature,
        signAndSendTransaction: (...inputs: unknown[]) => {
          const parts = mapList(inputs, (i) => standardInput(i, "transaction"));
          const forWallet = mapList(parts, (p) => p.forWallet);
          return reviewed({
            requests: mapList(parts, (p, k) => req("TRANSACTION", p.bytes, "signAndSendTransaction", p.address, p.chain, name, k + 1, inputs.length)),
            keys: mapList(parts, (p) => keyOf("TRANSACTION", p.bytes)),
            bound: walletBytes(forWallet, "transaction"),
            call: () => ReflectApply(signSend.fn, signSend.feature, forWallet),
          });
        },
      });
    }

    // (inputs[], options?) — one array, not a rest list. Broadcast by the wallet, so only the input can be held to the review.
    const signSendAll = method("solana:signAndSendAllTransactions", "signAndSendAllTransactions");
    if (signSendAll) {
      setOwn(out, "solana:signAndSendAllTransactions", {
        ...signSendAll.feature,
        signAndSendAllTransactions: (inputs: unknown, ...rest: unknown[]) => {
          const parts = mapList(copyList(inputs), (i) => standardInput(i, "transaction"));
          const forWallet = mapList(parts, (p) => p.forWallet);
          const options = mapList(rest, (o) => snapshot(o) ?? o);
          return reviewed({
            requests: parts.length
              ? mapList(parts, (p, k) => req("TRANSACTION", p.bytes, "signAndSendAllTransactions", p.address, p.chain, name, k + 1, parts.length))
              : [req("UNREADABLE", null, "signAndSendAllTransactions", null, null, name, 1, 1)],
            keys: mapList(parts, (p) => keyOf("TRANSACTION", p.bytes)),
            bound: walletBytes(forWallet, "transaction"),
            call: () => ReflectApply(signSendAll.fn, signSendAll.feature, prepend<unknown>(forWallet, options)),
          });
        },
      });
    }

    // The message is text; the wallet builds the off-chain preamble and signs preamble + text.
    const signOff = method("solana:signOffchainMessage", "signOffchainMessage");
    if (signOff) {
      setOwn(out, "solana:signOffchainMessage", {
        ...signOff.feature,
        signOffchainMessage: (...inputs: unknown[]) => {
          const list = mapList(inputs, (i) => {
            const s = snapshot(i);
            if (!s) return i;
            pin(s, "message");
            pin(s, "account");
            const signers = s.requiredSigners;
            setOwn(s, "requiredSigners", ArrayIsArray(signers) ? copyList(signers) : signers);
            return s;
          });
          const texts = mapList(list, (s) => {
            const m = own(s, "message");
            return typeof m === "string" ? utf8(m) : null;
          });
          const addresses = mapList(list, (s) => addressOf(own(s, "account")));
          return reviewed({
            requests: mapList(list, (_, k) => req("MESSAGE", texts[k], "signOffchainMessage", addresses[k], null, name, k + 1, list.length)),
            keys: mapList(texts, (t) => keyOf("MESSAGE", t)),
            // The text the wallet receives (it adds the off-chain preamble itself).
            bound: () =>
              mapList(list, (s) => {
                const m = own(s, "message");
                return typeof m === "string" ? utf8(m) : null;
              }),
            call: () => ReflectApply(signOff.fn, signOff.feature, list),
            verify: (res) => messageResultsProblem(res, texts, addresses, "signedOffchainMessage"),
          });
        },
      });
    }

    const signMsg = method("solana:signMessage", "signMessage");
    if (signMsg) {
      setOwn(out, "solana:signMessage", {
        ...signMsg.feature,
        signMessage: (...inputs: unknown[]) => {
          const parts = mapList(inputs, (i) => standardInput(i, "message"));
          const msgs = mapList(parts, (p) => p.bytes);
          const addresses = mapList(parts, (p) => p.address);
          const forWallet = mapList(parts, (p) => p.forWallet);
          return reviewed({
            requests: mapList(parts, (p, k) => req("MESSAGE", p.bytes, "signMessage", p.address, null, name, k + 1, inputs.length)),
            keys: mapList(msgs, (m) => keyOf("MESSAGE", m)),
            bound: walletBytes(forWallet, "message"),
            call: () => ReflectApply(signMsg.fn, signMsg.feature, forWallet),
            verify: (res) => messageResultsProblem(res, msgs, addresses, "signedMessage"),
          });
        },
      });
    }

    const signIn = method("solana:signIn", "signIn");
    if (signIn) {
      setOwn(out, "solana:signIn", {
        ...signIn.feature,
        signIn: (...inputs: unknown[]) => {
          // The fields as they are now, each a string or nothing: the site may change its own objects while the user reads the review.
          const given = inputs.length > 0;
          const list = given ? mapList(inputs, signInSnapshot) : [signInSnapshot({})];
          const accounts = copyList(ReflectGet(wallet, "accounts", wallet));
          const addressFor = (i: SignInInput): string | undefined => (typeof i.address === "string" ? i.address : accounts.length === 1 ? (addressOf(accounts[0]) ?? undefined) : undefined);
          const texts = mapList(list, (i) => {
            const address = addressFor(i);
            return address ? signInText(i, address) : null;
          });
          const forWallet = given ? list : [];
          // Without a known account the wallet chooses it while signing: it signs first, and the
          // site gets the signature only after Presign reviewed the exact signed text.
          let known = true;
          for (let k = 0; k < texts.length; k++) if (texts[k] === null) known = false;
          if (!known) return signInSignedFirst(list, name, () => ReflectApply(signIn.fn, signIn.feature, forWallet), (res) => (ArrayIsArray(res) ? copyList(res) : null));
          const bytes = mapList(texts, (t) => utf8(t!));
          return reviewed({
            requests: mapList(list, (i, k) => req("MESSAGE", bytes[k], "signIn", addressFor(i) ?? null, null, name, k + 1, list.length, { reconstructed: true })),
            keys: mapList(bytes, (b) => keyOf("MESSAGE", b)),
            // The text the wallet builds, rebuilt from the very inputs it receives.
            bound: () =>
              mapList(list, (i) => {
                const address = addressFor(i);
                return address ? utf8(signInText(i, address)) : null;
              }),
            call: () => ReflectApply(signIn.fn, signIn.feature, forWallet),
            verify: (res) => messageResultsProblem(res, bytes, mapList(list, (i) => addressFor(i) ?? null), "signedMessage"),
          });
        },
      });
    }

    // A wallet that announces changed features hands the app the new features object: wrapped too.
    const events = method("standard:events", "on");
    if (events) {
      const wrapProps = (props: unknown) => {
        if (props === null || typeof props !== "object" || !hasOwn(props, "features")) return props;
        const f = (props as { features?: unknown }).features;
        return { ...(props as object), features: f !== null && typeof f === "object" ? wrapFeatures(f as Record<string, Feature>, wallet) : f };
      };
      setOwn(out, "standard:events", {
        ...events.feature,
        on: (event: unknown, listener: unknown, ...rest: unknown[]) => {
          const wrappedListener = typeof listener === "function" ? (props: unknown) => ReflectApply(listener as Fn, undefined, [wrapProps(props)]) : listener;
          const args: unknown[] = [event, wrappedListener];
          for (let i = 0; i < rest.length; i++) push(args, rest[i]);
          return ReflectApply(events.fn, events.feature, args);
        },
      });
    }

    // Default deny: a Solana signing feature this hook does not review (a newer one, a typo'd one) is refused,
    // never handed through — otherwise it would be a way around every review.
    const keys = ObjectKeys(features);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (!startsWith(key, "solana:") || !containsSign(key) || key in REVIEWED_FEATURES) continue;
      const feature = own(features, key);
      const refused: Feature = {};
      if (feature !== null && typeof feature === "object") {
        const props = ObjectKeys(feature);
        for (let j = 0; j < props.length; j++) {
          const v = (feature as Record<string, unknown>)[props[j]];
          setOwn(refused, props[j], typeof v === "function" ? refuse(`"${key}"`) : v);
        }
      }
      setOwn(out, key, refused);
    }
    return out;
  }

  function isSolanaWallet(w: object): boolean {
    try {
      const chains = copyList(ReflectGet(w, "chains", w));
      for (let i = 0; i < chains.length; i++) if (typeof chains[i] === "string" && startsWith(chains[i] as string, "solana:")) return true;
      const features = ReflectGet(w, "features", w);
      if (features === null || typeof features !== "object") return false;
      const keys = ObjectKeys(features);
      for (let i = 0; i < keys.length; i++) if (startsWith(keys[i], "solana:")) return true;
      return false;
    } catch {
      return false;
    }
  }

  /**
   * The wallet the site receives: only the Wallet Standard properties, each read
   * on the real wallet (receiver = the wallet, so private class fields keep
   * working), with wrapped features. Not a Proxy: a Proxy would hand out the
   * wallet's own property descriptors, prototype and internal fields, through
   * any of which a site could reach the unwrapped signing methods.
   */
  function wrapWallet<T>(wallet: T): T {
    if (!wallet || typeof wallet !== "object") return wallet;
    const target = wallet as unknown as object;
    const existing = weakGet(wrappedWallets, target);
    if (existing) return existing as T;
    if (!isSolanaWallet(target)) return wallet;
    let source: unknown;
    let wrapped: unknown;
    const features = () => {
      const f = ReflectGet(target, "features", target);
      if (f !== source) {
        source = f;
        wrapped = f !== null && typeof f === "object" ? wrapFeatures(f as Record<string, Feature>, target) : f;
      }
      return wrapped;
    };
    const result = ObjectFreeze({
      get version() {
        return ReflectGet(target, "version", target);
      },
      get name() {
        return ReflectGet(target, "name", target);
      },
      get icon() {
        return ReflectGet(target, "icon", target);
      },
      get chains() {
        return ReflectGet(target, "chains", target);
      },
      get accounts() {
        return ReflectGet(target, "accounts", target);
      },
      get features() {
        return features();
      },
    });
    weakSet(wrappedWallets, target, result);
    return result as T;
  }

  const wrapAll = (wallets: ArrayLike<unknown>) => mapList(wallets, wrapWallet);

  /** The app's API with a register() that wraps every wallet before the app's own register sees it. */
  function wrappingApi(api: unknown): Record<string, unknown> {
    const register = field(api, "register");
    return {
      ...(api !== null && typeof api === "object" ? (api as Record<string, unknown>) : {}),
      register: (...wallets: unknown[]) => ReflectApply(register as Fn, api, wrapAll(wallets)),
    };
  }

  const dispatchOwn = (type: string, detail: unknown) => {
    const event = new NativeCustomEvent(type, bare({ detail }));
    weakSetAddValue(ownEvents, event);
    ReflectApply(eventDispatch, win, [event]);
  };

  // A wallet registering after the app: its callback receives a register() that wraps.
  ReflectApply(eventListen, win, [
    REGISTER,
    (event: Event) => {
      if (weakSetHasValue(ownEvents, event)) return;
      const callback = detailOf(event);
      if (typeof callback !== "function") return;
      stopAll(event);
      dispatchOwn(REGISTER, (api: unknown) => ReflectApply(callback as Fn, undefined, [wrappingApi(api)]));
    },
    true,
  ]);
  // The app announcing itself to wallets registered before it: they register through a wrapping API.
  ReflectApply(eventListen, win, [
    READY,
    (event: Event) => {
      if (weakSetHasValue(ownEvents, event)) return;
      const api = detailOf(event);
      if (typeof field(api, "register") !== "function") return;
      stopAll(event);
      dispatchOwn(READY, ObjectFreeze(wrappingApi(api)));
    },
    true,
  ]);

  // Legacy registration: wallets that push a callback to window.navigator.wallets, which
  // @solana/wallet-adapter still reads (DEPRECATED_getWallets) and calls with the app's own
  // register. Each callback is turned into the event handshake above (wrapping register),
  // and navigator.wallets becomes an empty list whose push does the same — so a wallet can
  // reach the app only wrapped. The property cannot be redefined afterwards; an app that
  // tries logs an error and keeps the wallets it got through the events.
  const nav = field(win, "navigator");
  if (nav !== null && typeof nav === "object") {
    const announce = (cb: unknown) => {
      if (typeof cb !== "function") return;
      dispatchOwn(REGISTER, (api: unknown) => ReflectApply(cb as Fn, undefined, [wrappingApi(api)]));
      // Apps that start later: they get our replacement app-ready event, whose register wraps.
      ReflectApply(eventListen, win, [
        READY,
        (e: Event) => {
          if (weakSetHasValue(ownEvents, e)) ReflectApply(cb as Fn, undefined, [detailOf(e)]);
        },
      ]);
    };
    const announceAll = (cbs: unknown) => {
      const list = copyList(cbs);
      for (let i = 0; i < list.length; i++) announce(list[i]);
    };
    let queued: unknown[] = [];
    try {
      queued = copyList(field(nav, "wallets"));
    } catch {
      // a hostile getter: nothing queued
    }
    const list: unknown[] = [];
    ObjectDefineProperty(list, "push", bare({ value: (...cbs: unknown[]) => (announceAll(cbs), 0) }));
    try {
      ObjectDefineProperty(
        nav,
        "wallets",
        bare({
          configurable: false,
          enumerable: true,
          get: () => list,
          set: (v: unknown) => announceAll(v),
        }),
      );
      announceAll(queued);
    } catch {
      // not definable here: the event handshake still wraps every wallet that uses it
    }
  }

  // ------------------------------------------------------------------ Injected providers

  /** The serialized transaction behind `tx` (raw bytes or a transaction object), as a private copy. */
  function serializeTx(tx: unknown): Uint8Array | null {
    const raw = copyBytes(tx);
    if (raw) return asTransactionBytes(raw);
    if (tx === null || typeof tx !== "object") return null;
    const serialize = field(tx, "serialize");
    if (typeof serialize !== "function") return null;
    try {
      const out = "version" in tx ? ReflectApply(serialize as Fn, tx, []) : ReflectApply(serialize as Fn, tx, [{ requireAllSignatures: false, verifySignatures: false }]);
      return copyBytes(out);
    } catch {
      return null;
    }
  }

  const siteObject = (out: unknown) => (out !== null && typeof out === "object" ? (weakGet(views, out) ?? out) : out);
  const isView = (out: unknown) => out !== null && typeof out === "object" && weakHas(views, out);

  /**
   * A view of the site's transaction object for the wallet: everything reads
   * through to the object (so the wallet can add its signature to it), except
   * serialization, which always yields the reviewed bytes. A site that changes
   * its object — or an object that serializes differently the second time —
   * cannot change what the wallet signs. A site object whose `serialize` /
   * `serializeMessage` / `message` is locked (non-configurable, read-only)
   * cannot be given another value by a Proxy: reading it through the view
   * throws, so the wallet call fails rather than signing other bytes.
   */
  function sealedView(target: object, bytes: Uint8Array): object {
    const message = transactionMessage(bytes);
    const fixed = (prop: PropertyKey): (() => Uint8Array) | undefined =>
      prop === "serialize" ? () => copyOf(bytes) : prop === "serializeMessage" && message ? () => copyOf(message) : undefined;
    let messageView: object | undefined;
    const view = new NativeProxy(
      target,
      bare({
        get(t: object, prop: PropertyKey) {
          const fixedFn = fixed(prop);
          if (fixedFn) return fixedFn;
          const v = ReflectGet(t, prop, t);
          // Versioned transactions: `message.serialize()` is the signed message.
          if (prop === "message" && message && v !== null && typeof v === "object" && typeof field(v, "serialize") === "function") {
            messageView ??= new NativeProxy(
              v as object,
              bare({
                get(m: object, mp: PropertyKey) {
                  if (mp === "serialize") return () => copyOf(message);
                  const mv = ReflectGet(m, mp, m);
                  return typeof mv === "function" && !isLockedValue(m, mp) ? bindTo(mv, m) : mv;
                },
              }),
            );
            return messageView;
          }
          return typeof v === "function" && !isLockedValue(t, prop) ? bindTo(v, t) : v;
        },
      }),
    );
    weakSet(views, view, target);
    return view;
  }

  /** One transaction argument, captured at call time: the reviewed bytes, and what the wallet gets for them. */
  function sealTx(tx: unknown): { bytes: Uint8Array | null; forWallet: unknown } {
    const raw = copyBytes(tx);
    if (raw) return { bytes: asTransactionBytes(copyOf(raw)), forWallet: raw };
    const bytes = serializeTx(tx);
    return { bytes, forWallet: bytes && tx !== null && typeof tx === "object" ? sealedView(tx, bytes) : tx };
  }

  /**
   * The transaction a wallet argument stands for, read from that very argument: a byte copy
   * as a whole transaction, or what a sealed view serializes to. A site object whose
   * `serialize` is locked cannot be read through its view (the Proxy invariant throws): null.
   */
  function walletTx(forWallet: unknown): Uint8Array | null {
    const raw = copyBytes(forWallet);
    if (raw) return asTransactionBytes(raw);
    if (!isView(forWallet)) return null;
    try {
      const serialize = ReflectGet(forWallet as object, "serialize", forWallet);
      return typeof serialize === "function" ? copyBytes(ReflectApply(serialize as Fn, forWallet, [])) : null;
    } catch {
      return null;
    }
  }

  /** A byte argument for the wallet: a string as is (immutable), bytes as a copy of their own. */
  const forWalletBytes = (m: unknown) => (typeof m === "string" ? m : (copyBytes(m) ?? m));
  const decode = (m: unknown) => (typeof m === "string" ? base58ToBytes(m) : toBytes(m));

  function providerAddress(p: Record<string, unknown>): string | null {
    try {
      const pk = field(p, "publicKey");
      const toBase58 = field(pk, "toBase58");
      const s = typeof toBase58 === "function" ? ReflectApply(toBase58 as Fn, pk, []) : null;
      return typeof s === "string" ? s : null;
    } catch {
      return null;
    }
  }

  /** Replaces `method` where it is defined (own property or prototype), if the wallet allows it. */
  /** "failed": the method exists but the wallet made it impossible to replace (not writable, not configurable, or a setter that ignores us). */
  function hook(provider: object, method: string, make: (orig: Fn) => Fn): "patched" | "absent" | "failed" {
    let owner: object | null = provider;
    for (let depth = 0; owner && !hasOwn(owner, method) && depth < 64; depth++) owner = ObjectGetPrototypeOf(owner);
    if (!owner || owner === ObjectPrototype || !hasOwn(owner, method)) return "absent";
    const desc = ObjectGetOwnPropertyDescriptor(owner, method);
    if (!desc) return "absent";
    const value = own(desc, "value");
    if (value !== null && (typeof value === "object" || typeof value === "function") && weakSetHasValue(patched, value)) return "patched";
    if (typeof value !== "function") return typeof own(desc, "get") === "function" ? "failed" : "absent";
    const replacement = make(value as Fn);
    weakSetAddValue(patched, replacement);
    try {
      if (own(desc, "configurable") === true) ObjectDefineProperty(owner, method, bare({ value: replacement, writable: own(desc, "writable") === true, enumerable: own(desc, "enumerable") === true, configurable: true }));
      else if (own(desc, "writable") === true) (owner as Record<string, unknown>)[method] = replacement;
      else return "failed";
      return ReflectGet(owner, method, owner) === replacement ? "patched" : "failed";
    } catch {
      return "failed";
    }
  }

  function patchProvider(provider: unknown, label: string): boolean {
    if (!provider || typeof provider !== "object" || weakSetHasValue(patched, provider)) return false;
    const p = provider as Record<string, unknown>;
    if (typeof field(p, "signTransaction") !== "function" && typeof field(p, "signMessage") !== "function") return false;
    weakSetAddValue(patched, provider);
    // Methods the wallet locked against replacement: reported, never silently left unreviewed.
    const unwrapped: string[] = [];
    const wrap = (method: string, make: (orig: Fn) => Fn) => {
      if (hook(p, method, make) === "failed") push(unwrapped, method);
    };

    // Every wallet call below gets the captured copy (or a sealed view), also when a wallet's
    // own approved call re-enters the hook: the caller's object is never handed on.
    wrap("signTransaction", (orig) =>
      function (this: unknown, tx: unknown, ...rest: unknown[]) {
        const s = sealTx(tx);
        const key = keyOf("TRANSACTION", s.bytes);
        const args = prepend(s.forWallet, rest);
        const call = () => ReflectApply(orig, this, args);
        if (allInFlight([key])) return passThrough(call, siteObject);
        return reviewed({
          requests: [req("TRANSACTION", s.bytes, "signTransaction", providerAddress(p), null, label, 1, 1)],
          keys: [key],
          bound: () => [walletTx(s.forWallet)],
          call,
          verify: (out) => (isView(out) || signedTxMatches(s.bytes, serializeTx(out)) ? null : CHANGED),
          restore: siteObject,
        });
      },
    );
    wrap("signAllTransactions", (orig) =>
      function (this: unknown, txs: unknown, ...rest: unknown[]) {
        const sealed = mapList(copyList(txs), sealTx);
        const keys = mapList(sealed, (s) => keyOf("TRANSACTION", s.bytes));
        const forWallet = mapList(sealed, (s) => s.forWallet);
        const back = (out: unknown) => (ArrayIsArray(out) ? mapList(copyList(out), siteObject) : out);
        const call = () => ReflectApply(orig, this, prepend<unknown>(forWallet, rest));
        if (allInFlight(keys)) return passThrough(call, back);
        const allMatch = (out: unknown) => {
          if (!ArrayIsArray(out)) return false;
          const list = copyList(out);
          if (list.length !== sealed.length) return false;
          for (let k = 0; k < list.length; k++) if (!isView(list[k]) && !signedTxMatches(sealed[k].bytes, serializeTx(list[k]))) return false;
          return true;
        };
        return reviewed({
          requests: mapList(sealed, (s, k) => req("TRANSACTION", s.bytes, "signAllTransactions", providerAddress(p), null, label, k + 1, sealed.length)),
          keys,
          bound: () => mapList(forWallet, walletTx),
          call,
          verify: (out) => (allMatch(out) ? null : CHANGED),
          restore: back,
        });
      },
    );
    wrap("signAndSendTransaction", (orig) =>
      function (this: unknown, tx: unknown, ...rest: unknown[]) {
        const s = sealTx(tx);
        const key = keyOf("TRANSACTION", s.bytes);
        const args = prepend(s.forWallet, rest);
        if (allInFlight([key])) return ReflectApply(orig, this, args);
        return reviewed({ requests: [req("TRANSACTION", s.bytes, "signAndSendTransaction", providerAddress(p), null, label, 1, 1)], keys: [key], bound: () => [walletTx(s.forWallet)], call: () => ReflectApply(orig, this, args) });
      },
    );
    wrap("signAndSendAllTransactions", (orig) =>
      function (this: unknown, txs: unknown, ...rest: unknown[]) {
        const sealed = mapList(copyList(txs), sealTx);
        const keys = mapList(sealed, (s) => keyOf("TRANSACTION", s.bytes));
        const forWallet = mapList(sealed, (s) => s.forWallet);
        const args = prepend<unknown>(forWallet, rest);
        if (allInFlight(keys)) return ReflectApply(orig, this, args);
        return reviewed({
          requests: sealed.length
            ? mapList(sealed, (s, k) => req("TRANSACTION", s.bytes, "signAndSendAllTransactions", providerAddress(p), null, label, k + 1, sealed.length))
            : [req("UNREADABLE", null, "signAndSendAllTransactions", providerAddress(p), null, label, 1, 1)],
          keys,
          bound: () => mapList(forWallet, walletTx),
          call: () => ReflectApply(orig, this, args),
        });
      },
    );
    wrap("signMessage", (orig) =>
      function (this: unknown, message: unknown, ...rest: unknown[]) {
        const bytes = copyBytes(message);
        const address = providerAddress(p);
        const key = keyOf("MESSAGE", bytes);
        const args = prepend(bytes ? copyOf(bytes) : message, rest);
        if (allInFlight([key])) return ReflectApply(orig, this, args);
        return reviewed({
          requests: [req("MESSAGE", bytes, "signMessage", address, null, label, 1, 1)],
          keys: [key],
          bound: () => [copyBytes(args[0])],
          call: () => ReflectApply(orig, this, args),
          verify: (out) => signatureProblem(bytes!, field(out, "signature"), address),
        });
      },
    );
    // Sign-In With Solana on the injected provider: same rules as the Wallet Standard feature.
    wrap("signIn", (orig) =>
      function (this: unknown, input?: unknown, ...rest: unknown[]) {
        const i = signInSnapshot(input);
        const address = (typeof i.address === "string" ? i.address : null) ?? providerAddress(p) ?? undefined;
        const args = prepend(input === undefined ? undefined : (i as unknown), rest);
        if (!address) return signInSignedFirst([i], label, () => ReflectApply(orig, this, args), (out) => (out !== null && typeof out === "object" ? [out] : null));
        const bytes = utf8(signInText(i, address));
        const key = keyOf("MESSAGE", bytes);
        if (allInFlight([key])) return ReflectApply(orig, this, args);
        return reviewed({
          requests: [req("MESSAGE", bytes, "signIn", address, null, label, 1, 1, { reconstructed: true })],
          keys: [key],
          // The text the wallet builds, rebuilt from the very input it receives.
          bound: () => [utf8(signInText(i, address))],
          call: () => ReflectApply(orig, this, args),
          verify: (out) => messageResultsProblem([out], [bytes], [address], "signedMessage"),
        });
      },
    );
    // Generic RPC-style entry point some sites (and wallets internally) use: { method, params: { message: base58 } }.
    wrap("request", (orig) =>
      function (this: unknown, args: unknown, ...rest: unknown[]) {
        // One snapshot of the site's object, read once: an accessor cannot show Presign one method and the wallet another.
        const a = snapshot(args);
        const methodValue = a ? pin(a, "method") : undefined;
        const method = typeof methodValue === "string" ? methodValue : "";
        if (!a || (method !== "signTransaction" && method !== "signAllTransactions" && method !== "signAndSendTransaction" && method !== "signMessage")) {
          if (!a || !startsWithSign(method)) return ReflectApply(orig, this, prepend(a ?? args, rest));
          return otherSignRequest(this, orig, a, method, paramsOf(a), rest);
        }
        const params = paramsOf(a);
        if (method === "signMessage") {
          const m = forWalletBytes(pin(params, "message"));
          const bytes = decode(m);
          const forWallet = { ...a, params: { ...params, message: forWalletBytes(m) } };
          const key = keyOf("MESSAGE", bytes);
          const address = providerAddress(p);
          const call = () => ReflectApply(orig, this, prepend<unknown>(forWallet, rest));
          if (allInFlight([key])) return call();
          return reviewed({
            requests: [req("MESSAGE", bytes, "signMessage", address, null, label, 1, 1)],
            keys: [key],
            bound: () => [decode(own(own(forWallet, "params"), "message"))],
            call,
            verify: (out) => signatureProblem(bytes!, field(out, "signature"), address),
          });
        }
        const many = method === "signAllTransactions";
        const raw = mapList(many ? copyList(pin(params, "messages")) : [pin(params, "message")], forWalletBytes);
        const bytes = mapList(raw, (m) => {
          const b = decode(m);
          return b ? asTransactionBytes(b) : null;
        });
        const forWallet = { ...a, params: many ? { ...params, messages: mapList(raw, forWalletBytes) } : { ...params, message: forWalletBytes(raw[0]) } };
        const keys = mapList(bytes, (b) => keyOf("TRANSACTION", b));
        const call = () => ReflectApply(orig, this, prepend<unknown>(forWallet, rest));
        if (allInFlight(keys)) return call();
        // What the wallet receives, read back from the request it is given.
        const walletParams = () => own(forWallet, "params");
        return reviewed({
          requests: bytes.length ? mapList(bytes, (b, k) => req("TRANSACTION", b, method as ReviewMethod, providerAddress(p), null, label, k + 1, bytes.length)) : [req("UNREADABLE", null, method as ReviewMethod, providerAddress(p), null, label, 1, 1)],
          keys,
          bound: () =>
            mapList(many ? copyList(own(walletParams(), "messages")) : [own(walletParams(), "message")], (m) => {
              const b = decode(m);
              return b ? asTransactionBytes(b) : null;
            }),
          call,
        });
      },
    );

    /** The request's params as a snapshot of their own, pinned on the request snapshot. */
    function paramsOf(a: Record<string, unknown>): Record<string, unknown> {
      const params = snapshot(pin(a, "params")) ?? {};
      setOwn(a, "params", params);
      return params;
    }

    /**
     * request({ method: "sign…" }) for a method Presign cannot read. A wallet's own approved
     * call may re-enter this way with the approved payload (passed on as a copy); anything
     * else is reviewed as unreadable, where Cancel is the only choice.
     */
    function otherSignRequest(self: unknown, orig: Fn, a: Record<string, unknown>, method: string, params: Record<string, unknown>, rest: unknown[]): unknown {
      // Every field the wallet might sign is pinned: absent ones as undefined, so a prototype cannot supply them.
      const snap: Record<string, unknown> = method === "signIn" ? ({ ...signInSnapshot(params) } as Record<string, unknown>) : { ...params };
      const payloads: unknown[] = [];
      const PAYLOAD_KEYS = ["message", "messages", "transaction", "transactions"];
      for (let i = 0; i < PAYLOAD_KEYS.length; i++) {
        const k = PAYLOAD_KEYS[i];
        const v = params[k];
        if (v === undefined) {
          setOwn(snap, k, undefined);
          continue;
        }
        const copied = ArrayIsArray(v) ? mapList(copyList(v), forWalletBytes) : forWalletBytes(v);
        setOwn(snap, k, copied);
        if (ArrayIsArray(copied)) for (let j = 0; j < (copied as unknown[]).length; j++) push(payloads, (copied as unknown[])[j]);
        else push(payloads, copied);
      }
      const approvedPayload = (m: unknown) => {
        const b = decode(m);
        if (!b) return false;
        const t = asTransactionBytes(copyOf(b));
        return requestKey("MESSAGE", b) in inFlight || (t !== null && requestKey("TRANSACTION", t) in inFlight);
      };
      let approved = payloads.length > 0;
      for (let j = 0; approved && j < payloads.length; j++) approved = approvedPayload(payloads[j]);
      if (!approved && method === "signIn" && payloads.length === 0) {
        const si = snap as SignInInput;
        const address = (typeof si.address === "string" ? si.address : null) ?? providerAddress(p);
        approved = !!address && requestKey("MESSAGE", utf8(signInText(si, address))) in inFlight;
      }
      if (approved) return ReflectApply(orig, self, prepend<unknown>({ ...a, params: snap }, rest));
      const kind: ReviewMethod = containsWord(method, "message") || containsWord(method, "signin") || containsWord(method, "sign-in") ? "signMessage" : "signTransaction";
      // Unreadable: Cancel is the only choice, so the wallet is never called from here.
      return reviewed({
        requests: [req("UNREADABLE", null, kind, providerAddress(p), null, label, 1, 1, { reason: `The site called "${clip(method, 40)}" through the wallet's request() API, which Presign cannot read.` })],
        keys: [],
        bound: () => [],
        call: () => ReflectApply(orig, self, prepend<unknown>(a, rest)),
      });
    }

    // Default deny: any other signing method on the provider (own or inherited) is refused, never handed through.
    const names = methodNames(p);
    for (let i = 0; i < names.length; i++) {
      const m = names[i];
      if (startsWithSign(m) && !(m in REVIEWED_METHODS)) wrap(m, () => refuse(`${label}.${m}()`));
    }
    if (unwrapped.length > 0) {
      let list = "";
      for (let i = 0; i < unwrapped.length; i++) list += (i ? ", " : "") + unwrapped[i];
      const one = unwrapped.length === 1;
      reportFn?.(undefined, {
        status: "UNPROTECTED",
        method: unwrapped[0],
        detail: `${label}: ${list} could not be wrapped (the wallet locked ${one ? "it" : "them"}), so requests through ${one ? "it" : "them"} reach the wallet without Presign's review.`,
      });
    }
    return true;
  }

  /** Function-valued properties of an object and its prototypes (not Object.prototype). */
  function methodNames(o: object): string[] {
    const seen: Record<string, true> = bare({});
    const names: string[] = [];
    let x: object | null = o;
    for (let depth = 0; x && x !== ObjectPrototype && depth < 64; depth++) {
      let props: string[] = [];
      try {
        props = ObjectGetOwnPropertyNames(x);
      } catch {
        break;
      }
      for (let i = 0; i < props.length; i++) {
        const n = props[i];
        try {
          const d = ObjectGetOwnPropertyDescriptor(x, n);
          if (d && typeof own(d, "value") === "function" && !(n in seen)) {
            seen[n] = true;
            push(names, n);
          }
        } catch {
          // a hostile descriptor: skip it
        }
      }
      x = ObjectGetPrototypeOf(x);
    }
    return names;
  }

  /** Wraps every injected provider present now; call again later for wallets that inject late. */
  function scanProviders(): number {
    let n = 0;
    for (let i = 0; i < PROVIDER_PATHS.length; i++) {
      const path = PROVIDER_PATHS[i][0];
      const label = PROVIDER_PATHS[i][1];
      try {
        let value: unknown = win;
        for (let j = 0; j < path.length; j++) value = value !== null && typeof value === "object" ? (value as Record<string, unknown>)[path[j]] : undefined;
        if (patchProvider(value, label)) n++;
      } catch {
        // a hostile getter: skip it
      }
    }
    return n;
  }

  return { wrapWallet, patchProvider, scanProviders };
}
