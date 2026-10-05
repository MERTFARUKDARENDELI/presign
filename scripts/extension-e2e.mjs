// End-to-end check of the Presign extension in a real Chrome, without a real wallet extension:
//   1. a test dApp (served here) registers a fake Wallet Standard wallet and asks it to sign;
//   2. the extension must open Presign's review (local server on :3000) BEFORE the wallet is asked;
//   3. approving must reach the wallet with the exact bytes; cancelling or closing must not.
//
// The reviewed wallet is a throwaway test key held by this script, so the one-time ownership proof
// is a real ed25519 signature; a funded devnet account pays the fee in the SIMULATION only (it never
// signs anything). Nothing is broadcast.
//
// Requirements: `npm run build:extension`, Presign running on http://localhost:3000 (devnet), Chrome.
// Usage: node scripts/extension-e2e.mjs [--headed]
//   E2E_RPC        devnet RPC used for a current blockhash (default: OnFinality public devnet)
//   E2E_FEE_PAYER  funded devnet system account used as fee payer in the simulation
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

// ---------------------------------------------------------------- requests
const TEST_SEED = new Uint8Array(32).fill(77); // throwaway test key, devnet only
const wallet = Keypair.fromSeed(TEST_SEED).publicKey;
const feePayer = new PublicKey(process.env.E2E_FEE_PAYER ?? "6a1wxRdkWZKPHqSJvEEwcd9KywCEtrSnmswHDhNsBNqd");
const RPC = process.env.E2E_RPC ?? "https://solana-devnet.api.onfinality.io/public";
// Built when the dApp asks, with a current blockhash, like a real dApp (an expired one is — correctly — unverifiable).
const latestBlockhash = async () => (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [{ commitment: "confirmed" }] }) })).json()).result.value.blockhash;
const serialize = (t) => Buffer.from(t.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64");
const memo = new TransactionInstruction({ programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), keys: [{ pubkey: wallet, isSigner: true, isWritable: false }], data: Buffer.from("presign e2e") });
const served = {};
async function buildTx(kind) {
  const t = new Transaction({ feePayer, recentBlockhash: await latestBlockhash() });
  // CRITICAL: the wallet account itself is handed to another program.
  t.add(kind === "critical" ? SystemProgram.assign({ accountPubkey: wallet, programId: Keypair.fromSeed(new Uint8Array(32).fill(43)).publicKey }) : memo);
  return (served[kind] = serialize(t));
}

// ---------------------------------------------------------------- test dApp
const dappHtml = `<!doctype html><meta charset="utf-8"><title>Test dApp</title><body><h1>Test dApp</h1><script>
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
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
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
    return inputs.map((i) => { const s = Uint8Array.from(i.transaction); s.fill(7, 65, 129); return { signedTransaction: s }; }); };
  #signMsg = async (...inputs) => { window.__walletCalls.push({ method: "signMessage" }); return inputs.map((i) => ({ signedMessage: i.message, signature: new Uint8Array(64) })); };
}
// The site (like @wallet-standard/app) — then the wallet registers (like @wallet-standard/wallet).
const wallets = [];
const api = Object.freeze({ register: (...w) => (wallets.push(...w), () => {}) });
window.addEventListener("wallet-standard:register-wallet", ({ detail }) => detail(api));
window.dispatchEvent(new AppReadyEvent(api));
const raw = new FakeWallet();
window.dispatchEvent(new RegisterWalletEvent(({ register }) => register(raw)));
window.__wrapped = wallets[0] !== raw;
window.run = (kind) => {
  window.__result = null;
  const w = wallets[0], account = w.accounts[0];
  const p = kind === "message"
    ? w.features["solana:signMessage"].signMessage({ account, message: new TextEncoder().encode("Sign in to test dApp\\nNonce: 8f3a2c91\\nIssued At: 2026-10-04T00:00:00Z") })
    : fetch("/tx/" + kind).then((r) => r.text()).then((tx) => w.features["solana:signTransaction"].signTransaction({ account, chain: "solana:devnet", transaction: b64(tx) }));
  p.then((out) => (window.__result = { ok: true, n: out.length }), (e) => (window.__result = { ok: false, code: e.code ?? null, message: String(e.message) }));
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

try {
  const { id: extId } = await cdp("Extensions.loadUnpacked", { path: path.join(root, "extension", "dist") });
  check(/^[a-p]{32}$/.test(extId), `extension loaded (${extId})`);

  // Point the extension at the local Presign server.
  const sw = await until(async () => (await cdp("Target.getTargets")).targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extId}/`)), "extension service worker");
  const swSession = await attach(sw.targetId);
  await evaluate(swSession, `chrome.storage.local.set({ settings: { enabled: true, instance: "local", skipSites: [] } }).then(() => true)`);

  const { targetId: dappTarget } = await cdp("Target.createTarget", { url: `http://localhost:${DAPP_PORT}/` });
  const dapp = await attach(dappTarget);
  await until(() => evaluate(dapp, `document.readyState === "complete" && typeof window.run === "function"`), "test dApp");
  check((await evaluate(dapp, "window.__wrapped")) === true, "the site received the wallet only wrapped by Presign");

  const seen = new Set();
  async function reviewWindow() {
    const t = await until(async () => (await cdp("Target.getTargets")).targetInfos.find((x) => x.type === "page" && x.url.includes("/extension/review") && !seen.has(x.targetId)), "Presign review window", 120_000);
    seen.add(t.targetId);
    return { target: t, session: await attach(t.targetId) };
  }
  const text = (s) => evaluate(s, "document.body.innerText");
  const clickButton = (s, re) => evaluate(s, `(() => { const b = [...document.querySelectorAll("button")].find((x) => ${re}.test(x.textContent) && !x.disabled); if (!b) return null; b.click(); return b.textContent.trim(); })()`);
  // The "Risk" field of the review header (not the domain chip or a signal badge).
  const riskOf = (page) => (page.match(/\nRisk\n(SAFE|LOW|MEDIUM|HIGH|CRITICAL|UNRATED)\b/) ?? [])[1] ?? "?";
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
  const pace = () => sleep(4_000); // public RPC rate limits

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

  // ---- 6. The extension's own log
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
