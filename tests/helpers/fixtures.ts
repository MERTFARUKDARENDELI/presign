import { Keypair, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@/lib/solana/constants";
import { bytesToBase64 } from "@/lib/transaction/input";

/** Deterministic keys: never random, so tests are reproducible. */
export function key(seed: number): PublicKey {
  return Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey;
}
export function keypair(seed: number): Keypair {
  return Keypair.fromSeed(new Uint8Array(32).fill(seed));
}

export const WALLET = key(1);
export const ATTACKER = key(2);
export const MINT = key(3);
export const WALLET_ATA = key(4);
export const ATTACKER_ATA = key(5);
export const OTHER_MINT = key(6);
export const BLOCKHASH = key(9).toBase58();

export function buildTx(instructions: TransactionInstruction[], feePayer = WALLET): { tx: Transaction; bytes: Uint8Array; base64: string } {
  const tx = new Transaction({ feePayer, recentBlockhash: BLOCKHASH }).add(...instructions);
  const bytes = new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
  return { tx, bytes, base64: bytesToBase64(bytes) };
}

export function parsedTokenAccount(opts: {
  mint?: string;
  owner?: string;
  amount?: string;
  decimals?: number;
  state?: "initialized" | "frozen";
  delegate?: string;
  delegatedAmount?: string;
  closeAuthority?: string;
  program?: string;
  lamports?: number;
  isNative?: boolean;
  extensions?: Array<{ extension: string; state?: Record<string, unknown> }>;
}) {
  return {
    lamports: opts.lamports ?? 2_039_280,
    owner: opts.program ?? TOKEN_PROGRAM_ID,
    executable: false,
    data: {
      program: opts.program === TOKEN_2022_PROGRAM_ID ? "spl-token-2022" : "spl-token",
      parsed: {
        type: "account",
        info: {
          mint: opts.mint ?? MINT.toBase58(),
          owner: opts.owner ?? WALLET.toBase58(),
          state: opts.state ?? "initialized",
          isNative: opts.isNative ?? false,
          tokenAmount: { amount: opts.amount ?? "0", decimals: opts.decimals ?? 6, uiAmountString: "0" },
          ...(opts.delegate ? { delegate: opts.delegate, delegatedAmount: { amount: opts.delegatedAmount ?? "0" } } : {}),
          ...(opts.closeAuthority ? { closeAuthority: opts.closeAuthority } : {}),
          ...(opts.extensions ? { extensions: opts.extensions } : {}),
        },
      },
    },
  };
}

export function parsedMint(opts: {
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  supply?: string;
  decimals?: number;
  program?: string;
  extensions?: Array<{ extension: string; state?: Record<string, unknown> }>;
}) {
  return {
    lamports: 1_461_600,
    owner: opts.program ?? TOKEN_PROGRAM_ID,
    data: {
      parsed: {
        type: "mint",
        info: {
          decimals: opts.decimals ?? 6,
          supply: opts.supply ?? "1000000000000",
          isInitialized: true,
          mintAuthority: opts.mintAuthority ?? null,
          freezeAuthority: opts.freezeAuthority ?? null,
          ...(opts.extensions ? { extensions: opts.extensions } : {}),
        },
      },
    },
  };
}

export function systemAccount(lamports: number) {
  return { lamports, owner: "11111111111111111111111111111111", data: ["", "base64"] };
}
