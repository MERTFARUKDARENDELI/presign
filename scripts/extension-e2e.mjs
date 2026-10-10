// End-to-end check of the Presign extension in a real Chrome, without a real wallet extension:
//   1. a test dApp (served here) registers a fake Wallet Standard wallet and asks it to sign;
//   2. the extension must open Presign's review (local server on :3000) BEFORE the wallet is asked;
//   3. approving must reach the wallet with the exact bytes; cancelling or closing must not.
//
// The reviewed wallet is a throwaway test key held by this script, so the one-time ownership proof
// is a real ed25519 signature; a funded devnet account pays the fee in the SIMULATION only (it never
// signs anything). Nothing is broadcast.
//
// The test dApp also exposes a fake injected provider (window.solana), so both kinds of entry point are driven.
//
// Requirements: Chrome, and either Presign on http://localhost:3000 (devnet) with a development build
// (`npm run build:extension:dev`), or E2E_INSTANCE=production with `npm run build:extension`.
// `node scripts/e2e/local.mjs` runs it isolated: a local mock RPC instead of devnet, no outside network.
// Usage: node scripts/extension-e2e.mjs [--headed]
//   E2E_RPC        devnet RPC used for a current blockhash (default: OnFinality public devnet)
//   E2E_RPC_KIND   how the run describes that RPC (scripts/e2e/local.mjs: "mock (local, deterministic)")
//   E2E_FEE_PAYER  funded devnet system account used as fee payer in the simulation
//   E2E_INSTANCE   "local" (default, http://localhost:3000) or "production" (devnet requests → presign-devnet.vercel.app)
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DAPP_PORT = 5174;
const headed = process.argv.includes("--headed");
const INSTANCE = process.env.E2E_INSTANCE === "production" ? "production" : "local";

// ---------------------------------------------------------------- requests
const TEST_SEED = new Uint8Array(32).fill(77); // throwaway test key, devnet only
const wallet = Keypair.fromSeed(TEST_SEED).publicKey;
// The same key as PKCS#8, so the fake wallet in the page signs messages for real (Web Crypto Ed25519).
const TEST_PKCS8 = [...Buffer.from("302e020100300506032b657004220420", "hex"), ...TEST_SEED].join(",");
const feePayer = new PublicKey(process.env.E2E_FEE_PAYER ?? "6a1wxRdkWZKPHqSJvEEwcd9KywCEtrSnmswHDhNsBNqd");
const RPC = process.env.E2E_RPC ?? "https://solana-devnet.api.onfinality.io/public";
// Built when the dApp asks, with a current blockhash, like a real dApp (an expired one is — correctly — unverifiable).
// Retries with back-off: a public RPC answers 429 under load, which would otherwise hand the dApp an empty transaction.
const latestBlockhash = async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      return (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [{ commitment: "confirmed" }] }), signal: AbortSignal.timeout(10_000) })).json()).result.value.blockhash;
    } catch (error) {
      if (attempt >= 8) throw error;
      await new Promise((r) => setTimeout(r, 1_500 * attempt));
    }
  }
};
const serialize = (t) => Buffer.from(t.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64");
const memoOf = (text) => new TransactionInstruction({ programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), keys: [{ pubkey: wallet, isSigner: true, isWritable: false }], data: Buffer.from(text) });
const served = {};
async function buildTx(kind) {
  const t = new Transaction({ feePayer, recentBlockhash: await latestBlockhash() });
  // CRITICAL: the wallet account itself is handed to another program. "other": a second, different request.
  t.add(kind === "critical" ? SystemProgram.assign({ accountPubkey: wallet, programId: Keypair.fromSeed(new Uint8Array(32).fill(43)).publicKey }) : memoOf(kind === "other" ? "presign e2e: other bytes" : "presign e2e"));
  return (served[kind] = serialize(t));
}

// ---------------------------------------------------------------- test dApp
const dappHtml = `<!doctype html><meta charset="utf-8"><title>Test dApp</title><script>
// The first site script: tries to (re)start Presign's handshake and listens for anything that carries a secret.
// It also keeps Uint8Array.from for itself and the test wallet (real wallets run their own code), before window.poison() replaces it.
const __realFrom = Uint8Array.from;
window.__probe = [];
for (const t of ["presign:hello", "presign:hook-ready"]) document.addEventListener(t, (e) => window.__probe.push(String(e.detail ?? "")));
document.dispatchEvent(new CustomEvent("presign:content-ready"));
window.__channelSeen = document.querySelector("presign-channel") ? (document.querySelector("presign-channel").shadowRoot === null ? "closed" : "open") : "gone";
</script><body><h1>Test dApp</h1><script>
class RegisterWalletEvent extends Event {
  #d; get detail() { return this.#d; }
  constructor(cb) { super("wallet-standard:register-wallet", { bubbles: false, cancelable: false, composed: false }); this.#d = cb; }
  stopImmediatePropagation() { throw new Error("stopImmediatePropagation cannot be called"); }
  stopPropagation() { throw new Error("stopPropagation cannot be called"); }
}
class AppReadyEvent extends Event {
  #d; get detail() { return this.#d; }
  constructor(api) { super("wallet-standard:app-ready", { bubbles: false, cancelable: false, composed: false }); this.#d = api; }
  stopImmediatePropagation() { throw new Error("stopImmediatePropagation cannot be called"); }
  stopPropagation() { throw new Error("stopPropagation cannot be called"); }
}
const b64 = (s) => Reflect.apply(__realFrom, Uint8Array, [atob(s), (c) => c.charCodeAt(0)]);
window.__walletCalls = [];
class FakeWallet {
  version = "1.0.0"; name = "E2E Wallet"; icon = "data:image/svg+xml;base64,PHN2Zy8+";
  #accounts = [{ address: "${wallet.toBase58()}", publicKey: new Uint8Array(32), chains: ["solana:devnet"], features: [] }];
  get chains() { return ["solana:devnet"]; }
  get accounts() { return this.#accounts; }
  get features() { return {
    "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: this.#accounts }) },
    "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0], signTransaction: this.#signTx },
    "solana:signMessage": { version: "1.0.0", signMessage: this.#signMsg },
  }; }
  // Fills the wallet's signature slot (index 1: the fee payer is index 0).
  #signTx = async (...inputs) => { window.__walletCalls.push({ method: "signTransaction", b64: btoa(String.fromCharCode(...inputs[0].transaction)) });
    if (window.__hold) await window.__hold; // the wallet's window stays open while the test needs it to
    return inputs.map((i) => { const s = Reflect.apply(__realFrom, Uint8Array, [i.transaction]); s.fill(7, 65, 129); return { signedTransaction: s }; }); };
  #signMsg = async (...inputs) => { window.__walletCalls.push({ method: "signMessage" });
    const key = await crypto.subtle.importKey("pkcs8", new Uint8Array([${TEST_PKCS8}]), { name: "Ed25519" }, false, ["sign"]);
    return Promise.all(inputs.map(async (i) => ({ signedMessage: i.message, signature: new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, i.message)) }))); };
}
// The site (like @wallet-standard/app) — then the wallet registers (like @wallet-standard/wallet).
const wallets = [];
const api = Object.freeze({ register: (...w) => (wallets.push(...w), () => {}) });
window.addEventListener("wallet-standard:register-wallet", ({ detail }) => detail(api));
window.dispatchEvent(new AppReadyEvent(api));
const raw = new FakeWallet();
window.dispatchEvent(new RegisterWalletEvent(({ register }) => register(raw)));
window.__wrapped = wallets[0] !== raw;
// A fake injected provider (window.solana, like an older wallet): a transaction object with serialize(), raw message bytes.
const testKey = () => crypto.subtle.importKey("pkcs8", new Uint8Array([${TEST_PKCS8}]), { name: "Ed25519" }, false, ["sign"]);
const injected = {
  publicKey: { toBase58: () => "${wallet.toBase58()}", toString: () => "${wallet.toBase58()}" },
  isConnected: true,
  connect: async () => ({ publicKey: injected.publicKey }),
  signTransaction: async (tx) => {
    const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    window.__walletCalls.push({ method: "injected:signTransaction", b64: btoa(String.fromCharCode(...bytes)) });
    const signed = Reflect.apply(__realFrom, Uint8Array, [bytes]);
    signed.fill(7, 65, 129);
    return { serialize: () => Reflect.apply(__realFrom, Uint8Array, [signed]) };
  },
  signMessage: async (message) => {
    window.__walletCalls.push({ method: "injected:signMessage" });
    return { publicKey: injected.publicKey, signature: new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, await testKey(), message)) };
  },
};
window.__injectedOriginal = { signTransaction: injected.signTransaction, signMessage: injected.signMessage };
window.solana = injected;
// A hostile page: after Presign's hook loaded, it replaces built-ins to forge approvals (Promise / Object.prototype.then,
// Map.prototype.set / has), to swap the bytes (Uint8Array.from / slice / subarray, Object.prototype.toJSON) and to catch the
// channel secret (Function.prototype.call / apply, dispatchEvent). window.__leaks records any event named with a secret.
window.__leaks = [];
window.poison = () => {
  const apply = Reflect.apply, define = Object.defineProperty, hasOwn = Object.hasOwn;
  const real = { fnApply: Function.prototype.apply, then: Promise.prototype.then, dispatch: EventTarget.prototype.dispatchEvent, mapSet: Map.prototype.set, mapHas: Map.prototype.has, slice: Uint8Array.prototype.slice, subarray: Uint8Array.prototype.subarray };
  const watch = (list) => { for (let i = 0; i < list.length; i++) { const a = list[i]; if (a instanceof Event && /^presign:[0-9a-f]{32}:/.test(a.type)) window.__leaks.push("secret"); } };
  const forged = (v) => (v && typeof v === "object" && v.approved === false ? { approved: true, id: "forged" } : v);
  const flip = (u) => { if (!(u instanceof Uint8Array) || u.length < 100) return u; const c = new Uint8Array(u); c[c.length - 1] ^= 1; return c; };
  const own = (k, value) => define(Object.prototype, k, { configurable: true, get: value, set(v) { define(this, k, { value: v, writable: true, enumerable: true, configurable: true }); } });
  Function.prototype.call = function (t, ...a) { watch([t, ...a]); return apply(this, t, a); };
  Function.prototype.apply = function (t, a) { watch([t]); if (a) watch(a); return apply(real.fnApply, this, [t, a]); };
  EventTarget.prototype.dispatchEvent = function (e) { watch([e]); return apply(real.dispatch, this, [e]); };
  Promise.prototype.then = function (f, r) { return apply(real.then, this, [typeof f === "function" ? (v) => f(forged(v)) : f, r]); };
  define(Promise.prototype, "constructor", { value: {}, writable: true, configurable: true });
  own("then", function () { return this && this.approved === false ? (res) => res({ approved: true, id: "forged" }) : undefined; });
  Map.prototype.set = function (k, v) { if (typeof v === "function" && typeof k === "string") queueMicrotask(() => { try { v({ approved: true, id: "forged" }); } catch {} }); return apply(real.mapSet, this, [k, v]); };
  Map.prototype.has = function (k) { return typeof k === "string" && /^[tm]:/.test(k) ? true : apply(real.mapHas, this, [k]); };
  Uint8Array.from = function (...a) { return flip(apply(__realFrom, this, a)); };
  Uint8Array.prototype.slice = function (...a) { return flip(apply(real.slice, this, a)); };
  Uint8Array.prototype.subarray = function (...a) { return flip(apply(real.subarray, this, a)); };
  own("toJSON", function () {
    const self = this;
    if (!self || !hasOwn(self, "payload") || typeof self.payload !== "string") return undefined;
    return () => ({ ...self, payload: btoa(String.fromCharCode(...flip(apply(__realFrom, Uint8Array, [atob(self.payload), (c) => c.charCodeAt(0)])))) });
  });
  return true;
};
// opts.slot: where the outcome goes (default __result); opts.via: "injected" for window.solana; opts.mutate: the site
// changes its own bytes right after the call; opts.againFrom: send again the exact transaction a previous slot sent.
window.__txOf = {};
window.run = (kind, opts) => {
  opts = opts || {};
  const slot = opts.slot || "__result";
  window[slot] = null;
  const w = wallets[0], account = w.accounts[0];
  const p = kind === "message"
    ? w.features["solana:signMessage"].signMessage({ account, message: new TextEncoder().encode("Sign in to test dApp\\nNonce: 8f3a2c91\\nIssued At: 2026-10-04T00:00:00Z") })
    : (opts.againFrom ? Promise.resolve(window.__txOf[opts.againFrom]) : fetch("/tx/" + kind).then((r) => r.text())).then((tx) => {
        window.__txOf[slot] = tx;
        const bytes = b64(tx);
        const out = opts.via === "injected"
          ? window.solana.signTransaction({ serialize: () => Reflect.apply(__realFrom, Uint8Array, [bytes]) })
          : w.features["solana:signTransaction"].signTransaction({ account, chain: "solana:devnet", transaction: bytes });
        if (opts.mutate) bytes[bytes.length - 1] ^= 1;
        return out;
      });
  p.then((out) => (window[slot] = { ok: true, n: Array.isArray(out) ? out.length : 1 }), (e) => (window[slot] = { ok: false, code: e.code ?? null, message: String(e.message) }));
};
</script></body>`;

const server = createServer((req, res) => {
  if (req.url?.startsWith("/tx/")) {
    buildTx(req.url.slice(4)).then(
      (tx) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(tx);
      },
      () => {
        res.writeHead(502);
        res.end();
      },
    );
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(dappHtml);
}).listen(DAPP_PORT);

// ---------------------------------------------------------------- Chrome over the DevTools pipe
const profile = await mkdtemp(path.join(tmpdir(), "presign-e2e-"));
const chrome = spawn(CHROME, [`--user-data-dir=${profile}`, "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check", ...(headed ? [] : ["--headless=new"]), "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
const toChrome = chrome.stdio[3];
let buf = "";
let nextId = 0;
const pending = new Map();
chrome.stdio[4].on("data", (d) => {
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\0")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data ?? ""}`));
      else resolve(msg.result);
    }
  }
});
const cdp = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    toChrome.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 90_000) {
  const start = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(400);
  }
}
const evaluate = async (sessionId, expression) => (await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId)).result.value;
const attach = async (targetId) => (await cdp("Target.attachToTarget", { targetId, flatten: true })).sessionId;

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

console.log(`Wallets: fake Wallet Standard and injected wallets, throwaway test key (no wallet extension) · RPC: ${process.env.E2E_RPC_KIND ?? new URL(RPC).host} · Presign: ${INSTANCE}\n`);
try {
  const { id: extId } = await cdp("Extensions.loadUnpacked", { path: path.join(root, "extension", "dist") });
  check(/^[a-p]{32}$/.test(extId), `extension loaded (${extId})`);

  // Point the extension at the local Presign server.
  const sw = await until(async () => (await cdp("Target.getTargets")).targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extId}/`)), "extension service worker");
  const swSession = await attach(sw.targetId);
  await evaluate(swSession, `chrome.storage.local.set({ settings: { enabled: true, instance: ${JSON.stringify(INSTANCE)}, skipSites: [] } }).then(() => true)`);

  const { targetId: dappTarget } = await cdp("Target.createTarget", { url: `http://localhost:${DAPP_PORT}/` });
  const dapp = await attach(dappTarget);
  await until(() => evaluate(dapp, `document.readyState === "complete" && typeof window.run === "function"`), "test dApp");
  check((await evaluate(dapp, "window.__wrapped")) === true, "the site received the wallet only wrapped by Presign");
  check((await evaluate(dapp, "window.__probe.every((d) => !/^[0-9a-f]{32}$/.test(d))")) === true, "a site script that restarts the handshake hears no secret");
  check((await evaluate(dapp, "window.__channelSeen !== 'open' && document.querySelector('presign-channel') === null")) === true, "the secret's element is closed to the page and gone after the handshake");

  const seen = new Set();
  async function reviewWindow() {
    const t = await until(async () => (await cdp("Target.getTargets")).targetInfos.find((x) => x.type === "page" && x.url.includes("/extension/review") && !seen.has(x.targetId)), "Presign review window", 120_000);
    seen.add(t.targetId);
    return { target: t, session: await attach(t.targetId) };
  }
  const text = (s) => evaluate(s, "document.body.innerText");
  const clickButton = (s, re) => evaluate(s, `(() => { const b = [...document.querySelectorAll("button")].find((x) => ${re}.test(x.textContent) && !x.disabled); if (!b) return null; b.click(); return b.textContent.trim(); })()`);
  // The "Risk" field of the review header (not the domain chip or a signal badge).
  const riskOf = (page) => (page.match(/\nRisk\n(No risk found|LOW|MEDIUM|HIGH|CRITICAL|Unrated)\b/i) ?? [])[1] ?? "?";
  // The decision button's labels (lib/presign/decision.ts).
  const PRIMARY = /^\s*(Sign|Sign with wallet|Continue anyway|I understand the (critical )?risk — sign anyway)\s*$/;
  const analyzed = (s, what) =>
    until(async () => /your decision/i.test(await text(s)), what, 180_000).catch(async (e) => {
      console.error(`      review page:\n${(await text(s).catch(() => "?")).slice(0, 1800)}`);
      throw e;
    });

  /** The one-time ownership proof, made in the review page's own session (as the gate's wallet button does). */
  async function proveOwnership(s) {
    const ch = await evaluate(s, `fetch("/api/presign/nonce", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ walletAddress: "${wallet.toBase58()}" }) }).then((r) => r.json())`);
    const message = ch.data.message;
    const signature = bs58.encode(ed25519.sign(new TextEncoder().encode(message), TEST_SEED));
    const v = await evaluate(s, `fetch("/api/presign/connect/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(${JSON.stringify({ walletAddress: wallet.toBase58(), message, signature, nonceToken: ch.data.nonceToken })}) }).then((r) => r.json())`);
    await evaluate(s, `window.dispatchEvent(new Event("presign-session")), true`);
    return v?.data?.wallet === wallet.toBase58();
  }
  const pace = () => sleep(Number(process.env.E2E_PACE_MS ?? 8_000)); // public RPC rate limits

  // ---- 1. Transaction, approved (first time: ownership gate)
  await evaluate(dapp, `window.run("transaction"), true`);
  const r1 = await reviewWindow();
  check(new URL(r1.target.url).searchParams.get("ext") === extId, "review opened on Presign with this extension's id");
  check((await evaluate(dapp, "window.__walletCalls.length")) === 0, "the wallet was NOT asked before the review");
  await analyzed(r1.session, "analysis on the review page");
  const page1 = await text(r1.session);
  check(page1.includes(`localhost:${DAPP_PORT}`), "review shows the requesting site, observed by the extension");
  console.log(`      risk on the review page: ${riskOf(page1)}`);
  check(/Verify that you own/i.test(page1) && (await clickButton(r1.session, PRIMARY)) === null, "before ownership is proven the sign path is locked (Cancel stays available)");
  check(await proveOwnership(r1.session), "ownership proven once with a real signature (authorizes nothing)");
  const clicked = await until(() => clickButton(r1.session, PRIMARY), "primary action", 20_000);
  console.log(`      clicked: ${clicked}`);
  await sleep(500);
  await clickButton(r1.session, /I understand — continue/);
  const res1 = await until(() => evaluate(dapp, "window.__result"), "result in the dApp", 45_000).catch(async (e) => {
    console.error("      review decision area:", (await text(r1.session)).split(/YOUR DECISION/i)[1]?.slice(0, 600));
    throw e;
  });
  check(res1.ok === true, `approve → the site got the signature (${JSON.stringify(res1)})`);
  const calls1 = await evaluate(dapp, "window.__walletCalls");
  check(calls1.length === 1 && calls1[0].b64 === served.transaction, "the wallet received exactly the reviewed bytes, once");
  await until(async () => /returned to the (site|application)/i.test(await text(r1.session).catch(() => "")), "signed outcome on the review page", 20_000).then(() => check(true, "review page shows the wallet's outcome"), () => check(false, "review page shows the wallet's outcome"));

  // ---- 2. Transaction, cancelled
  await pace();
  await evaluate(dapp, `window.run("transaction"), true`);
  const r2 = await reviewWindow();
  await analyzed(r2.session, "second analysis");
  check(!/Verify that you own/i.test(await text(r2.session)), "ownership is not asked again in the same session");
  await clickButton(r2.session, /^\s*Cancel\s*$/);
  const res2 = await until(() => evaluate(dapp, "window.__result"), "cancel result", 30_000);
  check(res2.ok === false && res2.code === 4001, `cancel → the site got a user-rejected error (${JSON.stringify(res2)})`);
  check((await evaluate(dapp, "window.__walletCalls.length")) === 1, "cancel → the wallet was never asked");

  // ---- 3. Message, approved
  await pace();
  await evaluate(dapp, `window.run("message"), true`);
  const r3 = await reviewWindow();
  await analyzed(r3.session, "message analysis");
  check(/Sign in to test dApp/.test(await text(r3.session)), "review shows the exact message text");
  // A message has no chain: production reviews it on the mainnet site, a separate session there.
  if (/Verify that you own/i.test(await text(r3.session))) check(await proveOwnership(r3.session), `ownership proven once for the ${new URL(r3.target.url).host} session`);
  await until(() => clickButton(r3.session, PRIMARY), "message primary action");
  await sleep(500);
  await clickButton(r3.session, /I understand — continue/);
  const res3 = await until(() => evaluate(dapp, "window.__result"), "message result", 60_000);
  check(res3.ok === true, `message approve → the site got the signature (${JSON.stringify(res3)})`);

  // ---- 4. CRITICAL: valid and analyzable → the user may still override, after one explicit confirmation
  await pace();
  await evaluate(dapp, `window.run("critical"), true`);
  const r4 = await reviewWindow();
  await analyzed(r4.session, "critical analysis");
  const page4 = await text(r4.session);
  console.log(`      risk on the review page: ${riskOf(page4)}`);
  check(/CRITICAL/.test(page4), "the wallet-reassign transaction is rated CRITICAL");
  if (!/do not sign/i.test(page4)) console.error(`      critical page:\n${page4.split(/PRESIGN PRE-SIGN SECURITY CHECK/i)[1]?.slice(0, 2200)}`);
  check(/do not sign/i.test(page4), "Presign recommends not signing");
  const before = await evaluate(dapp, "window.__walletCalls.length");
  const first = await until(() => clickButton(r4.session, /sign anyway/i), "override button", 20_000);
  check(/critical risk/i.test(first ?? ""), `the override button names the risk (${first})`);
  await sleep(400);
  check((await evaluate(dapp, "window.__walletCalls.length")) === before, "the first click only opens the confirmation; the wallet is not asked yet");
  await until(() => clickButton(r4.session, /I understand — continue/), "explicit confirmation");
  const res4 = await until(() => evaluate(dapp, "window.__result"), "critical result", 60_000);
  check(res4.ok === true, `explicit override → the site got the signature (${JSON.stringify(res4)})`);
  check((await evaluate(dapp, "window.__walletCalls")).at(-1)?.b64 === served.critical, "override → the wallet received exactly the reviewed bytes");

  // ---- 5. Closing the review window without deciding cancels
  await pace();
  await evaluate(dapp, `window.run("transaction"), true`);
  const r5 = await reviewWindow();
  const callsBefore = await evaluate(dapp, "window.__walletCalls.length");
  await cdp("Target.closeTarget", { targetId: r5.target.targetId });
  const res5 = await until(() => evaluate(dapp, "window.__result"), "close result", 30_000);
  check(res5.ok === false && res5.code === 4001, `closing the review window → rejected (${JSON.stringify(res5)})`);
  check((await evaluate(dapp, "window.__walletCalls.length")) === callsBefore, "closing → the wallet was never asked");

  // ---- 6. A made-up approval sent from the Presign page (as script running there could) never reaches the wallet:
  //          the extension confirms every approval with the Presign server first.
  await pace();
  await evaluate(dapp, `window.run("transaction"), true`);
  const r6 = await reviewWindow();
  await analyzed(r6.session, "analysis for the made-up approval");
  const callsBefore6 = await evaluate(dapp, "window.__walletCalls.length");
  const forged = await evaluate(r6.session, `(async () => {
    const q = new URL(location.href).searchParams;
    const ext = q.get("ext"), rid = q.get("rid");
    const send = (m) => Promise.race([new Promise((resolve) => chrome.runtime.sendMessage(ext, m, resolve)), new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 30_000))]);
    const t = await send({ kind: "presign:get", rid });
    return send({ kind: "presign:approve", rid, payload: t.ticket.request.payload, payloadHash: "ab".repeat(32), approvalToken: "made-up-".repeat(6), riskLevel: "SAFE", choice: "SIGN" });
  })()`);
  check(forged?.ok === false && forged.error === "APPROVAL_UNCONFIRMED", `a made-up approval is refused by the extension after asking Presign (${JSON.stringify(forged)})`);
  const res6 = await until(() => evaluate(dapp, "window.__result"), "made-up approval result", 30_000);
  check(res6.ok === false, `made-up approval → the site got a refusal (${JSON.stringify(res6)})`);
  check((await evaluate(dapp, "window.__walletCalls.length")) === callsBefore6, "made-up approval → the wallet was never asked");

  // ---- 7. A hostile page (window.poison above): built-ins replaced after the hook loaded. Cancel must still reach no
  //          wallet and leave no forged approval; approving must still sign exactly the reviewed bytes; no secret leaks.
  await pace();
  check((await evaluate(dapp, "window.poison()")) === true, "the page replaced call / apply / then / Promise constructor / Map set+has / Uint8Array copies / toJSON / dispatchEvent");
  const callsBefore7 = await evaluate(dapp, "window.__walletCalls.length");
  await evaluate(dapp, `window.run("transaction"), true`);
  const r7 = await reviewWindow();
  check((await evaluate(dapp, "window.__walletCalls.length")) === callsBefore7, "hostile page: the wallet was NOT asked before the review");
  await analyzed(r7.session, "hostile-page analysis");
  check((await clickButton(r7.session, /^\s*Cancel\s*$/)) !== null, "hostile page: Cancel clicked on the review page");
  const res7 = await until(() => evaluate(dapp, "window.__result"), "hostile-page cancel result", 30_000);
  check(res7.ok === false, `hostile page, cancel → refused (${JSON.stringify(res7)})`);
  await sleep(1_500);
  check((await evaluate(dapp, "window.__walletCalls.length")) === callsBefore7, "hostile page, cancel → the wallet was never asked (no forged approval)");

  await pace();
  await evaluate(dapp, `window.run("transaction"), true`);
  const r8 = await reviewWindow();
  await analyzed(r8.session, "hostile-page analysis (approve)");
  const reviewed8 = await evaluate(r8.session, `(async () => {
    const q = new URL(location.href).searchParams;
    return new Promise((resolve) => chrome.runtime.sendMessage(q.get("ext"), { kind: "presign:get", rid: q.get("rid") }, (t) => resolve(t?.ticket?.request?.payload ?? null)));
  })()`);
  check(reviewed8 === served.transaction, "hostile page: Presign reviewed exactly the site's bytes");
  await until(() => clickButton(r8.session, PRIMARY), "hostile-page primary action", 20_000);
  await sleep(500);
  await clickButton(r8.session, /I understand — continue/);
  const res8 = await until(() => evaluate(dapp, "window.__result"), "hostile-page approve result", 60_000);
  check(res8.ok === true, `hostile page, approve → the site got the signature (${JSON.stringify(res8)})`);
  check((await evaluate(dapp, "window.__walletCalls")).at(-1)?.b64 === served.transaction, "hostile page, approve → the wallet received exactly the reviewed bytes");
  check((await evaluate(dapp, "window.__leaks.length")) === 0, "hostile page: no event carrying the channel secret reached the page's code");

  // ---- From here on, a fresh tab of the test dApp (built-ins intact): the other entry points and attacks on the approval.
  const { targetId: dapp2Target } = await cdp("Target.createTarget", { url: `http://localhost:${DAPP_PORT}/` });
  const site = await attach(dapp2Target);
  await until(() => evaluate(site, `document.readyState === "complete" && typeof window.run === "function"`), "second test dApp tab");
  check((await evaluate(site, "window.__wrapped")) === true, "second tab: the Wallet Standard wallet reached the site only wrapped");
  await until(() => evaluate(site, "window.solana.signTransaction !== window.__injectedOriginal.signTransaction && window.solana.signMessage !== window.__injectedOriginal.signMessage"), "injected provider wrapped", 15_000).then(
    () => check(true, "the injected provider's signing methods are wrapped by Presign"),
    () => check(false, "the injected provider's signing methods are wrapped by Presign"),
  );
  const run = (kind, opts) => evaluate(site, `window.run(${JSON.stringify(kind)}, ${JSON.stringify(opts)}), true`);
  const outcome = (slot, what) => until(() => evaluate(site, `window[${JSON.stringify(slot)}]`), what, 60_000);
  const walletCalls = () => evaluate(site, "window.__walletCalls");
  const approveInPage = async (s, what) => {
    await until(() => clickButton(s, PRIMARY), what, 20_000);
    await sleep(500);
    await clickButton(s, /I understand — continue/);
  };
  // The request the extension holds for a review window (its rid and payload), asked the way the review page asks.
  const ticketOf = (s) =>
    evaluate(s, `(() => { const q = new URL(location.href).searchParams; const send = window.__realSend ?? chrome.runtime.sendMessage.bind(chrome.runtime);
      return new Promise((resolve) => send(q.get("ext"), { kind: "presign:get", rid: q.get("rid") }, (t) => resolve({ rid: q.get("rid"), payload: t?.ticket?.request?.payload ?? null }))); })()`);
  // A message to the extension from a review page, as script running on the Presign page could send it.
  const sendFrom = (s, message) =>
    evaluate(s, `(() => { const send = window.__realSend ?? chrome.runtime.sendMessage.bind(chrome.runtime); const ext = new URL(location.href).searchParams.get("ext");
      return Promise.race([new Promise((resolve) => send(ext, ${JSON.stringify(message)}, resolve)), new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 30000))]); })()`);
  // Records the approvals the review page sends to the extension; with hold, keeps them from the extension.
  const recordApprovals = (s, hold) =>
    evaluate(s, `(() => { const rt = chrome.runtime; const real = rt.sendMessage.bind(rt); window.__realSend = real; window.__approvals = [];
      const wrapped = (ext, msg, cb) => { if (msg && msg.kind === "presign:approve") { window.__approvals.push(msg); if (${hold}) return void setTimeout(() => cb({ ok: false, error: "HELD_BY_TEST" }), 0); } return real(ext, msg, cb); };
      try { rt.sendMessage = wrapped; } catch {} if (rt.sendMessage !== wrapped) Object.defineProperty(rt, "sendMessage", { value: wrapped, configurable: true, writable: true });
      return rt.sendMessage === wrapped; })()`);

  // ---- 9. Injected provider, approved — and the site's transaction object changes what it serializes right after the call
  // window.solana names no chain, so production reviews its requests on the network picked in the menu (mainnet by
  // default). These transactions are devnet's: the test picks devnet there, as someone testing on devnet would.
  if (INSTANCE === "production") await evaluate(swSession, `chrome.storage.local.get("settings").then((v) => chrome.storage.local.set({ settings: { ...v.settings, unnamedChain: "devnet" } })).then(() => true)`);
  await pace();
  const calls9 = (await walletCalls()).length;
  await run("transaction", { via: "injected", slot: "__i1", mutate: true });
  const r9 = await reviewWindow();
  if (INSTANCE === "production") check(new URL(r9.target.url).origin === "https://presign-devnet.vercel.app", "a request that names no chain is reviewed on the network picked in the menu (devnet)");
  check((await walletCalls()).length === calls9, "injected provider: the wallet was NOT asked before the review");
  await analyzed(r9.session, "injected-provider analysis");
  check((await ticketOf(r9.session)).payload === served.transaction, "injected provider: Presign reviewed exactly the site's bytes as they were at the call");
  await approveInPage(r9.session, "injected-provider primary action");
  const res9 = await outcome("__i1", "injected-provider result");
  check(res9.ok === true, `injected provider, approve → the site got the signed transaction (${JSON.stringify(res9)})`);
  const after9 = await walletCalls();
  check(after9.length === calls9 + 1 && after9.at(-1).method === "injected:signTransaction" && after9.at(-1).b64 === served.transaction, "injected provider: the wallet received exactly the reviewed bytes, not the site's changed ones, once");

  // ---- 10. Injected provider, cancelled
  await pace();
  const calls10 = (await walletCalls()).length;
  await run("transaction", { via: "injected", slot: "__i2" });
  const r10 = await reviewWindow();
  await analyzed(r10.session, "injected-provider analysis (cancel)");
  await clickButton(r10.session, /^\s*Cancel\s*$/);
  const res10 = await outcome("__i2", "injected-provider cancel result");
  check(res10.ok === false && res10.code === 4001, `injected provider, cancel → user-rejected error (${JSON.stringify(res10)})`);
  check((await walletCalls()).length === calls10, "injected provider, cancel → the wallet was never asked");

  // ---- 11. Wallet Standard: the site changes its own byte array while the review is open
  await pace();
  await run("transaction", { slot: "__m", mutate: true });
  const r11 = await reviewWindow();
  await analyzed(r11.session, "analysis of a request whose bytes the site changed");
  check((await ticketOf(r11.session)).payload === served.transaction, "site changes its array after the call: Presign reviewed the bytes as they were at the call");
  await approveInPage(r11.session, "primary action (changed array)");
  const res11 = await outcome("__m", "result (changed array)");
  check(res11.ok === true && (await walletCalls()).at(-1).b64 === served.transaction, `site changes its array after the call → the wallet still signs exactly the reviewed bytes (${JSON.stringify(res11)})`);

  // ---- 12. A genuine approval, but for OTHER bytes: request A is approved in Presign and the approval held back;
  //          script on the Presign page then offers it for request B. The extension asks the server, which refuses it.
  //          The same approval, given to A, is accepted: the refusal is about the bytes, not a broken token.
  await pace();
  const calls12 = (await walletCalls()).length;
  await run("transaction", { slot: "__a" });
  const rA = await reviewWindow();
  await analyzed(rA.session, "analysis of request A");
  check(await recordApprovals(rA.session, true), "request A: the test records and holds back the approval the review page sends");
  await approveInPage(rA.session, "request A primary action");
  const heldA = await until(() => evaluate(rA.session, "window.__approvals[0] ?? null"), "request A's approval", 30_000);
  await run("other", { slot: "__b" });
  const rB = await reviewWindow();
  await analyzed(rB.session, "analysis of request B");
  const ticketB = await ticketOf(rB.session);
  check(ticketB.payload === served.other && ticketB.payload !== heldA.payload, "request B carries other bytes than request A");
  const misused = await sendFrom(rB.session, { ...heldA, rid: ticketB.rid, payload: ticketB.payload });
  check(misused?.ok === false && misused.error === "APPROVAL_UNCONFIRMED", `A's genuine approval offered for B's bytes is refused after asking Presign (${JSON.stringify(misused)})`);
  const resB = await outcome("__b", "request B result");
  check(resB.ok === false, `request B → the site got a refusal (${JSON.stringify(resB)})`);
  check((await walletCalls()).length === calls12, "request B → the wallet was never asked");
  const usedForA = await sendFrom(rA.session, heldA);
  check(usedForA?.ok === true, `the same approval for A's own bytes is accepted (${JSON.stringify(usedForA)})`);
  const resA = await outcome("__a", "request A result");
  check(resA.ok === true && (await walletCalls()).at(-1).b64 === heldA.payload, `request A → the wallet signed exactly A's reviewed bytes (${JSON.stringify(resA)})`);

  // ---- 13. Replays: the approval A already used, sent again for A, and offered for a new request with A's very bytes
  await pace();
  const calls13 = (await walletCalls()).length;
  const again = await sendFrom(rA.session, heldA);
  check(again?.ok === false, `a used approval sent again for its own request is refused (${JSON.stringify(again)})`);
  await run("transaction", { slot: "__c", againFrom: "__a" });
  const rC = await reviewWindow();
  await analyzed(rC.session, "analysis of A's bytes sent again");
  const ticketC = await ticketOf(rC.session);
  check(ticketC.payload === heldA.payload, "the site sent A's exact bytes again, as a new request");
  const replayed = await sendFrom(rC.session, { ...heldA, rid: ticketC.rid, payload: ticketC.payload });
  check(replayed?.ok === false && replayed.error === "APPROVAL_UNCONFIRMED", `A's used approval offered for the same bytes again is refused: approvals are confirmed once (${JSON.stringify(replayed)})`);
  const resC = await outcome("__c", "replayed-approval result");
  check(resC.ok === false && (await walletCalls()).length === calls13, `replayed approval → refused, and the wallet was never asked (${JSON.stringify(resC)})`);

  // ---- 14. Re-entrancy: while an approved request is still in the wallet, the site asks for OTHER bytes
  await pace();
  await evaluate(site, "window.__hold = new Promise((r) => (window.__release = r)), true");
  const calls14 = (await walletCalls()).length;
  await run("transaction", { slot: "__d" });
  const rD = await reviewWindow();
  await analyzed(rD.session, "analysis before the re-entrant call");
  await approveInPage(rD.session, "primary action (held in the wallet)");
  await until(async () => (await walletCalls()).length === calls14 + 1, "the approved request to reach the wallet", 30_000);
  await run("other", { slot: "__e" });
  const rE = await reviewWindow();
  check((await walletCalls()).length === calls14 + 1, "re-entrant call with other bytes: a new review opened and the wallet was not asked for them");
  await analyzed(rE.session, "analysis of the re-entrant call");
  await clickButton(rE.session, /^\s*Cancel\s*$/);
  const resE = await outcome("__e", "re-entrant call result");
  check(resE.ok === false && resE.code === 4001, `re-entrant call, cancel → user-rejected error (${JSON.stringify(resE)})`);
  await evaluate(site, "window.__release(), window.__hold = null, true");
  const resD = await outcome("__d", "held request result");
  const calls14After = await walletCalls();
  check(resD.ok === true && calls14After.length === calls14 + 1 && calls14After.at(-1).b64 === served.transaction, `the held request completed with its own reviewed bytes; the other bytes never reached the wallet (${JSON.stringify(resD)})`);

  // ---- 15. The extension's own log
  const log = await evaluate(swSession, `chrome.storage.local.get("log").then((v) => (v.log || []).map((e) => e.state))`);
  console.log(`      extension log: ${JSON.stringify(log)}`);
  check(Array.isArray(log) && log.includes("signed") && log.includes("cancelled"), "decisions are recorded in the extension's log");
} catch (error) {
  failures++;
  console.error("ERROR", error.message);
} finally {
  chrome.kill();
  server.close();
  await sleep(500);
  await rm(profile, { recursive: true, force: true }).catch(() => undefined);
}
console.log(failures === 0 ? "\nAll extension end-to-end checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
