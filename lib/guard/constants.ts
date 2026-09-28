import { PublicKey } from "@solana/web3.js";

/**
 * Presign Guard program (guard/programs/presign-guard). The program id is set
 * per deployment with NEXT_PUBLIC_GUARD_PROGRAM_ID; without it Guard features
 * are off and nothing is assumed. Discriminators are Anchor's
 * sha256("global:<ix>") / sha256("account:<Name>") prefixes, recomputed in tests.
 */

export function guardProgramId(): string | null {
  const id = process.env.NEXT_PUBLIC_GUARD_PROGRAM_ID?.trim();
  if (!id) return null;
  try {
    return new PublicKey(id).toBase58();
  } catch {
    return null;
  }
}

export const GUARD_ACCOUNT_DISCRIMINATOR = {
  Guard: "36bb5489c00f4af8",
  Action: "90f169db4a88cbb0",
} as const;

export const GUARD_IX_DISCRIMINATOR = {
  createGuard: "fbfe11c6dbda9a63",
  schedule: "95cbe5d12f33ddce",
  veto: "be9845e23d966bd7",
  cancel: "e8dbdf29dbecdcbe",
  execute: "82ddf29a0dc1bd1d",
  updateConfig: "1d9efcbf0a53db63",
  closeAction: "445b26b77c4aef88",
} as const;

export type GuardIxName = keyof typeof GUARD_IX_DISCRIMINATOR;

/** Account names per instruction, in program order. */
export const GUARD_IX_ACCOUNTS: Record<GuardIxName, string[]> = {
  createGuard: ["guard", "guardSigner", "createKey", "payer", "systemProgram"],
  schedule: ["guard", "action", "proposer", "payer", "systemProgram"],
  veto: ["guard", "action", "guardian"],
  cancel: ["guard", "action", "proposer"],
  execute: ["guard", "action", "guardSigner"],
  updateConfig: ["guard", "guardSigner"],
  closeAction: ["guard", "action", "rentPayer"],
};

export const GUARD_SEED = { guard: "guard", signer: "signer", action: "action" } as const;

export const GUARD_LIMITS = { maxGuardians: 10, minDelaySeconds: 60, maxDelaySeconds: 30 * 24 * 60 * 60, maxInstructions: 4, maxAccounts: 24, maxData: 900, maxMemo: 128 } as const;

export function guardPda(programId: string, createKey: string): string {
  return PublicKey.findProgramAddressSync([new TextEncoder().encode(GUARD_SEED.guard), new PublicKey(createKey).toBytes()], new PublicKey(programId))[0].toBase58();
}

export function guardSignerPda(programId: string, guard: string): string {
  return PublicKey.findProgramAddressSync([new TextEncoder().encode(GUARD_SEED.signer), new PublicKey(guard).toBytes()], new PublicKey(programId))[0].toBase58();
}

export function actionPda(programId: string, guard: string, index: bigint | string | number): string {
  const idx = new Uint8Array(8);
  new DataView(idx.buffer).setBigUint64(0, BigInt(index), true);
  return PublicKey.findProgramAddressSync([new TextEncoder().encode(GUARD_SEED.action), new PublicKey(guard).toBytes(), idx], new PublicKey(programId))[0].toBase58();
}
