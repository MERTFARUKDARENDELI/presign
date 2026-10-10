// The extension end-to-end test (scripts/extension-e2e.mjs), isolated on this machine:
//   - wallets: the test dApp's fake Wallet Standard and injected wallets with a throwaway test key (no wallet extension);
//   - RPC: scripts/e2e/mock-rpc.mjs, a deterministic local stand-in for devnet (no outside RPC);
//   - Presign: the production server build (`npm run build` first) on http://localhost:3000, with a throwaway session
//     secret that is never printed or written, no Helius / AI / RugCheck / alert / shared-store configuration, and
//     every request to a non-loopback host refused and recorded (scripts/e2e/no-network.mjs);
//   - extension: the development build (`npm run build:extension:dev` first), the only one that accepts localhost.
// Nothing here reaches production, a real wallet or a chain. The production extension build is not what runs here.
// Usage: node scripts/e2e/local.mjs [--headed]
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startMockRpc } from "./mock-rpc.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = 3000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inUse = (port) =>
  new Promise((resolve) => {
    const s = connect(port, "127.0.0.1");
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });

function stop(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else process.kill(-child.pid, "SIGTERM");
}

const problems = [];
if (!existsSync(path.join(root, ".next", "BUILD_ID"))) problems.push("no production server build: run `npm run build` first");
const manifest = path.join(root, "extension", "dist", "manifest.json");
if (!existsSync(manifest) || !readFileSync(manifest, "utf8").includes("http://localhost:3000/*")) problems.push("no development extension build: run `npm run build:extension:dev` first");
for (const port of [PORT, 5174]) if (await inUse(port)) problems.push(`port ${port} is already in use; this test does not stop other processes`);
if (problems.length) {
  for (const p of problems) console.error(`cannot start: ${p}`);
  process.exit(2);
}

const work = await mkdtemp(path.join(tmpdir(), "presign-e2e-local-"));
const blockedLog = path.join(work, "blocked.log");
writeFileSync(blockedLog, "");
const rpc = await startMockRpc();
console.log("Isolated local e2e: fake wallets (test key) · mock devnet RPC (local, deterministic) · local Presign production server build · development extension build · outside network refused\n");

const env = {
  ...process.env,
  NODE_ENV: "production",
  NEXT_TELEMETRY_DISABLED: "1",
  NODE_OPTIONS: `--import=${pathToFileURL(path.join(root, "scripts", "e2e", "no-network.mjs")).href}`,
  E2E_BLOCKED_LOG: blockedLog,
  PRESIGN_SESSION_SECRET: randomBytes(32).toString("hex"),
  PRESIGN_SESSION_SECRET_PREVIOUS: "",
  PRESIGN_CANONICAL_ORIGIN: "",
  PRESIGN_ALERT_WEBHOOK_URL: "",
  SOLANA_CLUSTER: "devnet",
  SOLANA_FALLBACK_RPC_URL: rpc.url,
  SOLANA_DISABLE_PUBLIC_FALLBACK: "false",
  HELIUS_API_KEY: "",
  ANTHROPIC_API_KEY: "",
  OPENAI_API_KEY: "",
  RUGCHECK_API_KEY: "",
  RUGCHECK_DISABLED: "true",
  TELEGRAM_BOT_TOKEN: "",
  KV_REST_API_URL: "",
  KV_REST_API_TOKEN: "",
  UPSTASH_REDIS_REST_URL: "",
  UPSTASH_REDIS_REST_TOKEN: "",
};
const server = spawn(process.execPath, [path.join(root, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], {
  cwd: root,
  env,
  stdio: ["ignore", "ignore", "inherit"],
  detached: process.platform !== "win32",
});

let code = 1;
try {
  const started = Date.now();
  for (;;) {
    const ok = await fetch(`http://localhost:${PORT}/api/health`, { signal: AbortSignal.timeout(5_000) }).then((r) => r.ok, () => false);
    if (ok) break;
    if (server.exitCode !== null || Date.now() - started > 90_000) throw new Error("the local Presign server did not start");
    await sleep(1_000);
  }
  const e2e = spawn(process.execPath, [path.join(root, "scripts", "extension-e2e.mjs"), ...process.argv.slice(2)], {
    cwd: root,
    env: { ...process.env, E2E_RPC: rpc.url, E2E_RPC_KIND: "mock (local, deterministic)", E2E_PACE_MS: process.env.E2E_PACE_MS ?? "4500" },
    stdio: "inherit",
  });
  code = await new Promise((resolve) => e2e.on("exit", (c) => resolve(c ?? 1)));
} catch (error) {
  console.error("ERROR", error.message);
} finally {
  stop(server);
  await rpc.close();
}

const blocked = readFileSync(blockedLog, "utf8").split("\n").filter(Boolean);
console.log(`\nmock RPC calls: ${JSON.stringify(rpc.counts)}`);
console.log(`outside requests refused by the isolation: ${blocked.length ? [...new Set(blocked)].join(", ") : "none"}`);
if (rpc.unknown.size) {
  console.error(`the server asked the mock RPC for methods it does not answer: ${[...rpc.unknown].join(", ")} — extend scripts/e2e/mock-rpc.mjs`);
  code = code || 1;
}
await sleep(1_000);
await rm(work, { recursive: true, force: true }).catch(() => undefined);
process.exit(code);
