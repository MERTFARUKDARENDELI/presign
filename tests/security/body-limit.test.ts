import { describe, expect, it } from "vitest";
import { readJsonBody } from "@/lib/api/handler";

/** A request body that counts how many chunks were pulled from it. */
function streamed(chunks: number, chunkBytes: number, headers: Record<string, string> = {}) {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunks) return controller.close();
      pulled++;
      controller.enqueue(new TextEncoder().encode(pulled === 1 ? `{"a":"${"x".repeat(chunkBytes - 6)}` : "x".repeat(chunkBytes)));
    },
  }, { highWaterMark: 0 }); // pulled only when read
  const request = new Request("http://localhost/api/x", { method: "POST", body, headers, duplex: "half" } as RequestInit);
  return { request, pulled: () => pulled };
}

describe("request body size limit (applied before the body is buffered)", () => {
  it("a declared Content-Length above the limit is refused without reading the body", async () => {
    const { request, pulled } = streamed(100, 10_000, { "content-length": "1000000" });
    await expect(readJsonBody(request, 8_000)).rejects.toThrow(/too large/);
    expect(pulled()).toBe(0);
  });

  it("a body without Content-Length is cut off once it passes the limit, not read to the end", async () => {
    const { request, pulled } = streamed(1_000, 4_000);
    await expect(readJsonBody(request, 8_000)).rejects.toThrow(/too large/);
    expect(pulled()).toBeLessThan(10);
  });

  it("a body within the limit is parsed (multi-byte text counted in bytes)", async () => {
    const ok = new Request("http://localhost/api/x", { method: "POST", body: JSON.stringify({ name: "ğüşiöç" }) });
    await expect(readJsonBody(ok, 100)).resolves.toEqual({ name: "ğüşiöç" });
    const over = new Request("http://localhost/api/x", { method: "POST", body: JSON.stringify({ name: "ğ".repeat(60) }) });
    await expect(readJsonBody(over, 100)).rejects.toThrow(/too large/);
    await expect(readJsonBody(new Request("http://localhost/api/x", { method: "POST", body: "{not json" }), 100)).rejects.toThrow(/valid JSON/);
  });
});
