// A deterministic, local stand-in for the devnet JSON-RPC, for the extension end-to-end test (scripts/e2e/local.mjs).
// It is NOT a validator: it answers the methods Presign's analysis and the test dApp call, from a fixed table.
//   - every address is a system account holding 2 SOL, except the programs listed in PROGRAMS (executable);
//   - getLatestBlockhash hands out a new blockhash per call (a fixed sequence); isBlockhashValid is true only for those;
//   - simulateTransaction applies the fee and the System Program's transfer / assign to that table and reports the
//     accounts asked for, at the same slot as the pre-state (so the diff is exact); every other instruction changes nothing;
//   - history (signatures, transactions, token accounts) is empty.
// Unknown methods answer a JSON-RPC error and are listed in the summary, so a test cannot pass on a silent gap.
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

const SLOT = 350_000_000;
const LAMPORTS = 2_000_000_000;
const FEE_PER_SIGNATURE = 5_000;
const SYSTEM = SystemProgram.programId.toBase58();
const PROGRAMS = {
  [SYSTEM]: "NativeLoader1111111111111111111111111111111",
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "BPFLoader2111111111111111111111111111111111",
  ComputeBudget111111111111111111111111111111: "NativeLoader1111111111111111111111111111111",
};

const account = (owner, lamports, executable = false) => ({ lamports, owner, data: ["", "base64"], executable, rentEpoch: 18446744073709552000, space: 0 });
const preState = (address) => (PROGRAMS[address] ? account(PROGRAMS[address], 1_141_440, true) : account(SYSTEM, LAMPORTS));
const ctx = (value) => ({ context: { slot: SLOT, apiVersion: "mock" }, value });

/** The fee and the System Program's transfer / assign, applied to the accounts the transaction names. */
function simulate(base64, addresses) {
  const tx = VersionedTransaction.deserialize(Buffer.from(base64, "base64"));
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  const state = new Map(keys.map((k) => [k, { ...preState(k) }]));
  state.get(keys[0]).lamports -= FEE_PER_SIGNATURE * tx.message.header.numRequiredSignatures;
  const logs = [];
  for (const ix of tx.message.compiledInstructions) {
    const program = keys[ix.programIdIndex];
    logs.push(`Program ${program} invoke [1]`);
    const data = Buffer.from(ix.data);
    if (program === SYSTEM && data.length >= 4) {
      const kind = data.readUInt32LE(0);
      const at = (i) => state.get(keys[ix.accountKeyIndexes[i]]);
      if (kind === 1 && data.length >= 36) at(0).owner = new PublicKey(data.subarray(4, 36)).toBase58(); // Assign
      if (kind === 2 && data.length >= 12) {
        const lamports = Number(data.readBigUInt64LE(4)); // Transfer
        at(0).lamports -= lamports;
        at(1).lamports += lamports;
      }
    }
    if (program === "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr") logs.push(`Program log: Memo (len ${data.length}): ${JSON.stringify(data.toString("utf8"))}`);
    logs.push(`Program ${program} consumed 300 of 200000 compute units`, `Program ${program} success`);
  }
  return ctx({ err: null, logs, accounts: addresses.map((a) => state.get(a) ?? preState(a)), unitsConsumed: 300 * tx.message.compiledInstructions.length, innerInstructions: [], returnData: null });
}

export function startMockRpc({ port = 0, log } = {}) {
  const issued = new Set();
  const counts = {};
  const unknown = new Set();
  const handlers = {
    getLatestBlockhash: () => {
      const blockhash = bs58.encode(createHash("sha256").update(`presign-e2e-mock-blockhash-${issued.size}`).digest());
      issued.add(blockhash);
      return ctx({ blockhash, lastValidBlockHeight: SLOT + 150 });
    },
    isBlockhashValid: ([blockhash]) => ctx(issued.has(blockhash)),
    getFeeForMessage: () => ctx(FEE_PER_SIGNATURE),
    getMultipleAccounts: ([addresses]) => ctx(addresses.map(preState)),
    getAccountInfo: ([address]) => ctx(preState(address)),
    getBalance: ([address]) => ctx(preState(address).lamports),
    simulateTransaction: ([base64, config]) => simulate(base64, config?.accounts?.addresses ?? []),
    getSignaturesForAddress: () => [],
    getTransaction: () => null,
    getTokenAccountsByOwner: () => ctx([]),
    getMinimumBalanceForRentExemption: ([size = 0]) => 890_880 + 6_960 * size,
    getSlot: () => SLOT,
    getBlockHeight: () => SLOT,
    getHealth: () => "ok",
    getVersion: () => ({ "solana-core": "mock", "feature-set": 0 }),
    getGenesisHash: () => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  };
  const answer = (req) => {
    const method = String(req?.method);
    counts[method] = (counts[method] ?? 0) + 1;
    if (log) appendFileSync(log, `${JSON.stringify({ method })}\n`);
    const handler = Object.hasOwn(handlers, method) ? handlers[method] : null;
    if (!handler) {
      unknown.add(method);
      return { jsonrpc: "2.0", id: req?.id ?? null, error: { code: -32601, message: `mock RPC: method not available (${method})` } };
    }
    try {
      return { jsonrpc: "2.0", id: req.id, result: handler(req.params ?? []) };
    } catch (error) {
      return { jsonrpc: "2.0", id: req?.id ?? null, error: { code: -32602, message: `mock RPC: ${error.message}` } };
    }
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)));
    });
  });
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}`, counts, unknown, close: () => new Promise((r) => server.close(r)) }),
    ),
  );
}
