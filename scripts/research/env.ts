import { readFileSync } from "node:fs";

/** Reads one key from .env.local without printing it; strips surrounding quotes like Next.js does. */
export function envValue(name: string, file = ".env.local"): string | undefined {
  if (process.env[name]) return process.env[name];
  try {
    const line = readFileSync(file, "utf8").split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
    return line?.slice(name.length + 1).trim().replace(/^["']|["']$/g, "") || undefined;
  } catch {
    return undefined;
  }
}

export function rpcUrl(): string {
  const key = envValue("HELIUS_API_KEY");
  if (!key) throw new Error("HELIUS_API_KEY is required (in .env.local or the environment).");
  return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
}

let id = 0;
export async function rpc<T>(method: string, params: unknown[], timeoutMs = 120_000): Promise<T> {
  const res = await fetch(rpcUrl(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: AbortSignal.timeout(timeoutMs) });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}
