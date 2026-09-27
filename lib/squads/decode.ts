import { MessageV0, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { BorshReader, hex } from "./borsh";
import {
  SQUADS_ACCOUNT_DISCRIMINATOR,
  SQUADS_IX_ACCOUNTS,
  SQUADS_IX_BY_DISCRIMINATOR,
  SQUADS_PERMISSION,
  type SquadsIxName,
} from "./constants";
import type {
  BatchAccount,
  ConfigAction,
  ConfigTransactionAccount,
  MultisigAccount,
  ProposalAccount,
  ProposalStatusName,
  SquadsInstruction,
  SquadsIxKind,
  SquadsMember,
  SquadsMessage,
  SquadsPermission,
  TransactionBufferAccount,
  VaultBatchTransactionAccount,
  VaultTransactionAccount,
} from "./types";

/**
 * Deterministic, isomorphic decoder for Squads v4 instructions and accounts.
 * Layouts follow the program's published IDL (v2.1.0). Unknown discriminators
 * return null (never guessed); malformed payloads throw.
 */

const DEFAULT_PUBKEY = "11111111111111111111111111111111";
/** Placeholder blockhash for vault messages: they carry none; the multisig program supplies execution context. */
const NO_BLOCKHASH = DEFAULT_PUBKEY;

const PERIODS = ["OneTime", "Day", "Week", "Month"] as const;
const PROPOSAL_STATUSES: ProposalStatusName[] = ["Draft", "Active", "Rejected", "Approved", "Executing", "Executed", "Cancelled"];

const KIND: Record<SquadsIxName, SquadsIxKind> = {
  programConfigInit: "program-config",
  programConfigSetAuthority: "program-config",
  programConfigSetMultisigCreationFee: "program-config",
  programConfigSetTreasury: "program-config",
  multisigCreate: "multisig-create",
  multisigCreateV2: "multisig-create",
  multisigAddMember: "multisig-config",
  multisigRemoveMember: "multisig-config",
  multisigSetTimeLock: "multisig-config",
  multisigChangeThreshold: "multisig-config",
  multisigSetConfigAuthority: "multisig-config",
  multisigSetRentCollector: "multisig-config",
  multisigAddSpendingLimit: "multisig-config",
  multisigRemoveSpendingLimit: "multisig-config",
  configTransactionCreate: "create-config-transaction",
  configTransactionExecute: "execute",
  vaultTransactionCreate: "create-vault-transaction",
  transactionBufferCreate: "buffer",
  transactionBufferClose: "buffer",
  transactionBufferExtend: "buffer",
  vaultTransactionCreateFromBuffer: "create-vault-transaction",
  vaultTransactionExecute: "execute",
  batchCreate: "create-batch",
  batchAddTransaction: "create-vault-transaction",
  batchExecuteTransaction: "execute",
  proposalCreate: "create-proposal",
  proposalActivate: "activate-proposal",
  proposalApprove: "vote",
  proposalReject: "vote",
  proposalCancel: "vote",
  proposalCancelV2: "vote",
  spendingLimitUse: "spending-limit-use",
  configTransactionAccountsClose: "close",
  vaultTransactionAccountsClose: "close",
  vaultBatchTransactionAccountClose: "close",
  batchAccountsClose: "close",
};

export function permissionsFromMask(mask: number): SquadsPermission[] {
  return (Object.entries(SQUADS_PERMISSION) as Array<[SquadsPermission, number]>).filter(([, bit]) => (mask & bit) !== 0).map(([name]) => name);
}

function member(r: BorshReader): SquadsMember {
  return { key: r.pubkey(), permissions: permissionsFromMask(r.u8()) };
}

function memo(r: BorshReader): string | null {
  return r.option(() => r.string().slice(0, 200));
}

function configAction(r: BorshReader): ConfigAction {
  const variant = r.u8();
  switch (variant) {
    case 0:
      return { type: "AddMember", member: member(r) };
    case 1:
      return { type: "RemoveMember", member: r.pubkey() };
    case 2:
      return { type: "ChangeThreshold", newThreshold: r.u16() };
    case 3:
      return { type: "SetTimeLock", newTimeLock: r.u32() };
    case 4: {
      const createKey = r.pubkey();
      const vaultIndex = r.u8();
      const mint = r.pubkey();
      const amount = r.u64().toString();
      const p = r.u8();
      if (p >= PERIODS.length) throw new RangeError(`Unknown spending-limit period ${p}`);
      return { type: "AddSpendingLimit", createKey, vaultIndex, mint, amount, period: PERIODS[p], members: r.vec(() => r.pubkey()), destinations: r.vec(() => r.pubkey()) };
    }
    case 5:
      return { type: "RemoveSpendingLimit", spendingLimit: r.pubkey() };
    case 6:
      return { type: "SetRentCollector", newRentCollector: r.option(() => r.pubkey()) };
    default:
      throw new RangeError(`Unknown config action ${variant}`);
  }
}

/**
 * The `transaction_message` bytes of vaultTransactionCreate / batchAddTransaction
 * and of transaction buffers: Squads' compact TransactionMessage, where vectors
 * use u8 length prefixes and instruction data a u16 prefix. Must be consumed exactly.
 */
export function parseTransactionMessage(bytes: Uint8Array): SquadsMessage {
  const r = new BorshReader(bytes);
  const numSigners = r.u8();
  const numWritableSigners = r.u8();
  const numWritableNonSigners = r.u8();
  const accountKeys = Array.from({ length: r.u8() }, () => r.pubkey());
  const instructions = Array.from({ length: r.u8() }, () => {
    const programIdIndex = r.u8();
    const accountIndexes = Array.from(r.fixed(r.u8()));
    const data = Uint8Array.from(r.fixed(r.len(r.u16())));
    return { programIdIndex, accountIndexes, data };
  });
  const addressTableLookups = Array.from({ length: r.u8() }, () => ({
    accountKey: r.pubkey(),
    writableIndexes: Array.from(r.fixed(r.u8())),
    readonlyIndexes: Array.from(r.fixed(r.u8())),
  }));
  r.end();
  return validateMessage({ numSigners, numWritableSigners, numWritableNonSigners, accountKeys, instructions, addressTableLookups });
}

/** The message stored in a VaultTransaction account (standard Borsh vectors, u32 prefixes). */
function vaultTransactionMessage(r: BorshReader): SquadsMessage {
  const numSigners = r.u8();
  const numWritableSigners = r.u8();
  const numWritableNonSigners = r.u8();
  const accountKeys = r.vec(() => r.pubkey());
  const instructions = r.vec(() => ({ programIdIndex: r.u8(), accountIndexes: Array.from(r.bytes()), data: Uint8Array.from(r.bytes()) }));
  const addressTableLookups = r.vec(() => ({ accountKey: r.pubkey(), writableIndexes: Array.from(r.bytes()), readonlyIndexes: Array.from(r.bytes()) }));
  return validateMessage({ numSigners, numWritableSigners, numWritableNonSigners, accountKeys, instructions, addressTableLookups });
}

function validateMessage(m: SquadsMessage): SquadsMessage {
  const lookupCount = m.addressTableLookups.reduce((n, l) => n + l.writableIndexes.length + l.readonlyIndexes.length, 0);
  const total = m.accountKeys.length + lookupCount;
  if (m.numWritableSigners > m.numSigners || m.numSigners > m.accountKeys.length || m.numWritableNonSigners > m.accountKeys.length - m.numSigners) {
    throw new RangeError("Inconsistent message header");
  }
  for (const ix of m.instructions) {
    // Unlike regular v0 messages, a vault message may load its program ids from lookup tables:
    // the multisig program executes each instruction by CPI.
    if (ix.programIdIndex >= total) throw new RangeError("Program id index out of range");
    if (ix.accountIndexes.some((i) => i >= total)) throw new RangeError("Account index out of range");
  }
  return m;
}

/**
 * Re-expresses a vault message as an (unsigned) v0 transaction so the regular
 * decoder, lookup-table resolution and simulation can run on it unchanged.
 */
export function toVersionedTransaction(m: SquadsMessage): VersionedTransaction {
  const message = new MessageV0({
    header: {
      numRequiredSignatures: m.numSigners,
      numReadonlySignedAccounts: m.numSigners - m.numWritableSigners,
      numReadonlyUnsignedAccounts: m.accountKeys.length - m.numSigners - m.numWritableNonSigners,
    },
    staticAccountKeys: m.accountKeys.map((k) => new PublicKey(k)),
    recentBlockhash: NO_BLOCKHASH,
    compiledInstructions: m.instructions.map((ix) => ({ programIdIndex: ix.programIdIndex, accountKeyIndexes: ix.accountIndexes, data: ix.data })),
    addressTableLookups: m.addressTableLookups.map((l) => ({ accountKey: new PublicKey(l.accountKey), writableIndexes: l.writableIndexes, readonlyIndexes: l.readonlyIndexes })),
  });
  return new VersionedTransaction(message);
}

export function squadsIxName(data: Uint8Array): SquadsIxName | null {
  return data.length >= 8 ? (SQUADS_IX_BY_DISCRIMINATOR[hex(data.subarray(0, 8))] ?? null) : null;
}

/** Decodes one Squads instruction. Returns null for an unknown discriminator; throws on malformed args. */
export function decodeSquadsInstruction(data: Uint8Array, accounts: Array<string | null>): SquadsInstruction | null {
  const name = squadsIxName(data);
  if (!name) return null;
  const names = SQUADS_IX_ACCOUNTS[name] ?? [];
  const named: Record<string, string | null> = {};
  accounts.forEach((a, i) => {
    named[names[i] ?? `account${i}`] = a;
  });

  const out: SquadsInstruction = { name, kind: KIND[name], accounts: named, vote: null, transactionIndex: null, vaultIndex: null, memo: null, message: null, configActions: [], extra: {} };
  const r = new BorshReader(data.subarray(8));

  switch (name) {
    case "vaultTransactionCreate":
    case "vaultTransactionCreateFromBuffer": {
      out.vaultIndex = r.u8();
      out.extra.ephemeralSigners = String(r.u8());
      const message = r.bytes();
      out.memo = memo(r);
      // From-buffer carries an empty message; the real one lives in the buffer account.
      out.message = message.length > 0 ? parseTransactionMessage(message) : null;
      break;
    }
    case "batchAddTransaction": {
      out.extra.ephemeralSigners = String(r.u8());
      out.message = parseTransactionMessage(r.bytes());
      break;
    }
    case "batchCreate":
      out.vaultIndex = r.u8();
      out.memo = memo(r);
      break;
    case "proposalCreate":
      out.transactionIndex = r.u64().toString();
      out.extra.draft = String(r.bool());
      break;
    case "proposalApprove":
    case "proposalReject":
    case "proposalCancel":
    case "proposalCancelV2":
      out.vote = name === "proposalApprove" ? "approve" : name === "proposalReject" ? "reject" : "cancel";
      out.memo = memo(r);
      break;
    case "configTransactionCreate":
      out.configActions = r.vec(() => configAction(r));
      out.memo = memo(r);
      break;
    case "multisigAddMember":
      out.configActions = [{ type: "AddMember", member: member(r) }];
      out.memo = memo(r);
      break;
    case "multisigRemoveMember":
      out.configActions = [{ type: "RemoveMember", member: r.pubkey() }];
      out.memo = memo(r);
      break;
    case "multisigChangeThreshold":
      out.configActions = [{ type: "ChangeThreshold", newThreshold: r.u16() }];
      out.memo = memo(r);
      break;
    case "multisigSetTimeLock":
      out.configActions = [{ type: "SetTimeLock", newTimeLock: r.u32() }];
      out.memo = memo(r);
      break;
    case "multisigSetConfigAuthority":
      out.configActions = [{ type: "SetConfigAuthority", newConfigAuthority: r.pubkey() }];
      out.memo = memo(r);
      break;
    case "multisigSetRentCollector":
      out.configActions = [{ type: "SetRentCollector", newRentCollector: r.option(() => r.pubkey()) }];
      out.memo = memo(r);
      break;
    case "multisigAddSpendingLimit": {
      const createKey = r.pubkey();
      const vaultIndex = r.u8();
      const mint = r.pubkey();
      const amount = r.u64().toString();
      const p = r.u8();
      if (p >= PERIODS.length) throw new RangeError(`Unknown spending-limit period ${p}`);
      out.configActions = [{ type: "AddSpendingLimit", createKey, vaultIndex, mint, amount, period: PERIODS[p], members: r.vec(() => r.pubkey()), destinations: r.vec(() => r.pubkey()) }];
      out.memo = memo(r);
      break;
    }
    case "multisigRemoveSpendingLimit":
      out.configActions = [{ type: "RemoveSpendingLimit", spendingLimit: named.spendingLimit ?? null }];
      out.memo = memo(r);
      break;
    case "multisigCreateV2": {
      const configAuthority = r.option(() => r.pubkey());
      const threshold = r.u16();
      const members = r.vec(() => member(r));
      const timeLock = r.u32();
      r.option(() => r.pubkey());
      out.memo = memo(r);
      out.extra = { configAuthority, threshold: String(threshold), members: String(members.length), timeLock: String(timeLock) };
      break;
    }
    case "spendingLimitUse":
      out.extra = { amount: r.u64().toString(), decimals: String(r.u8()) };
      out.memo = memo(r);
      break;
    default:
      // Instructions without arguments (execute, activate, closes) or not security-relevant (buffers, program config).
      break;
  }
  return out;
}

function expectDiscriminator(data: Uint8Array, expected: string, name: string): BorshReader {
  if (data.length < 8 || hex(data.subarray(0, 8)) !== expected) throw new TypeError(`Not a Squads ${name} account`);
  return new BorshReader(data.subarray(8));
}

/** Accounts may carry trailing reserved space (realloc), so decoding stops at the last field. */
export function decodeMultisigAccount(data: Uint8Array): MultisigAccount {
  const r = expectDiscriminator(data, SQUADS_ACCOUNT_DISCRIMINATOR.Multisig, "Multisig");
  const createKey = r.pubkey();
  const configAuthority = r.pubkey();
  const threshold = r.u16();
  const timeLock = r.u32();
  const transactionIndex = r.u64().toString();
  const staleTransactionIndex = r.u64().toString();
  const rentCollector = r.option(() => r.pubkey());
  r.u8();
  const members = r.vec(() => member(r));
  return { createKey, configAuthority: configAuthority === DEFAULT_PUBKEY ? null : configAuthority, threshold, timeLock, transactionIndex, staleTransactionIndex, rentCollector, members };
}

export function decodeProposalAccount(data: Uint8Array): ProposalAccount {
  const r = expectDiscriminator(data, SQUADS_ACCOUNT_DISCRIMINATOR.Proposal, "Proposal");
  const multisig = r.pubkey();
  const transactionIndex = r.u64().toString();
  const variant = r.u8();
  const status = PROPOSAL_STATUSES[variant];
  if (!status) throw new RangeError(`Unknown proposal status ${variant}`);
  const statusTimestamp = status === "Executing" ? null : r.i64().toString();
  r.u8();
  return { multisig, transactionIndex, status, statusTimestamp, approved: r.vec(() => r.pubkey()), rejected: r.vec(() => r.pubkey()), cancelled: r.vec(() => r.pubkey()) };
}

export function decodeVaultTransactionAccount(data: Uint8Array): VaultTransactionAccount {
  const r = expectDiscriminator(data, SQUADS_ACCOUNT_DISCRIMINATOR.VaultTransaction, "VaultTransaction");
  const multisig = r.pubkey();
  const creator = r.pubkey();
  const index = r.u64().toString();
  r.u8();
  const vaultIndex = r.u8();
  r.u8();
  const ephemeralSignerCount = r.bytes().length;
  return { multisig, creator, index, vaultIndex, ephemeralSignerCount, message: vaultTransactionMessage(r) };
}

export function decodeBatchAccount(data: Uint8Array): BatchAccount {
  const r = expectDiscriminator(data, SQUADS_ACCOUNT_DISCRIMINATOR.Batch, "Batch");
  const multisig = r.pubkey();
  const creator = r.pubkey();
  const index = r.u64().toString();
  r.u8();
  const vaultIndex = r.u8();
  r.u8();
  return { multisig, creator, index, vaultIndex, size: r.u32(), executedTransactionIndex: r.u32() };
}

export function decodeVaultBatchTransactionAccount(data: Uint8Array): VaultBatchTransactionAccount {
  const r = expectDiscriminator(data, SQUADS_ACCOUNT_DISCRIMINATOR.VaultBatchTransaction, "VaultBatchTransaction");
  r.u8();
  const ephemeralSignerCount = r.bytes().length;
  return { ephemeralSignerCount, message: vaultTransactionMessage(r) };
}

export function decodeConfigTransactionAccount(data: Uint8Array): ConfigTransactionAccount {
  const r = expectDiscriminator(data, SQUADS_ACCOUNT_DISCRIMINATOR.ConfigTransaction, "ConfigTransaction");
  const multisig = r.pubkey();
  const creator = r.pubkey();
  const index = r.u64().toString();
  r.u8();
  return { multisig, creator, index, actions: r.vec(() => configAction(r)) };
}

export function decodeTransactionBufferAccount(data: Uint8Array): TransactionBufferAccount {
  const r = expectDiscriminator(data, SQUADS_ACCOUNT_DISCRIMINATOR.TransactionBuffer, "TransactionBuffer");
  const multisig = r.pubkey();
  const creator = r.pubkey();
  r.u8();
  const vaultIndex = r.u8();
  const finalBufferHash = hex(r.fixed(32));
  const finalBufferSize = r.u16();
  return { multisig, creator, vaultIndex, finalBufferHash, finalBufferSize, buffer: Uint8Array.from(r.bytes()) };
}
