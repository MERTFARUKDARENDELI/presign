import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as health } from "@/app/api/health/route";
import { DEFAULT_GEMINI_MODEL, diagnoseGemini, generateWithGemini, resetGeminiDiagnostic } from "@/lib/ai/gemini";

// A fake backup key. It must never appear in a URL, an error message or a response.
const FAKE_KEY = `AIza-test-${"y".repeat(30)}`;
const REQUEST = { system: "system rules", user: "Presign findings (JSON): {}", maxOutputTokens: 4_000 };

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const f = vi.fn(impl);
  vi.stubGlobal("fetch", f);
  return f;
}
const reply = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

beforeEach(() => resetGeminiDiagnostic());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetGeminiDiagnostic();
});

describe("Gemini backup — the request", () => {
  it("sends the key in a header, never in the URL, and the rules as the system instruction", async () => {
    vi.stubEnv("GEMINI_API_KEY", FAKE_KEY);
    const f = stubFetch(reply({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "What you are signing: …" }] } }] }));
    expect(await generateWithGemini(REQUEST)).toEqual({ kind: "text", text: "What you are signing: …" });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent`);
    expect(url).not.toContain(FAKE_KEY);
    expect((init!.headers as Record<string, string>)["x-goog-api-key"]).toBe(FAKE_KEY);
    const body = JSON.parse(String(init!.body));
    expect(body.systemInstruction.parts[0].text).toBe("system rules");
    expect(body.contents[0].parts[0].text).toContain("Presign findings");
    expect(body.generationConfig.maxOutputTokens).toBe(4_000);
  });

  it("uses GEMINI_MODEL, and refuses anything that is not a model name before any request", async () => {
    vi.stubEnv("GEMINI_API_KEY", FAKE_KEY);
    vi.stubEnv("GEMINI_MODEL", "gemini-3.8-flash");
    const f = stubFetch(reply({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }));
    await generateWithGemini(REQUEST);
    expect(f.mock.calls[0][0]).toContain("/models/gemini-3.8-flash:generateContent");
    vi.stubEnv("GEMINI_MODEL", "../../evil?x=");
    await expect(generateWithGemini(REQUEST)).rejects.toThrow();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("no key → throws without a request", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const f = stubFetch(reply({}));
    await expect(generateWithGemini(REQUEST)).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });
});

describe("Gemini backup — the answer", () => {
  beforeEach(() => vi.stubEnv("GEMINI_API_KEY", FAKE_KEY));

  it("a blocked prompt or a filtered answer is 'blocked', not text", async () => {
    stubFetch(reply({ promptFeedback: { blockReason: "SAFETY" } }));
    expect(await generateWithGemini(REQUEST)).toEqual({ kind: "blocked" });
    stubFetch(reply({ candidates: [{ finishReason: "PROHIBITED_CONTENT", content: { parts: [{ text: "partial" }] } }] }));
    expect(await generateWithGemini(REQUEST)).toEqual({ kind: "blocked" });
  });

  it("thought parts are not shown as the explanation", async () => {
    stubFetch(reply({ candidates: [{ content: { parts: [{ text: "internal reasoning", thought: true }, { text: "The explanation." }] } }] }));
    expect(await generateWithGemini(REQUEST)).toEqual({ kind: "text", text: "The explanation." });
  });

  it("an HTTP error throws with the status only — not Google's body, not the key", async () => {
    stubFetch(reply({ error: { message: `API key not valid: ${FAKE_KEY}` } }, 400));
    const error = await generateWithGemini(REQUEST).catch((e: Error) => e);
    expect(String(error)).toContain("HTTP 400");
    expect(String(error)).not.toContain(FAKE_KEY);
    expect(String(error)).not.toContain("API key not valid");
  });
});

describe("Gemini backup — the key check (no tokens generated)", () => {
  it("without a key: NOT_CONFIGURED, nothing over the network", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const f = stubFetch(reply({}));
    expect(await diagnoseGemini()).toMatchObject({ status: "NOT_CONFIGURED" });
    expect(f).not.toHaveBeenCalled();
  });

  it("reads the model's metadata (a GET, not generateContent) and maps the answer", async () => {
    vi.stubEnv("GEMINI_API_KEY", FAKE_KEY);
    const f = stubFetch(reply({ name: `models/${DEFAULT_GEMINI_MODEL}` }));
    expect(await diagnoseGemini(1_000)).toMatchObject({ provider: "gemini", model: DEFAULT_GEMINI_MODEL, status: "READY", cached: false });
    expect(f.mock.calls[0][0]).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_MODEL}`);
    expect(f.mock.calls[0][1]?.method).toBeUndefined();
    // Cached for ten minutes.
    expect(await diagnoseGemini(2_000)).toMatchObject({ status: "READY", cached: true });
    expect(f).toHaveBeenCalledTimes(1);

    for (const [status, expected] of [[400, "INVALID_KEY"], [403, "INVALID_KEY"], [404, "MODEL_NOT_FOUND"], [503, "UNAVAILABLE"]] as const) {
      resetGeminiDiagnostic();
      stubFetch(reply({ error: { message: FAKE_KEY } }, status));
      const r = await diagnoseGemini();
      expect(r.status).toBe(expected);
      expect(JSON.stringify(r)).not.toContain(FAKE_KEY);
    }
  });

  it("/api/health says whether a backup is configured (a boolean) and never calls it", async () => {
    vi.stubEnv("GEMINI_API_KEY", FAKE_KEY);
    const f = stubFetch(reply({}));
    const res = await health(new Request("http://localhost/api/health", { headers: { "x-forwarded-for": "10.9.9.9" } }));
    const text = await res.text();
    expect(JSON.parse(text).data.aiBackup).toBe(true);
    expect(text).not.toContain(FAKE_KEY);
    expect(f).not.toHaveBeenCalled();
  });
});
