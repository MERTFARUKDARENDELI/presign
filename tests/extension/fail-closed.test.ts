import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SystemProgram } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "@/extension/src/lib/bytes";
import { answerFor, reviewableRequest } from "@/extension/src/lib/protocol";
import { ATTACKER, buildTx, WALLET } from "../helpers/fixtures";

const W = WALLET.toBase58();
const tx = () => bytesToBase64(buildTx([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 1 })]).bytes);

describe("with protection on, a request Presign cannot review is never sent to the wallet unreviewed", () => {
  it("a message too large to review opens the review as UNREADABLE (Cancel only), with the reason", () => {
    const big = bytesToBase64(new Uint8Array(6_100).fill(65));
    const r = reviewableRequest({ type: "MESSAGE", payload: big, walletAddress: W, chain: null, method: "signMessage", walletName: "Phantom", index: 1, total: 1 });
    expect(r).toMatchObject({ type: "UNREADABLE", payload: null, method: "signMessage", walletAddress: W, walletName: "Phantom" });
    expect(r!.reason).toMatch(/larger than Presign can review/);
  });

  it("a batch of more than 50 transactions opens the review as UNREADABLE", () => {
    const r = reviewableRequest({ type: "TRANSACTION", payload: tx(), walletAddress: W, chain: "solana:mainnet", method: "signAllTransactions", walletName: null, index: 1, total: 51 });
    expect(r).toMatchObject({ type: "UNREADABLE", payload: null, index: 1, total: 51 });
    expect(r!.reason).toMatch(/51 signatures/);
  });

  it("a malformed request with a known method is UNREADABLE; without a known method there is nothing to review", () => {
    expect(reviewableRequest({ type: "TRANSACTION", payload: "%%%", method: "signTransaction", index: 1, total: 1 })).toMatchObject({ type: "UNREADABLE", reason: expect.stringMatching(/malformed/) });
    expect(reviewableRequest({ type: "TRANSACTION", payload: tx(), method: "drainEverything", index: 1, total: 1 })).toBeNull();
    expect(reviewableRequest("nonsense")).toBeNull();
  });

  it("a readable request is reviewed as sent", () => {
    expect(reviewableRequest({ type: "TRANSACTION", payload: tx(), walletAddress: W, chain: null, method: "signTransaction", walletName: null, index: 1, total: 1 })).toMatchObject({ type: "TRANSACTION", payload: tx() });
  });

  it("the page's answer: only an explicit pass (protection off for the site) goes straight to the wallet; any failure is a refusal", () => {
    expect(answerFor({ ok: true, mode: "pass" }, false)).toEqual({ kind: "approve" });
    expect(answerFor({ ok: true, mode: "review" }, false)).toEqual({ kind: "wait" });
    const failures = [answerFor({ ok: false, error: "could not open the review window" }, false), answerFor(undefined, true), answerFor({ ok: true, mode: "review" }, true), answerFor(undefined, false)];
    for (const f of failures) expect(f.kind).toBe("deny");
    expect(failures[0]).toMatchObject({ reason: expect.stringMatching(/could not open the review window.*not sent to your wallet/) });
    expect(failures[1]).toMatchObject({ reason: expect.stringMatching(/reload this page/) });
  });

  it("the extension never offers to continue without a review (no confirm dialogs)", () => {
    const dir = join(process.cwd(), "extension", "src");
    const files = [...readdirSync(dir).map((f) => join(dir, f)), ...readdirSync(join(dir, "lib")).map((f) => join(dir, "lib", f))].filter((f) => f.endsWith(".ts"));
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(/\bconfirm\s*\(|\.confirm\b/);
  });
});
