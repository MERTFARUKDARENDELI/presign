import { describe, expect, it, vi } from "vitest";
import { createReviewer, NOT_CONNECTED, TIMED_OUT, type ReviewerDeps } from "@/extension/src/lib/channel";
import { installInterceptor, PresignRejection, type HookWindow } from "@/extension/src/lib/intercept";
import type { ReviewRequest } from "@/extension/src/lib/protocol";

const request = { type: "MESSAGE", payload: "aGVsbG8=", walletAddress: null, chain: null, method: "signMessage", walletName: null, index: 1, total: 1 } as ReviewRequest;

function deps(over: Partial<ReviewerDeps> = {}) {
  const sent: unknown[] = [];
  const timers: Array<() => void> = [];
  let n = 0;
  const d: ReviewerDeps = {
    ready: () => true,
    send: (m) => void sent.push(m),
    newId: () => `id-${++n}`,
    timeoutMs: 1_000,
    setTimer: (fn) => (timers.push(fn), timers.length - 1),
    clearTimer: (t) => void (timers[t as number] = () => undefined),
    ...over,
  };
  return { d, sent, fire: () => timers.forEach((t) => t()) };
}

/** An injected provider whose wallet records every call. */
function provider() {
  const calls: string[] = [];
  const p = { publicKey: { toBase58: () => "11111111111111111111111111111111" }, async signMessage(m: Uint8Array) { calls.push("signMessage"); return { signature: new Uint8Array(64), m }; }, async signTransaction(tx: unknown) { calls.push("signTransaction"); return tx; } };
  return { p, calls };
}

describe("the page hook's review channel fails closed", () => {
  it("without a connected channel the request is refused at once, nothing is sent, and the wallet is never asked", async () => {
    const { d, sent } = deps({ ready: () => false });
    const reviewer = createReviewer(d);
    expect(await reviewer.review(request)).toEqual({ approved: false, reason: NOT_CONNECTED });
    expect(sent).toEqual([]);

    const hook = installInterceptor(new EventTarget() as HookWindow, { review: reviewer.review, host: () => "dapp.example" });
    const { p, calls } = provider();
    hook.patchProvider(p, "Injected");
    await expect(p.signMessage(new TextEncoder().encode("hello"))).rejects.toBeInstanceOf(PresignRejection);
    expect(calls).toEqual([]);
  });

  it("a review with no decision in time is refused; a decision arriving afterwards changes nothing", async () => {
    const { d, fire } = deps();
    const reviewer = createReviewer(d);
    const pending = reviewer.review(request);
    fire();
    expect(await pending).toEqual({ approved: false, reason: TIMED_OUT });
    reviewer.settle({ kind: "decision", id: "id-1", approved: true });
    expect(await pending).toEqual({ approved: false, reason: TIMED_OUT });
  });

  it("only an explicit approval for this request's id approves; anything else is ignored or refuses", async () => {
    const { d, sent } = deps();
    const reviewer = createReviewer(d);
    const pending = reviewer.review(request);
    expect(sent).toEqual([{ kind: "review", id: "id-1", request }]);
    for (const noise of [null, { kind: "decision" }, { kind: "decision", id: "id-9", approved: true }, { kind: "other", id: "id-1", approved: true }]) reviewer.settle(noise);
    reviewer.settle({ kind: "decision", id: "id-1", approved: true, rid: "rid-7" });
    expect(await pending).toEqual({ approved: true, id: "rid-7" });

    const second = reviewer.review(request);
    reviewer.settle({ kind: "decision", id: "id-2", approved: "true", reason: 42 });
    expect(await second).toMatchObject({ approved: false, reason: expect.stringMatching(/cancelled/) });
  });

  it("the wallet is asked only after an explicit approval arrives over the channel", async () => {
    const { d } = deps();
    const reviewer = createReviewer(d);
    const hook = installInterceptor(new EventTarget() as HookWindow, { review: reviewer.review, host: () => "dapp.example" });
    const { p, calls } = provider();
    hook.patchProvider(p, "Injected");
    const signing = p.signMessage(new TextEncoder().encode("hello"));
    await Promise.resolve();
    expect(calls).toEqual([]);
    reviewer.settle({ kind: "decision", id: "id-1", approved: false, reason: "you cancelled" });
    await expect(signing).rejects.toBeInstanceOf(PresignRejection);
    expect(calls).toEqual([]);
    vi.restoreAllMocks();
  });
});
