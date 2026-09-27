import { z } from "zod";
import { formatRawAmount } from "@/lib/token/amount";
import type { MintExtensions, MintInfo, TokenAccountState, TokenProgramKind } from "@/lib/token/types";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./constants";

/**
 * Pure parsers from RPC `jsonParsed` shapes to internal models.
 * Malformed input returns null — it is never treated as trusted data.
 */

const u64 = z.string().regex(/^\d+$/);
const pubkey = z.string().min(32).max(44);

const extensionSchema = z.object({
  extension: z.string(),
  state: z.record(z.string(), z.unknown()).optional(),
});

const tokenAccountInfoSchema = z.object({
  mint: pubkey,
  owner: pubkey,
  state: z.enum(["initialized", "frozen", "uninitialized"]),
  isNative: z.boolean().optional().default(false),
  tokenAmount: z.object({ amount: u64, decimals: z.number().int().min(0).max(255) }),
  delegate: pubkey.optional(),
  delegatedAmount: z.object({ amount: u64 }).optional(),
  closeAuthority: pubkey.optional(),
  extensions: z.array(extensionSchema).optional(),
});

const parsedAccountSchema = z.object({
  lamports: z.union([z.number(), z.string()]).optional(),
  owner: z.string(),
  data: z.object({
    program: z.string().optional(),
    parsed: z.object({ type: z.string(), info: z.unknown() }),
  }),
});

export function programKind(programId: string): TokenProgramKind | null {
  if (programId === TOKEN_PROGRAM_ID) return "spl-token";
  if (programId === TOKEN_2022_PROGRAM_ID) return "token-2022";
  return null;
}

function lamportsToString(value: number | string | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value === "string") return /^\d+$/.test(value) ? value : null;
  return Number.isSafeInteger(value) && value >= 0 ? BigInt(value).toString() : null;
}

export function parseTokenAccount(address: string, account: unknown): TokenAccountState | null {
  const parsed = parsedAccountSchema.safeParse(account);
  if (!parsed.success || parsed.data.data.parsed.type !== "account") return null;
  const program = programKind(parsed.data.owner);
  if (!program) return null;
  const info = tokenAccountInfoSchema.safeParse(parsed.data.data.parsed.info);
  if (!info.success) return null;
  const i = info.data;

  return {
    address,
    mint: i.mint,
    owner: i.owner,
    program,
    amountRaw: i.tokenAmount.amount,
    decimals: i.tokenAmount.decimals,
    uiAmount: formatRawAmount(i.tokenAmount.amount, i.tokenAmount.decimals),
    state: i.state,
    delegate: i.delegate ?? null,
    delegatedAmountRaw: i.delegate ? (i.delegatedAmount?.amount ?? "0") : null,
    closeAuthority: i.closeAuthority ?? null,
    isNative: i.isNative,
    lamports: lamportsToString(parsed.data.lamports),
    extensions: (i.extensions ?? []).map((e) => e.extension),
  };
}

const mintInfoSchema = z.object({
  decimals: z.number().int().min(0).max(255),
  supply: u64,
  isInitialized: z.boolean(),
  mintAuthority: pubkey.nullable().optional(),
  freezeAuthority: pubkey.nullable().optional(),
  extensions: z.array(extensionSchema).optional(),
});

function str(state: Record<string, unknown> | undefined, key: string): string | null {
  const v = state?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function parseMintExtensions(extensions: z.infer<typeof extensionSchema>[]): {
  ext: MintExtensions;
  metadata: MintInfo["onchainMetadata"];
} {
  const ext: MintExtensions = {
    permanentDelegate: null,
    transferFeeBasisPoints: null,
    transferHookProgramId: null,
    nonTransferable: false,
    defaultAccountState: null,
    mintCloseAuthority: null,
    pausable: false,
    paused: false,
  };
  let metadata: MintInfo["onchainMetadata"] = null;

  for (const e of extensions) {
    const s = e.state;
    switch (e.extension) {
      case "permanentDelegate":
        ext.permanentDelegate = str(s, "delegate");
        break;
      case "transferFeeConfig": {
        const newer = s?.newerTransferFee as { transferFeeBasisPoints?: unknown } | undefined;
        const bps = newer?.transferFeeBasisPoints;
        ext.transferFeeBasisPoints = typeof bps === "number" ? bps : null;
        break;
      }
      case "transferHook":
        ext.transferHookProgramId = str(s, "programId");
        break;
      case "nonTransferable":
        ext.nonTransferable = true;
        break;
      case "defaultAccountState":
        ext.defaultAccountState = str(s, "accountState");
        break;
      case "mintCloseAuthority":
        ext.mintCloseAuthority = str(s, "closeAuthority");
        break;
      case "pausableConfig":
        ext.pausable = true;
        ext.paused = s?.paused === true;
        break;
      case "tokenMetadata":
        metadata = {
          name: str(s, "name") ?? undefined,
          symbol: str(s, "symbol") ?? undefined,
          uri: str(s, "uri") ?? undefined,
        };
        break;
    }
  }
  return { ext, metadata };
}

export function parseMintAccount(address: string, account: unknown): MintInfo | null {
  const parsed = parsedAccountSchema.safeParse(account);
  if (!parsed.success || parsed.data.data.parsed.type !== "mint") return null;
  const program = programKind(parsed.data.owner);
  if (!program) return null;
  const info = mintInfoSchema.safeParse(parsed.data.data.parsed.info);
  if (!info.success) return null;
  const extensions = info.data.extensions ?? [];
  const { ext, metadata } = parseMintExtensions(extensions);

  return {
    address,
    program,
    decimals: info.data.decimals,
    supplyRaw: info.data.supply,
    mintAuthority: info.data.mintAuthority ?? null,
    freezeAuthority: info.data.freezeAuthority ?? null,
    isInitialized: info.data.isInitialized,
    extensionNames: extensions.map((e) => e.extension),
    extensions: ext,
    onchainMetadata: metadata,
  };
}
