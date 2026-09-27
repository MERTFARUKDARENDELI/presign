/**
 * Squads Multisig v4 (program v2.x) identifiers. Pure constants — safe for
 * client and server. Discriminators are Anchor's sha256("global:<snake_name>")
 * and sha256("account:<Name>") prefixes; tests/unit/squads.test.ts recomputes
 * every one of them from the names so a typo cannot slip through.
 */

export const SQUADS_V4_PROGRAM_ID = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";

export type SquadsIxName =
  | "programConfigInit"
  | "programConfigSetAuthority"
  | "programConfigSetMultisigCreationFee"
  | "programConfigSetTreasury"
  | "multisigCreate"
  | "multisigCreateV2"
  | "multisigAddMember"
  | "multisigRemoveMember"
  | "multisigSetTimeLock"
  | "multisigChangeThreshold"
  | "multisigSetConfigAuthority"
  | "multisigSetRentCollector"
  | "multisigAddSpendingLimit"
  | "multisigRemoveSpendingLimit"
  | "configTransactionCreate"
  | "configTransactionExecute"
  | "vaultTransactionCreate"
  | "transactionBufferCreate"
  | "transactionBufferClose"
  | "transactionBufferExtend"
  | "vaultTransactionCreateFromBuffer"
  | "vaultTransactionExecute"
  | "batchCreate"
  | "batchAddTransaction"
  | "batchExecuteTransaction"
  | "proposalCreate"
  | "proposalActivate"
  | "proposalApprove"
  | "proposalReject"
  | "proposalCancel"
  | "proposalCancelV2"
  | "spendingLimitUse"
  | "configTransactionAccountsClose"
  | "vaultTransactionAccountsClose"
  | "vaultBatchTransactionAccountClose"
  | "batchAccountsClose";

/** Instruction discriminator (hex) → name. */
export const SQUADS_IX_BY_DISCRIMINATOR: Record<string, SquadsIxName> = {
  b8bcc6c3cd7c75d8: "programConfigInit",
  eef224b5208fd84b: "programConfigSetAuthority",
  "65a0f93f9ad7990d": "programConfigSetMultisigCreationFee",
  "6f2ef37590bca26b": "programConfigSetTreasury",
  "7a4d509f54585ac5": "multisigCreate",
  "32ddc75d28f58be9": "multisigCreateV2",
  "01dbd76cb8e5d608": "multisigAddMember",
  d975b1d2b691da48: "multisigRemoveMember",
  "949a794dd4fe9b48": "multisigSetTimeLock",
  "8d2a0f7ea95c3eb5": "multisigChangeThreshold",
  "8f5dc78f5ca9c1e8": "multisigSetConfigAuthority",
  "30cc4139d2469c4a": "multisigSetRentCollector",
  "0bf29f2a56c55973": "multisigAddSpendingLimit",
  e4c6886f7b04b271: "multisigRemoveSpendingLimit",
  "9bec57e4894b5127": "configTransactionCreate",
  "7292f4bdfc8c2428": "configTransactionExecute",
  "30fa4ea8d0e2dad3": "vaultTransactionCreate",
  f5c9716c253f1d59: "transactionBufferCreate",
  "11b6d0e48818b266": "transactionBufferClose",
  e69d433805eef592: "transactionBufferExtend",
  de36954457f630e7: "vaultTransactionCreateFromBuffer",
  c208a15799a419ab: "vaultTransactionExecute",
  c28e8d1137b914f8: "batchCreate",
  "5964e0124546364c": "batchAddTransaction",
  ac2cb398157feab4: "batchExecuteTransaction",
  dc3c49e01e6c4f9f: "proposalCreate",
  "0b225cf89a1b336a": "proposalActivate",
  "9025a488bcd82af8": "proposalApprove",
  f33e869ce66af687: "proposalReject",
  "1b2a7fed26a354cb": "proposalCancel",
  cd29c23ddc8b10f7: "proposalCancelV2",
  "1039827fc1149b86": "spendingLimitUse",
  "50cb54359770bbba": "configTransactionAccountsClose",
  c447bbb00223aaa5: "vaultTransactionAccountsClose",
  "8612136a814461f7": "vaultBatchTransactionAccountClose",
  dac407af82660bff: "batchAccountsClose",
};

/** Account names per instruction, in program order (from the v4 IDL; nested account structs flattened). */
export const SQUADS_IX_ACCOUNTS: Partial<Record<SquadsIxName, string[]>> = {
  multisigCreateV2: ["programConfig", "treasury", "multisig", "createKey", "creator", "systemProgram"],
  multisigAddMember: ["multisig", "configAuthority", "rentPayer", "systemProgram"],
  multisigRemoveMember: ["multisig", "configAuthority", "rentPayer", "systemProgram"],
  multisigSetTimeLock: ["multisig", "configAuthority", "rentPayer", "systemProgram"],
  multisigChangeThreshold: ["multisig", "configAuthority", "rentPayer", "systemProgram"],
  multisigSetConfigAuthority: ["multisig", "configAuthority", "rentPayer", "systemProgram"],
  multisigSetRentCollector: ["multisig", "configAuthority", "rentPayer", "systemProgram"],
  multisigAddSpendingLimit: ["multisig", "configAuthority", "spendingLimit", "rentPayer", "systemProgram"],
  multisigRemoveSpendingLimit: ["multisig", "configAuthority", "spendingLimit", "rentCollector"],
  configTransactionCreate: ["multisig", "transaction", "creator", "rentPayer", "systemProgram"],
  configTransactionExecute: ["multisig", "member", "proposal", "transaction", "rentPayer", "systemProgram"],
  vaultTransactionCreate: ["multisig", "transaction", "creator", "rentPayer", "systemProgram"],
  transactionBufferCreate: ["multisig", "transactionBuffer", "creator", "rentPayer", "systemProgram"],
  transactionBufferClose: ["multisig", "transactionBuffer", "creator"],
  transactionBufferExtend: ["multisig", "transactionBuffer", "creator"],
  vaultTransactionCreateFromBuffer: ["multisig", "transaction", "creator", "rentPayer", "systemProgram", "transactionBuffer", "bufferCreator"],
  vaultTransactionExecute: ["multisig", "proposal", "transaction", "member"],
  batchCreate: ["multisig", "batch", "creator", "rentPayer", "systemProgram"],
  batchAddTransaction: ["multisig", "proposal", "batch", "transaction", "member", "rentPayer", "systemProgram"],
  batchExecuteTransaction: ["multisig", "member", "proposal", "batch", "transaction"],
  proposalCreate: ["multisig", "proposal", "creator", "rentPayer", "systemProgram"],
  proposalActivate: ["multisig", "member", "proposal"],
  proposalApprove: ["multisig", "member", "proposal"],
  proposalReject: ["multisig", "member", "proposal"],
  proposalCancel: ["multisig", "member", "proposal"],
  proposalCancelV2: ["multisig", "member", "proposal", "systemProgram"],
  spendingLimitUse: ["multisig", "member", "spendingLimit", "vault", "destination", "systemProgram", "mint", "vaultTokenAccount", "destinationTokenAccount", "tokenProgram"],
  configTransactionAccountsClose: ["multisig", "proposal", "transaction", "rentCollector", "systemProgram"],
  vaultTransactionAccountsClose: ["multisig", "proposal", "transaction", "rentCollector", "systemProgram"],
  vaultBatchTransactionAccountClose: ["multisig", "proposal", "batch", "transaction", "rentCollector", "systemProgram"],
  batchAccountsClose: ["multisig", "proposal", "batch", "rentCollector", "systemProgram"],
};

/** Account discriminators (hex). */
export const SQUADS_ACCOUNT_DISCRIMINATOR = {
  Multisig: "e07479ba44a14fec",
  Proposal: "1a5ebdbb74883521",
  VaultTransaction: "a8faa264510ea2cf",
  ConfigTransaction: "5e080423718b8b70",
  TransactionBuffer: "5a2423db5de16e60",
  Batch: "9cc2462c1658892c",
  VaultBatchTransaction: "c4792e240c13fc07",
} as const;

/** Batch transactions loaded per batch; larger batches are reported as partially inspected. */
export const SQUADS_BATCH_LIMIT = 10;

/** Member permission bits (Squads `Permissions.mask`). */
export const SQUADS_PERMISSION = { Initiate: 1, Vote: 2, Execute: 4 } as const;

export const SQUADS_SEED = {
  prefix: "multisig",
  vault: "vault",
  transaction: "transaction",
  proposal: "proposal",
  ephemeralSigner: "ephemeral_signer",
  batchTransaction: "batch_transaction",
} as const;

/** Vault indexes checked when deciding whether an address is controlled by a multisig. */
export const SQUADS_VAULT_SCAN = 16;
