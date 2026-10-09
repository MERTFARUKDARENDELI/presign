import { SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";
import { afterEach, describe, expect, it } from "vitest";
import { asTransactionBytes, transactionMessage } from "@/extension/src/lib/bytes";
import { createReviewer, pageTransport } from "@/extension/src/lib/channel";
import { installInterceptor, type HookWindow } from "@/extension/src/lib/intercept";
import { randomHex } from "@/extension/src/lib/primordials";
import { createSignInMessageText } from "@/extension/src/lib/siws";
import { ATTACKER, buildTx, WALLET } from "../helpers/fixtures";

/**
 * A hostile page. The hook is installed first (document_start); then the page's
 * scripts replace built-ins — as any site can — and only then do the app start,
 * the wallets register and the injected provider get wrapped. Every signing
 * entry point is then called with the site's bytes, and the user cancels or
 * approves through the real channel (pageTransport → createReviewer).
 *
 * For every (replaced built-in × entry point):
 *  - cancel:  the wallet is never called and the site gets no result;
 *  - approve: the wallet receives exactly the bytes the user reviewed, and
 *             those are exactly the site's bytes;
 *  - always:  neither the channel secret nor an unwrapped wallet reaches page code;
 *             a signing feature / method Presign does not review never reaches the wallet.
 *
 * The test's wallets and its content-script side use built-ins captured before
 * the page replaced them (real wallets run their own code; the content script
 * runs in an isolated world): what is under test is Presign's page hook.
 */

type Fn = (...args: unknown[]) => unknown;

// ------------------------------------------------------------------ the test's own built-ins (captured first)
const realApply = Reflect.apply;
const realDefine = Object.defineProperty;
const realGetDesc = Object.getOwnPropertyDescriptor;
const realSetProto = Object.setPrototypeOf;
const realGetProto = Object.getPrototypeOf;
const realDelete = Reflect.deleteProperty;
const realHasOwn = Object.hasOwn;
const realFreeze = Object.freeze;
const realThen = Promise.prototype.then;
const RealPromise = Promise;
const realSetImmediate = setImmediate;
const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;
const realQueueMicrotask = queueMicrotask;
const realParse = JSON.parse;
const realStringify = JSON.stringify;
const realDispatch = EventTarget.prototype.dispatchEvent;
const realListen = EventTarget.prototype.addEventListener;
const RealEvent = Event;
const RealCustomEvent = CustomEvent;
const RealU8 = Uint8Array;
const RealWeakSet = WeakSet;
const realWeakSetHas = WeakSet.prototype.has;
const realWeakSetAdd = WeakSet.prototype.add;
const detailGetter = realGetDesc(CustomEvent.prototype, "detail")!.get!;
const typeGetter = realGetDesc(Event.prototype, "type")!.get!;
const TA = realGetProto(Uint8Array.prototype) as object;
const lengthGetter = realGetDesc(TA, "length")!.get!;
const tagGetter = realGetDesc(TA, Symbol.toStringTag)!.get!;
const realEncoder = new TextEncoder();
const realEncode = TextEncoder.prototype.encode;
const ArrayIteratorPrototype = realGetProto([][Symbol.iterator]()) as object;
const realArrayValues = Array.prototype[Symbol.iterator];
const realArrayNext = (ArrayIteratorPrototype as { next: Fn }).next;
const realStringIterator = String.prototype[Symbol.iterator];

const nullProto = <T extends object>(o: T): T => realSetProto(o, null) as T;
const data = (value: unknown) => nullProto({ value, writable: true, enumerable: true, configurable: true });
const tpush = <T>(a: T[], v: T): void => void realDefine(a, a.length, data(v));
const isU8 = (v: unknown): v is Uint8Array => v !== null && typeof v === "object" && realApply(tagGetter, v, []) === "Uint8Array";
const len = (b: Uint8Array) => realApply(lengthGetter, b, []) as number;
function tCopy(b: Uint8Array): Uint8Array {
  const n = len(b);
  const out = new RealU8(n);
  for (let i = 0; i < n; i++) out[i] = b[i];
  return out;
}
function tEq(a: Uint8Array, b: Uint8Array): boolean {
  const n = len(a);
  if (n !== len(b)) return false;
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
}
function tStarts(s: string, p: string): boolean {
  if (s.length < p.length) return false;
  for (let i = 0; i < p.length; i++) if (s[i] !== p[i]) return false;
  return true;
}
function startsAt(s: string, at: number, part: string): boolean {
  if (at + part.length > s.length) return false;
  for (let j = 0; j < part.length; j++) if (s[at + j] !== part[j]) return false;
  return true;
}
function tIncludes(s: string, part: string): boolean {
  for (let i = 0; i + part.length <= s.length; i++) if (startsAt(s, i, part)) return true;
  return false;
}
const encode = (s: string) => realApply(realEncode, realEncoder, [s]) as Uint8Array;
const ok = <T>(v: T) => new RealPromise<T>((resolve) => resolve(v));
const tick = () => new RealPromise<void>((resolve) => void realSetImmediate(resolve));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fromBase64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

// ------------------------------------------------------------------ the site's two versions of each request
const W = WALLET.toBase58();
const txBytes = (lamports: number) => buildTx([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports })]).bytes;
const ATTACK_TX = txBytes(999_000_000);
const BENIGN_TX = txBytes(1);
const ATTACK_TX_MESSAGE = transactionMessage(ATTACK_TX)!;
const BENIGN_TX_MESSAGE = transactionMessage(BENIGN_TX)!;
const ATTACK_TEXT = "Transfer all assets to the attacker!!";
const BENIGN_TEXT = "Sign in to dapp.example, nonce 12345";
const ATTACK_MSG = encode(ATTACK_TEXT);
const BENIGN_MSG = encode(BENIGN_TEXT);
const ATTACK_STATEMENT = "Approve unlimited spending of all tokens";
const BENIGN_STATEMENT = "Welcome back";
const siws = (statement: string) => createSignInMessageText({ domain: "dapp.example", address: W, statement, nonce: "abc12345" });
const ATTACK_SIWS = siws(ATTACK_STATEMENT);
const BENIGN_SIWS = siws(BENIGN_STATEMENT);
const latin1 = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
};
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
// The site's base58 text, made before the page replaces anything (its own encoder reads the replaced built-ins too).
const B58_ATTACK_MSG = bs58.encode(ATTACK_MSG);
const B58_ATTACK_TX_MESSAGE = bs58.encode(ATTACK_TX_MESSAGE);

const BYTE_PAIRS: Array<[Uint8Array, Uint8Array]> = [];
const STRING_PAIRS: Array<[string, string]> = [];
for (const [a, b] of [
  [ATTACK_TX, BENIGN_TX],
  [ATTACK_TX_MESSAGE, BENIGN_TX_MESSAGE],
  [ATTACK_MSG, BENIGN_MSG],
  [encode(ATTACK_SIWS), encode(BENIGN_SIWS)],
] as Array<[Uint8Array, Uint8Array]>) {
  BYTE_PAIRS.push([a, b], [b, a]);
  for (const f of [b64, (x: Uint8Array) => bs58.encode(x), latin1]) STRING_PAIRS.push([f(a), f(b)], [f(b), f(a)]);
}
STRING_PAIRS.push([ATTACK_TEXT, BENIGN_TEXT], [BENIGN_TEXT, ATTACK_TEXT], [ATTACK_STATEMENT, BENIGN_STATEMENT], [BENIGN_STATEMENT, ATTACK_STATEMENT], [ATTACK_SIWS, BENIGN_SIWS], [BENIGN_SIWS, ATTACK_SIWS]);

function swapBytes(v: Uint8Array): Uint8Array | null {
  for (let i = 0; i < BYTE_PAIRS.length; i++) if (tEq(v, BYTE_PAIRS[i][0])) return tCopy(BYTE_PAIRS[i][1]);
  return null;
}
function swapString(s: string): string | null {
  for (let i = 0; i < STRING_PAIRS.length; i++) if (s === STRING_PAIRS[i][0]) return STRING_PAIRS[i][1];
  return null;
}
const FIELDS = ["transaction", "message", "statement"];
/** The other version of a value the site sent (bytes, text, or an input object holding them), or the value itself. */
function swapValue(v: unknown): unknown {
  if (typeof v === "string") return swapString(v) ?? v;
  if (isU8(v)) return swapBytes(v) ?? v;
  if (v !== null && typeof v === "object" && !isU8(v)) {
    for (let k = 0; k < FIELDS.length; k++) {
      const key = FIELDS[k];
      if (!realHasOwn(v, key)) continue;
      const inner = (v as Record<string, unknown>)[key];
      const swapped = swapValue(inner);
      if (swapped !== inner) return { ...(v as object), [key]: swapped };
    }
  }
  return v;
}
const isMarker = (v: unknown) => swapValue(v) !== v;
function hasMarker(list: unknown): boolean {
  if (!Array.isArray(list)) return false;
  for (let i = 0; i < list.length; i++) if (isMarker(list[i])) return true;
  return false;
}
function swapInText(s: string): string {
  for (let i = 0; i < STRING_PAIRS.length; i++) {
    const a = STRING_PAIRS[i][0];
    const b = STRING_PAIRS[i][1];
    if (a.length <= 8 || !tIncludes(s, a)) continue;
    let out = "";
    for (let at = 0; at < s.length; ) {
      if (startsAt(s, at, a)) {
        out += b;
        at += a.length;
      } else out += s[at++];
    }
    return out;
  }
  return s;
}
const FORGED = () => nullProto({ kind: "decision", approved: true, id: "forged", rid: "forged" });
const isCancel = (v: unknown) => v !== null && typeof v === "object" && realHasOwn(v, "approved") && (v as { approved: unknown }).approved === false;

// ------------------------------------------------------------------ what the page is watching for
interface Ctx {
  leak(what: string): void;
  isRaw(o: unknown): boolean;
  isProvider(o: unknown): boolean;
  secret: string;
}
let ctx: Ctx;

function inspect(values: ArrayLike<unknown>) {
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (ctx.isRaw(v)) ctx.leak("an unwrapped wallet was passed through a replaced built-in");
    if (v !== null && typeof v === "object") {
      let type: unknown;
      try {
        type = realApply(typeGetter, v, []);
      } catch {
        type = undefined;
      }
      if (typeof type === "string" && tIncludes(type, ctx.secret)) ctx.leak(`the channel secret, in an event passed to a replaced built-in (${type})`);
    }
  }
}
/** A stolen registration callback, called with the page's own register. */
function steal(fn: unknown) {
  if (typeof fn !== "function") return;
  try {
    realApply(fn as Fn, undefined, [
      {
        register: (...wallets: unknown[]) => {
          for (let i = 0; i < wallets.length; i++) if (ctx.isRaw(wallets[i])) ctx.leak("an unwrapped wallet, through a stolen registration callback");
          return () => undefined;
        },
      },
    ]);
  } catch {
    // not a registration callback
  }
}

// ------------------------------------------------------------------ replacing built-ins
type Restore = () => void;
function replace(obj: object, key: PropertyKey, value: unknown): Restore {
  const before = realGetDesc(obj, key);
  realDefine(obj, key, nullProto({ value, writable: true, enumerable: before?.enumerable === true, configurable: true }));
  return () => (before ? realDefine(obj, key, before) : realDelete(obj, key), undefined);
}
function accessor(obj: object, key: PropertyKey, get: (this: unknown) => unknown, set?: (this: unknown, v: unknown) => void): Restore {
  const before = realGetDesc(obj, key);
  realDefine(obj, key, nullProto({ get, set: set ?? function (this: unknown, v: unknown) { realDefine(this as object, key, data(v)); }, enumerable: false, configurable: true }));
  return () => (before ? realDefine(obj, key, before) : realDelete(obj, key), undefined);
}
const realGet = Reflect.get;
/** The current value, own or inherited (Uint8Array.from lives on %TypedArray%). */
const orig = (obj: object, key: PropertyKey) => realGet(obj, key) as Fn;
const all = (...restores: Restore[]): Restore => () => {
  for (let i = restores.length - 1; i >= 0; i--) restores[i]();
};

interface Poison {
  name: string;
  install(): Restore;
}

const POISONS: Poison[] = [
  {
    name: "Map.prototype.has answers yes for the hook's keys",
    install: () => {
      const has = orig(Map.prototype, "has");
      return replace(Map.prototype, "has", function (this: unknown, k: unknown) {
        return typeof k === "string" && (tStarts(k, "t:") || tStarts(k, "m:") || tStarts(k, "id-")) ? true : realApply(has, this, [k]);
      });
    },
  },
  {
    name: "Map.prototype.set takes a pending review's resolver and approves it",
    install: () => {
      const set = orig(Map.prototype, "set");
      return replace(Map.prototype, "set", function (this: unknown, k: unknown, v: unknown) {
        if (typeof v === "function" && typeof k === "string" && tStarts(k, "id-")) realQueueMicrotask(() => realApply(v as Fn, undefined, [FORGED()]));
        return realApply(set, this, [k, v]);
      });
    },
  },
  {
    name: "WeakMap.prototype.get / has hand back the unwrapped wallet and fake sealed views",
    install: () => {
      const get = orig(WeakMap.prototype, "get");
      const has = orig(WeakMap.prototype, "has");
      return all(
        replace(WeakMap.prototype, "get", function (this: unknown, k: unknown) {
          return ctx.isRaw(k) ? k : realApply(get, this, [k]);
        }),
        replace(WeakMap.prototype, "has", function (this: unknown, k: unknown) {
          return k !== null && typeof k === "object" && realHasOwn(k, "serialize") ? true : realApply(has, this, [k]);
        }),
      );
    },
  },
  {
    name: "WeakSet.prototype.has / add pretend events and providers were already handled",
    install: () => {
      const has = orig(WeakSet.prototype, "has");
      const add = orig(WeakSet.prototype, "add");
      return all(
        replace(WeakSet.prototype, "has", function (this: unknown, v: unknown) {
          return v instanceof RealEvent || ctx.isProvider(v) ? true : realApply(has, this, [v]);
        }),
        replace(WeakSet.prototype, "add", function (this: unknown, v: unknown) {
          return v instanceof RealEvent ? this : realApply(add, this, [v]);
        }),
      );
    },
  },
  {
    name: "Set.prototype.has answers yes for signing names",
    install: () => {
      const has = orig(Set.prototype, "has");
      return replace(Set.prototype, "has", function (this: unknown, v: unknown) {
        return typeof v === "string" && (tStarts(v, "solana:") || tStarts(v, "sign")) ? true : realApply(has, this, [v]);
      });
    },
  },
  {
    name: "btoa / atob swap the request",
    install: () => {
      const btoa = orig(globalThis, "btoa");
      const atob = orig(globalThis, "atob");
      return all(
        replace(globalThis, "btoa", function (s: unknown) {
          return realApply(btoa, globalThis, [typeof s === "string" ? (swapString(s) ?? s) : s]);
        }),
        replace(globalThis, "atob", function (s: unknown) {
          const out = realApply(atob, globalThis, [s]) as string;
          return swapString(out) ?? out;
        }),
      );
    },
  },
  {
    name: "String.fromCharCode swaps the request",
    install: () => {
      const fromCharCode = orig(String, "fromCharCode");
      return replace(String, "fromCharCode", function (this: unknown) {
        // eslint-disable-next-line prefer-rest-params
        const s = realApply(fromCharCode, String, arguments as unknown as unknown[]) as string;
        return swapString(s) ?? s;
      });
    },
  },
  {
    name: "Uint8Array.from swaps the copy",
    install: () => {
      const from = orig(Uint8Array, "from");
      return replace(Uint8Array, "from", function (this: unknown) {
        // eslint-disable-next-line prefer-rest-params
        const out = realApply(from, this, arguments as unknown as unknown[]) as Uint8Array;
        return swapBytes(out) ?? out;
      });
    },
  },
  {
    name: "%TypedArray%.prototype subarray / slice / set swap the bytes",
    install: () => {
      const subarray = orig(TA, "subarray");
      const slice = orig(TA, "slice");
      const set = orig(TA, "set");
      return all(
        replace(TA, "subarray", function (this: unknown, a: unknown, b: unknown) {
          const out = realApply(subarray, this, [a, b]) as Uint8Array;
          return swapBytes(out) ?? out;
        }),
        replace(TA, "slice", function (this: unknown, a: unknown, b: unknown) {
          const out = realApply(slice, this, [a, b]) as Uint8Array;
          return swapBytes(out) ?? out;
        }),
        replace(TA, "set", function (this: unknown, src: unknown, offset: unknown) {
          return realApply(set, this, [swapValue(src), offset]);
        }),
      );
    },
  },
  {
    name: "a typed array's length accessor drops the last byte of the request",
    install: () =>
      accessor(TA, "length", function (this: unknown) {
        const n = realApply(lengthGetter, this, []) as number;
        return isMarker(this) ? n - 1 : n;
      }),
  },
  {
    name: "Array.prototype map / forEach / filter / push swap the request",
    install: () => {
      const map = orig(Array.prototype, "map");
      const forEach = orig(Array.prototype, "forEach");
      const filter = orig(Array.prototype, "filter");
      const push = orig(Array.prototype, "push");
      return all(
        replace(Array.prototype, "map", function (this: unknown[], fn: unknown, thisArg: unknown) {
          const out = realApply(map, this, [fn, thisArg]) as unknown[];
          if (hasMarker(out) || hasMarker(this)) for (let i = 0; i < out.length; i++) realDefine(out, i, data(swapValue(out[i])));
          for (let i = 0; i < out.length; i++) inspect([out[i], this[i]]);
          return out;
        }),
        replace(Array.prototype, "forEach", function (this: unknown[], fn: unknown, thisArg: unknown) {
          inspect(this);
          return realApply(forEach, this, [(v: unknown, i: number, a: unknown) => realApply(fn as Fn, thisArg, [swapValue(v), i, a]), thisArg]);
        }),
        replace(Array.prototype, "filter", function (this: unknown[], fn: unknown, thisArg: unknown) {
          const out = realApply(filter, this, [fn, thisArg]) as unknown[];
          for (let i = 0; i < out.length; i++) realDefine(out, i, data(swapValue(out[i])));
          return out;
        }),
        replace(Array.prototype, "push", function (this: unknown[]) {
          const args: unknown[] = [];
          // eslint-disable-next-line prefer-rest-params
          for (let i = 0; i < arguments.length; i++) tpush(args, swapValue(arguments[i]));
          inspect(args);
          return realApply(push, this, args);
        }),
      );
    },
  },
  {
    name: "Array.prototype every / some / includes / indexOf lie",
    install: () => {
      const every = orig(Array.prototype, "every");
      const some = orig(Array.prototype, "some");
      const includes = orig(Array.prototype, "includes");
      const indexOf = orig(Array.prototype, "indexOf");
      const looksLikeHook = (a: unknown[]) => {
        const first = a[0];
        return (typeof first === "string" && (tStarts(first, "t:") || tStarts(first, "m:") || tStarts(first, "solana:") || tStarts(first, "sign"))) || (first !== null && typeof first === "object" && (realHasOwn(first, "payload") || realHasOwn(first, "signedTransaction") || realHasOwn(first, "signedMessage")));
      };
      return all(
        replace(Array.prototype, "every", function (this: unknown[], fn: unknown, t: unknown) {
          return looksLikeHook(this) ? true : realApply(every, this, [fn, t]);
        }),
        replace(Array.prototype, "some", function (this: unknown[], fn: unknown, t: unknown) {
          return looksLikeHook(this) ? false : realApply(some, this, [fn, t]);
        }),
        replace(Array.prototype, "includes", function (this: unknown[], v: unknown, from: unknown) {
          return looksLikeHook(this) ? false : realApply(includes, this, [v, from]);
        }),
        replace(Array.prototype, "indexOf", function (this: unknown[], v: unknown, from: unknown) {
          return looksLikeHook(this) ? -1 : realApply(indexOf, this, [v, from]);
        }),
      );
    },
  },
  {
    name: "Array.prototype[Symbol.iterator] and the array iterator's next swap spread arguments",
    install: () => {
      const swapping = new WeakSet<object>();
      return all(
        replace(Array.prototype, Symbol.iterator, function (this: unknown[]) {
          inspect(this);
          const it = realApply(realArrayValues, this, []) as object;
          if (hasMarker(this)) realApply(realWeakSetAdd, swapping, [it]);
          return it;
        }),
        replace(ArrayIteratorPrototype, "next", function (this: object) {
          const r = realApply(realArrayNext, this, []) as { value: unknown; done: boolean };
          return realApply(realWeakSetHas, swapping, [this]) && !r.done ? { value: swapValue(r.value), done: false } : r;
        }),
      );
    },
  },
  {
    name: "String.prototype[Symbol.iterator] swaps base58 text",
    install: () =>
      replace(String.prototype, Symbol.iterator, function (this: string) {
        const s = swapString(String(this)) ?? this;
        return realApply(realStringIterator, s, []);
      }),
  },
  {
    name: "index accessors on Array.prototype swap what is written",
    install: () =>
      all(
        ...["0", "1"].map((k) =>
          accessor(
            Array.prototype,
            k,
            () => undefined,
            function (this: unknown, v: unknown) {
              inspect([v]);
              realDefine(this as object, k, data(swapValue(v)));
            },
          ),
        ),
      ),
  },
  {
    name: "setters on Object.prototype swap a field that is written",
    install: () =>
      all(
        ...["transaction", "message", "messages", "params", "method", "chain", "account", "requiredSigners", "statement", "resources", "serialize", "detail"].map((k) =>
          accessor(
            Object.prototype,
            k,
            () => undefined,
            function (this: unknown, v: unknown) {
              realDefine(this as object, k, data(swapValue(v)));
            },
          ),
        ),
      ),
  },
  {
    name: "getters on Object.prototype supply a missing field with the attack",
    install: () =>
      all(
        accessor(Object.prototype, "transaction", () => tCopy(ATTACK_TX)),
        accessor(Object.prototype, "messages", () => [tCopy(ATTACK_TX)]),
        accessor(Object.prototype, "statement", () => ATTACK_STATEMENT),
        accessor(Object.prototype, "chain", () => "solana:devnet"),
        accessor(Object.prototype, "verifySignature", () => async () => true),
      ),
  },
  {
    name: "Object.prototype.then answers a cancellation with an approval",
    install: () =>
      accessor(Object.prototype, "then", function (this: unknown) {
        return isCancel(this) ? (resolve: Fn) => resolve(FORGED()) : undefined;
      }),
  },
  {
    name: "Promise.prototype.then / .constructor turn a cancellation into an approval",
    install: () => {
      const then = orig(Promise.prototype, "then");
      return all(
        replace(Promise.prototype, "then", function (this: unknown, onFulfilled: unknown, onRejected: unknown) {
          return realApply(then, this, [typeof onFulfilled === "function" ? (v: unknown) => realApply(onFulfilled as Fn, undefined, [isCancel(v) ? FORGED() : v]) : onFulfilled, onRejected]);
        }),
        // Not %Promise%: `await` takes the slow path through the replaced `then`.
        replace(Promise.prototype, "constructor", {}),
      );
    },
  },
  {
    name: "the global Promise, Promise.resolve and Promise.reject turn cancellations into approvals",
    install: () => {
      class FakePromise<T> extends RealPromise<T> {
        constructor(executor: (resolve: (v: T) => void, reject: (e: unknown) => void) => void) {
          super((resolve, reject) => executor((v) => resolve((isCancel(v) ? FORGED() : v) as T), reject));
        }
      }
      const resolve = orig(RealPromise, "resolve");
      return all(
        replace(globalThis, "Promise", FakePromise),
        replace(RealPromise, "resolve", function (this: unknown, v: unknown) {
          return realApply(resolve, this, [isCancel(v) ? FORGED() : v]);
        }),
      );
    },
  },
  {
    name: "Function.prototype.call / apply watch every call",
    install: () => {
      const apply = orig(Function.prototype, "apply");
      return all(
        replace(Function.prototype, "call", function (this: Fn, thisArg: unknown, ...args: unknown[]) {
          inspect([thisArg]);
          inspect(args);
          return realApply(this, thisArg, args);
        }),
        replace(Function.prototype, "apply", function (this: Fn, thisArg: unknown, args: unknown) {
          inspect([thisArg]);
          if (args !== null && typeof args === "object") inspect(args as ArrayLike<unknown>);
          return realApply(apply, this, [thisArg, args]);
        }),
      );
    },
  },
  {
    name: "Function.prototype.bind swaps the arguments of the bound function",
    install: () =>
      replace(Function.prototype, "bind", function (this: Fn, thisArg: unknown, ...bound: unknown[]) {
        inspect([thisArg]);
        return (...args: unknown[]) => {
          const list: unknown[] = [];
          for (let i = 0; i < bound.length; i++) tpush(list, bound[i]);
          for (let i = 0; i < args.length; i++) tpush(list, swapValue(args[i]));
          inspect(list);
          return realApply(this, thisArg, list);
        };
      }),
  },
  {
    name: "Reflect.apply / Reflect.get swap and watch",
    install: () => {
      const get = orig(Reflect, "get");
      return all(
        replace(Reflect, "apply", function (fn: unknown, thisArg: unknown, args: unknown) {
          const list: unknown[] = [];
          const a = args as ArrayLike<unknown>;
          for (let i = 0; i < a.length; i++) tpush(list, swapValue(a[i]));
          inspect(list);
          return realApply(fn as Fn, thisArg, list);
        }),
        replace(Reflect, "get", function (t: unknown, k: unknown, r: unknown) {
          inspect([t, r]);
          return realApply(get, Reflect, [t, k, r]);
        }),
      );
    },
  },
  {
    name: "JSON.stringify swaps the payload in the text; JSON.parse approves a cancellation",
    install: () => {
      const stringify = orig(JSON, "stringify");
      const parse = orig(JSON, "parse");
      return all(
        replace(JSON, "stringify", function () {
          // eslint-disable-next-line prefer-rest-params
          const s = realApply(stringify, JSON, arguments as unknown as unknown[]) as string;
          return typeof s === "string" ? swapInText(s) : s;
        }),
        replace(JSON, "parse", function () {
          // eslint-disable-next-line prefer-rest-params
          const v = realApply(parse, JSON, arguments as unknown as unknown[]);
          return isCancel(v) ? FORGED() : v;
        }),
      );
    },
  },
  {
    name: "Object.prototype.toJSON swaps the review payload",
    install: () =>
      accessor(Object.prototype, "toJSON", function (this: unknown) {
        const self = this as Record<string, unknown>;
        if (self === null || typeof self !== "object" || !realHasOwn(self, "payload") || typeof self.payload !== "string") return undefined;
        return () => ({ ...self, payload: swapString(self.payload as string) ?? self.payload });
      }),
  },
  {
    name: "TextEncoder.prototype.encode swaps the text",
    install: () =>
      replace(TextEncoder.prototype, "encode", function (this: unknown, s: unknown) {
        const out = realApply(realEncode, this, [s]) as Uint8Array;
        return swapBytes(out) ?? out;
      }),
  },
  {
    name: "String.prototype startsWith / indexOf / slice / toLowerCase / padStart lie",
    install: () => {
      const indexOf = orig(String.prototype, "indexOf");
      const slice = orig(String.prototype, "slice");
      const lower = orig(String.prototype, "toLowerCase");
      return all(
        replace(String.prototype, "startsWith", () => false),
        replace(String.prototype, "indexOf", function (this: string, s: unknown, from: unknown) {
          const i = realApply(indexOf, this, [s, from]) as number;
          // The base58 alphabet: every digit decodes as its neighbour.
          return this.length === 58 && i >= 0 ? (i + 1) % 58 : i;
        }),
        replace(String.prototype, "slice", function (this: string, a: unknown, b: unknown) {
          const s = realApply(slice, this, [a, b]) as string;
          return swapString(s) ?? s;
        }),
        replace(String.prototype, "toLowerCase", function (this: string) {
          const s = realApply(lower, this, []) as string;
          return tStarts(s, "sign") ? "connect" : s;
        }),
        replace(String.prototype, "padStart", () => "00"),
      );
    },
  },
  {
    name: "RegExp.prototype test / exec never match a signing name",
    install: () => {
      const test = orig(RegExp.prototype, "test");
      const exec = orig(RegExp.prototype, "exec");
      const signing = (r: RegExp) => tIncludes(r.source, "sign") || tIncludes(r.source, "solana");
      return all(
        replace(RegExp.prototype, "test", function (this: RegExp, s: unknown) {
          return signing(this) ? false : realApply(test, this, [s]);
        }),
        replace(RegExp.prototype, "exec", function (this: RegExp, s: unknown) {
          return signing(this) ? null : realApply(exec, this, [s]);
        }),
      );
    },
  },
  {
    name: "Object.keys / entries / getOwnPropertyNames hide signing names",
    install: () => {
      const keys = orig(Object, "keys");
      const entries = orig(Object, "entries");
      const names = orig(Object, "getOwnPropertyNames");
      const hide = (k: unknown) => typeof k === "string" && (tStarts(k, "solana:") || tStarts(k, "sign"));
      const filtered = (list: unknown[]) => {
        const out: unknown[] = [];
        for (let i = 0; i < list.length; i++) if (!hide(list[i]) && !(Array.isArray(list[i]) && hide((list[i] as unknown[])[0]))) tpush(out, list[i]);
        return out;
      };
      return all(
        replace(Object, "keys", (o: unknown) => filtered(realApply(keys, Object, [o]) as unknown[])),
        replace(Object, "entries", (o: unknown) => filtered(realApply(entries, Object, [o]) as unknown[])),
        replace(Object, "getOwnPropertyNames", (o: unknown) => filtered(realApply(names, Object, [o]) as unknown[])),
      );
    },
  },
  {
    name: "Object.getOwnPropertyDescriptor / defineProperty / freeze lie",
    install: () => {
      const getDesc = orig(Object, "getOwnPropertyDescriptor");
      const define = orig(Object, "defineProperty");
      return all(
        replace(Object, "getOwnPropertyDescriptor", (o: unknown, k: unknown) => (k === "detail" || k === "serialize" || k === "features" ? undefined : realApply(getDesc, Object, [o, k]))),
        replace(Object, "defineProperty", (o: unknown, k: unknown, d: unknown) => (k === "stopPropagation" || k === "wallets" || k === "push" || k === "transaction" || k === "message" ? o : realApply(define, Object, [o, k, d]))),
        replace(Object, "freeze", (o: unknown) => o),
      );
    },
  },
  {
    name: "Event.prototype stopImmediatePropagation / stopPropagation do nothing",
    install: () => all(replace(Event.prototype, "stopImmediatePropagation", () => undefined), replace(Event.prototype, "stopPropagation", () => undefined)),
  },
  {
    name: "the global CustomEvent and CustomEvent.prototype.detail steal callbacks and the secret",
    install: () => {
      class StealingEvent<T> extends RealCustomEvent<T> {
        constructor(type: string, init?: CustomEventInit<T>) {
          super(type, init);
          inspect([this]);
          steal(init?.detail);
        }
      }
      return all(
        replace(globalThis, "CustomEvent", StealingEvent),
        accessor(CustomEvent.prototype, "detail", function (this: unknown) {
          const v = realApply(detailGetter, this, []);
          steal(v);
          return v;
        }),
      );
    },
  },
  {
    name: "EventTarget.prototype dispatchEvent / addEventListener watch the events",
    install: () => {
      const dispatch = orig(EventTarget.prototype, "dispatchEvent");
      const listen = orig(EventTarget.prototype, "addEventListener");
      return all(
        replace(EventTarget.prototype, "dispatchEvent", function (this: unknown, e: unknown) {
          inspect([e]);
          return realApply(dispatch, this, [e]);
        }),
        replace(EventTarget.prototype, "addEventListener", function (this: unknown, type: unknown, fn: unknown, o: unknown) {
          if (typeof type === "string" && tIncludes(type, ctx.secret)) ctx.leak("the channel secret, in a listener type");
          return realApply(listen, this, [type, fn, o]);
        }),
      );
    },
  },
  {
    name: "the global Proxy hands back its target",
    install: () =>
      replace(globalThis, "Proxy", function (target: unknown) {
        if (ctx.isRaw(target)) ctx.leak("an unwrapped wallet, given to the global Proxy");
        return target;
      }),
  },
  {
    name: "proxy traps on Object.prototype capture a proxy's target",
    install: () =>
      all(
        ...(["has", "ownKeys", "getOwnPropertyDescriptor", "getPrototypeOf", "defineProperty", "deleteProperty", "isExtensible", "preventExtensions", "setPrototypeOf"] as const).map((trap) =>
          replace(Object.prototype, trap, function (target: unknown, ...rest: unknown[]) {
            if (ctx.isRaw(target)) ctx.leak(`an unwrapped wallet, through a "${trap}" proxy trap`);
            return realApply(Reflect[trap] as Fn, Reflect, [target, ...rest]);
          }),
        ),
      ),
  },
  {
    name: "Date.now / Math.random / Number.prototype.toString are constant",
    install: () => all(replace(Date, "now", () => 0), replace(Math, "random", () => 0.5), replace(Number.prototype, "toString", () => "0")),
  },
];

// ------------------------------------------------------------------ the page, the wallets, the channel
class RegisterWalletEvent extends RealEvent {
  readonly #detail: unknown;
  get detail() {
    return this.#detail;
  }
  constructor(callback: unknown) {
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
class AppReadyEvent extends RealEvent {
  readonly #detail: unknown;
  get detail() {
    return this.#detail;
  }
  constructor(api: unknown) {
    super("wallet-standard:app-ready", { bubbles: false, cancelable: false, composed: false });
    this.#detail = api;
  }
  stopImmediatePropagation(): never {
    throw new Error("stopImmediatePropagation cannot be called");
  }
}

interface Logged {
  kind: string;
  value: unknown;
}

interface Env {
  win: HookWindow;
  hook: ReturnType<typeof installInterceptor>;
  secret: string;
  reviews: Array<Record<string, unknown>>;
  log: Logged[];
  leaks: string[];
  appWallets: unknown[];
  rawWallet: object;
  provider: Record<string, unknown>;
  decide(id: string, approved: boolean): void;
}

const ZEROS = () => new RealU8(64);

/** A Wallet Standard wallet that records what it was given (with the test's own built-ins). */
function hardenedWallet(log: Logged[]) {
  const account = realFreeze({ address: W, publicKey: new RealU8(32), chains: realFreeze(["solana:mainnet"]), features: realFreeze([]) });
  const record = (kind: string, value: unknown) => tpush(log, { kind, value });
  const wallet = {
    version: "1.0.0",
    name: "Hardened",
    icon: "data:image/svg+xml;base64,",
    chains: realFreeze(["solana:mainnet", "solana:devnet"]),
    accounts: realFreeze([account]),
    _internal: "wallet internals",
    features: {
      "solana:signTransaction": {
        version: "1.0.0",
        signTransaction: (...inputs: Array<{ transaction: Uint8Array; chain?: unknown }>) => {
          const out: unknown[] = [];
          for (let i = 0; i < inputs.length; i++) {
            const tx = tCopy(inputs[i].transaction);
            record("ws:signTransaction", tx);
            record("ws:signTransaction:chain", inputs[i].chain);
            const signed = tCopy(tx);
            for (let j = 1; j < 65; j++) signed[j] = 7;
            tpush(out, { signedTransaction: signed });
          }
          return ok(out);
        },
      },
      "solana:signAndSendTransaction": {
        version: "1.0.0",
        signAndSendTransaction: (...inputs: Array<{ transaction: Uint8Array }>) => {
          const out: unknown[] = [];
          for (let i = 0; i < inputs.length; i++) {
            record("ws:signAndSendTransaction", tCopy(inputs[i].transaction));
            tpush(out, { signature: ZEROS() });
          }
          return ok(out);
        },
      },
      "solana:signAndSendAllTransactions": {
        version: "1.0.0",
        signAndSendAllTransactions: (inputs: Array<{ transaction: Uint8Array }>) => {
          const out: unknown[] = [];
          for (let i = 0; i < inputs.length; i++) {
            record("ws:signAndSendAllTransactions", tCopy(inputs[i].transaction));
            tpush(out, { status: "fulfilled", value: { signature: ZEROS() } });
          }
          return ok(out);
        },
      },
      "solana:signMessage": {
        version: "1.0.0",
        signMessage: (...inputs: Array<{ message: Uint8Array }>) => {
          const out: unknown[] = [];
          for (let i = 0; i < inputs.length; i++) {
            const m = tCopy(inputs[i].message);
            record("ws:signMessage", m);
            tpush(out, { signedMessage: tCopy(m), signature: ZEROS() });
          }
          return ok(out);
        },
      },
      "solana:signOffchainMessage": {
        version: "1.0.0",
        signOffchainMessage: (...inputs: Array<{ message: string }>) => {
          const out: unknown[] = [];
          for (let i = 0; i < inputs.length; i++) {
            const text = inputs[i].message;
            record("ws:signOffchainMessage", text);
            const body = encode(`ÿsolana offchain|preamble|${text}`);
            tpush(out, { signedOffchainMessage: body, signature: ZEROS() });
          }
          return ok(out);
        },
      },
      "solana:signIn": {
        version: "1.0.0",
        signIn: (...inputs: Array<Record<string, string>>) => {
          const out: unknown[] = [];
          for (let i = 0; i < inputs.length; i++) {
            const input = inputs[i];
            const text = createSignInMessageText({ ...input, domain: input.domain ?? "dapp.example", address: input.address ?? W });
            record("ws:signIn", text);
            tpush(out, { account, signedMessage: encode(text), signature: ZEROS() });
          }
          return ok(out);
        },
      },
      "solana:signFutureThing": { version: "1.0.0", signFutureThing: () => (record("ws:signFutureThing", null), ok([])) },
      "standard:events": { version: "1.0.0", on: (_event: string, listener: (p: unknown) => void) => (record("ws:on", listener), () => undefined) },
    } as Record<string, Record<string, unknown>>,
  };
  return wallet;
}

/** An injected provider that records what it was given (with the test's own built-ins). */
function hardenedProvider(log: Logged[]): Record<string, unknown> {
  const record = (kind: string, value: unknown) => tpush(log, { kind, value });
  const serialized = (tx: unknown): Uint8Array => {
    if (isU8(tx)) return tCopy(tx);
    const serialize = (tx as { serialize: Fn }).serialize;
    return tCopy(realApply(serialize, tx, [{ requireAllSignatures: false, verifySignatures: false }]) as Uint8Array);
  };
  const Provider = class HardenedProvider {
    publicKey = { toBase58: () => W };
    signTransaction(tx: unknown) {
      record("in:signTransaction", serialized(tx));
      return ok(tx);
    }
    signAllTransactions(txs: unknown[]) {
      for (let i = 0; i < txs.length; i++) record("in:signAllTransactions", serialized(txs[i]));
      return ok(txs);
    }
    signAndSendTransaction(tx: unknown) {
      record("in:signAndSendTransaction", serialized(tx));
      return ok({ signature: "sig" });
    }
    signMessage(m: Uint8Array) {
      record("in:signMessage", tCopy(m));
      return ok({ signature: ZEROS(), publicKey: this.publicKey });
    }
    signIn(input: Record<string, string>) {
      const text = createSignInMessageText({ ...input, domain: input.domain ?? "dapp.example", address: W });
      record("in:signIn", text);
      return ok({ address: W, signedMessage: encode(text), signature: ZEROS() });
    }
    signOffchainThing() {
      record("in:signOffchainThing", null);
      return ok({});
    }
    request(args: { method: string; params?: Record<string, unknown> }) {
      record(`in:request:${args.method}`, args.params ? (args.params.message ?? args.params.messages ?? null) : null);
      return ok({ ok: true });
    }
  };
  return new Provider() as unknown as Record<string, unknown>;
}

const rawWallets = new RealWeakSet<object>();
const providers = new RealWeakSet<object>();

/** The hook, installed at document_start: before any page script. */
function environment(): Env {
  const doc = new EventTarget();
  const win = new EventTarget() as HookWindow;
  const secret = randomHex(16);
  const reviews: Array<Record<string, unknown>> = [];
  const log: Logged[] = [];
  const leaks: string[] = [];
  const transport = pageTransport({ doc, secret, dispatch: realDispatch, listen: realListen, CustomEvent: RealCustomEvent, detailOf: detailGetter });
  let n = 0;
  const reviewer = createReviewer({
    ready: () => true,
    send: transport.send,
    newId: () => `id-${++n}`,
    timeoutMs: 60_000,
    setTimer: (fn, ms) => realSetTimeout(fn, ms),
    clearTimer: (t) => realClearTimeout(t as ReturnType<typeof setTimeout>),
  });
  transport.onMessage(reviewer.settle);
  // The content script's side (an isolated world in the browser: its own built-ins).
  realApply(realListen, doc, [
    `presign:${secret}:to-content`,
    (e: Event) => {
      const m = realParse(realApply(detailGetter, e, []) as string) as Record<string, unknown>;
      if (m.kind === "review") tpush(reviews, m);
    },
  ]);
  const hook = installInterceptor(win, { review: reviewer.review, report: () => undefined, host: () => "dapp.example" });
  const rawWallet = hardenedWallet(log);
  realApply(realWeakSetAdd, rawWallets, [rawWallet]);
  const provider = hardenedProvider(log);
  realApply(realWeakSetAdd, providers, [provider]);
  realApply(realWeakSetAdd, providers, [realGetProto(provider) as object]);
  return {
    win,
    hook,
    secret,
    reviews,
    log,
    leaks,
    appWallets: [],
    rawWallet,
    provider,
    decide(id, approved) {
      const text = `{"kind":"decision","id":${realStringify(id)},"approved":${approved ? "true" : "false"}${approved ? `,"rid":"rid-${id}"` : `,"reason":"you cancelled"`}}`;
      realApply(realDispatch, doc, [new RealCustomEvent(`presign:${secret}:to-page`, nullProto({ detail: text }))]);
    },
  };
}

/** The page's own start-up, after its scripts replaced built-ins: the app, then the wallet registering, then the provider scan. */
function connect(env: Env) {
  const api = realFreeze({
    register: (...wallets: unknown[]) => {
      for (let i = 0; i < wallets.length; i++) tpush(env.appWallets, wallets[i]);
      return () => undefined;
    },
  });
  realApply(realListen, env.win, ["wallet-standard:register-wallet", (e: Event) => steal2((e as unknown as { detail: unknown }).detail, api)]);
  realApply(realDispatch, env.win, [new AppReadyEvent(api)]);
  const callback = ({ register }: { register: Fn }) => register(env.rawWallet);
  realApply(realDispatch, env.win, [new RegisterWalletEvent(callback)]);
  realApply(realListen, env.win, ["wallet-standard:app-ready", (e: Event) => callback((e as unknown as { detail: { register: Fn } }).detail)]);
  env.hook.patchProvider(env.provider, "Hardened");
  // The page probing the wallet it received.
  const w = env.appWallets[0];
  if (w && typeof w === "object") {
    try {
      if ("features" in w) void Object.keys(w);
      const d = Object.getOwnPropertyDescriptor(w, "features");
      if (d && ctx.isRaw(d.value)) ctx.leak("an unwrapped wallet's features, through a property descriptor");
      const proto = Object.getPrototypeOf(w);
      if (proto && proto !== Object.prototype) ctx.leak("the wallet's own prototype");
      if ((w as Record<string, unknown>)._internal !== undefined) ctx.leak("the wallet's internal fields");
    } catch {
      // a frozen wrapper
    }
  }
}
function steal2(detail: unknown, api: unknown) {
  if (typeof detail === "function") realApply(detail as Fn, undefined, [api]);
}

interface Entry {
  name: string;
  logKind: string;
  /** Never reaches the wallet, whatever the user decides (Presign does not review it). */
  refused?: boolean;
  start(env: Env, w: Record<string, Record<string, Record<string, Fn>>>): unknown;
  expected: Uint8Array;
  /** The bytes that identify the request, from the review payload / from what the wallet received. */
  fromReview(payload: Uint8Array): Uint8Array;
  fromWallet(value: unknown): Uint8Array;
}
const asMessage = (b: Uint8Array) => transactionMessage(b) ?? b;
const ENTRIES: Entry[] = [
  { name: "Wallet Standard signTransaction", logKind: "ws:signTransaction", start: (_, w) => w.features["solana:signTransaction"].signTransaction({ transaction: tCopy(ATTACK_TX), account: { address: W }, chain: "solana:mainnet" }), expected: ATTACK_TX_MESSAGE, fromReview: asMessage, fromWallet: (v) => asMessage(v as Uint8Array) },
  { name: "Wallet Standard signAndSendTransaction", logKind: "ws:signAndSendTransaction", start: (_, w) => w.features["solana:signAndSendTransaction"].signAndSendTransaction({ transaction: tCopy(ATTACK_TX), account: { address: W }, chain: "solana:mainnet" }), expected: ATTACK_TX_MESSAGE, fromReview: asMessage, fromWallet: (v) => asMessage(v as Uint8Array) },
  { name: "Wallet Standard signAndSendAllTransactions", logKind: "ws:signAndSendAllTransactions", start: (_, w) => w.features["solana:signAndSendAllTransactions"].signAndSendAllTransactions([{ transaction: tCopy(ATTACK_TX), account: { address: W }, chain: "solana:mainnet" }], { mode: "serial" }), expected: ATTACK_TX_MESSAGE, fromReview: asMessage, fromWallet: (v) => asMessage(v as Uint8Array) },
  { name: "Wallet Standard signMessage", logKind: "ws:signMessage", start: (_, w) => w.features["solana:signMessage"].signMessage({ message: tCopy(ATTACK_MSG), account: { address: W } }), expected: ATTACK_MSG, fromReview: (b) => b, fromWallet: (v) => v as Uint8Array },
  { name: "Wallet Standard signOffchainMessage", logKind: "ws:signOffchainMessage", start: (_, w) => w.features["solana:signOffchainMessage"].signOffchainMessage({ message: ATTACK_TEXT, account: { address: W }, requiredSigners: [] }), expected: ATTACK_MSG, fromReview: (b) => b, fromWallet: (v) => new TextEncoder().encode(v as string) },
  { name: "Wallet Standard signIn", logKind: "ws:signIn", start: (_, w) => w.features["solana:signIn"].signIn({ statement: ATTACK_STATEMENT, nonce: "abc12345" }), expected: encode(ATTACK_SIWS), fromReview: (b) => b, fromWallet: (v) => new TextEncoder().encode(v as string) },
  { name: "injected signTransaction (bytes)", logKind: "in:signTransaction", start: (env) => (env.provider.signTransaction as Fn)(tCopy(ATTACK_TX)), expected: ATTACK_TX_MESSAGE, fromReview: asMessage, fromWallet: (v) => asMessage(v as Uint8Array) },
  { name: "injected signTransaction (transaction object)", logKind: "in:signTransaction", start: (env) => (env.provider.signTransaction as Fn)({ serialize: () => tCopy(ATTACK_TX) }), expected: ATTACK_TX_MESSAGE, fromReview: asMessage, fromWallet: (v) => asMessage(v as Uint8Array) },
  { name: "injected signAllTransactions", logKind: "in:signAllTransactions", start: (env) => (env.provider.signAllTransactions as Fn)([tCopy(ATTACK_TX)]), expected: ATTACK_TX_MESSAGE, fromReview: asMessage, fromWallet: (v) => asMessage(v as Uint8Array) },
  { name: "injected signAndSendTransaction", logKind: "in:signAndSendTransaction", start: (env) => (env.provider.signAndSendTransaction as Fn)(tCopy(ATTACK_TX)), expected: ATTACK_TX_MESSAGE, fromReview: asMessage, fromWallet: (v) => asMessage(v as Uint8Array) },
  { name: "injected signMessage", logKind: "in:signMessage", start: (env) => (env.provider.signMessage as Fn)(tCopy(ATTACK_MSG)), expected: ATTACK_MSG, fromReview: (b) => b, fromWallet: (v) => v as Uint8Array },
  { name: "injected signIn", logKind: "in:signIn", start: (env) => (env.provider.signIn as Fn)({ statement: ATTACK_STATEMENT, nonce: "abc12345" }), expected: encode(ATTACK_SIWS), fromReview: (b) => b, fromWallet: (v) => new TextEncoder().encode(v as string) },
  { name: "injected request({ method: 'signMessage' }) with base58 text", logKind: "in:request:signMessage", start: (env) => (env.provider.request as Fn)({ method: "signMessage", params: { message: B58_ATTACK_MSG } }), expected: ATTACK_MSG, fromReview: (b) => b, fromWallet: (v) => bs58.decode(v as string) },
  { name: "injected request({ method: 'signTransaction' }) with a base58 message", logKind: "in:request:signTransaction", start: (env) => (env.provider.request as Fn)({ method: "signTransaction", params: { message: B58_ATTACK_TX_MESSAGE } }), expected: ATTACK_TX_MESSAGE, fromReview: asMessage, fromWallet: (v) => asMessage(asTransactionBytes(bs58.decode(v as string))!) },
  { name: "an unknown Wallet Standard signing feature", logKind: "ws:signFutureThing", refused: true, start: (_, w) => w.features["solana:signFutureThing"].signFutureThing(), expected: new Uint8Array(), fromReview: (b) => b, fromWallet: () => new Uint8Array() },
  { name: "an unknown injected signing method", logKind: "in:signOffchainThing", refused: true, start: (env) => (env.provider.signOffchainThing as Fn)(), expected: new Uint8Array(), fromReview: (b) => b, fromWallet: () => new Uint8Array() },
  { name: "an unknown signing method through request()", logKind: "in:request:signSomethingNew", refused: true, start: (env) => (env.provider.request as Fn)({ method: "signSomethingNew", params: { message: B58_ATTACK_MSG } }), expected: new Uint8Array(), fromReview: (b) => b, fromWallet: () => new Uint8Array() },
];

interface Run {
  state: "pending" | "resolved" | "rejected";
  value: unknown;
  env: Env;
}

/** Hook first, then the page's replaced built-ins, then the page starts and calls; the user decides every review. */
async function run(poison: Poison | null, entry: Entry, approve: boolean): Promise<Run> {
  const env = environment();
  ctx = {
    leak: (what) => tpush(env.leaks, what),
    isRaw: (o) => o !== null && typeof o === "object" && (realApply(realWeakSetHas, rawWallets, [o]) as boolean),
    isProvider: (o) => o !== null && typeof o === "object" && (realApply(realWeakSetHas, providers, [o]) as boolean),
    secret: env.secret,
  };
  const restore = poison ? poison.install() : () => undefined;
  const result: Run = { state: "pending", value: undefined, env };
  try {
    try {
      connect(env);
      for (let i = 0; i < env.appWallets.length; i++) if (ctx.isRaw(env.appWallets[i])) ctx.leak("the app received an unwrapped wallet");
      const w = env.appWallets[0] as Record<string, Record<string, Record<string, Fn>>>;
      const p = entry.start(env, w);
      try {
        realApply(realThen, p, [
          (v: unknown) => ((result.state = "resolved"), (result.value = v)),
          (e: unknown) => ((result.state = "rejected"), (result.value = e)),
        ]);
      } catch {
        result.state = "resolved";
        result.value = p;
      }
    } catch (error) {
      result.state = "rejected";
      result.value = error;
    }
    let handled = 0;
    for (let i = 0; i < 60 && result.state === "pending"; i++) {
      await tick();
      while (handled < env.reviews.length) {
        const r = env.reviews[handled++];
        env.decide(r.id as string, approve);
      }
    }
  } finally {
    restore();
  }
  return result;
}

function check(r: Run, entry: Entry, approve: boolean) {
  const { env } = r;
  expect(env.leaks).toEqual([]);
  const calls = env.log.filter((l) => l.kind === entry.logKind);
  if (entry.refused) {
    expect(calls, "a request Presign does not review reached the wallet").toEqual([]);
    expect(r.state).not.toBe("resolved");
    return;
  }
  expect(env.reviews.length, "the request was never shown for review").toBeGreaterThan(0);
  const reviewedPayload = env.reviews[0].request as { payload: string | null };
  expect(typeof reviewedPayload.payload).toBe("string");
  // What the user saw is exactly what the site sent.
  expect(hex(entry.fromReview(fromBase64(reviewedPayload.payload!)))).toBe(hex(entry.expected));
  if (!approve) {
    expect(calls, "the wallet was asked although the user cancelled").toEqual([]);
    expect(r.state).toBe("rejected");
    return;
  }
  expect(r.state, `approved, but the site got: ${String(r.value)}`).toBe("resolved");
  expect(calls).toHaveLength(1);
  // What the wallet signed is exactly what the user saw.
  expect(hex(entry.fromWallet(calls[0].value))).toBe(hex(entry.expected));
}

afterEach(() => {
  // Every replaced built-in is back.
  expect(Promise.prototype.then).toBe(realThen);
  expect(Object.getOwnPropertyDescriptor(Object.prototype, "then")).toBeUndefined();
});

describe("a page that replaces built-ins after the hook loaded cannot change, skip or approve a review", () => {
  it("baseline: without a replaced built-in every entry point behaves", async () => {
    for (const entry of ENTRIES) {
      for (const approve of [false, true]) check(await run(null, entry, approve), entry, approve);
    }
  });

  for (const poison of POISONS) {
    it(poison.name, async () => {
      for (const entry of ENTRIES) {
        for (const approve of [false, true]) {
          const r = await run(poison, entry, approve);
          try {
            check(r, entry, approve);
          } catch (error) {
            throw new Error(`${entry.name}, user ${approve ? "approves" : "cancels"}: ${(error as Error).message}`);
          }
        }
      }
    });
  }

  it("all of them at once", async () => {
    const together: Poison = {
      name: "all",
      install: () => all(...POISONS.map((p) => p.install())),
    };
    for (const entry of ENTRIES) {
      for (const approve of [false, true]) {
        const r = await run(together, entry, approve);
        try {
          check(r, entry, approve);
        } catch (error) {
          throw new Error(`${entry.name}, user ${approve ? "approves" : "cancels"}: ${(error as Error).message}`);
        }
      }
    }
  });
});

describe("accessors on the site's own objects cannot show Presign one request and the wallet another", () => {
  /** A site object whose `key` answers `first` on the first read and `later` on every other. */
  function twoFaced<T extends object>(base: T, key: string, first: unknown, later: unknown): T {
    // Descriptors, not a spread: a spread would read (and use up) an accessor already on `base`.
    const o = Object.defineProperties({}, Object.getOwnPropertyDescriptors(base));
    let reads = 0;
    return Object.defineProperty(o, key, { get: () => (reads++ === 0 ? first : later), enumerable: true, configurable: true }) as T;
  }

  it("request(): a method that reads 'connect' first and 'signTransaction' later is never sent unreviewed", async () => {
    const env = environment();
    ctx = { leak: (w) => tpush(env.leaks, w), isRaw: () => false, isProvider: () => false, secret: env.secret };
    connect(env);
    const args = twoFaced({ params: { message: bs58.encode(ATTACK_TX_MESSAGE) } }, "method", "connect", "signTransaction");
    await (env.provider.request as Fn)(args);
    expect(env.log.map((l) => l.kind)).toEqual(["in:request:connect"]);
  });

  it("Wallet Standard: a transaction / chain / statement accessor gives the wallet what Presign reviewed", async () => {
    for (const approve of [true]) {
      const env = environment();
      ctx = { leak: (w) => tpush(env.leaks, w), isRaw: () => false, isProvider: () => false, secret: env.secret };
      connect(env);
      const w = env.appWallets[0] as Record<string, Record<string, Record<string, Fn>>>;
      const tx = twoFaced(twoFaced({ account: { address: W } }, "transaction", tCopy(BENIGN_TX), tCopy(ATTACK_TX)), "chain", "solana:devnet", "solana:mainnet");
      const signing = w.features["solana:signTransaction"].signTransaction(tx) as Promise<unknown>;
      const siwsInput = twoFaced({ nonce: "abc12345" }, "statement", BENIGN_STATEMENT, ATTACK_STATEMENT);
      const signingIn = w.features["solana:signIn"].signIn(siwsInput) as Promise<unknown>;
      let handled = 0;
      for (let i = 0; i < 20; i++) {
        await tick();
        while (handled < env.reviews.length) env.decide(env.reviews[handled++].id as string, approve);
      }
      await Promise.allSettled([signing, signingIn]);
      const signed = env.log.find((l) => l.kind === "ws:signTransaction")!.value as Uint8Array;
      expect(hex(transactionMessage(signed)!)).toBe(hex(BENIGN_TX_MESSAGE));
      // The cluster the review simulated on is the one the wallet signs for.
      const reviewedTx = env.reviews.find((r) => (r.request as { method: string }).method === "signTransaction")!.request as { chain: string };
      expect(reviewedTx.chain).toBe("solana:devnet");
      expect(env.log.find((l) => l.kind === "ws:signTransaction:chain")!.value).toBe("solana:devnet");
      expect(env.log.find((l) => l.kind === "ws:signIn")!.value).toBe(BENIGN_SIWS);
    }
  });

  it("injected: a transaction object whose serialize is locked and two-faced cannot make the wallet sign other bytes", async () => {
    const env = environment();
    ctx = { leak: (w) => tpush(env.leaks, w), isRaw: () => false, isProvider: () => false, secret: env.secret };
    connect(env);
    let reads = 0;
    const liar = {};
    Object.defineProperty(liar, "serialize", { value: () => tCopy(reads++ === 0 ? BENIGN_TX : ATTACK_TX), writable: false, configurable: false, enumerable: true });
    const signing = ((env.provider.signTransaction as Fn)(liar) as Promise<unknown>).catch(() => undefined);
    for (let i = 0; i < 20; i++) {
      await tick();
      for (const r of env.reviews.splice(0)) env.decide(r.id as string, true);
    }
    await signing;
    // The wallet either signed the reviewed bytes or could not read the transaction at all.
    for (const l of env.log.filter((x) => x.kind === "in:signTransaction")) expect(hex(transactionMessage(l.value as Uint8Array)!)).toBe(hex(BENIGN_TX_MESSAGE));
  });
});

describe("the wallet the site receives exposes only wrapped signing methods", () => {
  it("not through a property descriptor, the prototype, internal fields or a 'change' event", () => {
    const env = environment();
    ctx = { leak: (w) => tpush(env.leaks, w), isRaw: (o) => o !== null && typeof o === "object" && (realApply(realWeakSetHas, rawWallets, [o]) as boolean), isProvider: () => false, secret: env.secret };
    connect(env);
    const w = env.appWallets[0] as Record<string, unknown>;
    const raw = env.rawWallet as unknown as { features: Record<string, Record<string, Fn>> };
    expect(w).not.toBe(raw);
    const descriptor = Object.getOwnPropertyDescriptor(w, "features");
    const viaDescriptor = (descriptor?.value ?? descriptor?.get?.call(w)) as Record<string, Record<string, Fn>>;
    expect(viaDescriptor["solana:signTransaction"].signTransaction).not.toBe(raw.features["solana:signTransaction"].signTransaction);
    expect(Object.getPrototypeOf(w)).toBe(Object.prototype);
    expect(w._internal).toBeUndefined();
    // A wallet announcing new features: the listener gets them wrapped.
    const features = w.features as Record<string, Record<string, Fn>>;
    let announced: Record<string, Record<string, Fn>> | null = null;
    features["standard:events"].on("change", (p: unknown) => (announced = (p as { features: Record<string, Record<string, Fn>> }).features));
    const listener = env.log.find((l) => l.kind === "ws:on")!.value as Fn;
    listener({ features: raw.features });
    expect(announced).not.toBeNull();
    expect(announced!["solana:signTransaction"].signTransaction).not.toBe(raw.features["solana:signTransaction"].signTransaction);
    expect(announced!["solana:signFutureThing"].signFutureThing).not.toBe(raw.features["solana:signFutureThing"].signFutureThing);
    expect(env.leaks).toEqual([]);
  });
});

describe("the channel", () => {
  it("review ids stay unpredictable and distinct when Date / Math.random / Number.prototype.toString are replaced", () => {
    const restore = POISONS.find((p) => p.name.startsWith("Date.now"))!.install();
    let a: string;
    let b: string;
    try {
      a = randomHex(12);
      b = randomHex(12);
    } finally {
      restore();
    }
    expect(a).toMatch(/^[0-9a-f]{24}$/);
    expect(a).not.toBe(b);
  });

  it("a second review under an id that is still pending is refused, never merged", async () => {
    const sent: unknown[] = [];
    const reviewer = createReviewer({ ready: () => true, send: (m) => void sent.push(m), newId: () => "same", timeoutMs: 60_000, setTimer: () => 0, clearTimer: () => undefined });
    const first = reviewer.review({ type: "MESSAGE", payload: "aGVsbG8=", walletAddress: null, chain: null, method: "signMessage", walletName: null, index: 1, total: 1 });
    const second = await reviewer.review({ type: "MESSAGE", payload: "d29ybGQ=", walletAddress: null, chain: null, method: "signMessage", walletName: null, index: 1, total: 1 });
    expect(second).toMatchObject({ approved: false });
    expect(sent).toHaveLength(1);
    reviewer.settle({ kind: "decision", id: "same", approved: true });
    expect(await first).toMatchObject({ approved: true });
  });
});
