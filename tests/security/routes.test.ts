import { SystemProgram } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as diagnoseRoute } from "@/app/api/ai/diagnose/route";
import { POST as cleanupPrepareRoute } from "@/app/api/cleanup/prepare/route";
import { POST as cleanupSubmitRoute } from "@/app/api/cleanup/submit/route";
import { POST as txSubmitRoute } from "@/app/api/transaction/submit/route";
import { resetAiStatus } from "@/lib/ai/status";
import { resetRateLimits } from "@/lib/api/rate-limit";
import { buildCleanupInstructions, messageHashOf, type CleanupIntent } from "@/lib/cleanup/intent";
import { DEMO } from "@/lib/demo/scenario";
import { getParsedAccounts } from "@/lib/solana/accounts";
import { rpcCall } from "@/lib/solana/client";
import { TOKEN_PROGRAM_ID } from "@/lib/solana/constants";
import { bytesToBase64 } from "@/lib/transaction/input";
import { ATTACKER, buildTx, keypair, MINT, WALLET, WALLET_ATA } from "../helpers/fixtures";

// HTTP-level tests: the real route handlers (rate limit, body limits, zod,
// error mapping) in front of the real verification code. Only the network edge
// is mocked, and every blocked request must leave it untouched.
vi.mock("@/lib/solana/client", async (importOriginal) => ({ ...(await importOriginal<object>()), rpcCall: vi.fn() }));
vi.mock("@/lib/solana/accounts", () => ({ getParsedAccounts: vi.fn() }));

const rpc = vi.mocked(rpcCall);
const accounts = vi.mocked(getParsedAccounts);

const W = WALLET.toBase58();
const OWNER = keypair(1);
const FAKE_KEY = `sk-test-${"x".repeat(40)}`;

let ip = 0;
function post(path: string, body: unknown, clientIp = `10.1.${Math.floor(++ip / 250)}.${ip % 250}`) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": clientIp },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function json(res: Response) {
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as { success: boolean; data: unknown; error: { code: string; message: string } | null } };
}

const intent: CleanupIntent = {
  action: "BURN_AND_CLOSE", owner: W, tokenAccount: WALLET_ATA.toBase58(), mint: MINT.toBase58(),
  tokenProgram: TOKEN_PROGRAM_ID, amountRaw: "1000", decimals: 6, destination: W, cluster: "devnet",
};

function signed(instructions = buildCleanupInstructions(intent), signer = OWNER) {
  const { tx, bytes } = buildTx(instructions);
  tx.partialSign(signer);
  return { b64: bytesToBase64(new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }))), bytes };
}

beforeEach(() => {
  rpc.mockReset();
  accounts.mockReset();
  resetRateLimits();
  resetAiStatus();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const networkUntouched = () => {
  expect(rpc).not.toHaveBeenCalled();
  expect(accounts).not.toHaveBeenCalled();
};

describe("POST /api/cleanup/submit", () => {
  it("rejects invalid JSON, oversized bodies and schema violations with 400 before any verification", async () => {
    expect((await json(await cleanupSubmitRoute(post("/api/cleanup/submit", "{not json")))).body.error?.code).toBe("INVALID_INPUT");
    expect((await json(await cleanupSubmitRoute(post("/api/cleanup/submit", "x".repeat(8_001))))).status).toBe(400);
    const bad = await json(await cleanupSubmitRoute(post("/api/cleanup/submit", { signedTransaction: "AA==", expectedMessageHash: "nothex", intent })));
    expect(bad.status).toBe(400);
    expect(bad.body.error?.code).toBe("INVALID_INPUT");
    const badIntent = await json(await cleanupSubmitRoute(post("/api/cleanup/submit", { signedTransaction: "AA==", expectedMessageHash: "a".repeat(64), intent: { ...intent, owner: "not-a-key" } })));
    expect(badIntent.status).toBe(400);
    networkUntouched();
  });

  it("returns 409 SECURITY_BLOCK for a signed tx that differs from the confirmed hash and never relays it", async () => {
    const confirmed = await messageHashOf(buildTx(buildCleanupInstructions(intent)).bytes);
    const tampered = signed([...buildCleanupInstructions(intent), SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 1_000_000 })]);
    const r = await json(await cleanupSubmitRoute(post("/api/cleanup/submit", { signedTransaction: tampered.b64, expectedMessageHash: confirmed, intent })));
    expect(r.status).toBe(409);
    expect(r.body.error?.code).toBe("SECURITY_BLOCK");
    networkUntouched();
  });

  it("returns 409 when the attacker supplies the tampered tx's own hash (intent re-verification)", async () => {
    const tampered = signed([...buildCleanupInstructions(intent), SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 1 })]);
    const r = await json(await cleanupSubmitRoute(post("/api/cleanup/submit", { signedTransaction: tampered.b64, expectedMessageHash: await messageHashOf(tampered.bytes), intent })));
    expect(r.status).toBe(409);
    networkUntouched();
  });

  it("rate limits per client (6/min) with Retry-After", async () => {
    const body = { signedTransaction: "AA==", expectedMessageHash: "0".repeat(64), intent };
    for (let i = 0; i < 6; i++) expect((await cleanupSubmitRoute(post("/api/cleanup/submit", body, "10.9.9.9"))).status).not.toBe(429);
    const limited = await cleanupSubmitRoute(post("/api/cleanup/submit", body, "10.9.9.9"));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    // another client is unaffected
    expect((await cleanupSubmitRoute(post("/api/cleanup/submit", body, "10.9.9.10"))).status).not.toBe(429);
  });
});

describe("POST /api/transaction/submit", () => {
  const transfer = () => [SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 1 })];

  it("400 on schema violations", async () => {
    expect((await txSubmitRoute(post("/api/transaction/submit", { signedTransaction: "***", expectedMessageHash: "a".repeat(64) }))).status).toBe(400);
    expect((await txSubmitRoute(post("/api/transaction/submit", { signedTransaction: "AA==" }))).status).toBe(400);
    networkUntouched();
  });

  it("400 INVALID_TRANSACTION for unparseable bytes", async () => {
    const r = await json(await txSubmitRoute(post("/api/transaction/submit", { signedTransaction: "AAAA", expectedMessageHash: "a".repeat(64) })));
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe("INVALID_TRANSACTION");
    networkUntouched();
  });

  it("409 when the signed bytes differ from the analyzed hash", async () => {
    const analyzedHash = await messageHashOf(buildTx(transfer()).bytes);
    const changed = signed([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 999 })]);
    const r = await json(await txSubmitRoute(post("/api/transaction/submit", { signedTransaction: changed.b64, expectedMessageHash: analyzedHash })));
    expect(r.status).toBe(409);
    networkUntouched();
  });

  it("409 for an unsigned transaction even with a matching hash", async () => {
    const { base64, bytes } = buildTx(transfer());
    const r = await json(await txSubmitRoute(post("/api/transaction/submit", { signedTransaction: base64, expectedMessageHash: await messageHashOf(bytes) })));
    expect(r.status).toBe(409);
    expect(r.body.error?.message).toMatch(/signatures/);
    networkUntouched();
  });

  it("409 for a transaction signed by the synthetic demo wallet", async () => {
    // The demo check runs before signature verification, so no demo key is needed (and none exists here).
    const { tx, bytes } = buildTx([SystemProgram.transfer({ fromPubkey: DEMO.wallet, toPubkey: ATTACKER, lamports: 1 })], DEMO.wallet);
    const b64 = bytesToBase64(new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false })));
    const r = await json(await txSubmitRoute(post("/api/transaction/submit", { signedTransaction: b64, expectedMessageHash: await messageHashOf(bytes) })));
    expect(r.status).toBe(409);
    expect(r.body.error?.message).toMatch(/Demo/);
    networkUntouched();
  });
});

describe("POST /api/cleanup/prepare", () => {
  it("400 for an unknown action or invalid address", async () => {
    expect((await cleanupPrepareRoute(post("/api/cleanup/prepare", { owner: W, tokenAccount: WALLET_ATA.toBase58(), action: "TRANSFER" }))).status).toBe(400);
    expect((await cleanupPrepareRoute(post("/api/cleanup/prepare", { owner: "abc", tokenAccount: WALLET_ATA.toBase58(), action: "CLOSE" }))).status).toBe(400);
    networkUntouched();
  });

  it("422 for the synthetic demo wallet without touching the network", async () => {
    const r = await json(await cleanupPrepareRoute(post("/api/cleanup/prepare", { owner: DEMO.wallet.toBase58(), tokenAccount: WALLET_ATA.toBase58(), action: "CLOSE" })));
    expect(r.status).toBe(422);
    expect(r.body.error?.code).toBe("CLEANUP_NOT_ELIGIBLE");
    networkUntouched();
  });

  it("maps an unexpected internal error to a generic 500 without leaking its message", async () => {
    accounts.mockRejectedValue(new Error(`connect ECONNREFUSED https://mainnet.helius-rpc.com/?api-key=${FAKE_KEY}`));
    const r = await json(await cleanupPrepareRoute(post("/api/cleanup/prepare", { owner: W, tokenAccount: WALLET_ATA.toBase58(), action: "CLOSE" })));
    expect(r.status).toBe(500);
    expect(r.body.error?.code).toBe("UNKNOWN_ERROR");
    expect(r.text).not.toContain(FAKE_KEY);
    expect(r.text).not.toContain("helius");
  });
});

describe("POST /api/ai/diagnose", () => {
  it("returns NOT_CONFIGURED without a key and makes no provider call", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const r = await json(await diagnoseRoute(post("/api/ai/diagnose", "")));
    expect(r.status).toBe(200);
    expect((r.body.data as { status: string }).status).toBe("NOT_CONFIGURED");
    expect(f).not.toHaveBeenCalled();
  });

  it("never returns the key, even when the provider rejects it", async () => {
    vi.stubEnv("OPENAI_API_KEY", FAKE_KEY);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${FAKE_KEY}` } }), { status: 401 })));
    const r = await json(await diagnoseRoute(post("/api/ai/diagnose", "")));
    expect((r.body.data as { status: string }).status).toBe("INVALID_KEY");
    expect(r.text).not.toContain(FAKE_KEY);
    expect(r.text).not.toContain("Incorrect API key");
  });

  it("is rate limited to 3 requests per minute per client", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    for (let i = 0; i < 3; i++) expect((await diagnoseRoute(post("/api/ai/diagnose", "", "10.8.8.8"))).status).toBe(200);
    expect((await diagnoseRoute(post("/api/ai/diagnose", "", "10.8.8.8"))).status).toBe(429);
  });
});
