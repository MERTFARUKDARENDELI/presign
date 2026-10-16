import bs58 from "bs58";

/**
 * Durable-nonce replacements. Durable nonces are moving out of the protocol into on-chain programs
 * (Solana Foundation, October 2026: https://solana.com/upgrades/durable-nonce-deprecation). With
 * these, an authority signs a message that has no blockhash; whoever holds it can submit it later,
 * until it is used or cancelled — the property the Drift Security Council takeover relied on. The
 * guide asks signing tools to recognize these programs, decode their payloads and warn.
 *
 * Pure parsing: safe for client and server.
 */

/** Anza Ed25519 Programmatic Signer (devnet, pre-audit): verifies authority signatures, then signs as their PDAs. */
export const PROGRAMMATIC_SIGNER_PROGRAM_ID = "EdSigVfK1DkeMrjFNDMjwfQaJPhPTtX7jW8uPv3oKEgN";
/** Anza Legacy Message Executor (devnet, pre-audit): checks the execution message against the nonce, advances it, runs it. */
export const MESSAGE_EXECUTOR_PROGRAM_ID = "ExecxgyHYsAXB4c5dZodV1zJZ9hqfsDCYkRDRATrpkFR";
/** SPL Nonce (devnet, pre-audit): 72-byte nonce accounts, separate from System Program nonces. */
export const SPL_NONCE_PROGRAM_ID = "Noncediea1fH12usShuQAz28UhgAeuE5Maf32LsMUQB";

/** Blueshift Vector: one program per signature scheme, same instruction set (published program ids). */
export const VECTOR_PROGRAMS: Record<string, string> = {
  vectorcLBXJ2TuoKuUygkEi6FWqvBnbHDEDWoYamfjV: "Ed25519",
  "9NCknbW4LpePSZzbZGFk2HHsSH4y4pkmRjEguJo7qqjd": "Secp256k1",
  G6okL1MvXx7k5eytY7wRXNupXyYG1QVZW37ygAjMiTTu: "EIP-191",
  HdkE3dPYgCRZJgLv64mbFmojyCprUim8VRXzK2wR6Qgm: "Falcon-512",
};

export const isVectorProgram = (programId: string | null): programId is string => programId !== null && Object.hasOwn(VECTOR_PROGRAMS, programId);

const SUBMIT = 0; // Programmatic Signer: Submit
const EXECUTE = 0; // Message Executor: Execute
const NONCE_ADVANCE = 1; // SPL Nonce: Advance
const VECTOR_ADVANCE = 1; // Vector: Advance (verifies the signature, consumes the nonce)

export interface V1Instruction {
  programIndex: number;
  accounts: number[];
  data: Uint8Array;
}

export interface V1Message {
  numSigners: number;
  numReadonlySigners: number;
  numReadonlyNonSigners: number;
  /** The message's blockhash field. In an execution message it holds the nonce value. */
  lifetime: string;
  staticAccounts: string[];
  instructions: V1Instruction[];
}

/**
 * Parses a v1 transaction message: version byte (0x81), header, config mask, lifetime, counts,
 * static accounts, config values, instruction headers, instruction payloads. Returns null for
 * anything else, including a message with transaction config: the programs above reject those
 * inside an envelope, so they are not decoded here.
 */
export function parseV1Message(bytes: Uint8Array): V1Message | null {
  if (bytes.length < 42 || bytes[0] !== 0x81) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const [numSigners, numReadonlySigners, numReadonlyNonSigners] = [bytes[1], bytes[2], bytes[3]];
  if (view.getUint32(4, true) !== 0) return null;
  const lifetime = bs58.encode(bytes.subarray(8, 40));
  const numInstructions = bytes[40];
  const numStaticAccounts = bytes[41];
  let offset = 42;
  if (bytes.length < offset + 32 * numStaticAccounts + 4 * numInstructions) return null;
  const staticAccounts: string[] = [];
  for (let i = 0; i < numStaticAccounts; i++, offset += 32) staticAccounts.push(bs58.encode(bytes.subarray(offset, offset + 32)));
  const headers: Array<{ programIndex: number; numAccounts: number; dataLength: number }> = [];
  for (let i = 0; i < numInstructions; i++, offset += 4) headers.push({ programIndex: bytes[offset], numAccounts: bytes[offset + 1], dataLength: view.getUint16(offset + 2, true) });
  const instructions: V1Instruction[] = [];
  for (const h of headers) {
    if (h.programIndex >= numStaticAccounts || offset + h.numAccounts + h.dataLength > bytes.length) return null;
    const accounts = [...bytes.subarray(offset, offset + h.numAccounts)];
    if (accounts.some((a) => a >= numStaticAccounts)) return null;
    offset += h.numAccounts;
    instructions.push({ programIndex: h.programIndex, accounts, data: new Uint8Array(bytes.subarray(offset, offset + h.dataLength)) });
    offset += h.dataLength;
  }
  if (offset !== bytes.length || numSigners > numStaticAccounts) return null;
  return { numSigners, numReadonlySigners, numReadonlyNonSigners, lifetime, staticAccounts, instructions };
}

/** An instruction inside an envelope, resolved to addresses. */
export interface EnvelopeInstruction {
  programId: string;
  accounts: string[];
  data: Uint8Array;
}

export interface OfflineSignerEnvelope {
  kind: "programmatic-signer" | "vector";
  /** Program of the top-level instruction that carries the offline signature. */
  program: string;
  /** Its top-level instruction index. */
  instruction: number;
  /** Programmatic signer: the authorities that signed the authorization message. Vector: empty (the key lives in the vector account). */
  authorities: string[];
  /** Account whose state the signature consumes: the SPL Nonce account, or the vector account. Null when it could not be read. */
  nonceAccount: string | null;
  /** Who advances that nonce: the programmatic-signer PDA, or the vector account itself. */
  nonceAuthority: string | null;
  /** Programmatic signer: the nonce value the execution message is bound to. */
  nonceValue: string | null;
  /** Programmatic signer: the instructions the execution message runs, decoded from the signed bytes. Null when not decodable. */
  executes: EnvelopeInstruction[] | null;
}

export interface TopLevelInstruction {
  programId: string | null;
  accounts: Array<string | null>;
  data: Uint8Array;
}

/** Programmatic Signer `Submit` data: discriminator, u8 count of Option<[u8; 64]> signatures, then the authorization message. */
function submitMessage(data: Uint8Array): { signatures: number; message: Uint8Array } | null {
  if (data.length < 2 || data[0] !== SUBMIT) return null;
  const count = data[1];
  let offset = 2;
  for (let i = 0; i < count; i++) {
    if (offset >= data.length) return null;
    const tag = data[offset];
    if (tag === 0) offset += 1;
    else if (tag === 1) offset += 65;
    else return null;
  }
  return offset <= data.length ? { signatures: count, message: data.subarray(offset) } : null;
}

function programmaticSigner(ix: TopLevelInstruction, index: number): OfflineSignerEnvelope {
  const envelope: OfflineSignerEnvelope = { kind: "programmatic-signer", program: PROGRAMMATIC_SIGNER_PROGRAM_ID, instruction: index, authorities: [], nonceAccount: null, nonceAuthority: null, nonceValue: null, executes: null };
  const submit = submitMessage(ix.data);
  const auth = submit ? parseV1Message(submit.message) : null;
  if (!auth) return envelope;
  envelope.authorities = auth.staticAccounts.slice(0, auth.numSigners);
  const [exec] = auth.instructions;
  if (auth.instructions.length !== 1 || auth.staticAccounts[exec.programIndex] !== MESSAGE_EXECUTOR_PROGRAM_ID || exec.data[0] !== EXECUTE) return envelope;
  envelope.nonceAuthority = auth.staticAccounts[exec.accounts[0]] ?? null;
  envelope.nonceAccount = auth.staticAccounts[exec.accounts[1]] ?? null;
  const execution = parseV1Message(exec.data.subarray(1));
  if (!execution) return envelope;
  envelope.nonceValue = execution.lifetime;
  envelope.executes = execution.instructions.map((i) => ({ programId: execution.staticAccounts[i.programIndex], accounts: i.accounts.map((a) => execution.staticAccounts[a]), data: i.data }));
  return envelope;
}

/**
 * The offline-signer envelope a transaction carries, from its top-level instructions; null when
 * there is none. Vector's `Advance` is only valid at the top level, and a `Submit` reached by CPI
 * carries no authority signature of its own, so top-level instructions are where these start.
 */
export function detectOfflineSigner(instructions: TopLevelInstruction[]): OfflineSignerEnvelope | null {
  for (const [index, ix] of instructions.entries()) {
    if (ix.programId === PROGRAMMATIC_SIGNER_PROGRAM_ID && ix.data[0] === SUBMIT) return programmaticSigner(ix, index);
    if (isVectorProgram(ix.programId) && ix.data[0] === VECTOR_ADVANCE) {
      const vector = ix.accounts[0] ?? null;
      return { kind: "vector", program: ix.programId, instruction: index, authorities: [], nonceAccount: vector, nonceAuthority: vector, nonceValue: null, executes: null };
    }
  }
  return null;
}

/** SPL Nonce `Advance` seen as an inner instruction: [authority, nonce account]. */
export function splNonceAdvance(programId: string, data: Uint8Array, accounts: string[]): { nonceAccount: string; nonceAuthority: string } | null {
  if (programId !== SPL_NONCE_PROGRAM_ID || data[0] !== NONCE_ADVANCE || accounts.length < 2) return null;
  return { nonceAuthority: accounts[0], nonceAccount: accounts[1] };
}

/** What a finding cites for the envelope. */
export function envelopeEvidence(e: OfflineSignerEnvelope): string {
  if (e.kind === "vector") return `vector account ${e.nonceAccount ?? "?"}`;
  return `authorities ${e.authorities.join(", ") || "?"}; SPL Nonce account ${e.nonceAccount ?? "?"} (authority ${e.nonceAuthority ?? "?"})`;
}

/** How the envelope is named in findings. */
export function envelopeLabel(e: Pick<OfflineSignerEnvelope, "kind" | "program">): string {
  return e.kind === "vector" ? `Blueshift Vector (${VECTOR_PROGRAMS[e.program] ?? "unknown scheme"})` : "Anza Ed25519 Programmatic Signer";
}
