import { describe, expect, it, vi } from "vitest";
import { createHandler, TOOLS, type Fetch } from "../../mcp/protocol";

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data, error: null }), { status: 200 });
const fail = (status: number, message: string) => new Response(JSON.stringify({ success: false, data: null, error: { code: "X", message } }), { status });

const risk = (level: string, status = "COMPLETE") => ({ level, status, summary: "s", signals: level === "SAFE" ? [] : [{ severity: level, code: "C", title: "T", description: "D" }] });

describe("MCP protocol", () => {
  it("negotiates the protocol version and advertises tools", async () => {
    const handle = createHandler("http://x", vi.fn());
    const init = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
    expect(init).toMatchObject({ id: 1, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "presign" } } });
    const unknownVersion = await handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    expect((unknownVersion!.result as { protocolVersion: string }).protocolVersion).toBe("2025-06-18");
    const list = await handle({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    expect((list!.result as { tools: unknown[] }).tools).toHaveLength(TOOLS.length);
  });

  it("ignores notifications and rejects unknown methods and tools", async () => {
    const handle = createHandler("http://x", vi.fn());
    expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(await handle({ jsonrpc: "2.0", id: 4, method: "resources/list" })).toMatchObject({ error: { code: -32601 } });
    expect(await handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "sign_everything", arguments: {} } })).toMatchObject({ error: { code: -32602 } });
  });

  it("verify_transaction passes the API's deterministic gate through", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => ok({ gate: "block", risk: risk("CRITICAL", "PARTIAL"), brief: { headline: "You are about to approve #7", neverExpires: true, config: null, payloads: [] }, multisig: null, decoded: { usesDurableNonce: true }, messageHash: "ab", cluster: "mainnet-beta" }));
    const handle = createHandler("http://presign.test/", fetchImpl);
    const res = await handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "presign_verify_transaction", arguments: { transaction: "AQID", signer: "11111111111111111111111111111111" } } });
    const result = res!.result as { isError: boolean; structuredContent: { gate: string; verdict: string; brief: { neverExpires: boolean } } };
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ gate: "block", verdict: "CRITICAL", brief: { neverExpires: true } });
    expect(fetchImpl.mock.calls[0][0]).toBe("http://presign.test/api/transaction/analyze");
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]!.body))).toEqual({ input: "AQID", walletAddress: "11111111111111111111111111111111" });
  });

  it("check_token never maps an incomplete analysis to no_known_risk", async () => {
    const handle = createHandler("http://x", vi.fn<Fetch>(async () => ok({ mint: "M", risk: risk("SAFE", "PARTIAL") })));
    const res = await handle({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "presign_check_token", arguments: { mint: "11111111111111111111111111111111" } } });
    expect((res!.result as { structuredContent: { gate: string } }).structuredContent.gate).toBe("require_human_review");
    const complete = createHandler("http://x", vi.fn<Fetch>(async () => ok({ mint: "M", risk: risk("SAFE") })));
    const r2 = await complete({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "presign_check_token", arguments: { mint: "11111111111111111111111111111111" } } });
    expect((r2!.result as { structuredContent: { gate: string } }).structuredContent.gate).toBe("no_known_risk");
  });

  it("reports API failures as tool errors, not protocol errors", async () => {
    const handle = createHandler("http://x", vi.fn<Fetch>(async () => fail(404, "No Squads account was found")));
    const res = await handle({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "presign_inspect_multisig", arguments: { query: "x" } } });
    expect(res).toMatchObject({ result: { isError: true, content: [{ type: "text", text: "No Squads account was found" }] } });
  });

  it("holds every check to the operator's team policy and reports its outcome", async () => {
    const MS = "2LW6PSEjp81xSEttWwXDB6Etb1eKdhYPbFEojYbyhx88";
    const general = { version: 1, name: "General", minThreshold: 2 };
    const council = { version: 1, name: "Council", multisig: MS, minThreshold: 3 };
    const report = { name: "Council", severity: "HIGH", status: "violation", checks: [{ rule: "minThreshold", label: "Minimum threshold", status: "violation", findings: ["The threshold is 2; the policy requires at least 3."] }] };
    const fetchImpl = vi.fn<Fetch>(async () => ok({ kind: "proposal", inspection: { gate: "block", multisig: MS, transactionIndex: "7", risk: risk("HIGH"), brief: null, analysis: { payloads: [] }, policy: report } }));
    const handle = createHandler("http://x", fetchImpl, [general, council]);
    const res = await handle({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "presign_inspect_multisig", arguments: { query: `${MS} #7` } } });
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]!.body)).policy).toEqual(council);
    expect((res!.result as { structuredContent: { policy: unknown } }).structuredContent.policy).toEqual({ name: "Council", status: "violation", broken: [{ rule: "Minimum threshold", findings: ["The threshold is 2; the policy requires at least 3."] }], notCheckable: [] });
    await handle({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "presign_inspect_multisig", arguments: { query: "11111111111111111111111111111111" } } });
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]!.body)).policy).toEqual(general);
  });
});
