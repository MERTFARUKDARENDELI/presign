import "server-only";
import { createHash } from "node:crypto";
import { logger } from "@/lib/api/logger";
import { TtlCache } from "@/lib/cache";
import { rpcCall } from "@/lib/solana/client";
import { BPF_LOADER_UPGRADEABLE_ID } from "@/lib/solana/constants";
import type { DecodedTransaction } from "@/lib/transaction/types";

/**
 * Program upgrades in a proposal: the hash of the code it would deploy and
 * what the OtterSec verified-builds registry says about the program. Hashes
 * follow `solana-verify` (sha256 of the executable bytes after the loader
 * header, trailing zero bytes removed) — checked against OtterSec's
 * on_chain_hash for a live program.
 */

export const PROGRAMDATA_HEADER = 45;
export const BUFFER_HEADER = 37;
const MAX_BUFFER_BYTES = 12 * 1024 * 1024;

export function programHash(accountData: Uint8Array, headerLen: number): string {
  let end = accountData.length;
  while (end > headerLen && accountData[end - 1] === 0) end--;
  return createHash("sha256").update(accountData.subarray(headerLen, end)).digest("hex");
}

export interface VerifiedBuildStatus {
  verified: boolean;
  onChainHash: string | null;
  executableHash: string | null;
  repo: string | null;
  commit: string | null;
}

export interface UpgradeCheck {
  program: string | null;
  buffer: string | null;
  bufferStatus: "OK" | "NOT_FOUND" | "FAILED";
  /** solana-verify hash of the code the upgrade would deploy. */
  bufferHash: string | null;
  registry: VerifiedBuildStatus | null;
  registryStatus: "OK" | "UNAVAILABLE";
  /** True when the new code is exactly a build the registry verified. */
  matchesVerifiedBuild: boolean | null;
}

const registryCache = new TtlCache<VerifiedBuildStatus | null>(10 * 60_000, 500);

const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);

export async function verifiedBuildStatus(program: string): Promise<VerifiedBuildStatus | null> {
  return registryCache.getOrLoad(program, async () => {
    try {
      const res = await fetch(`https://verify.osec.io/status/${encodeURIComponent(program)}`, { signal: AbortSignal.timeout(8_000), cache: "no-store" });
      if (!res.ok) return null;
      const j = (await res.json()) as Record<string, unknown>;
      if (typeof j.is_verified !== "boolean") return null;
      return { verified: j.is_verified, onChainHash: str(j.on_chain_hash), executableHash: str(j.executable_hash), repo: str(j.repo_url), commit: str(j.commit) };
    } catch (error) {
      logger.warn("verify.registry_unavailable", { error: error instanceof Error ? error.name : "unknown" });
      return null;
    }
  });
}

async function bufferHash(buffer: string): Promise<{ status: UpgradeCheck["bufferStatus"]; hash: string | null }> {
  try {
    const res = await rpcCall<{ value: { data: [string, string]; owner: string } | null }>("getAccountInfo", [buffer, { encoding: "base64", commitment: "confirmed" }], { timeoutMs: 20_000 });
    const v = res.result?.value;
    if (!v || v.owner !== BPF_LOADER_UPGRADEABLE_ID) return { status: "NOT_FOUND", hash: null };
    const data = Buffer.from(v.data[0], "base64");
    if (data.length > MAX_BUFFER_BYTES || data.length <= BUFFER_HEADER) return { status: "FAILED", hash: null };
    return { status: "OK", hash: programHash(data, BUFFER_HEADER) };
  } catch {
    return { status: "FAILED", hash: null };
  }
}

/** Checks every BPF loader `upgrade` in a decoded transaction or payload (at most 3). */
export async function checkUpgrades(decoded: DecodedTransaction): Promise<UpgradeCheck[]> {
  const upgrades = decoded.instructions.filter((i) => i.type === "bpfLoader:upgrade").slice(0, 3);
  const out: UpgradeCheck[] = [];
  for (const ix of upgrades) {
    const program = ix.info.program ?? null;
    const buffer = ix.info.buffer ?? null;
    const b = buffer ? await bufferHash(buffer) : { status: "NOT_FOUND" as const, hash: null };
    const registry = program ? await verifiedBuildStatus(program) : null;
    out.push({
      program,
      buffer,
      bufferStatus: b.status,
      bufferHash: b.hash,
      registry,
      registryStatus: registry ? "OK" : "UNAVAILABLE",
      matchesVerifiedBuild: b.hash && registry?.executableHash ? b.hash === registry.executableHash : null,
    });
  }
  return out;
}
