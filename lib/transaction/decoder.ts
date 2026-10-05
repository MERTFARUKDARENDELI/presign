import {
  decodeInstruction as decodeTokenInstruction,
  TokenInstruction,
} from "@solana/spl-token";
import {
  ComputeBudgetInstruction,
  PublicKey,
  StakeInstruction,
  SystemInstruction,
  TransactionInstruction,
  type AccountKeysFromLookups,
  type VersionedTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  BPF_LOADER_UPGRADEABLE_ID,
  BUBBLEGUM_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  MEMO_PROGRAM_ID,
  MEMO_V1_PROGRAM_ID,
  programInfo,
  STAKE_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@/lib/solana/constants";
import { decodeGuardInstruction } from "@/lib/guard/codec";
import { GUARD_IX_ACCOUNTS, guardProgramId } from "@/lib/guard/constants";
import { SQUADS_IX_ACCOUNTS, SQUADS_V4_PROGRAM_ID } from "@/lib/squads/constants";
import { decodeSquadsInstruction } from "@/lib/squads/decode";
import type {
  DecodedAccountMeta,
  DecodedInstruction,
  DecodedTransaction,
  InstructionAccountRef,
} from "./types";
import { authorityTypeName, decodeToken2022Extension, TOKEN_2022_FIRST_EXTENSION_IX } from "./token2022";

/**
 * Deterministic, isomorphic transaction decoder (legacy + v0).
 * It reports only what the bytes say; instructions of unknown programs are
 * listed with their accounts but their intent is never guessed.
 */

export const U64_MAX = 18_446_744_073_709_551_615n;
const DEFAULT_CU_PER_INSTRUCTION = 200_000n;
const MAX_CU = 1_400_000n;

/**
 * Upper-bound priority fee (lamports) implied by the transaction's own
 * ComputeBudget instructions: ceil(price µlamports × CU limit / 1e6).
 */
export function estimatePriorityFeeLamports(decoded: DecodedTransaction): bigint {
  // v1 states the total priority fee in the message itself.
  if (decoded.version === 1) return BigInt(decoded.transactionConfig?.priorityFeeLamports ?? "0");
  let price = 0n;
  let limit: bigint | null = null;
  for (const i of decoded.instructions) {
    if (i.type === "computeBudget:setComputeUnitPrice" && i.info.microLamports) price = BigInt(i.info.microLamports);
    if (i.type === "computeBudget:setComputeUnitLimit" && i.info.units) limit = BigInt(i.info.units);
  }
  if (price === 0n) return 0n;
  const nonBudget = BigInt(decoded.instructions.filter((i) => !i.type.startsWith("computeBudget:")).length);
  const units = limit ?? (nonBudget * DEFAULT_CU_PER_INSTRUCTION > MAX_CU ? MAX_CU : nonBudget * DEFAULT_CU_PER_INSTRUCTION);
  return (price * units + 999_999n) / 1_000_000n;
}

export function formatTxVersion(version: DecodedTransaction["version"]): string {
  return version === "legacy" ? "legacy" : `v${version}`;
}

export interface DecodeOptions {
  /** Resolved lookup-table addresses (e.g. from getTransaction meta.loadedAddresses). */
  loadedAddresses?: { writable: string[]; readonly: string[] };
}

const TOKEN_IX_NAMES: Partial<Record<TokenInstruction, string>> = {
  [TokenInstruction.InitializeMint]: "initializeMint",
  [TokenInstruction.InitializeAccount]: "initializeAccount",
  [TokenInstruction.Transfer]: "transfer",
  [TokenInstruction.Approve]: "approve",
  [TokenInstruction.Revoke]: "revoke",
  [TokenInstruction.SetAuthority]: "setAuthority",
  [TokenInstruction.MintTo]: "mintTo",
  [TokenInstruction.Burn]: "burn",
  [TokenInstruction.CloseAccount]: "closeAccount",
  [TokenInstruction.FreezeAccount]: "freezeAccount",
  [TokenInstruction.ThawAccount]: "thawAccount",
  [TokenInstruction.TransferChecked]: "transferChecked",
  [TokenInstruction.ApproveChecked]: "approveChecked",
  [TokenInstruction.MintToChecked]: "mintToChecked",
  [TokenInstruction.BurnChecked]: "burnChecked",
  [TokenInstruction.InitializeAccount2]: "initializeAccount2",
  [TokenInstruction.SyncNative]: "syncNative",
  [TokenInstruction.InitializeAccount3]: "initializeAccount3",
  [TokenInstruction.InitializeMint2]: "initializeMint2",
};

function b58(k: PublicKey): string {
  return k.toBase58();
}

function resolveKeys(tx: VersionedTransaction, options: DecodeOptions): {
  keys: Array<string | null>;
  resolved: boolean;
} {
  const msg = tx.message;
  const staticKeys = msg.staticAccountKeys.map(b58);
  const lookups = "addressTableLookups" in msg ? msg.addressTableLookups : [];
  if (lookups.length === 0) return { keys: staticKeys, resolved: true };

  const writableCount = lookups.reduce((n, l) => n + l.writableIndexes.length, 0);
  const readonlyCount = lookups.reduce((n, l) => n + l.readonlyIndexes.length, 0);
  const loaded = options.loadedAddresses;
  if (loaded && loaded.writable.length === writableCount && loaded.readonly.length === readonlyCount) {
    return { keys: [...staticKeys, ...loaded.writable, ...loaded.readonly], resolved: true };
  }
  return {
    keys: [...staticKeys, ...Array<null>(writableCount + readonlyCount).fill(null)],
    resolved: false,
  };
}

export function lookupAccountsFrom(loaded: { writable: string[]; readonly: string[] }): AccountKeysFromLookups {
  return {
    writable: loaded.writable.map((k) => new PublicKey(k)),
    readonly: loaded.readonly.map((k) => new PublicKey(k)),
  };
}

export function decodeTransaction(tx: VersionedTransaction, options: DecodeOptions = {}): DecodedTransaction {
  const msg = tx.message;
  const { keys, resolved } = resolveKeys(tx, options);
  const numSigners = msg.header.numRequiredSignatures;

  const accounts: DecodedAccountMeta[] = keys.map((address, index) => ({
    index,
    address,
    signer: index < numSigners,
    writable: msg.isAccountWritable(index),
    source: index < msg.staticAccountKeys.length ? "static" : "lookup",
  }));

  const out: DecodedTransaction = {
    version: msg.version === 0 ? 0 : msg.version === 1 ? 1 : "legacy",
    transactionConfig: "transactionConfig" in msg ? {
      computeUnitLimit: msg.transactionConfig.computeUnitLimit,
      heapSize: msg.transactionConfig.heapSize,
      loadedAccountsDataSizeLimit: msg.transactionConfig.loadedAccountsDataSizeLimit,
      priorityFeeLamports: msg.transactionConfig.priorityFee === null ? null : String(msg.transactionConfig.priorityFee),
    } : null,
    feePayer: keys[0] as string,
    signers: accounts.filter((a) => a.signer).map((a) => a.address as string),
    signaturesPresent: tx.signatures.filter((s) => s.some((b) => b !== 0)).length,
    recentBlockhash: msg.recentBlockhash,
    accounts,
    instructions: [],
    programs: [],
    solTransfers: [],
    tokenTransfers: [],
    approvals: [],
    authorityChanges: [],
    closes: [],
    usesDurableNonce: false,
    lookupTablesResolved: resolved,
    undecodedInstructions: [],
    innerInstructions: [],
    innerInstructionsSource: "NONE",
  };

  msg.compiledInstructions.forEach((cix, index) => {
    const programId = keys[cix.programIdIndex];
    const refs = (names: string[]): InstructionAccountRef[] =>
      cix.accountKeyIndexes.map((ki, i) => ({
        name: names[i] ?? `account${i}`,
        address: keys[ki] ?? null,
        signer: accounts[ki]?.signer ?? false,
        writable: accounts[ki]?.writable ?? false,
      }));

    const base = (type: string, parsed: boolean, names: string[] = [], info: Record<string, string | null> = {}): DecodedInstruction => {
      const p = programInfo(programId ?? "");
      return {
        index,
        programId: programId ?? "unresolved",
        programName: p.name,
        programTrust: programId ? p.trust : "unknown",
        type,
        parsed,
        accounts: refs(names),
        info,
        dataLength: cix.data.length,
      };
    };

    if (!programId) {
      out.instructions.push(base("unresolved-program", false));
      out.undecodedInstructions.push(index);
      return;
    }

    const allResolved = cix.accountKeyIndexes.every((ki) => keys[ki] !== null);
    const ix = allResolved
      ? new TransactionInstruction({
          programId: new PublicKey(programId),
          keys: cix.accountKeyIndexes.map((ki) => ({
            pubkey: new PublicKey(keys[ki] as string),
            isSigner: accounts[ki].signer,
            isWritable: accounts[ki].writable,
          })),
          data: Buffer.from(cix.data),
        })
      : null;

    const accountKeys = cix.accountKeyIndexes.map((ki) => keys[ki] ?? null);
    let decoded: DecodedInstruction | null = null;
    try {
      if (ix && programId === SYSTEM_PROGRAM_ID) decoded = decodeSystem(ix, index, out, base);
      else if (ix && (programId === TOKEN_PROGRAM_ID || programId === TOKEN_2022_PROGRAM_ID)) decoded = decodeToken(ix, index, out, base);
      else if (ix && programId === COMPUTE_BUDGET_PROGRAM_ID) decoded = decodeComputeBudget(ix, base);
      else if (ix && programId === STAKE_PROGRAM_ID) decoded = decodeStake(ix, base);
      else if (programId === BUBBLEGUM_PROGRAM_ID) decoded = decodeBubblegum(cix.data, accountKeys, base);
      else if (programId === ASSOCIATED_TOKEN_PROGRAM_ID) decoded = decodeAta(cix.data, base);
      else if (programId === BPF_LOADER_UPGRADEABLE_ID) decoded = decodeBpfLoader(cix.data, accountKeys, index, out, base);
      else if (programId === SQUADS_V4_PROGRAM_ID) decoded = decodeSquads(cix.data, accountKeys, base);
      else if (programId === guardProgramId()) decoded = decodeGuard(cix.data, base);
      else if (programId === MEMO_PROGRAM_ID || programId === MEMO_V1_PROGRAM_ID) {
        const text = new TextDecoder("utf-8", { fatal: false }).decode(cix.data).slice(0, 200);
        decoded = base("memo", true, [], { memo: text });
      }
    } catch {
      decoded = null;
    }

    if (!decoded) {
      const known = programInfo(programId).trust !== "unknown";
      decoded = { ...base(known ? `${programInfo(programId).name}:undecoded` : "unknown", false), rawData: Buffer.from(cix.data).toString("base64") };
      out.undecodedInstructions.push(index);
    } else if (!decoded.parsed) {
      // Identified instruction family whose payload is not decoded (e.g. confidential transfers).
      out.undecodedInstructions.push(index);
    }
    out.instructions.push(decoded);
  });

  const seen = new Set<string>();
  for (const ixn of out.instructions) {
    if (seen.has(ixn.programId)) continue;
    seen.add(ixn.programId);
    out.programs.push({ programId: ixn.programId, name: ixn.programName, trust: ixn.programTrust });
  }
  return out;
}

function emptyEffects(from: DecodedTransaction): DecodedTransaction {
  return { ...from, instructions: [], programs: [], solTransfers: [], tokenTransfers: [], approvals: [], authorityChanges: [], closes: [], undecodedInstructions: [], innerInstructions: [] };
}

/**
 * Decodes one inner (CPI) instruction from raw program id, resolved accounts
 * and data. Effects (transfers, approvals, authority changes, closes) are
 * appended to `out` with `cpi: true` and the parent instruction index.
 */
export function decodeInnerRaw(
  programId: string,
  accounts: string[],
  data: Uint8Array,
  parentIndex: number,
  stackHeight: number | null,
  out: DecodedTransaction,
): DecodedInstruction {
  const p = programInfo(programId);
  const base: BaseFn = (type, parsed, names = [], info = {}) => ({
    index: out.innerInstructions.length,
    programId,
    programName: p.name,
    programTrust: p.trust,
    type,
    parsed,
    accounts: accounts.map((address, i) => ({ name: names[i] ?? `account${i}`, address, signer: false, writable: false })),
    info,
    dataLength: data.length,
    parentIndex,
    stackHeight,
  });
  const scratch = emptyEffects(out);
  let decoded: DecodedInstruction | null = null;
  try {
    const ix = new TransactionInstruction({
      programId: new PublicKey(programId),
      keys: accounts.map((a) => ({ pubkey: new PublicKey(a), isSigner: false, isWritable: false })),
      data: Buffer.from(data),
    });
    if (programId === SYSTEM_PROGRAM_ID) decoded = decodeSystem(ix, parentIndex, scratch, base);
    else if (programId === TOKEN_PROGRAM_ID || programId === TOKEN_2022_PROGRAM_ID) decoded = decodeToken(ix, parentIndex, scratch, base);
    else if (programId === COMPUTE_BUDGET_PROGRAM_ID) decoded = decodeComputeBudget(ix, base);
    else if (programId === STAKE_PROGRAM_ID) decoded = decodeStake(ix, base);
    else if (programId === BUBBLEGUM_PROGRAM_ID) decoded = decodeBubblegum(data, accounts, base);
    else if (programId === ASSOCIATED_TOKEN_PROGRAM_ID) decoded = decodeAta(data, base);
    else if (programId === BPF_LOADER_UPGRADEABLE_ID) decoded = decodeBpfLoader(data, accounts, parentIndex, scratch, base);
    else if (programId === SQUADS_V4_PROGRAM_ID) decoded = decodeSquads(data, accounts, base);
    else if (programId === guardProgramId()) decoded = decodeGuard(data, base);
  } catch {
    decoded = null;
  }
  if (!decoded) decoded = { ...base(p.trust === "unknown" ? "unknown" : `${p.name}:undecoded`, false), rawData: Buffer.from(data).toString("base64") };
  mergeCpiEffects(out, scratch);
  return decoded;
}

/** Copies effect records from `from` into `out`, flagged as CPI. */
export function mergeCpiEffects(out: DecodedTransaction, from: Pick<DecodedTransaction, "solTransfers" | "tokenTransfers" | "approvals" | "authorityChanges" | "closes">) {
  out.solTransfers.push(...from.solTransfers.map((x) => ({ ...x, cpi: true })));
  out.tokenTransfers.push(...from.tokenTransfers.map((x) => ({ ...x, cpi: true })));
  out.approvals.push(...from.approvals.map((x) => ({ ...x, cpi: true })));
  out.authorityChanges.push(...from.authorityChanges.map((x) => ({ ...x, cpi: true })));
  out.closes.push(...from.closes.map((x) => ({ ...x, cpi: true })));
}

type BaseFn = (type: string, parsed: boolean, names?: string[], info?: Record<string, string | null>) => DecodedInstruction;

function decodeSystem(ix: TransactionInstruction, index: number, out: DecodedTransaction, base: BaseFn): DecodedInstruction | null {
  const type = SystemInstruction.decodeInstructionType(ix);
  switch (type) {
    case "Transfer": {
      const d = SystemInstruction.decodeTransfer(ix);
      const lamports = BigInt(d.lamports).toString();
      out.solTransfers.push({ instruction: index, from: b58(d.fromPubkey), to: b58(d.toPubkey), lamports });
      return base("system:transfer", true, ["from", "to"], { from: b58(d.fromPubkey), to: b58(d.toPubkey), lamports });
    }
    case "TransferWithSeed": {
      const d = SystemInstruction.decodeTransferWithSeed(ix);
      const lamports = BigInt(d.lamports).toString();
      out.solTransfers.push({ instruction: index, from: b58(d.fromPubkey), to: b58(d.toPubkey), lamports });
      return base("system:transferWithSeed", true, ["from", "base", "to"], { from: b58(d.fromPubkey), to: b58(d.toPubkey), lamports });
    }
    case "Create": {
      const d = SystemInstruction.decodeCreateAccount(ix);
      const lamports = BigInt(d.lamports).toString();
      out.solTransfers.push({ instruction: index, from: b58(d.fromPubkey), to: b58(d.newAccountPubkey), lamports });
      return base("system:createAccount", true, ["from", "newAccount"], { from: b58(d.fromPubkey), newAccount: b58(d.newAccountPubkey), lamports, space: String(d.space), owner: b58(d.programId) });
    }
    case "Assign": {
      const d = SystemInstruction.decodeAssign(ix);
      out.authorityChanges.push({ instruction: index, kind: "system-assign", account: b58(d.accountPubkey), authorityType: "ProgramOwner", currentAuthority: SYSTEM_PROGRAM_ID, newAuthority: b58(d.programId) });
      return base("system:assign", true, ["account"], { account: b58(d.accountPubkey), newOwnerProgram: b58(d.programId) });
    }
    case "AdvanceNonceAccount": {
      const d = SystemInstruction.decodeNonceAdvance(ix);
      if (index === 0) out.usesDurableNonce = true;
      return base("system:advanceNonce", true, ["nonce", "recentBlockhashes", "authority"], { nonce: b58(d.noncePubkey), authority: b58(d.authorizedPubkey) });
    }
    case "WithdrawNonceAccount": {
      const d = SystemInstruction.decodeNonceWithdraw(ix);
      const lamports = BigInt(d.lamports).toString();
      out.solTransfers.push({ instruction: index, from: b58(d.noncePubkey), to: b58(d.toPubkey), lamports });
      return base("system:withdrawNonce", true, ["nonce", "to"], { nonce: b58(d.noncePubkey), to: b58(d.toPubkey), lamports });
    }
    case "Allocate": {
      const d = SystemInstruction.decodeAllocate(ix);
      return base("system:allocate", true, ["account"], { account: b58(d.accountPubkey), space: String(d.space) });
    }
    case "AllocateWithSeed": {
      const d = SystemInstruction.decodeAllocateWithSeed(ix);
      return base("system:allocateWithSeed", true, ["account", "base"], { account: b58(d.accountPubkey), base: b58(d.basePubkey), space: String(d.space) });
    }
    case "AuthorizeNonceAccount": {
      const d = SystemInstruction.decodeNonceAuthorize(ix);
      out.authorityChanges.push({ instruction: index, kind: "system-assign", account: b58(d.noncePubkey), authorityType: "NonceAuthority", currentAuthority: b58(d.authorizedPubkey), newAuthority: b58(d.newAuthorizedPubkey) });
      return base("system:authorizeNonce", true, ["nonce", "authority"], { nonce: b58(d.noncePubkey), newAuthority: b58(d.newAuthorizedPubkey) });
    }
    default:
      return base(`system:${type.charAt(0).toLowerCase()}${type.slice(1)}`, true);
  }
}

function decodeToken(ix: TransactionInstruction, index: number, out: DecodedTransaction, base: BaseFn): DecodedInstruction | null {
  const programId = ix.programId.toBase58();
  const program = programId === TOKEN_2022_PROGRAM_ID ? "token-2022" : "spl-token";
  const prefix = program === "token-2022" ? "token-2022" : "token";

  // Discriminators >= 25 are Token-2022 extensions. The classic SPL Token
  // program has no such instructions: leave them undecoded there.
  if (ix.data.length > 0 && ix.data[0] >= TOKEN_2022_FIRST_EXTENSION_IX) {
    if (program !== "token-2022") return null;
    const accounts = ix.keys.map((k) => b58(k.pubkey));
    const x = decodeToken2022Extension(new Uint8Array(ix.data), accounts);
    if (!x) return null;
    if (x.transfer) {
      const t = x.transfer;
      out.tokenTransfers.push({ instruction: index, program, source: t.source, destination: t.destination, authority: t.authority, amountRaw: t.amountRaw, mint: t.mint, decimals: t.decimals });
    }
    return base(`${prefix}:${x.name}`, x.parsed, x.accountNames, x.info);
  }

  // Base instructions the spl-token library does not decode (seen in every ATA creation on mainnet).
  // GetAccountDataSize: SPL Token takes no payload; Token-2022 may list u16 extension types.
  if (ix.data[0] === TokenInstruction.GetAccountDataSize && ix.keys.length >= 1 && (ix.data.length === 1 || (program === "token-2022" && (ix.data.length - 1) % 2 === 0))) {
    const exts = Array.from({ length: (ix.data.length - 1) / 2 }, (_, i) => String(ix.data[1 + i * 2] | (ix.data[2 + i * 2] << 8)));
    return base(`${prefix}:getAccountDataSize`, true, ["mint"], { mint: b58(ix.keys[0].pubkey), extensionTypes: exts.join(",") || null });
  }
  if (ix.data[0] === TokenInstruction.InitializeImmutableOwner && ix.data.length === 1 && ix.keys.length >= 1) {
    return base(`${prefix}:initializeImmutableOwner`, true, ["account"], { account: b58(ix.keys[0].pubkey) });
  }

  const d = decodeTokenInstruction(ix, ix.programId);
  const name = TOKEN_IX_NAMES[d.data.instruction as TokenInstruction] ?? `ix${d.data.instruction}`;
  const t = `${prefix}:${name}`;

  switch (d.data.instruction) {
    case TokenInstruction.Transfer: {
      const k = (d as import("@solana/spl-token").DecodedTransferInstruction).keys;
      const amount = (d.data as { amount: bigint }).amount.toString();
      out.tokenTransfers.push({ instruction: index, program, source: b58(k.source.pubkey), destination: b58(k.destination.pubkey), authority: b58(k.owner.pubkey), amountRaw: amount, mint: null, decimals: null });
      return base(t, true, ["source", "destination", "authority"], { source: b58(k.source.pubkey), destination: b58(k.destination.pubkey), authority: b58(k.owner.pubkey), amount });
    }
    case TokenInstruction.TransferChecked: {
      const x = d as import("@solana/spl-token").DecodedTransferCheckedInstruction;
      const amount = x.data.amount.toString();
      out.tokenTransfers.push({ instruction: index, program, source: b58(x.keys.source.pubkey), destination: b58(x.keys.destination.pubkey), authority: b58(x.keys.owner.pubkey), amountRaw: amount, mint: b58(x.keys.mint.pubkey), decimals: x.data.decimals });
      return base(t, true, ["source", "mint", "destination", "authority"], { source: b58(x.keys.source.pubkey), mint: b58(x.keys.mint.pubkey), destination: b58(x.keys.destination.pubkey), authority: b58(x.keys.owner.pubkey), amount, decimals: String(x.data.decimals) });
    }
    case TokenInstruction.Approve:
    case TokenInstruction.ApproveChecked: {
      const x = d as import("@solana/spl-token").DecodedApproveInstruction;
      const amount = (d.data as { amount: bigint }).amount;
      out.approvals.push({ instruction: index, account: b58(x.keys.account.pubkey), delegate: b58(x.keys.delegate.pubkey), owner: b58(x.keys.owner.pubkey), amountRaw: amount.toString(), unlimited: amount === U64_MAX });
      return base(t, true, d.data.instruction === TokenInstruction.Approve ? ["account", "delegate", "owner"] : ["account", "mint", "delegate", "owner"], { account: b58(x.keys.account.pubkey), delegate: b58(x.keys.delegate.pubkey), owner: b58(x.keys.owner.pubkey), amount: amount.toString() });
    }
    case TokenInstruction.Revoke: {
      const x = d as import("@solana/spl-token").DecodedRevokeInstruction;
      return base(t, true, ["account", "owner"], { account: b58(x.keys.account.pubkey), owner: b58(x.keys.owner.pubkey) });
    }
    case TokenInstruction.SetAuthority: {
      const x = d as import("@solana/spl-token").DecodedSetAuthorityInstruction;
      const kind = authorityTypeName(x.data.authorityType, program);
      const newAuthority = x.data.newAuthority ? b58(x.data.newAuthority) : null;
      out.authorityChanges.push({ instruction: index, kind: "token-authority", account: b58(x.keys.account.pubkey), authorityType: kind, currentAuthority: b58(x.keys.currentAuthority.pubkey), newAuthority });
      return base(t, true, ["account", "currentAuthority"], { account: b58(x.keys.account.pubkey), authorityType: kind, currentAuthority: b58(x.keys.currentAuthority.pubkey), newAuthority });
    }
    case TokenInstruction.CloseAccount: {
      const x = d as import("@solana/spl-token").DecodedCloseAccountInstruction;
      out.closes.push({ instruction: index, account: b58(x.keys.account.pubkey), destination: b58(x.keys.destination.pubkey), authority: b58(x.keys.authority.pubkey) });
      return base(t, true, ["account", "destination", "authority"], { account: b58(x.keys.account.pubkey), destination: b58(x.keys.destination.pubkey), authority: b58(x.keys.authority.pubkey) });
    }
    case TokenInstruction.Burn:
    case TokenInstruction.BurnChecked: {
      const x = d as import("@solana/spl-token").DecodedBurnInstruction;
      const amount = (d.data as { amount: bigint }).amount.toString();
      return base(t, true, ["account", "mint", "owner"], { account: b58(x.keys.account.pubkey), mint: b58(x.keys.mint.pubkey), owner: b58(x.keys.owner.pubkey), amount, decimals: "decimals" in d.data ? String((d.data as { decimals: number }).decimals) : null });
    }
    case TokenInstruction.MintTo:
    case TokenInstruction.MintToChecked: {
      const x = d as import("@solana/spl-token").DecodedMintToInstruction;
      return base(t, true, ["mint", "destination", "authority"], { mint: b58(x.keys.mint.pubkey), destination: b58(x.keys.destination.pubkey), authority: b58(x.keys.authority.pubkey), amount: (d.data as { amount: bigint }).amount.toString() });
    }
    case TokenInstruction.FreezeAccount:
    case TokenInstruction.ThawAccount: {
      const x = d as import("@solana/spl-token").DecodedFreezeAccountInstruction;
      return base(t, true, ["account", "mint", "authority"], { account: b58(x.keys.account.pubkey), mint: b58(x.keys.mint.pubkey), authority: b58(x.keys.authority.pubkey) });
    }
    default:
      return base(t, true);
  }
}

const STAKE_AUTHORITY = ["Staker", "Withdrawer"];

/**
 * Stake program. Staked SOL sits in stake accounts, not in the wallet: a
 * withdraw-authority change or a withdrawal to another address moves funds the
 * wallet's own balance never shows, so these are decoded explicitly.
 */
function decodeStake(ix: TransactionInstruction, base: BaseFn): DecodedInstruction | null {
  const tag = ix.data.length >= 4 ? ix.data.readUInt32LE(0) : -1;
  const key = (i: number) => (ix.keys[i] ? b58(ix.keys[i].pubkey) : null);
  try {
    switch (tag) {
      case 1: {
        const d = StakeInstruction.decodeAuthorize(ix);
        return base("stake:authorize", true, ["stakeAccount", "clock", "authority"], { stakeAccount: b58(d.stakePubkey), authority: b58(d.authorizedPubkey), newAuthority: b58(d.newAuthorizedPubkey), authorityType: STAKE_AUTHORITY[d.stakeAuthorizationType.index] ?? String(d.stakeAuthorizationType.index) });
      }
      case 8: {
        const d = StakeInstruction.decodeAuthorizeWithSeed(ix);
        return base("stake:authorizeWithSeed", true, ["stakeAccount", "authorityBase"], { stakeAccount: b58(d.stakePubkey), authority: b58(d.authorityBase), newAuthority: b58(d.newAuthorizedPubkey), authorityType: STAKE_AUTHORITY[d.stakeAuthorizationType.index] ?? String(d.stakeAuthorizationType.index) });
      }
      case 10:
      case 11: {
        // AuthorizeChecked(WithSeed): the new authority is an account (and must sign); the type follows the tag.
        const type = ix.data.length >= 8 ? ix.data.readUInt32LE(4) : -1;
        const checked = tag === 10;
        return base(checked ? "stake:authorizeChecked" : "stake:authorizeCheckedWithSeed", true, checked ? ["stakeAccount", "clock", "authority", "newAuthority"] : ["stakeAccount", "authorityBase", "clock", "newAuthority"], { stakeAccount: key(0), authority: checked ? key(2) : key(1), newAuthority: key(3), authorityType: STAKE_AUTHORITY[type] ?? String(type) });
      }
      case 4: {
        const d = StakeInstruction.decodeWithdraw(ix);
        return base("stake:withdraw", true, ["stakeAccount", "to", "clock", "stakeHistory", "authority"], { stakeAccount: b58(d.stakePubkey), to: b58(d.toPubkey), authority: b58(d.authorizedPubkey), lamports: BigInt(d.lamports).toString() });
      }
      case 6:
      case 12:
        return base(tag === 6 ? "stake:setLockup" : "stake:setLockupChecked", true, ["stakeAccount", "authority"], { stakeAccount: key(0), authority: key(1) });
      case 3: {
        const d = StakeInstruction.decodeSplit(ix);
        return base("stake:split", true, ["stakeAccount", "splitStakeAccount", "authority"], { stakeAccount: b58(d.stakePubkey), splitStakeAccount: b58(d.splitStakePubkey), authority: b58(d.authorizedPubkey), lamports: BigInt(d.lamports).toString() });
      }
      case 2:
        return base("stake:delegate", true, ["stakeAccount", "vote"], { stakeAccount: key(0), vote: key(1) });
      case 5:
        return base("stake:deactivate", true, ["stakeAccount"], { stakeAccount: key(0) });
      case 7:
        return base("stake:merge", true, ["destination", "source"], { destination: key(0), source: key(1) });
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Anchor discriminators (sha256("global:<name>")[0..8]) of Metaplex Bubblegum instructions that move or give away compressed NFTs. */
export const BUBBLEGUM_DISCRIMINATORS: Record<string, number[]> = {
  transfer: [163, 52, 200, 231, 140, 3, 69, 186],
  delegate: [90, 147, 75, 178, 85, 88, 4, 137],
  burn: [116, 110, 29, 56, 107, 219, 42, 93],
  transferV2: [119, 40, 6, 235, 234, 221, 248, 49],
  delegateV2: [95, 87, 125, 140, 181, 131, 128, 227],
  burnV2: [115, 210, 34, 240, 232, 143, 183, 16],
};

/**
 * Metaplex Bubblegum (compressed NFTs). cNFTs live in Merkle trees, not token
 * accounts, so their movement never appears in a token-balance simulation —
 * the decoded instruction is the only evidence. v1 account layouts are decoded;
 * v2 instructions are identified by name only (accounts not interpreted).
 */
function decodeBubblegum(data: Uint8Array, accounts: Array<string | null>, base: BaseFn): DecodedInstruction | null {
  if (data.length < 8) return null;
  const name = Object.entries(BUBBLEGUM_DISCRIMINATORS).find(([, d]) => d.every((b, i) => data[i] === b))?.[0];
  if (!name) return null;
  const a = (i: number) => accounts[i] ?? null;
  switch (name) {
    case "transfer":
      return base("bubblegum:transfer", true, ["treeAuthority", "leafOwner", "leafDelegate", "newLeafOwner", "merkleTree"], { leafOwner: a(1), leafDelegate: a(2), newLeafOwner: a(3), merkleTree: a(4) });
    case "delegate":
      return base("bubblegum:delegate", true, ["treeAuthority", "leafOwner", "previousLeafDelegate", "newLeafDelegate", "merkleTree"], { leafOwner: a(1), previousLeafDelegate: a(2), newLeafDelegate: a(3), merkleTree: a(4) });
    case "burn":
      return base("bubblegum:burn", true, ["treeAuthority", "leafOwner", "leafDelegate", "merkleTree"], { leafOwner: a(1), leafDelegate: a(2), merkleTree: a(3) });
    default:
      return base(`bubblegum:${name}`, false);
  }
}

function decodeComputeBudget(ix: TransactionInstruction, base: BaseFn): DecodedInstruction | null {
  const type = ComputeBudgetInstruction.decodeInstructionType(ix);
  if (type === "SetComputeUnitPrice") {
    const d = ComputeBudgetInstruction.decodeSetComputeUnitPrice(ix);
    return base("computeBudget:setComputeUnitPrice", true, [], { microLamports: BigInt(d.microLamports).toString() });
  }
  if (type === "SetComputeUnitLimit") {
    const d = ComputeBudgetInstruction.decodeSetComputeUnitLimit(ix);
    return base("computeBudget:setComputeUnitLimit", true, [], { units: String(d.units) });
  }
  return base(`computeBudget:${type}`, true);
}

/**
 * BPF Upgradeable Loader (bincode, u32 LE tag). Upgrades and upgrade-authority
 * changes are the most privileged actions a program owner can take.
 */
function decodeBpfLoader(data: Uint8Array, accounts: Array<string | null>, index: number, out: DecodedTransaction, base: BaseFn): DecodedInstruction | null {
  if (data.length < 4) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const a = (i: number) => accounts[i] ?? null;
  switch (view.getUint32(0, true)) {
    case 0:
      return base("bpfLoader:initializeBuffer", true, ["buffer", "authority"], { buffer: a(0), authority: a(1) });
    case 1:
      return base("bpfLoader:write", true, ["buffer", "authority"], { buffer: a(0), authority: a(1) });
    case 2:
      return base("bpfLoader:deployWithMaxDataLen", true, ["payer", "programData", "program", "buffer", "rent", "clock", "systemProgram", "authority"], { program: a(2), buffer: a(3), authority: a(7) });
    case 3:
      return base("bpfLoader:upgrade", true, ["programData", "program", "buffer", "spill", "rent", "clock", "authority"], { program: a(1), programData: a(0), buffer: a(2), authority: a(6) });
    case 4:
    case 7: {
      const checked = view.getUint32(0, true) === 7;
      // SetAuthority: a missing third account makes the program (or buffer) immutable.
      const newAuthority = a(2);
      out.authorityChanges.push({ instruction: index, kind: "program-upgrade-authority", account: a(0) ?? "unresolved", authorityType: "UpgradeAuthority", currentAuthority: a(1), newAuthority });
      return base(checked ? "bpfLoader:setAuthorityChecked" : "bpfLoader:setAuthority", true, ["account", "currentAuthority", "newAuthority"], { account: a(0), currentAuthority: a(1), newAuthority });
    }
    case 5:
      return base("bpfLoader:close", true, ["account", "recipient", "authority", "program"], { account: a(0), recipient: a(1), authority: a(2), program: a(3) });
    case 6:
    case 9:
      return base(view.getUint32(0, true) === 6 ? "bpfLoader:extendProgram" : "bpfLoader:extendProgramChecked", true, ["programData", "program"], { program: a(1), additionalBytes: data.length >= 8 ? String(view.getUint32(4, true)) : null });
    case 8:
      return base("bpfLoader:migrate", true, ["programData", "program", "authority"], { program: a(1), authority: a(2) });
    default:
      return null;
  }
}

/** Squads v4 multisig instructions; the vault payload itself is decoded separately (lib/multisig). */
function decodeSquads(data: Uint8Array, accounts: Array<string | null>, base: BaseFn): DecodedInstruction | null {
  const s = decodeSquadsInstruction(data, accounts);
  if (!s) return null;
  const info: Record<string, string | null> = { ...s.extra };
  for (const k of ["multisig", "proposal", "transaction", "member", "creator", "configAuthority"]) {
    if (k in s.accounts) info[k] = s.accounts[k];
  }
  if (s.vote) info.vote = s.vote;
  if (s.transactionIndex) info.transactionIndex = s.transactionIndex;
  if (s.vaultIndex !== null) info.vaultIndex = String(s.vaultIndex);
  if (s.message) info.vaultInstructions = String(s.message.instructions.length);
  if (s.configActions.length) info.configActions = s.configActions.map((c) => c.type).join(", ");
  if (s.memo !== null) info.memo = s.memo;
  return base(`squads:${s.name}`, true, SQUADS_IX_ACCOUNTS[s.name] ?? [], info);
}

/**
 * Presign Guard. A schedule carries the instructions that will run later; they
 * are kept (hidden `_scheduled`) for the Guard analysis, not executed here.
 */
function decodeGuard(data: Uint8Array, base: BaseFn): DecodedInstruction | null {
  const g = decodeGuardInstruction(data);
  if (!g) return null;
  const info: Record<string, string | null> = {};
  if (g.name === "schedule") {
    info.memo = g.memo;
    info.scheduledInstructions = String(g.instructions.length);
    info._scheduled = JSON.stringify(g.instructions.map((ix) => ({ programId: ix.programId, accounts: ix.accounts, data: Buffer.from(ix.data).toString("base64") })));
  } else if (g.name === "updateConfig" || g.name === "createGuard") {
    info.proposer = g.config.proposer;
    info.guardians = g.config.guardians.join(", ");
    info.delaySeconds = String(g.config.delaySeconds);
  }
  return base(`guard:${g.name}`, true, GUARD_IX_ACCOUNTS[g.name], info);
}

function decodeAta(data: Uint8Array, base: BaseFn): DecodedInstruction | null {
  const names = ["payer", "associatedAccount", "wallet", "mint", "systemProgram", "tokenProgram"];
  if (data.length === 0 || data[0] === 0) return base("ata:create", true, names);
  if (data[0] === 1) return base("ata:createIdempotent", true, names);
  if (data[0] === 2) return base("ata:recoverNested", true);
  return null;
}
