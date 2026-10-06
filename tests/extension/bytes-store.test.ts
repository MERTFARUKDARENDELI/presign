import { SystemProgram, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { asTransactionBytes, base58ToBytes, base64ToBytes, bytesToBase64, isSerializedTransaction, onlySignaturesChanged, requestKey } from "@/extension/src/lib/bytes";
import { isAllowedPresignOrigin, presignBaseFor, PRESIGN_ORIGINS, REVIEW_TTL_MS, validateReviewRequest, type ReviewRequest } from "@/extension/src/lib/protocol";
import { applyConfirmation, applyOutcome, DEFAULT_SETTINGS, handleExternal, logEntryForUnreviewed, modeFor, newPending, type PendingReview } from "@/extension/src/lib/store";
import { messageBytesOf } from "@/lib/wallet/signing";
import { ATTACKER, buildTx, WALLET } from "../helpers/fixtures";

const W = WALLET.toBase58();
const tx = () => buildTx([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 42 })]).bytes;

describe("byte helpers", () => {
  it("base64 / base58 round-trip like the libraries the app uses", () => {
    const b = tx();
    expect(base64ToBytes(bytesToBase64(b))).toEqual(b);
    expect(base58ToBytes(bs58.encode(b))).toEqual(b);
    expect(base58ToBytes("0OIl")).toBeNull();
    expect(base64ToBytes("not base64!")).toBeNull();
  });

  it("recognizes a serialized transaction, and wraps a bare message into one", () => {
    const b = tx();
    expect(isSerializedTransaction(b)).toBe(true);
    const message = messageBytesOf(b);
    expect(isSerializedTransaction(message)).toBe(false);
    const wrapped = asTransactionBytes(message)!;
    expect(isSerializedTransaction(wrapped)).toBe(true);
    expect(messageBytesOf(wrapped)).toEqual(message);
    expect(VersionedTransaction.deserialize(wrapped).message.staticAccountKeys[0].toBase58()).toBe(W);
  });

  it("a wallet may fill signature slots — any other change is detected", () => {
    const original = tx();
    const signed = Uint8Array.from(original);
    signed.fill(9, 1, 65);
    expect(onlySignaturesChanged(original, signed)).toBe(true);
    const tampered = Uint8Array.from(signed);
    tampered[tampered.length - 2] ^= 0xff;
    expect(onlySignaturesChanged(original, tampered)).toBe(false);
    expect(onlySignaturesChanged(original, signed.subarray(0, signed.length - 1))).toBe(false);
    const countChanged = Uint8Array.from(original);
    countChanged[0] = 2;
    expect(onlySignaturesChanged(original, countChanged)).toBe(false);
  });

  it("a request's identity ignores signatures (so a wallet's internal re-entry is recognized)", () => {
    const original = tx();
    const signed = Uint8Array.from(original);
    signed.fill(3, 1, 65);
    expect(requestKey("TRANSACTION", signed)).toBe(requestKey("TRANSACTION", original));
    expect(requestKey("TRANSACTION", asTransactionBytes(messageBytesOf(original))!)).toBe(requestKey("TRANSACTION", original));
    expect(requestKey("MESSAGE", original)).not.toBe(requestKey("TRANSACTION", original));
  });
});

describe("request validation (data from web pages is untrusted)", () => {
  const good: ReviewRequest = { type: "TRANSACTION", payload: bytesToBase64(tx()), walletAddress: W, chain: "solana:mainnet", method: "signTransaction", walletName: "Phantom", index: 1, total: 1 };

  it("accepts a well-formed request and strips control characters", () => {
    expect(validateReviewRequest({ ...good, walletName: "Pha\u0000ntom\u001b" })).toMatchObject({ walletName: "Phantom" });
  });

  it("rejects bad types, methods, payloads, batch positions; drops malformed optional fields", () => {
    expect(validateReviewRequest({ ...good, type: "EVAL" })).toBeNull();
    expect(validateReviewRequest({ ...good, method: "drain" })).toBeNull();
    expect(validateReviewRequest({ ...good, payload: "%%%" })).toBeNull();
    expect(validateReviewRequest({ ...good, payload: "A".repeat(8_004) })).toBeNull();
    expect(validateReviewRequest({ ...good, index: 3, total: 2 })).toBeNull();
    expect(validateReviewRequest({ ...good, walletAddress: "not-an-address", chain: "ethereum:1" })).toMatchObject({ walletAddress: null, chain: null });
    expect(validateReviewRequest({ ...good, type: "UNREADABLE", payload: "x" })).toMatchObject({ payload: null, reason: expect.any(String) });
  });

  it("picks the Presign instance by the request's chain", () => {
    expect(presignBaseFor("solana:devnet", "production")).toBe(PRESIGN_ORIGINS.devnet);
    expect(presignBaseFor("solana:mainnet", "production")).toBe(PRESIGN_ORIGINS.mainnet);
    expect(presignBaseFor(null, "production")).toBe(PRESIGN_ORIGINS.mainnet);
    expect(presignBaseFor("solana:devnet", "local", true)).toBe(PRESIGN_ORIGINS.local);
    // A production build never sends a review to localhost, even if the stored setting says "local".
    expect(presignBaseFor("solana:devnet", "local", false)).toBe(PRESIGN_ORIGINS.devnet);
    expect(presignBaseFor("solana:devnet", "local")).toBe(PRESIGN_ORIGINS.devnet);
    expect(isAllowedPresignOrigin(PRESIGN_ORIGINS.local)).toBe(false);
    expect(isAllowedPresignOrigin(PRESIGN_ORIGINS.local, true)).toBe(true);
    expect(isAllowedPresignOrigin(PRESIGN_ORIGINS.mainnet)).toBe(true);
  });
});

describe("background decisions", () => {
  const payload = bytesToBase64(tx());
  const request: ReviewRequest = { type: "TRANSACTION", payload, walletAddress: W, chain: null, method: "signTransaction", walletName: null, index: 1, total: 1 };
  const NOW = 1_000_000;
  const setup = () => {
    const r = newPending({ rid: "rid-1", origin: "https://dapp.example", request, tabId: 7, frameId: 0, hookId: "h1", presignOrigin: PRESIGN_ORIGINS.mainnet, now: NOW });
    return { r, reviews: new Map<string, PendingReview>([[r.rid, r]]) };
  };
  const approve = (over: Partial<{ payload: string; payloadHash: string; approvalToken: string }> = {}) => ({ kind: "presign:approve" as const, rid: "rid-1", payload, payloadHash: "a".repeat(64), approvalToken: "t".repeat(40), riskLevel: "HIGH", choice: "OVERRIDE", ...over });

  it("only the Presign origin the review was opened on may read or answer it", () => {
    const { reviews } = setup();
    expect(handleExternal({ kind: "presign:get", rid: "rid-1" }, "https://evil.example", reviews, NOW).reply).toMatchObject({ ok: false, error: "FORBIDDEN_ORIGIN" });
    expect(handleExternal({ kind: "presign:get", rid: "rid-1" }, PRESIGN_ORIGINS.devnet, reviews, NOW).reply).toMatchObject({ ok: false, error: "FORBIDDEN_ORIGIN" });
    expect(handleExternal({ kind: "presign:get", rid: "nope" }, PRESIGN_ORIGINS.mainnet, reviews, NOW).reply).toMatchObject({ ok: false, error: "UNKNOWN_REQUEST" });
    expect(handleExternal({ kind: "presign:get", rid: "rid-1" }, PRESIGN_ORIGINS.mainnet, reviews, NOW).reply).toMatchObject({ ok: true, ticket: { origin: "https://dapp.example", request } });
  });

  it("an approval must be for exactly the captured payload, with a server approval, once", () => {
    const { r, reviews } = setup();
    expect(handleExternal(approve({ payload: bytesToBase64(tx().map((b, i) => (i === 100 ? b ^ 1 : b))) }), PRESIGN_ORIGINS.mainnet, reviews, NOW).reply).toMatchObject({ ok: false, error: "PAYLOAD_MISMATCH" });
    expect(handleExternal(approve({ approvalToken: "" }), PRESIGN_ORIGINS.mainnet, reviews, NOW).reply).toMatchObject({ ok: false, error: "APPROVAL_MISSING" });
    const ok = handleExternal(approve(), PRESIGN_ORIGINS.mainnet, reviews, NOW);
    expect(ok.reply).toEqual({ ok: true });
    // Not to the wallet yet: first confirmed with the Presign server.
    expect(ok.effect).toMatchObject({ kind: "confirm", approvalToken: expect.any(String) });
    expect(r.state).toBe("verifying");
    expect(handleExternal(approve(), PRESIGN_ORIGINS.mainnet, reviews, NOW).reply).toMatchObject({ ok: false, error: "NOT_PENDING" });
    const confirmed = applyConfirmation(r, { ok: true });
    expect(confirmed.effect).toMatchObject({ kind: "forward", approved: true });
    expect(r.state).toBe("forwarded");
    expect(applyConfirmation(r, { ok: true }).reply).toMatchObject({ ok: false, error: "NOT_VERIFYING" });
  });

  it("an approval the server does not confirm never reaches the wallet", () => {
    const { r, reviews } = setup();
    handleExternal(approve(), PRESIGN_ORIGINS.mainnet, reviews, NOW);
    const refused = applyConfirmation(r, { ok: false, reason: "the approval was not confirmed (Presign's server did not issue it), so nothing was sent to your wallet." });
    expect(refused.reply).toMatchObject({ ok: false, error: "APPROVAL_UNCONFIRMED" });
    // Refused towards the site, while the review window stays open to show why.
    expect(refused.effect).toMatchObject({ kind: "forward", approved: false, keepWindow: true });
    expect(r.state).toBe("blocked");
    expect(r.detail).toMatch(/not confirmed/);
  });

  it("cancel relays a refusal; an expired review can no longer be approved", () => {
    const a = setup();
    expect(handleExternal({ kind: "presign:cancel", rid: "rid-1", riskLevel: "CRITICAL" }, PRESIGN_ORIGINS.mainnet, a.reviews, NOW).effect).toMatchObject({ kind: "forward", approved: false });
    expect(a.r.state).toBe("cancelled");
    const b = setup();
    const late = handleExternal(approve(), PRESIGN_ORIGINS.mainnet, b.reviews, NOW + REVIEW_TTL_MS + 1);
    expect(late.reply).toMatchObject({ ok: false, error: "EXPIRED" });
    expect(late.effect).toMatchObject({ kind: "forward", approved: false });
  });

  it("an unreadable request cannot be approved", () => {
    const r = newPending({ rid: "rid-2", origin: "https://dapp.example", request: { ...request, type: "UNREADABLE", payload: null }, tabId: 1, frameId: 0, hookId: "h", presignOrigin: PRESIGN_ORIGINS.mainnet, now: NOW });
    expect(handleExternal(approve({ payload: "" }), PRESIGN_ORIGINS.mainnet, new Map([["rid-1", r]]), NOW).reply).toMatchObject({ ok: false, error: "UNVERIFIABLE" });
  });

  it("the wallet's outcome is recorded only after a forwarded approval", () => {
    const { r } = setup();
    expect(applyOutcome(r, { status: "SIGNED", detail: "ok" })).toBe(false);
    r.state = "forwarded";
    expect(applyOutcome(r, { status: "BLOCKED", detail: "changed" })).toBe(true);
    expect(r.state).toBe("blocked");
  });

  it("requests on Presign's own pages, with protection off, or on a skipped site are not reviewed twice", () => {
    expect(modeFor(PRESIGN_ORIGINS.mainnet, DEFAULT_SETTINGS)).toMatchObject({ mode: "pass" });
    expect(modeFor("https://dapp.example", { ...DEFAULT_SETTINGS, enabled: false })).toMatchObject({ mode: "pass" });
    expect(modeFor("https://dapp.example", { ...DEFAULT_SETTINGS, skipSites: ["https://dapp.example"] })).toMatchObject({ mode: "pass" });
    expect(modeFor("https://dapp.example", DEFAULT_SETTINGS)).toEqual({ mode: "review" });
  });
});

describe("log entries for hook outcomes that belong to no review", () => {
  it("a wallet method that could not be wrapped is logged as not protected; unknown outcomes are not logged", () => {
    const e = logEntryForUnreviewed("https://dapp.example", { status: "UNPROTECTED", method: "signTransaction", detail: "Phantom: signTransaction could not be wrapped\u0007" }, 5);
    expect(e).toEqual({ at: 5, origin: "https://dapp.example", method: "signTransaction", type: "PROVIDER", state: "unprotected", riskLevel: null, detail: "Phantom: signTransaction could not be wrapped" });
    expect(logEntryForUnreviewed("https://dapp.example", { status: "BLOCKED", method: "signIn", detail: "x" }, 5)?.state).toBe("blocked");
    expect(logEntryForUnreviewed("https://dapp.example", { status: "SIGNED" }, 5)).toBeNull();
    expect(logEntryForUnreviewed("https://dapp.example", { status: "UNPROTECTED", method: "<script>" }, 5)?.method).toBe("signIn");
    expect(logEntryForUnreviewed("https://dapp.example", null, 5)).toBeNull();
  });
});
