/**
 * Built-ins captured when the page hook loads.
 *
 * The page hook runs in the website's own JavaScript world (MAIN), so a site
 * can replace any built-in there after the hook has loaded:
 * Map.prototype.has, btoa, Function.prototype.call,
 * Array.prototype[Symbol.iterator], Promise.prototype.then, the global
 * Promise or Proxy, a setter, getter or `then` added to Object.prototype…
 * Any of them, looked up while a request is handled, lets the site change
 * what Presign reviews, what the wallet receives, or which decision the hook
 * acts on.
 *
 * Everything below is captured when this module is evaluated: document_start,
 * before any site script. The hook's security path (capture the bytes → ask
 * for a review → act on the decision → call the wallet) uses only these
 * captured functions, index loops, records without a prototype and
 * typed-array indexing. None of these is a lookup a site can redirect:
 *  - integer indexing of a typed array never reaches a prototype;
 *  - characters and length of a primitive string are its own properties;
 *  - a record created with no prototype has nothing to inherit;
 *  - static built-ins (Object.keys, Reflect.apply, …) are called through the
 *    captured function, prototype methods through Reflect.apply.
 */

const R = Reflect;
const O = Object;

export const ReflectApply = R.apply;
export const ReflectGet = R.get;
export const ObjectCreate = O.create;
export const ObjectFreeze = O.freeze;
export const ObjectKeys = O.keys;
export const ObjectGetOwnPropertyNames = O.getOwnPropertyNames;
export const ObjectGetOwnPropertyDescriptor = O.getOwnPropertyDescriptor;
export const ObjectGetPrototypeOf = O.getPrototypeOf;
export const ObjectDefineProperty = O.defineProperty;
export const ObjectPrototype = O.prototype;
const ObjectSetPrototypeOf = O.setPrototypeOf;
const ObjectHasOwn = O.hasOwn;
export const ArrayIsArray = Array.isArray;
const JSONStringify = JSON.stringify;
export const JSONParse = JSON.parse;
const U8 = Uint8Array;
export const NativePromise = Promise;
export const NativeProxy = Proxy;
const NativeTypeError = TypeError;
const promiseThen = Promise.prototype.then;
const weakMapGet = WeakMap.prototype.get;
const weakMapSet = WeakMap.prototype.set;
const weakMapHas = WeakMap.prototype.has;
const weakSetHas = WeakSet.prototype.has;
const weakSetAdd = WeakSet.prototype.add;
const accessor = (proto: object, name: PropertyKey) => ObjectGetOwnPropertyDescriptor(proto, name)?.get;
const typedArrayPrototype = ObjectGetPrototypeOf(U8.prototype) as object;
const taLength = accessor(typedArrayPrototype, "length")!;
const taBuffer = accessor(typedArrayPrototype, "buffer")!;
const taByteOffset = accessor(typedArrayPrototype, "byteOffset")!;
const taByteLength = accessor(typedArrayPrototype, "byteLength")!;
const taTag = accessor(typedArrayPrototype, Symbol.toStringTag)!;
const dvBuffer = accessor(DataView.prototype, "buffer")!;
const dvByteOffset = accessor(DataView.prototype, "byteOffset")!;
const dvByteLength = accessor(DataView.prototype, "byteLength")!;
const abByteLength = accessor(ArrayBuffer.prototype, "byteLength")!;
const encoder = typeof TextEncoder === "function" ? new TextEncoder() : null;
const encode = encoder ? TextEncoder.prototype.encode : null;
const cryptoObject = (globalThis as { crypto?: Crypto }).crypto;
const getRandomValues = cryptoObject?.getRandomValues;

// ------------------------------------------------------------------ objects

/** `o` without a prototype: no key read or written on it can reach a property a site added to Object.prototype. */
export const bare = <T extends object>(o: T): T => ObjectSetPrototypeOf(o, null) as T;

/** Own data property, defined (not assigned): a setter a site put on a prototype is never called. */
export function setOwn(o: object, key: PropertyKey, value: unknown): void {
  ObjectDefineProperty(o, key, bare({ value, writable: true, enumerable: true, configurable: true }));
}

export const hasOwn = (o: object, key: PropertyKey): boolean => ObjectHasOwn(o, key);

/** `o[key]` only when it is `o`'s own property (a site cannot supply a missing field through Object.prototype). */
export function own(o: unknown, key: PropertyKey): unknown {
  return o !== null && typeof o === "object" && ObjectHasOwn(o, key) ? (o as Record<PropertyKey, unknown>)[key] : undefined;
}

/**
 * A shallow snapshot of a site object, read once. Each field Presign uses is
 * then pinned with `pin`, so the wallet reads the same value Presign reviewed
 * (an accessor cannot answer Presign one way and the wallet another).
 */
export function snapshot(o: unknown): Record<string, unknown> | null {
  return o !== null && typeof o === "object" ? { ...(o as Record<string, unknown>) } : null;
}

/** Reads `key` from a snapshot once and makes that value its own property. */
export function pin(o: Record<string, unknown>, key: string): unknown {
  const v = o[key];
  setOwn(o, key, v);
  return v;
}

// ------------------------------------------------------------------ arrays

/** Appends without Array.prototype.push and without a setter on Array.prototype. */
export function push<T>(list: T[], value: T): void {
  ObjectDefineProperty(list, list.length, bare({ value, writable: true, enumerable: true, configurable: true }));
}

/** list.map(fn), with an index loop and own elements. */
export function mapList<T, U>(list: ArrayLike<T>, fn: (value: T, index: number) => U): U[] {
  const out: U[] = [];
  const n = list.length;
  for (let i = 0; i < n; i++) push(out, fn(list[i], i));
  return out;
}

/** [first, ...rest] */
export function prepend<T>(first: T, rest: ArrayLike<T>): T[] {
  const out: T[] = [first];
  for (let i = 0; i < rest.length; i++) push(out, rest[i]);
  return out;
}

/** A copy of a site array (elements read once), or [] for anything else. */
export const copyList = (v: unknown): unknown[] => (ArrayIsArray(v) ? mapList(v as unknown[], (x) => x) : []);

// ------------------------------------------------------------------ weak collections

export const weakGet = <K extends object, V>(m: WeakMap<K, V>, k: K): V | undefined => ReflectApply(weakMapGet, m, [k]) as V | undefined;
export const weakSet = <K extends object, V>(m: WeakMap<K, V>, k: K, v: V): void => void ReflectApply(weakMapSet, m, [k, v]);
export const weakHas = <K extends object>(m: WeakMap<K, unknown>, k: K): boolean => ReflectApply(weakMapHas, m, [k]) as boolean;
export const weakSetHasValue = <K extends object>(s: WeakSet<K>, k: K): boolean => ReflectApply(weakSetHas, s, [k]) as boolean;
export const weakSetAddValue = <K extends object>(s: WeakSet<K>, k: K): void => void ReflectApply(weakSetAdd, s, [k]);

// ------------------------------------------------------------------ strings

/** s.startsWith(prefix) on primitive strings. */
export function startsWith(s: string, prefix: string): boolean {
  if (s.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (s[i] !== prefix[i]) return false;
  return true;
}

const TO_LOWER: Record<string, string> = bare({});
for (let i = 0; i < 26; i++) TO_LOWER["ABCDEFGHIJKLMNOPQRSTUVWXYZ"[i]] = "abcdefghijklmnopqrstuvwxyz"[i];
const lower = (c: string): string => TO_LOWER[c] ?? c;

/** /^sign/i.test(s) */
export const startsWithSign = (s: string): boolean => s.length >= 4 && lower(s[0]) === "s" && lower(s[1]) === "i" && lower(s[2]) === "g" && lower(s[3]) === "n";

/** /sign/i.test(s) */
export function containsSign(s: string): boolean {
  for (let i = 0; i + 4 <= s.length; i++) if (lower(s[i]) === "s" && lower(s[i + 1]) === "i" && lower(s[i + 2]) === "g" && lower(s[i + 3]) === "n") return true;
  return false;
}

/** /<word>/i.test(s) for a lower-case word. */
export function containsWord(s: string, word: string): boolean {
  for (let i = 0; i + word.length <= s.length; i++) {
    let hit = true;
    for (let j = 0; j < word.length && hit; j++) hit = lower(s[i + j]) === word[j];
    if (hit) return true;
  }
  return false;
}

/** UTF-8 bytes of a primitive string. */
export function utf8(s: string): Uint8Array {
  if (!encoder || !encode) throw new NativeTypeError("TextEncoder is not available");
  return ReflectApply(encode, encoder, [s]) as Uint8Array;
}

// ------------------------------------------------------------------ bytes

/** Length of a typed array, from the captured accessor (a site can redefine `length` on the prototype). */
export const byteCount = (b: Uint8Array): number => ReflectApply(taLength, b, []) as number;

function isDataView(v: object): boolean {
  try {
    ReflectApply(dvByteLength, v, []);
    return true;
  } catch {
    return false;
  }
}

function isArrayBuffer(v: object): boolean {
  try {
    ReflectApply(abByteLength, v, []);
    return true;
  } catch {
    return false;
  }
}

/** new Uint8Array(n), from the captured constructor. */
export const newBytes = (n: number): Uint8Array<ArrayBuffer> => new U8(n);

/** A private copy of `b[start, end)`. */
export function copyRange(b: Uint8Array, start: number, end: number): Uint8Array<ArrayBuffer> {
  const n = end > start ? end - start : 0;
  const out = new U8(n);
  for (let i = 0; i < n; i++) out[i] = b[start + i];
  return out;
}

/** A private copy of a Uint8Array. */
export const copyOf = (b: Uint8Array): Uint8Array<ArrayBuffer> => copyRange(b, 0, byteCount(b));

/**
 * A private copy of the bytes in `value` (any typed array or DataView: the
 * bytes it views; an ArrayBuffer; an array of byte values), read once.
 * Recognized by internal slots, never by `instanceof` or a prototype method.
 */
export function bytesFrom(value: unknown): Uint8Array | null {
  if (value === null || typeof value !== "object") return null;
  if (ReflectApply(taTag, value, []) !== undefined) {
    const view = new U8(ReflectApply(taBuffer, value, []) as ArrayBuffer, ReflectApply(taByteOffset, value, []) as number, ReflectApply(taByteLength, value, []) as number);
    return copyOf(view);
  }
  if (isDataView(value)) {
    const view = new U8(ReflectApply(dvBuffer, value, []) as ArrayBuffer, ReflectApply(dvByteOffset, value, []) as number, ReflectApply(dvByteLength, value, []) as number);
    return copyOf(view);
  }
  if (isArrayBuffer(value)) return copyOf(new U8(value as ArrayBuffer));
  if (ArrayIsArray(value)) {
    const list = value as unknown[];
    const n = list.length;
    if (typeof n !== "number" || n < 0 || n > 0x4000000) return null;
    const out = new U8(n);
    for (let i = 0; i < n; i++) {
      const b = list[i];
      if (typeof b !== "number" || b !== (b | 0) || b < 0 || b > 255) return null;
      out[i] = b;
    }
    return out;
  }
  return null;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 with padding, without btoa / String.fromCharCode. */
export function base64(bytes: Uint8Array): string {
  const n = byteCount(bytes);
  let s = "";
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    s += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
  }
  if (i < n) {
    const two = i + 1 < n;
    const v = (bytes[i] << 16) | (two ? bytes[i + 1] << 8 : 0);
    s += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + (two ? B64[(v >> 6) & 63] : "=") + "=";
  }
  return s;
}

const HEX = "0123456789abcdef";

/** Hex of fresh random bytes (crypto.getRandomValues captured at load). */
export function randomHex(byteLength: number): string {
  if (!cryptoObject || !getRandomValues) throw new NativeTypeError("crypto.getRandomValues is not available");
  const b = new U8(byteLength);
  ReflectApply(getRandomValues, cryptoObject, [b]);
  let s = "";
  for (let i = 0; i < byteLength; i++) s += HEX[b[i] >> 4] + HEX[b[i] & 15];
  return s;
}

// ------------------------------------------------------------------ promises

/**
 * p.then(ok, fail) with the captured `then`: for a native promise, the
 * callbacks get the value it really settled with — a site that replaced
 * Promise.prototype.then, .constructor or Object.prototype.then cannot
 * substitute it. `await` and `.then` both look those up; the hook's security
 * path never uses them.
 *
 * `strict` (a review decision): anything but a native promise fails, and so
 * does a `then` a site made throw (a hostile species constructor). Otherwise
 * (a wallet's result) a value that is not a native promise is the value.
 */
export function settle<T>(p: unknown, ok: (value: T) => void, fail: (error: unknown) => void, strict = false): void {
  let once = false;
  const okOnce = (v: T) => {
    if (once) return;
    once = true;
    ok(v);
  };
  const failOnce = (e: unknown) => {
    if (once) return;
    once = true;
    fail(e);
  };
  if (p === null || (typeof p !== "object" && typeof p !== "function")) return strict ? failOnce(new NativeTypeError("not a promise")) : okOnce(p as T);
  try {
    ReflectApply(promiseThen, p, [okOnce, failOnce]);
  } catch (error) {
    if (strict) failOnce(error);
    else okOnce(p as T);
  }
}

/** A native promise from the captured constructor; resolve it only with primitives or `bare` records (no `then` to look up). */
export const promise = <T>(executor: (resolve: (value: T) => void, reject: (error: unknown) => void) => void): Promise<T> => new NativePromise<T>(executor);

// ------------------------------------------------------------------ JSON

/**
 * JSON text of a message the hook built itself (records, arrays, strings,
 * numbers, booleans, null). JSON.stringify is used only on primitives, where
 * it never looks up `toJSON`; objects are walked by their own keys.
 */
export function jsonText(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return JSONStringify(value);
    case "object": {
      if (ArrayIsArray(value)) {
        const list = value as unknown[];
        let s = "[";
        for (let i = 0; i < list.length; i++) {
          const v = list[i];
          s += (i ? "," : "") + (v === undefined || typeof v === "function" || typeof v === "symbol" ? "null" : jsonText(v));
        }
        return `${s}]`;
      }
      const keys = ObjectKeys(value);
      let s = "{";
      let first = true;
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const v = (value as Record<string, unknown>)[k];
        if (v === undefined || typeof v === "function" || typeof v === "symbol") continue;
        s += (first ? "" : ",") + JSONStringify(k) + ":" + jsonText(v);
        first = false;
      }
      return `${s}}`;
    }
    default:
      return "null";
  }
}
