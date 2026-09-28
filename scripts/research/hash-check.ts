import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { rpc } from "./env.ts";

// Checks the solana-verify hashing convention against OtterSec's on_chain_hash for one program.
const program = process.argv[2] ?? "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const programData = PublicKey.findProgramAddressSync([new PublicKey(program).toBytes()], loader)[0].toBase58();
const acc = await rpc<{ value: { data: [string, string] } | null }>("getAccountInfo", [programData, { encoding: "base64" }], 170_000);
const data = Buffer.from(acc.value!.data[0], "base64");
let end = data.length;
while (end > 45 && data[end - 1] === 0) end--;
const ours = createHash("sha256").update(data.subarray(45, end)).digest("hex");
const osec = (await (await fetch(`https://verify.osec.io/status/${program}`)).json()) as { on_chain_hash: string };
console.log(JSON.stringify({ program, bytes: data.length, ours, osec: osec.on_chain_hash, match: ours === osec.on_chain_hash }));
