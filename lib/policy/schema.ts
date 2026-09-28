import { z } from "zod";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  BPF_LOADER_UPGRADEABLE_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  MEMO_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@/lib/solana/constants";
import { SQUADS_V4_PROGRAM_ID } from "@/lib/squads/constants";
import { publicKeySchema } from "@/lib/validation/schemas";

/**
 * Team policy: rules a multisig team writes once and Presign checks on every
 * proposal and signature — who may receive authorities, which actions must go
 * through Presign Guard, which programs and recipients the vault may touch,
 * how much may leave per proposal. Declarative JSON, versioned, no code.
 */

export const PRIVILEGED_KINDS = ["program-upgrade", "upgrade-authority", "program-close", "token-authority", "account-reassign", "admin-transfer", "admin-action"] as const;

/** Short names accepted in `allowedPrograms`. */
export const PROGRAM_ALIASES: Record<string, string> = {
  system: SYSTEM_PROGRAM_ID,
  "spl-token": TOKEN_PROGRAM_ID,
  "token-2022": TOKEN_2022_PROGRAM_ID,
  "associated-token": ASSOCIATED_TOKEN_PROGRAM_ID,
  "compute-budget": COMPUTE_BUDGET_PROGRAM_ID,
  memo: MEMO_PROGRAM_ID,
  "bpf-loader": BPF_LOADER_UPGRADEABLE_ID,
  squads: SQUADS_V4_PROGRAM_ID,
};

export const POLICY_LIMITS = { holders: 50, guards: 10, programs: 50, recipients: 100, outflowMints: 20 } as const;

const amount = z.string().trim().regex(/^\d{1,20}(\.\d{1,18})?$/, 'Use a decimal amount such as "250000" or "12.5".');

export const policySchema = z
  .object({
    version: z.literal(1),
    name: z.string().trim().min(1).max(80),
    /** The multisig this policy was written for. Applying it to another one is itself a violation. */
    multisig: publicKeySchema.optional(),
    /** Severity of a violation (unverifiable rules are always MEDIUM). HIGH and CRITICAL block automated signers. */
    severity: z.enum(["MEDIUM", "HIGH", "CRITICAL"]).default("HIGH"),
    /** Addresses allowed to receive an authority, besides the multisig and its vaults. "none" permits removing an authority. */
    authorityHolders: z.array(z.union([publicKeySchema, z.literal("none")])).max(POLICY_LIMITS.holders).optional(),
    /** Privileged actions that must be scheduled through Presign Guard instead of executed immediately. */
    requireGuardFor: z.array(z.enum(PRIVILEGED_KINDS)).max(PRIVILEGED_KINDS.length).optional(),
    /** Guards that may be used. Their signers may also receive authorities. */
    guards: z.array(publicKeySchema).max(POLICY_LIMITS.guards).optional(),
    minGuardDelaySeconds: z.number().int().min(0).max(30 * 86_400).optional(),
    minTimeLockSeconds: z.number().int().min(0).max(90 * 86_400).optional(),
    minThreshold: z.number().int().min(1).max(65_535).optional(),
    /** Programs the vault may call directly (addresses or aliases such as "system", "spl-token"). */
    allowedPrograms: z.array(z.union([publicKeySchema, z.enum(Object.keys(PROGRAM_ALIASES) as [string, ...string[]])])).max(POLICY_LIMITS.programs).optional(),
    /** Wallets the vault may send SOL or tokens to, or approve as delegates, besides itself. */
    allowedRecipients: z.array(publicKeySchema).max(POLICY_LIMITS.recipients).optional(),
    /** Maximum net outflow per proposal, in UI units, keyed by "SOL" or a mint address. */
    outflowLimits: z
      .record(z.union([z.literal("SOL"), publicKeySchema]), amount)
      .refine((r) => Object.keys(r).length <= POLICY_LIMITS.outflowMints, `At most ${POLICY_LIMITS.outflowMints} outflow limits.`)
      .optional(),
    /** Program upgrades must deploy exactly a build verified in the OtterSec registry. */
    requireVerifiedUpgrades: z.boolean().optional(),
    /** Signatures must not use a durable nonce (they would never expire). */
    forbidDurableNonce: z.boolean().optional(),
  })
  .strict();

/** Optional `policy` field for API request schemas. */
export const withPolicy = { policy: policySchema.optional() };

export type TeamPolicy = z.infer<typeof policySchema>;
export type PolicyInput = z.input<typeof policySchema>;

/** A starting point for the editor and the docs. Addresses are placeholders to replace. */
export const EXAMPLE_POLICY: PolicyInput = {
  version: 1,
  name: "Security council",
  severity: "HIGH",
  authorityHolders: [],
  requireGuardFor: ["admin-transfer", "upgrade-authority", "program-upgrade", "token-authority"],
  minGuardDelaySeconds: 86_400,
  minTimeLockSeconds: 3_600,
  minThreshold: 3,
  allowedPrograms: ["system", "spl-token", "token-2022", "associated-token", "squads"],
  allowedRecipients: [],
  outflowLimits: { SOL: "100" },
  requireVerifiedUpgrades: true,
  forbidDurableNonce: true,
};

/** Parses a policy from untrusted JSON text; returns readable errors instead of throwing. */
export function parsePolicyText(text: string): { ok: true; policy: TeamPolicy } | { ok: false; errors: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["Not valid JSON."] };
  }
  const r = policySchema.safeParse(json);
  if (r.success) return { ok: true, policy: r.data };
  return { ok: false, errors: r.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "policy"}: ${i.message}`) };
}
