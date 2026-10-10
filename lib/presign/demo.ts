import "server-only";
import { randomBytes } from "node:crypto";
import { ACCOUNT_SIZE, AuthorityType, createApproveInstruction, createInitializeAccount3Instruction, createSetAuthorityInstruction, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ComputeBudgetProgram, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { AppError } from "@/lib/api/errors";
import { rpcCall } from "@/lib/solana/client";
import { MEMO_PROGRAM_ID } from "@/lib/solana/constants";
import { bytesToBase64 } from "@/lib/transaction/input";
import type { DemoScenario } from "./demo-scenarios";
import type { ExpectedEffects, PayloadEncoding, SigningRequestType } from "./types";

/**
 * Controlled demo dApp: builds REAL unsigned signing requests for the
 * connected wallet. They go through exactly the same analysis pipeline as
 * any other request — nothing here decides a risk level.
 *
 * Safety of the samples themselves:
 *  - risky transactions act on a FRESH token account derived from the wallet
 *    with a random seed, never on an existing account holding funds;
 *  - the "delegate" / "new owner" is an off-curve address (a PDA of the Memo
 *    program): no private key exists for it, so nobody can ever use it;
 *  - the demo page never submits risky samples.
 */


export interface DemoRequest {
  scenario: DemoScenario;
  title: string;
  description: string;
  type: SigningRequestType;
  payload: string;
  payloadEncoding: PayloadEncoding;
  /** What the demo dApp claims the request does (compared with the simulation). */
  expectedEffects?: ExpectedEffects;
}

const MEMO = new PublicKey(MEMO_PROGRAM_ID);
/** Off-curve address nobody can sign for. */
export const DEMO_UNUSABLE_DELEGATE = PublicKey.findProgramAddressSync([Buffer.from("presign-demo-unusable-delegate")], MEMO)[0];
const U64_MAX = 18_446_744_073_709_551_615n;

/**
 * The demo dApp sets its own compute budget, as a well-behaved application should: wallets that add a
 * priority fee to a transaction without one (Phantom does) would otherwise change the reviewed bytes,
 * and Presign rightly withholds a signature for a transaction it did not review. 200k CU at 10k µlamports
 * is at most 0.000002 SOL, far below TX_EXCESSIVE_PRIORITY_FEE (0.01 SOL).
 */
export const DEMO_COMPUTE_UNIT_LIMIT = 200_000;
export const DEMO_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS = 10_000;

function memo(text: string): TransactionInstruction {
  return new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(text, "utf8") });
}

async function latestBlockhash(): Promise<string> {
  const bh = await rpcCall<{ value: { blockhash: string } }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
  return bh.result.value.blockhash;
}

async function rentForTokenAccount(): Promise<number> {
  const r = await rpcCall<number>("getMinimumBalanceForRentExemption", [ACCOUNT_SIZE]);
  return r.result;
}

function serialize(tx: Transaction): string {
  return bytesToBase64(new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false })));
}

/** A brand-new, empty WSOL token account owned by the wallet (address derived with a random seed). */
async function freshTokenAccount(wallet: PublicKey): Promise<{ account: PublicKey; instructions: TransactionInstruction[] }> {
  const seed = `presign-demo-${randomBytes(6).toString("hex")}`;
  const account = await PublicKey.createWithSeed(wallet, seed, TOKEN_PROGRAM_ID);
  return {
    account,
    instructions: [
      SystemProgram.createAccountWithSeed({ fromPubkey: wallet, basePubkey: wallet, seed, newAccountPubkey: account, lamports: await rentForTokenAccount(), space: ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID }),
      createInitializeAccount3Instruction(account, NATIVE_MINT, wallet),
    ],
  };
}

export async function buildDemoRequest(scenario: DemoScenario, walletAddress: string, host: string): Promise<DemoRequest> {
  let wallet: PublicKey;
  try {
    wallet = new PublicKey(walletAddress);
  } catch {
    throw new AppError("INVALID_WALLET", "Invalid wallet address.");
  }

  const tx = async (instructions: TransactionInstruction[]) => {
    const t = new Transaction({ feePayer: wallet, recentBlockhash: await latestBlockhash() });
    t.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: DEMO_COMPUTE_UNIT_LIMIT }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: DEMO_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS }),
      ...instructions,
    );
    return serialize(t);
  };

  switch (scenario) {
    case "safe-transaction":
      return { scenario, title: "Post a memo", description: "Writes a short memo on-chain. Costs only the network fee.", type: "TRANSACTION", payloadEncoding: "base64", payload: await tx([memo(`Presign demo: hello from ${host}`)]) };
    case "medium-transaction":
      return { scenario, title: "Memo with a promotional link", description: "Writes a memo that carries a link to an unknown 'airdrop' site.", type: "TRANSACTION", payloadEncoding: "base64", payload: await tx([memo("Congratulations! Claim your airdrop at https://jup-airdrop-claim.xyz")]) };
    case "high-transaction": {
      const fresh = await freshTokenAccount(wallet);
      return {
        scenario,
        title: "Approve token spending",
        description: "Creates a new empty token account and lets another address spend up to 1 SOL worth of wrapped SOL from it.",
        type: "TRANSACTION",
        payloadEncoding: "base64",
        payload: await tx([...fresh.instructions, createApproveInstruction(fresh.account, DEMO_UNUSABLE_DELEGATE, wallet, 1_000_000_000n)]),
      };
    }
    case "critical-transaction": {
      const fresh = await freshTokenAccount(wallet);
      return {
        scenario,
        title: "Unlimited approval + ownership transfer",
        description: "Creates a new empty token account, grants another address UNLIMITED spending, and hands it ownership of the account — a drainer pattern.",
        type: "TRANSACTION",
        payloadEncoding: "base64",
        payload: await tx([
          ...fresh.instructions,
          createApproveInstruction(fresh.account, DEMO_UNUSABLE_DELEGATE, wallet, U64_MAX),
          createSetAuthorityInstruction(fresh.account, wallet, AuthorityType.AccountOwner, DEMO_UNUSABLE_DELEGATE),
        ]),
      };
    }
    case "mismatch-transaction":
      return {
        scenario,
        title: "\"Swap 0.0001 SOL\"",
        description: "The demo dApp says it swaps 0.0001 SOL, but the transaction sends 0.002 SOL to an address nobody controls.",
        type: "TRANSACTION",
        payloadEncoding: "base64",
        expectedEffects: { summary: "Swap 0.0001 SOL for USDC", maxSolOutLamports: "100000" },
        payload: await tx([memo("Swap 0.0001 SOL for USDC"), SystemProgram.transfer({ fromPubkey: wallet, toPubkey: DEMO_UNUSABLE_DELEGATE, lamports: 2_000_000 })]),
      };
    case "invalid-transaction":
      return { scenario, title: "Malformed request", description: "Random bytes presented as a transaction.", type: "TRANSACTION", payloadEncoding: "base64", payload: randomBytes(180).toString("base64") };
    case "safe-message": {
      const now = new Date();
      const nonce = randomBytes(8).toString("hex");
      return {
        scenario,
        title: "Sign in to the demo dApp",
        description: "A standard sign-in message for this site, with a one-time nonce and an expiry.",
        type: "MESSAGE",
        payloadEncoding: "utf8",
        payload: [`${host} wants you to sign in with your Solana account:`, walletAddress, "", "Sign in to the Presign demo dApp.", "", `URI: https://${host}`, `Nonce: ${nonce}`, `Issued At: ${now.toISOString()}`, `Expiration Time: ${new Date(now.getTime() + 10 * 60_000).toISOString()}`].join("\n"),
      };
    }
    case "suspicious-message":
      return {
        scenario,
        title: "\"Verify your wallet\" message",
        description: "A message that claims to come from another site and asks to authorize transfers.",
        type: "MESSAGE",
        payloadEncoding: "utf8",
        payload: ["phantom-wallet-support.xyz wants you to sign in", "", "I authorize the transfer of all assets in this wallet to complete account verification.", "Keep your 12-word seed phrase ready for the next step: https://phantom-wallet-support.xyz/restore"].join("\n"),
      };
  }
}
