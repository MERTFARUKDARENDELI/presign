import bs58 from "bs58";
import { programInfo, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@/lib/solana/constants";
import { decodeInnerRaw, U64_MAX } from "./decoder";
import type { DecodedInstruction, DecodedTransaction } from "./types";

/**
 * Inner (CPI) instructions come in three shapes:
 *  - compiled   { programIdIndex, accounts: number[], data: base58 }   (getTransaction, json/base64)
 *  - raw        { programId, accounts: string[], data: base58 }        (simulate, unknown programs)
 *  - parsed     { program, programId, parsed: { type, info } }         (simulate, known programs)
 * All are normalized into DecodedInstruction entries with `parentIndex`, and
 * their effects (transfers, approvals, authority changes, closes) are added
 * to the decoded transaction flagged `cpi: true`. Unrecognized shapes are
 * counted as malformed, never guessed.
 */

type Raw = Record<string, unknown>;

const AUTHORITY_TYPES: Record<string, string> = {
  mintTokens: "MintTokens",
  freezeAccount: "FreezeAccount",
  accountOwner: "AccountOwner",
  closeAccount: "CloseAccount",
};

function str(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isSafeInteger(v)) return String(v);
  return null;
}

function amountOf(info: Raw): string | null {
  const direct = str(info.amount);
  if (direct && /^\d+$/.test(direct)) return direct;
  const ta = info.tokenAmount as Raw | undefined;
  const nested = ta ? str(ta.amount) : null;
  return nested && /^\d+$/.test(nested) ? nested : null;
}

function parsedToInstruction(entry: Raw, parentIndex: number, out: DecodedTransaction): DecodedInstruction | null {
  const programId = str(entry.programId);
  const parsed = entry.parsed as Raw | undefined;
  if (!programId || !parsed || typeof parsed.type !== "string") return null;
  const info = (typeof parsed.info === "object" && parsed.info !== null ? parsed.info : {}) as Raw;
  const type = parsed.type;
  const p = programInfo(programId);
  const flat: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(info)) {
    if (k === "tokenAmount") flat.amount = amountOf(info);
    else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") flat[k] = String(v);
  }

  const isToken = str(entry.program)?.startsWith("spl-token") === true;
  const tokenProgram = programId === TOKEN_2022_PROGRAM_ID ? "token-2022" : "spl-token";
  const cpi = { instruction: parentIndex, cpi: true } as const;

  if (programId === SYSTEM_PROGRAM_ID) {
    const lamports = str(info.lamports);
    if ((type === "transfer" || type === "transferWithSeed") && str(info.source) && str(info.destination) && lamports) {
      out.solTransfers.push({ ...cpi, from: str(info.source)!, to: str(info.destination)!, lamports });
    }
    if (type === "createAccount" && str(info.source) && str(info.newAccount) && lamports) {
      out.solTransfers.push({ ...cpi, from: str(info.source)!, to: str(info.newAccount)!, lamports });
    }
    if (type === "assign" && str(info.account) && str(info.owner)) {
      out.authorityChanges.push({ ...cpi, kind: "system-assign", account: str(info.account)!, authorityType: "ProgramOwner", currentAuthority: SYSTEM_PROGRAM_ID, newAuthority: str(info.owner) });
    }
  } else if (isToken) {
    const authority = str(info.authority) ?? str(info.multisigAuthority) ?? str(info.owner);
    const amount = amountOf(info);
    // transferCheckedWithFee exists only on Token-2022; the program id decides, never the name alone.
    const isTransfer = type === "transfer" || type === "transferChecked" || (type === "transferCheckedWithFee" && tokenProgram === "token-2022");
    if (isTransfer && str(info.source) && str(info.destination) && authority && amount) {
      const decimals = (info.tokenAmount as Raw | undefined)?.decimals;
      out.tokenTransfers.push({ ...cpi, program: tokenProgram, source: str(info.source)!, destination: str(info.destination)!, authority, amountRaw: amount, mint: str(info.mint), decimals: typeof decimals === "number" ? decimals : null });
    }
    if ((type === "approve" || type === "approveChecked") && str(info.source) && str(info.delegate) && authority && amount) {
      out.approvals.push({ ...cpi, account: str(info.source)!, delegate: str(info.delegate)!, owner: authority, amountRaw: amount, unlimited: BigInt(amount) === U64_MAX });
    }
    if (type === "setAuthority") {
      const account = str(info.account) ?? str(info.mint);
      if (account) {
        out.authorityChanges.push({ ...cpi, kind: "token-authority", account, authorityType: AUTHORITY_TYPES[str(info.authorityType) ?? ""] ?? str(info.authorityType) ?? "Unknown", currentAuthority: authority, newAuthority: str(info.newAuthority) });
      }
    }
    if (type === "closeAccount" && str(info.account) && str(info.destination) && authority) {
      out.closes.push({ ...cpi, account: str(info.account)!, destination: str(info.destination)!, authority });
    }
  }

  const accounts = Object.entries(info)
    .filter(([, v]) => typeof v === "string" && v.length >= 32 && v.length <= 44)
    .map(([name, v]) => ({ name, address: v as string, signer: false, writable: false }));

  return {
    index: out.innerInstructions.length,
    programId,
    programName: p.name,
    programTrust: p.trust,
    type: `${isToken ? (tokenProgram === "token-2022" ? "token-2022" : "token") : (str(entry.program) ?? p.name)}:${type}`,
    parsed: true,
    accounts,
    info: flat,
    dataLength: 0,
    parentIndex,
    stackHeight: typeof entry.stackHeight === "number" ? entry.stackHeight : null,
  };
}

export function applyInnerInstructions(
  decoded: DecodedTransaction,
  raw: unknown,
  source: "SIMULATION" | "EXECUTED",
): { applied: number; malformed: number } {
  if (!Array.isArray(raw)) return { applied: 0, malformed: 0 };
  const keys = decoded.accounts.map((a) => a.address);
  let applied = 0;
  let malformed = 0;

  for (const group of raw) {
    const g = group as Raw;
    const parentIndex = typeof g?.index === "number" ? g.index : -1;
    if (parentIndex < 0 || !Array.isArray(g.instructions)) {
      malformed++;
      continue;
    }
    for (const item of g.instructions as Raw[]) {
      let decodedIx: DecodedInstruction | null = null;
      const stackHeight = typeof item?.stackHeight === "number" ? item.stackHeight : null;
      try {
        if (item && typeof item === "object" && "parsed" in item) {
          decodedIx = parsedToInstruction(item, parentIndex, decoded);
        } else if (item && typeof item.programIdIndex === "number" && Array.isArray(item.accounts) && typeof item.data === "string") {
          const programId = keys[item.programIdIndex];
          const accounts = (item.accounts as number[]).map((i) => keys[i]);
          if (programId && accounts.every((a): a is string => typeof a === "string")) {
            decodedIx = decodeInnerRaw(programId, accounts, bs58.decode(item.data), parentIndex, stackHeight, decoded);
          }
        } else if (item && typeof item.programId === "string" && Array.isArray(item.accounts) && typeof item.data === "string") {
          const accounts = item.accounts as unknown[];
          if (accounts.every((a): a is string => typeof a === "string")) {
            decodedIx = decodeInnerRaw(item.programId, accounts, bs58.decode(item.data), parentIndex, stackHeight, decoded);
          }
        }
      } catch {
        decodedIx = null;
      }
      if (!decodedIx) {
        malformed++;
        continue;
      }
      decoded.innerInstructions.push({ ...decodedIx, index: decoded.innerInstructions.length });
      applied++;
    }
  }

  const seen = new Set(decoded.programs.map((p) => p.programId));
  for (const ix of decoded.innerInstructions) {
    if (seen.has(ix.programId)) continue;
    seen.add(ix.programId);
    decoded.programs.push({ programId: ix.programId, name: ix.programName, trust: ix.programTrust });
  }
  if (applied > 0) decoded.innerInstructionsSource = source;
  return { applied, malformed };
}
