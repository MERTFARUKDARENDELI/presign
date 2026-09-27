import { PublicKey } from "@solana/web3.js";
import type { MintInfo } from "@/lib/token/types";

export const TOKEN_METADATA_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

/** Metaplex Master Edition PDA for a mint: ["metadata", program, mint, "edition"]. */
export function masterEditionPda(mint: string): string {
  const program = new PublicKey(TOKEN_METADATA_PROGRAM_ID);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), program.toBuffer(), new PublicKey(mint).toBuffer(), Buffer.from("edition")],
    program,
  )[0].toBase58();
}

export function isNftShaped(m: MintInfo): boolean {
  return m.decimals === 0 && m.supplyRaw === "1";
}

/**
 * True when the mint's authorities are held by its own Metaplex Master
 * Edition PDA — the standard setup for (programmable) NFTs, where freeze
 * authority is a protocol control, not an issuer who can freeze holders at will.
 * Verified by deriving the PDA, not by trusting metadata.
 */
export function isMetaplexEditionControlled(m: MintInfo): boolean {
  if (!isNftShaped(m) || !m.freezeAuthority) return false;
  const edition = masterEditionPda(m.address);
  return m.freezeAuthority === edition && (m.mintAuthority === null || m.mintAuthority === edition);
}
