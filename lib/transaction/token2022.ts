import { PublicKey } from "@solana/web3.js";

/**
 * Token-2022 extension instructions (discriminator >= 25). These exist ONLY
 * on the Token-2022 program; the classic SPL Token program has no such
 * instructions, so callers must never route SPL Token data here.
 *
 * Decoding is byte-exact: the discriminator, sub-instruction and data length
 * must all match a known layout, otherwise the result is null (undecoded) and
 * nothing is guessed. Confidential-transfer families are identified by
 * discriminator but their payloads (zero-knowledge proofs) are not decoded.
 *
 * Instruction names follow the RPC jsonParsed names so top-level and CPI
 * (parsed inner) instructions share one vocabulary.
 */

export const TOKEN_2022_FIRST_EXTENSION_IX = 25;

export interface Token2022Decoded {
  name: string;
  /** false = family identified, payload not decoded (added to undecodedInstructions). */
  parsed: boolean;
  accountNames: string[];
  info: Record<string, string | null>;
  transfer?: { source: string; mint: string; destination: string; authority: string; amountRaw: string; decimals: number; feeRaw: string };
}

const ACCOUNT_STATE: Record<number, string> = { 0: "uninitialized", 1: "initialized", 2: "frozen" };

function u16(d: Uint8Array, o: number): number {
  return d[o] | (d[o + 1] << 8);
}
function u64(d: Uint8Array, o: number): string {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[o + i]);
  return v.toString();
}
function i16(d: Uint8Array, o: number): number {
  const v = u16(d, o);
  return v >= 0x8000 ? v - 0x10000 : v;
}
function key(d: Uint8Array, o: number): string | null {
  const slice = d.slice(o, o + 32);
  return slice.every((b) => b === 0) ? null : new PublicKey(slice).toBase58();
}

type Layout = { name: string; len: number | ((d: Uint8Array) => boolean); accounts: string[]; minAccounts: number; info?: (d: Uint8Array) => Record<string, string | null> };

const pointer = (label: string): Record<number, Layout> => ({
  0: { name: `initialize${label}`, len: 66, accounts: ["mint"], minAccounts: 1, info: (d) => ({ authority: key(d, 2), address: key(d, 34) }) },
  1: { name: `update${label}`, len: 34, accounts: ["mint", "authority"], minAccounts: 2, info: (d) => ({ address: key(d, 2) }) },
});

/** Extension families that carry a sub-instruction byte at data[1]. */
const FAMILIES: Record<number, Record<number, Layout>> = {
  26: {
    // Two COption<Pubkey> (1 or 33 bytes each) + u16 bps + u64 max fee.
    0: { name: "initializeTransferFeeConfig", len: (d) => [14, 46, 78].includes(d.length), accounts: ["mint"], minAccounts: 1 },
    1: { name: "transferCheckedWithFee", len: 19, accounts: ["source", "mint", "destination", "authority"], minAccounts: 4, info: (d) => ({ amount: u64(d, 2), decimals: String(d[10]), fee: u64(d, 11) }) },
    2: { name: "withdrawWithheldTokensFromMint", len: 2, accounts: ["mint", "destination", "authority"], minAccounts: 3 },
    3: { name: "withdrawWithheldTokensFromAccounts", len: 3, accounts: ["mint", "destination", "authority"], minAccounts: 3, info: (d) => ({ numTokenAccounts: String(d[2]) }) },
    4: { name: "harvestWithheldTokensToMint", len: 2, accounts: ["mint"], minAccounts: 1 },
    5: { name: "setTransferFee", len: 12, accounts: ["mint", "authority"], minAccounts: 2, info: (d) => ({ transferFeeBasisPoints: String(u16(d, 2)), maximumFee: u64(d, 4) }) },
  },
  28: {
    0: { name: "initializeDefaultAccountState", len: 3, accounts: ["mint"], minAccounts: 1, info: (d) => ({ accountState: ACCOUNT_STATE[d[2]] ?? null }) },
    1: { name: "updateDefaultAccountState", len: 3, accounts: ["mint", "freezeAuthority"], minAccounts: 2, info: (d) => ({ accountState: ACCOUNT_STATE[d[2]] ?? null }) },
  },
  30: {
    0: { name: "enableRequiredMemoTransfers", len: 2, accounts: ["account", "owner"], minAccounts: 2 },
    1: { name: "disableRequiredMemoTransfers", len: 2, accounts: ["account", "owner"], minAccounts: 2 },
  },
  33: {
    0: { name: "initializeInterestBearingConfig", len: 36, accounts: ["mint"], minAccounts: 1, info: (d) => ({ rateAuthority: key(d, 2), rate: String(i16(d, 34)) }) },
    1: { name: "updateInterestBearingConfigRate", len: 4, accounts: ["mint", "rateAuthority"], minAccounts: 2, info: (d) => ({ rate: String(i16(d, 2)) }) },
  },
  34: {
    0: { name: "enableCpiGuard", len: 2, accounts: ["account", "owner"], minAccounts: 2 },
    1: { name: "disableCpiGuard", len: 2, accounts: ["account", "owner"], minAccounts: 2 },
  },
  36: {
    0: { name: "initializeTransferHook", len: 66, accounts: ["mint"], minAccounts: 1, info: (d) => ({ authority: key(d, 2), programId: key(d, 34) }) },
    1: { name: "updateTransferHook", len: 34, accounts: ["mint", "authority"], minAccounts: 2, info: (d) => ({ programId: key(d, 2) }) },
  },
  39: pointer("MetadataPointer"),
  40: pointer("GroupPointer"),
  41: pointer("GroupMemberPointer"),
  44: {
    0: { name: "initializePausableConfig", len: 34, accounts: ["mint"], minAccounts: 1, info: (d) => ({ authority: key(d, 2) }) },
    1: { name: "pause", len: 2, accounts: ["mint", "authority"], minAccounts: 2 },
    2: { name: "resume", len: 2, accounts: ["mint", "authority"], minAccounts: 2 },
  },
};

/** Single-instruction extensions (no sub-instruction byte). */
const SINGLES: Record<number, Layout> = {
  25: { name: "initializeMintCloseAuthority", len: (d) => d.length === 2 || d.length === 34, accounts: ["mint"], minAccounts: 1, info: (d) => ({ closeAuthority: d[1] === 1 && d.length === 34 ? key(d, 2) : null }) },
  29: { name: "reallocate", len: (d) => d.length >= 1 && (d.length - 1) % 2 === 0, accounts: ["account", "payer", "systemProgram", "owner"], minAccounts: 4, info: (d) => ({ extensionTypes: Array.from({ length: (d.length - 1) / 2 }, (_, i) => String(u16(d, 1 + i * 2))).join(",") || null }) },
  31: { name: "createNativeMint", len: 1, accounts: ["payer", "nativeMint", "systemProgram"], minAccounts: 3 },
  32: { name: "initializeNonTransferableMint", len: 1, accounts: ["mint"], minAccounts: 1 },
  35: { name: "initializePermanentDelegate", len: 33, accounts: ["mint"], minAccounts: 1, info: (d) => ({ delegate: key(d, 1) }) },
  38: { name: "withdrawExcessLamports", len: 1, accounts: ["source", "destination", "authority"], minAccounts: 3 },
};

/** Identified families whose payloads are not decoded (proof-based or not yet supported). */
const OPAQUE: Record<number, string> = {
  27: "confidentialTransferExtension",
  37: "confidentialTransferFeeExtension",
  42: "confidentialMintBurnExtension",
  43: "scaledUiAmountExtension",
  45: "unwrapLamports",
  46: "permissionedBurnExtension",
};

export function isConfidentialFamily(name: string): boolean {
  return name.startsWith("confidential");
}

export function decodeToken2022Extension(data: Uint8Array, accounts: string[]): Token2022Decoded | null {
  if (data.length === 0 || data[0] < TOKEN_2022_FIRST_EXTENSION_IX) return null;
  const disc = data[0];

  const opaque = OPAQUE[disc];
  if (opaque) return { name: opaque, parsed: false, accountNames: [], info: {} };

  const layout = SINGLES[disc] ?? (data.length >= 2 ? FAMILIES[disc]?.[data[1]] : undefined);
  if (!layout) return null;
  const lenOk = typeof layout.len === "number" ? data.length === layout.len : layout.len(data);
  if (!lenOk || accounts.length < layout.minAccounts) return null;

  const info: Record<string, string | null> = {};
  layout.accounts.forEach((n, i) => (info[n] = accounts[i] ?? null));
  Object.assign(info, layout.info?.(data) ?? {});

  const out: Token2022Decoded = { name: layout.name, parsed: true, accountNames: layout.accounts, info };
  if (layout.name === "transferCheckedWithFee") {
    out.transfer = { source: accounts[0], mint: accounts[1], destination: accounts[2], authority: accounts[3], amountRaw: info.amount!, decimals: Number(info.decimals), feeRaw: info.fee! };
  }
  return out;
}

const EXTENDED_AUTHORITY_NAMES: Record<number, string> = {
  4: "TransferFeeConfig",
  5: "WithheldWithdraw",
  6: "CloseMint",
  7: "InterestRate",
  8: "PermanentDelegate",
  9: "ConfidentialTransferMint",
  10: "TransferHookProgramId",
  11: "ConfidentialTransferFeeConfig",
  12: "MetadataPointer",
  13: "GroupPointer",
  14: "GroupMemberPointer",
  15: "ScaledUiAmountConfig",
  16: "PausableConfig",
  17: "PermissionedBurn",
};

/** SetAuthority type names. Types >= 4 exist only on Token-2022; on SPL Token they are invalid. */
export function authorityTypeName(type: number, program: "spl-token" | "token-2022"): string {
  const base = ["MintTokens", "FreezeAccount", "AccountOwner", "CloseAccount"][type];
  if (base) return base;
  if (program === "token-2022" && EXTENDED_AUTHORITY_NAMES[type]) return EXTENDED_AUTHORITY_NAMES[type];
  return `Unknown(${type})`;
}
