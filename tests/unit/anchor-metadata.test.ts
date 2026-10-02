import { deflateSync } from "node:zlib";
import { PublicKey, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearIdlCache, enrichWithAnchorIdl, idlAddress, loadIdl, metadataIdlAddress, parseMetadataIdl, PROGRAM_METADATA_ID } from "@/lib/anchor/source";
import { rpcCall } from "@/lib/solana/client";
import { decodeTransaction } from "@/lib/transaction/decoder";
import real from "../fixtures/program-metadata-idl-devnet.json";
import { buildTx, key, WALLET } from "../helpers/fixtures";

vi.mock("@/lib/solana/client", async (importOriginal) => ({ ...(await importOriginal<object>()), rpcCall: vi.fn() }));
const rpc = vi.mocked(rpcCall);

const realData = () => Uint8Array.from(Buffer.from(real.data, "base64"));

/** A canonical Program Metadata IDL account, laid out as the program writes it. */
function metadataAccount(program: string, idl: object, opts: { canonical?: number; source?: number; compression?: number } = {}) {
  const body = opts.compression === 0 ? Buffer.from(JSON.stringify(idl)) : deflateSync(Buffer.from(JSON.stringify(idl)));
  const h = Buffer.alloc(96);
  h[0] = 2;
  new PublicKey(program).toBuffer().copy(h, 1);
  h[65] = 1;
  h[66] = opts.canonical ?? 1;
  h.write("idl", 67);
  h[83] = 1;
  h[84] = opts.compression ?? 2;
  h[85] = 1;
  h[86] = opts.source ?? 0;
  h.writeUInt32LE(body.length, 87);
  return Uint8Array.from(Buffer.concat([h, body]));
}

function serve(accounts: Map<string, { data: Uint8Array; owner: string }>) {
  rpc.mockImplementation((async (method: string, params: unknown[]) => {
    if (method !== "getAccountInfo") throw new Error(`unexpected rpc ${method}`);
    const a = accounts.get(params[0] as string);
    return { result: { context: { slot: 1 }, value: a ? { data: [Buffer.from(a.data).toString("base64"), "base64"], owner: a.owner, lamports: 1, executable: false } : null }, source: "HELIUS_RPC", fallbackUsed: false };
  }) as unknown as typeof rpcCall);
}

beforeEach(() => {
  rpc.mockReset();
  clearIdlCache();
});

describe("Anchor IDLs published through the Program Metadata program", () => {
  it("reads the real devnet IDL of the Presign Guard program from its canonical address", () => {
    expect(real.owner).toBe(PROGRAM_METADATA_ID);
    expect(metadataIdlAddress(real.program)).toBe(real.address);
    const idl = parseMetadataIdl(realData(), real.program) as unknown as { address: string; metadata: { name: string }; instructions: Array<{ name: string }> };
    expect(idl.address).toBe(real.program);
    expect(idl.metadata.name).toBe("presign_guard");
    expect(idl.instructions.map((i) => i.name)).toEqual(expect.arrayContaining(["schedule", "veto", "execute", "update_config"]));
  });

  it("rejects metadata that is not the program's own canonical, directly stored JSON", () => {
    const other = key(90).toBase58();
    expect(() => parseMetadataIdl(realData(), other)).toThrow(/another program/);
    const nonCanonical = realData();
    nonCanonical[66] = 0;
    expect(() => parseMetadataIdl(nonCanonical, real.program)).toThrow(/canonical/);
    expect(() => parseMetadataIdl(metadataAccount(other, { instructions: [] }, { source: 1 }), other)).toThrow(/Unsupported/);
    expect(parseMetadataIdl(metadataAccount(other, { instructions: [] }, { compression: 0 }), other)).toEqual({ instructions: [] });
  });

  it("prefers the legacy IDL account, falls back to the metadata account, and ignores one owned by anything else", async () => {
    const program = key(91).toBase58();
    const idl = { address: program, metadata: { name: "vault_program", version: "0.1.0", spec: "0.1.0" }, instructions: [{ name: "set_admin", discriminator: [1, 2, 3, 4, 5, 6, 7, 8], accounts: [{ name: "admin_account", signer: true }], args: [{ name: "new_admin", type: "pubkey" }] }] };
    serve(new Map([[metadataIdlAddress(program), { data: metadataAccount(program, idl), owner: PROGRAM_METADATA_ID }]]));
    const found = await loadIdl(program);
    expect(found).toMatchObject({ status: "FOUND", idl: { address: metadataIdlAddress(program) } });

    clearIdlCache();
    serve(new Map([[metadataIdlAddress(program), { data: metadataAccount(program, idl), owner: key(92).toBase58() }]]));
    expect(await loadIdl(program)).toEqual({ status: "NONE" });

    // Instructions of a program with no built-in decoder are then named from that IDL.
    clearIdlCache();
    serve(new Map([[metadataIdlAddress(program), { data: metadataAccount(program, idl), owner: PROGRAM_METADATA_ID }]]));
    const newAdmin = key(93).toBase58();
    const ix = new TransactionInstruction({ programId: new PublicKey(program), keys: [{ pubkey: WALLET, isSigner: true, isWritable: false }], data: Buffer.concat([Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]), new PublicKey(newAdmin).toBuffer()]) });
    const decoded = decodeTransaction(VersionedTransaction.deserialize(buildTx([ix]).bytes));
    const [result] = await enrichWithAnchorIdl(decoded);
    expect(result).toMatchObject({ status: "DECODED", idlAddress: metadataIdlAddress(program) });
    expect(decoded.instructions[0]).toMatchObject({ type: "anchor:set_admin", parsed: true });
    expect(decoded.instructions[0].info.new_admin).toBe(newAdmin);
    expect(await idlAddress(program)).not.toBe(metadataIdlAddress(program));
  });
});
