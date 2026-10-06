import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALERT_INTERVAL_MS, queueAlert, resetAlerts } from "@/lib/api/alerts";
import { withApi } from "@/lib/api/handler";
import { logger } from "@/lib/api/logger";
import { resetRateLimits } from "@/lib/api/rate-limit";

const HOOK = "https://hooks.example.com/presign";

let posts: Array<{ url: string; body: { text: string; content: string } }>;
beforeEach(() => {
  resetAlerts();
  resetRateLimits();
  posts = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    posts.push({ url, body: JSON.parse(String(init.body)) });
    return new Response("ok");
  }));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("operator alerts (PRESIGN_ALERT_WEBHOOK_URL)", () => {
  it("nothing is sent without the variable, or to a non-https URL", () => {
    logger.error("api.unhandled_error", { route: "x" });
    vi.stubEnv("PRESIGN_ALERT_WEBHOOK_URL", "http://hooks.example.com/presign");
    logger.error("api.unhandled_error", { route: "x" });
    expect(posts).toEqual([]);
  });

  it("an error is posted with event, route, code and a redacted message; never the request data", () => {
    vi.stubEnv("PRESIGN_ALERT_WEBHOOK_URL", HOOK);
    logger.error("api.unhandled_error", { route: "presign-analyze", code: "X", error: new Error("boom api_key=sk-ant-secret123456"), body: { payload: "AAAA" }, apiKey: "sk-ant-zzzzzzzz" });
    expect(posts).toHaveLength(1);
    const { url, body } = posts[0];
    expect(url).toBe(HOOK);
    expect(body.text).toMatch(/^Presign ERROR: api\.unhandled_error · route presign-analyze · code X · error: boom/);
    expect(body.content).toBe(body.text);
    expect(body.text).not.toMatch(/sk-ant|AAAA|payload/);
  });

  it("only errors and the listed outages alert; ordinary warnings and info do not", () => {
    vi.stubEnv("PRESIGN_ALERT_WEBHOOK_URL", HOOK);
    logger.info("presign.signing_analyzed", { level: "HIGH" });
    logger.warn("api.rate_limited", { route: "x" });
    expect(posts).toHaveLength(0);
    logger.warn("api.upstream_error", { route: "tx-analyze", code: "RPC_ERROR" });
    logger.warn("presign.ai_contradiction_dropped", {});
    expect(posts.map((p) => p.body.text.split(" · ")[0])).toEqual(["Presign WARN: api.upstream_error", "Presign WARN: presign.ai_contradiction_dropped"]);
  });

  it("at most one alert per event per interval, then a count of what was held back", () => {
    vi.stubEnv("PRESIGN_ALERT_WEBHOOK_URL", HOOK);
    const t = 1_000_000;
    queueAlert("error", "api.unhandled_error", { route: "a" }, t);
    for (let i = 0; i < 5; i++) queueAlert("error", "api.unhandled_error", { route: "a" }, t + 1_000);
    queueAlert("error", "cleanup.self_integrity_failed", {}, t + 1_000);
    expect(posts).toHaveLength(2);
    queueAlert("error", "api.unhandled_error", { route: "a" }, t + ALERT_INTERVAL_MS + 1);
    expect(posts).toHaveLength(3);
    expect(posts[2].body.text).toMatch(/5 more held back/);
  });

  it("the API error path waits for the alert before answering", async () => {
    vi.stubEnv("PRESIGN_ALERT_WEBHOOK_URL", HOOK);
    let delivered = false;
    vi.stubGlobal("fetch", vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 50));
      delivered = true;
      return new Response("ok");
    }));
    const route = withApi({ name: "alert-test", limit: 5, windowMs: 60_000 }, async () => {
      throw new Error("unexpected");
    });
    const res = await route(new Request("http://localhost/api/x", { headers: { "x-forwarded-for": "1.1.1.1" } }));
    expect(res.status).toBe(500);
    expect(delivered).toBe(true);
  });
});

describe("log lines keep their own level", () => {
  it("a field called level (a risk level) does not overwrite the line's level, event or time", () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => void lines.push(line));
    logger.error("tx.analyzed", { level: "CRITICAL", event: "x", ts: "y", kind: "serialized" });
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(parsed).toMatchObject({ level: "error", event: "tx.analyzed", field_level: "CRITICAL", field_event: "x", field_ts: "y", kind: "serialized" });
    expect(parsed.ts).not.toBe("y");
  });
});
