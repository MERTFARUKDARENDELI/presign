import "server-only";
import { gunzipSync, inflateSync } from "node:zlib";
import { PublicKey } from "@solana/web3.js";
import { logger } from "@/lib/api/logger";
import { TtlCache } from "@/lib/cache";
import { rpcCall } from "@/lib/solana/client";
import { programInfo } from "@/lib/solana/constants";
import type { DecodedInstruction, DecodedTransaction } from "@/lib/transaction/types";
import { decodeAnchorInstruction, idlName, indexIdl, type AnchorIdl, type IdlInstruction } from "./idl";

/**
 * Loads a program's Anchor IDL from chain — the legacy IDL account
 * (createWithSeed(PDA([], program), "anchor:idl", program)) or, for Anchor 1.x
 * programs, the canonical Program Metadata account — and uses it to decode
 * instructions the built-in decoder left undecoded. Absent or unreadable IDLs
 * leave instructions untouched.
 */

const MAX_IDL_BYTES = 2 * 1024 * 1024;

export interface LoadedIdl {
  address: string;
  idl: AnchorIdl;
  index: Map<string, IdlInstruction>;
}

export type IdlLookup = { status: "FOUND"; idl: LoadedIdl } | { status: "NONE" } | { status: "FAILED" };

const cache = new TtlCache<IdlLookup>(30 * 60_000, 500);

/** Tests only: forget loaded IDLs. */
export function clearIdlCache(): void {
  cache.clear();
}

export async function idlAddress(programId: string): Promise<string> {
  const program = new PublicKey(programId);
  const base = PublicKey.findProgramAddressSync([], program)[0];
  return (await PublicKey.createWithSeed(base, "anchor:idl", program)).toBase58();
}

/** Account layout: 8-byte discriminator, authority (32), u32 length, zlib-deflated JSON. */
export function parseIdlAccount(data: Uint8Array): AnchorIdl {
  if (data.length < 44) throw new RangeError("IDL account too short");
  const len = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(40, true);
  if (len === 0 || 44 + len > data.length) throw new RangeError("IDL length out of range");
  const json = inflateSync(data.subarray(44, 44 + len), { maxOutputLength: MAX_IDL_BYTES }).toString("utf8");
  const idl = JSON.parse(json) as AnchorIdl;
  if (!Array.isArray(idl.instructions)) throw new TypeError("Not an Anchor IDL");
  return idl;
}

/**
 * Anchor 1.x publishes IDLs through the Program Metadata program instead. Only the canonical metadata account
 * (PDA [program, seed "idl" padded to 16 bytes]) counts: only the program's upgrade authority can write it.
 */
export const PROGRAM_METADATA_ID = "ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S";
const METADATA_HEADER = 96;

export function metadataIdlAddress(programId: string): string {
  const seed = Buffer.alloc(16);
  seed.write("idl");
  return PublicKey.findProgramAddressSync([new PublicKey(programId).toBuffer(), seed], new PublicKey(PROGRAM_METADATA_ID))[0].toBase58();
}

/**
 * Metadata account: discriminator (1) = 2, program (32), authority (32), mutable, canonical, seed (16), encoding,
 * compression, format, data source, data length u32, padding (5), then the data. Accepts the canonical, directly
 * stored, UTF-8 JSON form (what Anchor writes); anything else is not read.
 */
export function parseMetadataIdl(data: Uint8Array, programId: string): AnchorIdl {
  if (data.length < METADATA_HEADER || data[0] !== 2) throw new TypeError("Not a metadata account");
  if (new PublicKey(data.subarray(1, 33)).toBase58() !== programId) throw new TypeError("Metadata for another program");
  if (data[66] !== 1) throw new TypeError("Not the canonical metadata");
  const [encoding, compression, format, source] = [data[83], data[84], data[85], data[86]];
  if (source !== 0 || format !== 1 || (encoding !== 0 && encoding !== 1)) throw new TypeError("Unsupported metadata form");
  const len = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(87, true);
  if (len === 0 || METADATA_HEADER + len > data.length) throw new RangeError("Metadata length out of range");
  const raw = data.subarray(METADATA_HEADER, METADATA_HEADER + len);
  const bytes = compression === 0 ? raw : compression === 1 ? gunzipSync(raw, { maxOutputLength: MAX_IDL_BYTES }) : compression === 2 ? inflateSync(raw, { maxOutputLength: MAX_IDL_BYTES }) : null;
  if (!bytes) throw new TypeError("Unsupported compression");
  const idl = JSON.parse(Buffer.from(bytes).toString("utf8")) as AnchorIdl;
  if (!Array.isArray(idl.instructions)) throw new TypeError("Not an Anchor IDL");
  return idl;
}

async function fetchAccount(address: string) {
  const res = await rpcCall<{ value: { data: [string, string]; owner: string } | null }>("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }]);
  const v = res.result?.value;
  return v ? { owner: v.owner, data: Uint8Array.from(Buffer.from(v.data[0], "base64")) } : null;
}

export async function loadIdl(programId: string): Promise<IdlLookup> {
  return cache.getOrLoad(programId, async () => {
    try {
      const address = await idlAddress(programId);
      const legacy = await fetchAccount(address);
      // The IDL account must be owned by the program itself; anything else is not its IDL.
      if (legacy && legacy.owner === programId) {
        const idl = parseIdlAccount(legacy.data);
        return { status: "FOUND", idl: { address, idl, index: indexIdl(idl) } };
      }
      const metaAddress = metadataIdlAddress(programId);
      const meta = await fetchAccount(metaAddress);
      if (!meta || meta.owner !== PROGRAM_METADATA_ID) return { status: "NONE" };
      const idl = parseMetadataIdl(meta.data, programId);
      return { status: "FOUND", idl: { address: metaAddress, idl, index: indexIdl(idl) } };
    } catch (error) {
      logger.warn("anchor.idl_unavailable", { program: programId, error: error instanceof Error ? error.name : "unknown" });
      return { status: "FAILED" };
    }
  });
}

export interface IdlEnrichment {
  programId: string;
  status: "DECODED" | "NO_MATCH" | "NO_IDL" | "FAILED";
  idlName: string | null;
  idlAddress: string | null;
  decoded: number;
}

function enrichOne(ix: DecodedInstruction, loaded: LoadedIdl): boolean {
  if (ix.parsed || !ix.rawData) return false;
  const d = decodeAnchorInstruction(loaded.idl, loaded.index, Uint8Array.from(Buffer.from(ix.rawData, "base64")));
  if (!d) return false;
  const known = programInfo(ix.programId);
  ix.type = `anchor:${d.name}`;
  ix.parsed = true;
  if (known.trust === "unknown") ix.programName = `${idlName(loaded.idl)} (from IDL)`;
  ix.accounts = ix.accounts.map((a, i) => ({ ...a, name: d.accountNames[i] ?? a.name }));
  ix.info = {
    ...Object.fromEntries(d.args.map((a) => [a.name, a.value])),
    _argTypes: d.args.map((a) => `${a.name}:${a.type}`).join(", ") || null,
    _decodedBy: "on-chain Anchor IDL",
    _complete: String(d.complete),
  };
  delete ix.rawData;
  return true;
}

/**
 * Decodes undecoded top-level and inner instructions of non-core programs with
 * their on-chain Anchor IDL. Mutates `decoded`; returns per-program status.
 */
export async function enrichWithAnchorIdl(decoded: DecodedTransaction): Promise<IdlEnrichment[]> {
  const candidates = [...decoded.instructions, ...decoded.innerInstructions].filter((i) => !i.parsed && i.rawData && i.programTrust !== "core");
  const programs = [...new Set(candidates.map((i) => i.programId))].slice(0, 8);
  const results: IdlEnrichment[] = [];
  for (const programId of programs) {
    const lookup = await loadIdl(programId);
    if (lookup.status !== "FOUND") {
      results.push({ programId, status: lookup.status === "NONE" ? "NO_IDL" : "FAILED", idlName: null, idlAddress: null, decoded: 0 });
      continue;
    }
    let n = 0;
    for (const ix of candidates.filter((i) => i.programId === programId)) if (enrichOne(ix, lookup.idl)) n++;
    results.push({ programId, status: n > 0 ? "DECODED" : "NO_MATCH", idlName: idlName(lookup.idl.idl), idlAddress: lookup.idl.address, decoded: n });
  }
  const decodedTop = new Set(decoded.instructions.filter((i) => i.parsed).map((i) => i.index));
  decoded.undecodedInstructions = decoded.undecodedInstructions.filter((i) => !decodedTop.has(i));
  return results;
}
