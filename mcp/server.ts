/**
 * Presign MCP server (stdio). Exposes pre-sign verification to AI agents.
 *
 *   PRESIGN_API_URL=https://your-presign-host node mcp/server.ts
 *   PRESIGN_POLICY_FILE=team-policy.json   optional: the team policy every check is held to
 *
 * Newline-delimited JSON-RPC on stdin/stdout; diagnostics go to stderr only.
 */
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { parsePolicyFile } from "../lib/policy/file.ts";
import { createHandler, type RpcMessage } from "./protocol.ts";

const policyPath = process.env.PRESIGN_POLICY_FILE;
const policies = policyPath ? parsePolicyFile(readFileSync(policyPath, "utf8")) : [];
const handle = createHandler(process.env.PRESIGN_API_URL ?? "http://localhost:3000", fetch, policies);
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg: RpcMessage;
  try {
    msg = JSON.parse(line) as RpcMessage;
  } catch {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
    return;
  }
  const response = await handle(msg);
  if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
});

process.stderr.write(`presign-mcp ready (API ${process.env.PRESIGN_API_URL ?? "http://localhost:3000"}${policies.length ? `, ${policies.length} team policy(ies)` : ""})\n`);
