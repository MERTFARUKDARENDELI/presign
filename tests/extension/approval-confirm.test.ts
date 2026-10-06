import { SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as confirmRoute } from "@/app/api/presign/signing/verify-approval/route";
import { CONFIRM_PATH, confirmApproval, payloadHashOfRequest, type ConfirmDeps } from "@/extension/src/lib/approval";
import { bytesToBase64 } from "@/extension/src/lib/bytes";
import { PRESIGN_ORIGINS, type ReviewRequest } from "@/extension/src/lib/protocol";
import { resetRateLimits } from "@/lib/api/rate-limit";
import { payloadHashOf } from "@/lib/presign/payload";
import { resetReplayRegistry } from "@/lib/presign/replay";
import { sealToken } from "@/lib/presign/tokens";
import { ATTACKER, BLOCKHASH, buildTx, WALLET } from "../helpers/fixtures";

const digest: ConfirmDeps["digest"] = (bytes) => crypto.subtle.digest("SHA-256", bytes as BufferSource);
const W = WALLET.toBase58();

const legacyTx = () => buildTx([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 7 })]).bytes;
const v0Tx = () => new VersionedTransaction(new TransactionMessage({ payerKey: WALLET, recentBlockhash: BLOCKHASH, instructions: [SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 9 })] }).compileToV0Message()).serialize();
const message = () => new TextEncoder().encode("Sign in to dapp.example\nNonce: 12345678");

const reviewRequest = (type: "TRANSACTION" | "MESSAGE", bytes: Uint8Array): ReviewRequest => ({ type, payload: bytesToBase64(bytes), walletAddress: W, chain: "solana:devnet", method: type === "TRANSACTION" ? "signTransaction" : "signMessage", walletName: "Test", index: 1, total: 1 });

/** An approval exactly as approveSigning seals it. */
const approvalFor = (ph: string, t: "TRANSACTION" | "MESSAGE", rid = "rid-1", ttl = 120_000, now = Date.now()) =>
  sealToken("approval", { rid, w: W, sid: "s".repeat(32), ph, t, choice: "OVERRIDE", lvl: "CRITICAL", to: null }, ttl, now);

/** The extension's request, answered by the real route handler in-process. */
let calls: string[];
const viaRoute: ConfirmDeps = {
  digest,
  fetch: async (url, init) => {
    calls.push(url);
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
});

describe("confirming an approval with the Presign server before the wallet is asked", () => {
  it("a genuine approval for exactly these bytes is confirmed once", async () => {
    const bytes = legacyTx();
    const req = reviewRequest("TRANSACTION", bytes);
    const token = approvalFor((await payloadHashOf("TRANSACTION", bytes))!, "TRANSACTION");
    expect(await confirmApproval(PRESIGN_ORIGINS.mainnet, req, token, viaRoute)).toEqual({ ok: true });
    expect(calls).toEqual([`${PRESIGN_ORIGINS.mainnet}${CONFIRM_PATH}`]);
    const again = await confirmApproval(PRESIGN_ORIGINS.mainnet, req, token, viaRoute);
    expect(again).toMatchObject({ ok: false, reason: expect.stringMatching(/already used/) });
  });

  it("an approval for other bytes, a forged one, an expired one or one of another type is refused", async () => {
    const bytes = legacyTx();
    const req = reviewRequest("TRANSACTION", bytes);
    const ph = (await payloadHashOf("TRANSACTION", bytes))!;
    const otherPh = (await payloadHashOf("TRANSACTION", v0Tx()))!;
    expect(await confirmApproval(PRESIGN_ORIGINS.mainnet, req, approvalFor(otherPh, "TRANSACTION", "rid-a"), viaRoute)).toMatchObject({ ok: false, reason: expect.stringMatching(/different bytes/) });
    expect(await confirmApproval(PRESIGN_ORIGINS.mainnet, req, "x".repeat(40), viaRoute)).toMatchObject({ ok: false, reason: expect.stringMatching(/did not issue it/) });
    const forgedSeal = `${approvalFor(ph, "TRANSACTION", "rid-b").split(".")[0]}.${"A".repeat(43)}`;
    expect(await confirmApproval(PRESIGN_ORIGINS.mainnet, req, forgedSeal, viaRoute)).toMatchObject({ ok: false, reason: expect.stringMatching(/did not issue it/) });
    expect(await confirmApproval(PRESIGN_ORIGINS.mainnet, req, approvalFor(ph, "TRANSACTION", "rid-c", 60_000, Date.now() - 120_000), viaRoute)).toMatchObject({ ok: false, reason: expect.stringMatching(/expired/) });
    // A message approval whose hash happens to be sent for a transaction review: the type must match too.
    const lying: ConfirmDeps = { digest, fetch: async () => new Response(JSON.stringify({ success: true, data: { valid: true, payloadHash: ph, type: "MESSAGE" } })) };
    expect(await confirmApproval(PRESIGN_ORIGINS.mainnet, req, approvalFor(ph, "TRANSACTION", "rid-d"), lying)).toMatchObject({ ok: false, reason: expect.stringMatching(/different request/) });
  });

  it("only ever asks an allowed Presign origin; no answer means no approval", async () => {
    const req = reviewRequest("MESSAGE", message());
    const token = approvalFor((await payloadHashOf("MESSAGE", message()))!, "MESSAGE");
    for (const origin of ["https://evil.example", PRESIGN_ORIGINS.local, "https://presign-app.vercel.app.evil.example"]) {
      expect(await confirmApproval(origin, req, token, viaRoute)).toMatchObject({ ok: false, reason: expect.stringMatching(/not Presign/) });
    }
    expect(calls).toEqual([]);
    const down: ConfirmDeps = { digest, fetch: async () => { throw new TypeError("network down"); } };
    expect(await confirmApproval(PRESIGN_ORIGINS.devnet, req, token, down)).toMatchObject({ ok: false, reason: expect.stringMatching(/could not confirm/) });
    const unreadable: ReviewRequest = { ...req, type: "UNREADABLE", payload: null };
    expect(await confirmApproval(PRESIGN_ORIGINS.devnet, unreadable, token, viaRoute)).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });
});
