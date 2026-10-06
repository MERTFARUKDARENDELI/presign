import { SystemProgram, Transaction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as confirmRoute } from "@/app/api/presign/signing/verify-approval/route";
import { CONFIRM_PATH, confirmApproval, payloadHashOfRequest, type ConfirmDeps } from "@/extension/src/lib/approval";
import { bytesToBase64 } from "@/extension/src/lib/bytes";
import { PRESIGN_ORIGINS, type ReviewRequest } from "@/extension/src/lib/protocol";
import { resetRateLimits } from "@/lib/api/rate-limit";
import { payloadHashOf } from "@/lib/presign/payload";
import { resetReplayRegistry } from "@/lib/presign/replay";
import { sealToken } from "@/lib/presign/tokens";
import { ATTACKER, BLOCKHASH, buildTx, keypair, WALLET } from "../helpers/fixtures";

const digest: ConfirmDeps["digest"] = (bytes) => crypto.subtle.digest("SHA-256", bytes as BufferSource);
const W = WALLET.toBase58();
const SITE = "https://dapp.example";

const legacyTx = (lamports = 7) => buildTx([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports })]).bytes;
const v0Tx = () => new VersionedTransaction(new TransactionMessage({ payerKey: WALLET, recentBlockhash: BLOCKHASH, instructions: [SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 9 })] }).compileToV0Message()).serialize();
const message = (text = "Sign in to dapp.example\nNonce: 12345678") => new TextEncoder().encode(text);

const reviewRequest = (type: "TRANSACTION" | "MESSAGE", bytes: Uint8Array, wallet: string | null = W): ReviewRequest => ({ type, payload: bytesToBase64(bytes), walletAddress: wallet, chain: "solana:devnet", method: type === "TRANSACTION" ? "signTransaction" : "signMessage", walletName: "Test", index: 1, total: 1 });

/** An approval exactly as approveSigning seals it. */
const approvalFor = (ph: string, t: "TRANSACTION" | "MESSAGE", o: { rid?: string; ttl?: number; now?: number; wallet?: string; to?: string | null } = {}) =>
  sealToken("approval", { rid: o.rid ?? "rid-1", w: o.wallet ?? W, sid: "s".repeat(32), ph, t, choice: "OVERRIDE", lvl: "CRITICAL", to: o.to === undefined ? SITE : o.to }, o.ttl ?? 120_000, o.now ?? Date.now());

/** The extension's request, answered by the real route handler in-process; every call is recorded. */
let calls: Array<{ url: string; init: RequestInit }>;
const viaRoute: ConfirmDeps = {
  digest,
  fetch: async (url, init) => {
    calls.push({ url, init });
    return confirmRoute(new Request(url, { ...init, headers: { ...(init.headers as Record<string, string>), "x-forwarded-for": "10.7.7.7" } }));
  },
};

beforeEach(() => {
  calls = [];
  resetReplayRegistry();
  resetRateLimits();
});
afterEach(() => vi.unstubAllEnvs());

describe("the extension computes the payload hash the way the server binds approvals", () => {
  it("legacy and v0 transactions (the message the signatures cover) and messages", async () => {
    for (const [type, bytes] of [["TRANSACTION", legacyTx()], ["TRANSACTION", v0Tx()], ["MESSAGE", message()]] as const) {
      expect(await payloadHashOfRequest(reviewRequest(type, bytes), digest)).toBe(await payloadHashOf(type, bytes));
    }
    expect(await payloadHashOfRequest({ ...reviewRequest("MESSAGE", message()), type: "UNREADABLE", payload: null }, digest)).toBeNull();
  });

  it("deterministic byte identity: the same message under other signatures hashes the same; any other byte does not", async () => {
    const unsigned = legacyTx();
    const { tx } = buildTx([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 7 })]);
    tx.partialSign(keypair(1));
    const signed = new Uint8Array((tx as Transaction).serialize({ requireAllSignatures: false, verifySignatures: false }));
    expect(signed).not.toEqual(unsigned);
    const h = (type: "TRANSACTION" | "MESSAGE", b: Uint8Array) => payloadHashOfRequest(reviewRequest(type, b), digest);
    expect(await h("TRANSACTION", signed)).toBe(await h("TRANSACTION", unsigned));
    // Same length, same structure, one amount different.
    expect(legacyTx(8).length).toBe(unsigned.length);
    expect(await h("TRANSACTION", legacyTx(8))).not.toBe(await h("TRANSACTION", unsigned));
    expect(await h("MESSAGE", message("Nonce: 12345678"))).not.toBe(await h("MESSAGE", message("Nonce: 12345679")));
  });
});

describe("confirming an approval with the Presign server before the wallet is asked", () => {
  it("a genuine approval for exactly these bytes, wallet and site is confirmed once", async () => {
    const bytes = legacyTx();
    const req = reviewRequest("TRANSACTION", bytes);
    const token = approvalFor((await payloadHashOf("TRANSACTION", bytes))!, "TRANSACTION");
    expect(await confirmApproval(PRESIGN_ORIGINS.mainnet, SITE, req, token, viaRoute)).toEqual({ ok: true });
    expect(calls.map((c) => c.url)).toEqual([`${PRESIGN_ORIGINS.mainnet}${CONFIRM_PATH}`]);
    const again = await confirmApproval(PRESIGN_ORIGINS.mainnet, SITE, req, token, viaRoute);
    expect(again).toMatchObject({ ok: false, reason: expect.stringMatching(/already used/) });
  });

  it("the one request: POST, no cookies or credentials, no redirects followed, only the token and the hash", async () => {
    const bytes = message();
    const ph = (await payloadHashOf("MESSAGE", bytes))!;
    await confirmApproval(PRESIGN_ORIGINS.devnet, SITE, reviewRequest("MESSAGE", bytes), approvalFor(ph, "MESSAGE"), viaRoute);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe("https://presign-devnet.vercel.app/api/presign/signing/verify-approval");
    expect(init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error", cache: "no-store" });
    expect(Object.keys(JSON.parse(String(init.body))).sort()).toEqual(["approvalToken", "payloadHash"]);
    expect(init.headers).toEqual({ "content-type": "application/json" });
  });

  it("an approval for other bytes, a forged one, an expired one or one of another type is refused", async () => {
    const bytes = legacyTx();
    const req = reviewRequest("TRANSACTION", bytes);
    const ph = (await payloadHashOf("TRANSACTION", bytes))!;
    const otherPh = (await payloadHashOf("TRANSACTION", v0Tx()))!;
    expect(await confirmApproval(PRESIGN_ORIGINS.mainnet, SITE, req, approvalFor(otherPh, "TRANSACTION", { rid: "rid-a" }), viaRoute)).toMatchObject({ ok: false, reason: expect.stringMatching(/different bytes/) });
    expect(await confirmApproval(PRESIGN_ORIGINS.mainnet, SITE, req, "x".repeat(40), viaRoute)).toMatchObject({ ok: false, reason: expect.stringMatching(/did not issue it/) });
    const forgedSeal = `${approvalFor(ph, "TRANSACTION", { rid: "rid-b" }).split(".")[0]}.${"A".repeat(43)}`;
    expect(await confirmApproval(PRESIGN_ORIGINS.mainnet, SITE, req, forgedSeal, viaRoute)).toMatchObject({ ok: false, reason: expect.stringMatching(/did not issue it/) });
    expect(await confirmApproval(PRESIGN_ORIGINS.mainnet, SITE, req, approvalFor(ph, "TRANSACTION", { rid: "rid-c", ttl: 60_000, now: Date.now() - 120_000 }), viaRoute)).toMatchObject({ ok: false, reason: expect.stringMatching(/expired/) });
    // The server's answer must name this request's type too.
    const lying: ConfirmDeps = { digest, fetch: async () => new Response(JSON.stringify({ success: true, data: { valid: true, payloadHash: ph, type: "MESSAGE", walletAddress: W, targetOrigin: SITE } })) };
    expect(await confirmApproval(PRESIGN_ORIGINS.mainnet, SITE, req, approvalFor(ph, "TRANSACTION", { rid: "rid-d" }), lying)).toMatchObject({ ok: false, reason: expect.stringMatching(/different request/) });
    // A refused attempt does not burn the genuine approval.
    expect(await confirmApproval(PRESIGN_ORIGINS.mainnet, SITE, req, approvalFor(ph, "TRANSACTION", { rid: "rid-a" }), viaRoute)).toEqual({ ok: true });
  });

  it("an approval made for another wallet or another site is refused, even for the same bytes", async () => {
    const bytes = message();
    const ph = (await payloadHashOf("MESSAGE", bytes))!;
    const other = ATTACKER.toBase58();
    expect(await confirmApproval(PRESIGN_ORIGINS.mainnet, SITE, reviewRequest("MESSAGE", bytes), approvalFor(ph, "MESSAGE", { rid: "w", wallet: other }), viaRoute)).toMatchObject({ ok: false, reason: expect.stringMatching(/another wallet/) });
    expect(await confirmApproval(PRESIGN_ORIGINS.mainnet, SITE, reviewRequest("MESSAGE", bytes), approvalFor(ph, "MESSAGE", { rid: "s", to: "https://evil.example" }), viaRoute)).toMatchObject({ ok: false, reason: expect.stringMatching(/another site/) });
    expect(await confirmApproval(PRESIGN_ORIGINS.mainnet, SITE, reviewRequest("MESSAGE", bytes), approvalFor(ph, "MESSAGE", { rid: "n", to: null }), viaRoute)).toMatchObject({ ok: false, reason: expect.stringMatching(/another site/) });
  });

  it("only ever asks an allowed Presign origin; no answer means no approval", async () => {
    const req = reviewRequest("MESSAGE", message());
    const token = approvalFor((await payloadHashOf("MESSAGE", message()))!, "MESSAGE");
    for (const origin of ["https://evil.example", PRESIGN_ORIGINS.local, "https://presign-app.vercel.app.evil.example", "https://solana-ai-defender.vercel.app", "https://x.vercel.app"]) {
      expect(await confirmApproval(origin, SITE, req, token, viaRoute)).toMatchObject({ ok: false, reason: expect.stringMatching(/not Presign/) });
    }
    expect(calls).toEqual([]);
    const down: ConfirmDeps = { digest, fetch: async () => { throw new TypeError("network down"); } };
    expect(await confirmApproval(PRESIGN_ORIGINS.devnet, SITE, req, token, down)).toMatchObject({ ok: false, reason: expect.stringMatching(/could not confirm/) });
    const redirected: ConfirmDeps = { digest, fetch: async () => { throw new TypeError("Failed to fetch: redirect mode is set to error"); } };
    expect(await confirmApproval(PRESIGN_ORIGINS.devnet, SITE, req, token, redirected)).toMatchObject({ ok: false });
    const serverError: ConfirmDeps = { digest, fetch: async () => new Response("oops", { status: 502 }) };
    expect(await confirmApproval(PRESIGN_ORIGINS.devnet, SITE, req, token, serverError)).toMatchObject({ ok: false });
    const malformed: ConfirmDeps = { digest, fetch: async () => new Response("{not json") };
    expect(await confirmApproval(PRESIGN_ORIGINS.devnet, SITE, req, token, malformed)).toMatchObject({ ok: false });
    const unreadable: ReviewRequest = { ...req, type: "UNREADABLE", payload: null };
    expect(await confirmApproval(PRESIGN_ORIGINS.devnet, SITE, unreadable, token, viaRoute)).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });
});
