import { ed25519 } from "@noble/curves/ed25519.js";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ed25519Verifier } from "@/extension/src/lib/ed25519";
import { installInterceptor, PresignRejection, type HookWindow, type InterceptorDeps } from "@/extension/src/lib/intercept";
import type { ReviewRequest } from "@/extension/src/lib/protocol";
import { createSignInMessageText } from "@/extension/src/lib/siws";
import { confirmedApproval } from "../helpers/approval";

// The signer's real key, so signatures are real ed25519 signatures.
const key = Keypair.generate();
const W = key.publicKey.toBase58();
const secret = key.secretKey.slice(0, 32);
const sign = (m: Uint8Array) => ed25519.sign(m, secret);
const text = (s: string) => new TextEncoder().encode(s);

let deps: InterceptorDeps;
let hook: ReturnType<typeof installInterceptor>;

beforeEach(() => {
  deps = { review: vi.fn(async (r: ReviewRequest) => confirmedApproval(r, "rid")), report: vi.fn(), host: () => "dapp.example", verifySignature: ed25519Verifier(globalThis.crypto.subtle) };
  hook = installInterceptor(new EventTarget() as HookWindow, deps);
});

type Fns = Record<string, (...i: unknown[]) => Promise<unknown>>;
/** A Wallet Standard wallet whose signMessage output is chosen by the test. */
const standardWallet = (signMessage: (message: Uint8Array) => unknown, signIn?: (input: Record<string, string>) => unknown) =>
  hook.wrapWallet({
    version: "1.0.0", name: "Signer", icon: "", chains: ["solana:mainnet"], accounts: [{ address: W }],
    features: {
      "solana:signMessage": { version: "1.0.0", signMessage: async (...inputs: Array<{ message: Uint8Array }>) => inputs.map((i) => signMessage(i.message)) },
      "solana:signIn": { version: "1.0.0", signIn: async (...inputs: Array<Record<string, string>>) => inputs.map((i) => signIn!(i)) },
    },
  }) as unknown as { features: Record<string, Fns> };
const account = { address: W };

describe("the wallet's message signature must be valid for the reviewed bytes and the reviewing account", () => {
  it("Wallet Standard signMessage: a real signature over the reviewed text reaches the site", async () => {
    const w = standardWallet((m) => ({ signedMessage: m, signature: sign(m) }));
    await expect(w.features["solana:signMessage"].signMessage({ message: text("Sign in to dapp.example"), account })).resolves.toHaveLength(1);
  });

  it("Wallet Standard signMessage: the reviewed bytes echoed back with a signature over other bytes are withheld", async () => {
    const w = standardWallet((m) => ({ signedMessage: m, signature: sign(text("Transfer everything")) }));
    await expect(w.features["solana:signMessage"].signMessage({ message: text("Sign in to dapp.example"), account })).rejects.toBeInstanceOf(PresignRejection);
    expect(deps.report).toHaveBeenCalledWith("rid", expect.objectContaining({ status: "BLOCKED" }));
  });

  it("Wallet Standard signMessage: a result without the signed message is withheld", async () => {
    const w = standardWallet((m) => ({ signature: sign(m) }));
    await expect(w.features["solana:signMessage"].signMessage({ message: text("Sign in to dapp.example"), account })).rejects.toBeInstanceOf(PresignRejection);
  });

  it("Wallet Standard signIn: the signature must be over the rebuilt text", async () => {
    const good = standardWallet(() => null, (i) => {
      const t = text(createSignInMessageText({ ...i, domain: "dapp.example", address: W }));
      return { account, signedMessage: t, signature: sign(t) };
    });
    await expect(good.features["solana:signIn"].signIn({ statement: "Welcome", nonce: "abc12345" })).resolves.toHaveLength(1);
    const bad = standardWallet(() => null, (i) => ({ account, signedMessage: text(createSignInMessageText({ ...i, domain: "dapp.example", address: W })), signature: sign(text("other")) }));
    await expect(bad.features["solana:signIn"].signIn({ statement: "Welcome", nonce: "abc12345" })).rejects.toBeInstanceOf(PresignRejection);
  });

  /** Injected provider (window.phantom.solana style): signMessage returns { signature, publicKey }. */
  const injected = (sig: (m: Uint8Array) => Uint8Array) =>
    new (class Provider {
      publicKey = { toBase58: () => W };
      async signTransaction(tx: unknown) {
        return tx;
      }
      async signMessage(m: Uint8Array) {
        return { signature: sig(m), publicKey: this.publicKey };
      }
      async request(args: { method: string; params: { message: string } }) {
        return { signature: bs58.encode(sig(bs58.decode(args.params.message))), publicKey: W };
      }
    })();

  it("injected signMessage: a valid signature passes, a signature over other bytes is withheld", async () => {
    const honest = injected(sign);
    hook.patchProvider(honest, "Test");
    await expect(honest.signMessage(text("Sign in to dapp.example"))).resolves.toMatchObject({ publicKey: honest.publicKey });
    const liar = injected(() => sign(text("Transfer everything")));
    hook.patchProvider(liar, "Test");
    await expect(liar.signMessage(text("Sign in to dapp.example"))).rejects.toBeInstanceOf(PresignRejection);
  });

  it("request({ method: 'signMessage' }): a base58 signature is checked too", async () => {
    const honest = injected(sign);
    hook.patchProvider(honest, "Test");
    await expect(honest.request({ method: "signMessage", params: { message: bs58.encode(text("Sign in")) } })).resolves.toMatchObject({ publicKey: W });
    const liar = injected(() => sign(text("Transfer everything")));
    hook.patchProvider(liar, "Test");
    await expect(liar.request({ method: "signMessage", params: { message: bs58.encode(text("Sign in")) } })).rejects.toBeInstanceOf(PresignRejection);
  });

  it("a browser that cannot check ed25519 lets a signature through (the wallet still signed the reviewed copy)", async () => {
    deps.verifySignature = async () => null;
    const liar = injected(() => sign(text("Transfer everything")));
    hook.patchProvider(liar, "Test");
    await expect(liar.signMessage(text("Sign in to dapp.example"))).resolves.toBeTruthy();
  });

  it("the verifier itself: valid, invalid and malformed inputs", async () => {
    const verify = ed25519Verifier(globalThis.crypto.subtle);
    const m = text("hello");
    expect(await verify(m, sign(m), key.publicKey.toBytes())).toBe(true);
    expect(await verify(text("hellO"), sign(m), key.publicKey.toBytes())).toBe(false);
    expect(await verify(m, new Uint8Array(10), key.publicKey.toBytes())).toBe(false);
  });
});
