import type { DecodedInstruction, DecodedTransaction } from "@/lib/transaction/types";
import type { AuthorityControl, PrivilegedAction } from "./types";

/**
 * Deterministic classification of privileged actions in a decoded payload.
 * Built-in decoders (BPF loader, SPL Token, System) are exact. For Anchor
 * programs the classification is name-based on the program's own IDL: an
 * instruction named like `update_admin` with a pubkey argument named `admin`
 * is an admin transfer. Names state intent; they do not prove behavior, and
 * the evidence says so.
 */

/** Instruction names (snake_case) that hand an authority role to a new key. */
const AUTHORITY_TRANSFER_IX = /^(set|update|change|transfer|accept|propose|nominate|assign|rotate)_(new_)?(pending_)?(super_)?(admin|authority|owner|governance|governor|guardian|upgrade_authority|multisig|council)s?$/;
/** Pubkey arguments that carry the new authority. */
const AUTHORITY_ARG = /^(new_?)?(pending_?)?(super_?)?(admin|authority|owner|governance|governor|guardian)$/i;
/** IDL account names that mark the signer as the program's privileged role. */
const ADMIN_ACCOUNT = /^(admin|authority|owner|governance|governor|guardian|super_?admin|[a-z]+_?(admin|authority))$/i;
/** Administrative (non-transfer) instruction names worth a signer's attention. */
const ADMIN_IX = /(admin|authority|owner|upgrade|governance|guardian|pause|emergency|whitelist|allowlist|blacklist|oracle|config|param|fee|freeze|migrate|withdraw_(fees|protocol|treasury|insurance))/;

const toSnake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

export function controlOf(address: string | null, controlled: ReadonlySet<string>, members: ReadonlySet<string>): AuthorityControl {
  if (address === null) return "none";
  if (controlled.has(address)) return "multisig";
  if (members.has(address)) return "member";
  return "outside";
}

function classify(ix: DecodedInstruction, origin: string, controlled: ReadonlySet<string>, members: ReadonlySet<string>): PrivilegedAction | null {
  const base = { origin, programId: ix.programId, programName: ix.programName };
  const f = ix.info;
  switch (ix.type) {
    case "bpfLoader:upgrade":
      return { ...base, kind: "program-upgrade", action: "upgrade", target: f.program ?? null, control: null, authorityField: null, source: "TRANSACTION_DECODER" };
    case "bpfLoader:setAuthority":
    case "bpfLoader:setAuthorityChecked": {
      const next = f.newAuthority ?? null;
      return { ...base, kind: "upgrade-authority", action: ix.type.split(":")[1], target: f.account ?? null, newAuthority: next, control: controlOf(next, controlled, members), authorityField: "newAuthority account", source: "TRANSACTION_DECODER" };
    }
    case "bpfLoader:close":
      return { ...base, kind: "program-close", action: "close", target: f.program ?? f.account ?? null, control: null, authorityField: null, source: "TRANSACTION_DECODER" };
    case "token:setAuthority":
    case "token-2022:setAuthority": {
      const next = f.newAuthority ?? null;
      return { ...base, kind: "token-authority", action: `setAuthority(${f.authorityType ?? "?"})`, target: f.account ?? null, newAuthority: next, control: controlOf(next, controlled, members), authorityField: "newAuthority argument", source: "TRANSACTION_DECODER" };
    }
    case "system:assign":
      return { ...base, kind: "account-reassign", action: "assign", target: f.account ?? null, control: null, authorityField: null, source: "TRANSACTION_DECODER" };
  }
  if (!ix.type.startsWith("anchor:")) return null;

  const name = ix.type.slice("anchor:".length);
  const snake = toSnake(name);
  const types = Object.fromEntries((f._argTypes ?? "").split(", ").filter(Boolean).map((p) => p.split(":") as [string, string]));
  const authorityArg = Object.keys(types).find((a) => types[a] === "publicKey" && AUTHORITY_ARG.test(a));
  const authorityAccount = ix.accounts.find((a) => /^new_?(admin|authority|owner|governance|guardian)$/i.test(a.name));
  if (AUTHORITY_TRANSFER_IX.test(snake) || (ADMIN_IX.test(snake) && authorityArg)) {
    const next = authorityArg ? (f[authorityArg] ?? null) : (authorityAccount?.address ?? null);
    const known = Boolean(authorityArg || authorityAccount);
    return {
      ...base,
      kind: "admin-transfer",
      action: name,
      target: ix.accounts.find((a) => a.writable)?.address ?? null,
      newAuthority: known ? next : undefined,
      control: known ? controlOf(next, controlled, members) : null,
      authorityField: authorityArg ? `argument "${authorityArg}"` : authorityAccount ? `account "${authorityAccount.name}"` : null,
      source: "ANCHOR_IDL",
    };
  }
  // A call the multisig itself signs is an exercise of its authority, whatever the instruction is named;
  // so is a call whose IDL names its signer as the program's admin or authority.
  const signedByMultisig = ix.accounts.some((a) => a.signer && a.address !== null && controlled.has(a.address));
  const adminSigner = ix.accounts.find((a) => a.signer && ADMIN_ACCOUNT.test(a.name));
  if (ADMIN_IX.test(snake) || signedByMultisig || adminSigner) {
    return { ...base, kind: "admin-action", action: name, target: null, control: null, authorityField: signedByMultisig ? "signed by the multisig vault" : adminSigner ? `signer account "${adminSigner.name}"` : null, source: "ANCHOR_IDL" };
  }
  return null;
}

export function findPrivilegedActions(
  decoded: DecodedTransaction,
  originPrefix: string,
  controlled: ReadonlySet<string>,
  members: ReadonlySet<string>,
  filter: (ix: DecodedInstruction) => boolean = () => true,
): PrivilegedAction[] {
  const out: PrivilegedAction[] = [];
  for (const ix of decoded.instructions.filter(filter)) {
    const p = classify(ix, `${originPrefix}instruction ${ix.index}`, controlled, members);
    if (p) out.push(p);
  }
  for (const ix of decoded.innerInstructions.filter(filter)) {
    const p = classify(ix, `${originPrefix}internal call of instruction ${ix.parentIndex ?? "?"}`, controlled, members);
    if (p) out.push(p);
  }
  return out;
}
