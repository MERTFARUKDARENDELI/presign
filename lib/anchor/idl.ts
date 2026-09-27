import { createHash } from "node:crypto";
import { BorshReader, hex } from "@/lib/squads/borsh";

/**
 * Decodes instructions of Anchor programs from their published IDL (legacy
 * < 0.30 and new 0.30+ formats). The IDL is published by the program's IDL
 * authority: it names the instruction and its arguments, it does not prove
 * what the program does. Arguments are decoded in order until a type is not
 * understood; everything after that stays null and the result is marked
 * incomplete — values are never guessed.
 */

type IdlType =
  | string
  | { option: IdlType }
  | { coption: IdlType }
  | { vec: IdlType }
  | { array: [IdlType, number] }
  | { defined: string | { name: string } };

interface IdlField {
  name: string;
  type: IdlType;
}

interface IdlAccountItem {
  name: string;
  accounts?: IdlAccountItem[];
}

export interface IdlInstruction {
  name: string;
  discriminator?: number[];
  accounts: IdlAccountItem[];
  args: IdlField[];
}

type IdlTypeDef =
  | { name: string; type: { kind: "struct"; fields?: IdlField[] | IdlType[] } }
  | { name: string; type: { kind: "enum"; variants: Array<{ name: string; fields?: IdlField[] | IdlType[] }> } }
  | { name: string; type: { kind: string } };

export interface AnchorIdl {
  name?: string;
  version?: string;
  metadata?: { name?: string; version?: string };
  instructions: IdlInstruction[];
  types?: IdlTypeDef[];
}

export interface AnchorArg {
  name: string;
  type: string;
  /** Decoded value rendered as a string; null when it could not be decoded. */
  value: string | null;
}

export interface AnchorDecodedInstruction {
  name: string;
  accountNames: string[];
  args: AnchorArg[];
  /** False when some arguments could not be decoded (unsupported type or short data). */
  complete: boolean;
}

const MAX_DEPTH = 4;
const MAX_ITEMS = 32;
const MAX_TEXT = 200;

export function idlName(idl: AnchorIdl): string {
  return idl.metadata?.name ?? idl.name ?? "anchor program";
}

const toSnake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

export function instructionDiscriminator(ix: IdlInstruction): string {
  if (Array.isArray(ix.discriminator) && ix.discriminator.length > 0) return hex(Uint8Array.from(ix.discriminator));
  return createHash("sha256").update(`global:${toSnake(ix.name)}`).digest().subarray(0, 8).toString("hex");
}

function flattenAccounts(items: IdlAccountItem[], prefix = ""): string[] {
  return items.flatMap((a) => (a.accounts ? flattenAccounts(a.accounts, `${prefix}${a.name}.`) : [`${prefix}${a.name}`]));
}

function typeName(t: IdlType): string {
  if (typeof t === "string") return t === "pubkey" ? "publicKey" : t;
  if ("option" in t) return `Option<${typeName(t.option)}>`;
  if ("coption" in t) return `COption<${typeName(t.coption)}>`;
  if ("vec" in t) return `Vec<${typeName(t.vec)}>`;
  if ("array" in t) return `[${typeName(t.array[0])}; ${t.array[1]}]`;
  return typeof t.defined === "string" ? t.defined : t.defined.name;
}

class Unsupported extends Error {}

function readValue(r: BorshReader, t: IdlType, idl: AnchorIdl, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new Unsupported("depth");
  if (typeof t === "string") {
    switch (t) {
      case "bool": return r.bool();
      case "u8": return r.u8();
      case "i8": { const v = r.u8(); return v > 127 ? v - 256 : v; }
      case "u16": return r.u16();
      case "i16": { const v = r.u16(); return v > 32767 ? v - 65536 : v; }
      case "u32": return r.u32();
      case "i32": { const v = r.u32(); return v > 2147483647 ? v - 4294967296 : v; }
      case "u64": return r.u64().toString();
      case "i64": return r.i64().toString();
      case "u128": return r.u128().toString();
      case "i128": return r.i128().toString();
      case "publicKey":
      case "pubkey": return r.pubkey();
      case "string": return r.string().slice(0, MAX_TEXT);
      case "bytes": { const b = r.bytes(); return `0x${hex(b.subarray(0, 64))}${b.length > 64 ? "…" : ""}`; }
      default: throw new Unsupported(t);
    }
  }
  if ("option" in t) return r.option(() => readValue(r, t.option, idl, depth + 1));
  if ("coption" in t) {
    const tag = r.u32();
    return tag === 0 ? null : readValue(r, t.coption, idl, depth + 1);
  }
  if ("vec" in t) {
    const n = r.len(r.u32());
    const items = Array.from({ length: n }, () => readValue(r, t.vec, idl, depth + 1));
    return items.length > MAX_ITEMS ? [...items.slice(0, MAX_ITEMS), `…${items.length - MAX_ITEMS} more`] : items;
  }
  if ("array" in t) {
    const [inner, n] = t.array;
    if (inner === "u8") return `0x${hex(r.fixed(n))}`;
    return Array.from({ length: n }, () => readValue(r, inner, idl, depth + 1));
  }
  const name = typeof t.defined === "string" ? t.defined : t.defined.name;
  const def = idl.types?.find((d) => d.name === name);
  if (!def) throw new Unsupported(name);
  if (def.type.kind === "struct" && "fields" in def.type) return readFields(r, def.type.fields ?? [], idl, depth + 1);
  if (def.type.kind === "enum" && "variants" in def.type) {
    const variant = def.type.variants[r.u8()];
    if (!variant) throw new Unsupported(`${name} variant`);
    return variant.fields?.length ? { [variant.name]: readFields(r, variant.fields, idl, depth + 1) } : variant.name;
  }
  throw new Unsupported(def.type.kind);
}

function readFields(r: BorshReader, fields: IdlField[] | IdlType[], idl: AnchorIdl, depth: number): unknown {
  const named = fields.length > 0 && typeof fields[0] === "object" && fields[0] !== null && "name" in (fields[0] as object) && "type" in (fields[0] as object);
  if (named) return Object.fromEntries((fields as IdlField[]).map((f) => [f.name, readValue(r, f.type, idl, depth)]));
  return (fields as IdlType[]).map((ft) => readValue(r, ft, idl, depth));
}

function render(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v).slice(0, 400);
}

/** Index of discriminator (hex) → instruction for one IDL. */
export function indexIdl(idl: AnchorIdl): Map<string, IdlInstruction> {
  return new Map(idl.instructions.map((ix) => [instructionDiscriminator(ix), ix]));
}

export function decodeAnchorInstruction(idl: AnchorIdl, index: Map<string, IdlInstruction>, data: Uint8Array): AnchorDecodedInstruction | null {
  if (data.length < 8) return null;
  const def = index.get(hex(data.subarray(0, 8)));
  if (!def) return null;
  const r = new BorshReader(data.subarray(8));
  const args: AnchorArg[] = [];
  let complete = true;
  for (const a of def.args) {
    let value: string | null = null;
    if (complete) {
      try {
        const v = readValue(r, a.type, idl, 0);
        // A decoded Option::None is a value, not a gap.
        value = v === null ? "None" : render(v);
      } catch {
        complete = false;
      }
    }
    args.push({ name: a.name, type: typeName(a.type), value });
  }
  return { name: def.name, accountNames: flattenAccounts(def.accounts), args, complete };
}
