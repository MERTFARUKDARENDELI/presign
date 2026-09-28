import { describe, expect, it } from "vitest";
import { gateFor } from "@/lib/agent/gate";
import { guardSignerPda } from "@/lib/guard/constants";
import type { ScheduledActions } from "@/lib/guard/types";
import type { PrivilegedAction, VaultPayload } from "@/lib/multisig/types";
import { applyPolicy, evaluatePolicy, toRawUnits, type PolicySubject } from "@/lib/policy/evaluate";
import { firstAddress, parsePolicyFile, policyFor } from "@/lib/policy/file";
import { EXAMPLE_POLICY, parsePolicyText, policySchema, type PolicyInput } from "@/lib/policy/schema";
import { buildAssessment } from "@/lib/security/engine";
import { SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@/lib/solana/constants";
import type { MultisigAccount } from "@/lib/squads/types";
import { controlledAddresses, vaultPda } from "@/lib/squads/pda";
import type { DecodedTransaction, TransactionEffects } from "@/lib/transaction/types";
import { key } from "../helpers/fixtures";

const MS = "2LW6PSEjp81xSEttWwXDB6Etb1eKdhYPbFEojYbyhx88";
const VAULT = vaultPda(MS, 0);
const ATTACKER = "H7PiGqqUaanBovwKgEtreJbKmQe6dbq6VTrw6guy7ZgL";
const TREASURY = key(40).toBase58();
const GUARD_PROGRAM = key(41).toBase58();
const GUARD = key(42).toBase58();
const GUARD_SIGNER = guardSignerPda(GUARD_PROGRAM, GUARD);
const DRIFT = "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH";
const MINT = key(43).toBase58();

const policy = (p: Partial<PolicyInput>) => policySchema.parse({ version: 1, name: "Council", ...p });

const account = (over: Partial<MultisigAccount> = {}): MultisigAccount =>
  ({ createKey: key(44).toBase58(), configAuthority: null, threshold: 2, timeLock: 0, transactionIndex: "9", staleTransactionIndex: "0", rentCollector: null, bump: 255, members: [], ...over }) as MultisigAccount;

function decoded(over: Partial<DecodedTransaction> = {}): DecodedTransaction {
  return {
    version: 0, transactionConfig: null, feePayer: VAULT, signers: [VAULT], signaturesPresent: 0, recentBlockhash: "", accounts: [], instructions: [], programs: [],
    solTransfers: [], tokenTransfers: [], approvals: [], authorityChanges: [], closes: [], usesDurableNonce: false, lookupTablesResolved: true, undecodedInstructions: [],
    innerInstructions: [], innerInstructionsSource: "NONE", ...over,
  };
}

const ix = (programId: string, index = 0) => ({ index, programId, programName: programId === DRIFT ? "Drift Protocol v2" : "program", programTrust: "known" as const, type: "x", parsed: true, accounts: [], info: {}, dataLength: 8 });

function effects(over: Partial<TransactionEffects> = {}): TransactionEffects {
  return { source: "SIMULATION", success: true, error: null, logs: [], logsTruncated: false, unitsConsumed: 1, slot: 1, preStateSlot: 1, stale: false, blockhashValid: null, feeLamports: "5000", solChanges: [], tokenChanges: [], accountChanges: [], notes: [], ...over };
}

function payload(over: Partial<VaultPayload> = {}): VaultPayload {
  return { source: "TRANSACTION_ACCOUNT", transaction: null, transactionIndex: "7", vaultIndex: 0, vault: VAULT, status: "DECODED", detail: null, decoded: decoded(), privileged: [], effects: effects(), effectsStatus: "COMPLETE", ...over };
}

const adminTo = (newAuthority: string | null, control: PrivilegedAction["control"], kind: PrivilegedAction["kind"] = "admin-transfer"): PrivilegedAction => ({
  kind, origin: "proposal #7, instruction 0", programId: DRIFT, programName: "Drift Protocol v2", action: "updateAdmin", target: null, newAuthority, control, authorityField: "admin", source: "ANCHOR_IDL",
});

function scheduled(over: Partial<ScheduledActions> = {}): ScheduledActions {
  return { guard: GUARD, guardSigner: GUARD_SIGNER, guardAccount: { proposer: VAULT, guardians: [TREASURY], delaySeconds: 86_400, createKey: key(45).toBase58(), actionCount: "0", bump: 1, signerBump: 1 }, guardStatus: "OK", memo: "", origin: "proposal #7, instruction 0", decoded: decoded({ instructions: [ix(DRIFT)] }), privileged: [], ...over };
}

const subject = (over: Partial<PolicySubject> = {}): PolicySubject => ({ mode: "proposal", multisig: MS, account: account(), controlled: controlledAddresses(MS), payloads: [], configActions: [], usesDurableNonce: false, ...over });
const ctx = { guardProgram: GUARD_PROGRAM };
const check = (r: ReturnType<typeof evaluatePolicy>, rule: string) => r.checks.find((c) => c.rule === rule)!;

describe("policy schema", () => {
  it("accepts the example, rejects unknown keys, bad amounts and bad addresses with readable errors", () => {
    expect(policySchema.safeParse(EXAMPLE_POLICY).success).toBe(true);
    expect(policySchema.safeParse({ ...EXAMPLE_POLICY, allowAll: true }).success).toBe(false);
    expect(policySchema.safeParse({ ...EXAMPLE_POLICY, outflowLimits: { SOL: "1e9" } }).success).toBe(false);
    const bad = parsePolicyText(JSON.stringify({ ...EXAMPLE_POLICY, authorityHolders: ["not-an-address"] }));
    expect(bad).toEqual({ ok: false, errors: [expect.stringContaining("authorityHolders.0")] });
    expect(parsePolicyText("{")).toEqual({ ok: false, errors: ["Not valid JSON."] });
    expect(policy({}).severity).toBe("HIGH");
  });

  it("converts UI amounts to raw units, dropping digits beyond the mint's decimals", () => {
    expect(toRawUnits("100", 9)).toBe(100_000_000_000n);
    expect(toRawUnits("12.5", 6)).toBe(12_500_000n);
    expect(toRawUnits("1.123456789", 2)).toBe(112n);
  });
});

describe("policy rules", () => {
  it("Drift: admin handed to an outside address breaks the holder and guard rules", () => {
    const r = evaluatePolicy(policy({ authorityHolders: [TREASURY], requireGuardFor: ["admin-transfer"] }), subject({ payloads: [payload({ privileged: [adminTo(ATTACKER, "outside")] })] }), ctx);
    expect(r.status).toBe("violation");
    expect(check(r, "authorityHolders")).toMatchObject({ status: "violation", findings: [expect.stringContaining(`→ ${ATTACKER}, not an approved holder`)] });
    expect(check(r, "requireGuardFor").findings[0]).toContain("runs immediately instead of through Presign Guard");
  });

  it("approved holders, the multisig itself and listed guards pass; removal needs \"none\"", () => {
    const p = policy({ authorityHolders: [TREASURY], requireGuardFor: ["token-authority"], guards: [GUARD] });
    const ok = evaluatePolicy(p, subject({ payloads: [payload({ privileged: [adminTo(TREASURY, "outside"), adminTo(VAULT, "multisig"), adminTo(GUARD_SIGNER, "outside", "token-authority")] })] }), ctx);
    expect(check(ok, "authorityHolders").status).toBe("pass");
    // Handing an authority to an approved guard is allowed even when the kind requires the guard.
    expect(check(ok, "requireGuardFor").status).toBe("pass");
    const removed = evaluatePolicy(p, subject({ payloads: [payload({ privileged: [adminTo(null, "none")] })] }), ctx);
    expect(check(removed, "authorityHolders").status).toBe("violation");
    expect(check(evaluatePolicy(policy({ authorityHolders: ["none"] }), subject({ payloads: [payload({ privileged: [adminTo(null, "none")] })] }), ctx), "authorityHolders").status).toBe("pass");
  });

  it("content that cannot be decoded is unverifiable, never compliant", () => {
    const r = evaluatePolicy(policy({ authorityHolders: [], requireGuardFor: ["admin-transfer"], allowedPrograms: ["system"] }), subject({ payloads: [payload({ status: "UNAVAILABLE", decoded: null, effects: null })] }), ctx);
    expect(r.status).toBe("unverifiable");
    expect(r.checks.map((c) => c.status)).toEqual(["unverifiable", "unverifiable", "unverifiable"]);
    const unknownHolder = evaluatePolicy(policy({ authorityHolders: [] }), subject({ payloads: [payload({ privileged: [{ ...adminTo(null, null), newAuthority: undefined }] })] }), ctx);
    expect(check(unknownHolder, "authorityHolders").findings[0]).toContain("could not be identified");
  });

  it("scheduled actions must use an approved guard with a long enough delay", () => {
    const p = policy({ guards: [GUARD], minGuardDelaySeconds: 2 * 86_400 });
    const short = evaluatePolicy(p, subject({ payloads: [payload({ scheduled: [scheduled()] })] }), ctx);
    expect(check(short, "guards").findings).toEqual([expect.stringContaining("guard delay is 1 day(s); the policy requires at least 2 day(s)")]);
    const other = evaluatePolicy(p, subject({ payloads: [payload({ scheduled: [scheduled({ guard: TREASURY, guardAccount: null, guardStatus: "NOT_FOUND" })] })] }), ctx);
    expect(check(other, "guards").status).toBe("violation");
    expect(check(other, "guards").findings).toHaveLength(2);
    expect(check(evaluatePolicy(p, subject(), ctx), "guards").status).toBe("not-applicable");
  });

  it("time lock and threshold: current setup and proposed config changes", () => {
    const p = policy({ minTimeLockSeconds: 3600, minThreshold: 3 });
    const r = evaluatePolicy(p, subject({ account: account({ timeLock: 0, threshold: 2 }), configActions: [{ origin: "proposal #8, action 0", action: { type: "SetTimeLock", newTimeLock: 60 } }] }), ctx);
    expect(check(r, "minTimeLockSeconds").findings).toEqual(["The time lock is none; the policy requires at least 1 hour(s).", "proposal #8, action 0: sets the time lock to 1 minute(s), below 1 hour(s)."]);
    expect(check(r, "minThreshold").findings).toEqual(["The threshold is 2; the policy requires at least 3."]);
    expect(check(evaluatePolicy(p, subject({ account: null }), ctx), "minThreshold").status).toBe("unverifiable");
    expect(evaluatePolicy(p, subject({ account: account({ timeLock: 7200, threshold: 3 }) }), ctx).status).toBe("compliant");
  });

  it("programs: aliases resolve, other programs break the rule, the guard program is allowed when guards are required", () => {
    const p = policy({ allowedPrograms: ["system", "spl-token"], requireGuardFor: ["admin-transfer"] });
    const r = evaluatePolicy(p, subject({ payloads: [payload({ decoded: decoded({ instructions: [ix(SYSTEM_PROGRAM_ID), ix(TOKEN_PROGRAM_ID, 1), ix(GUARD_PROGRAM, 2)] }), scheduled: [scheduled()] })] }), ctx);
    expect(check(r, "allowedPrograms").findings).toEqual([expect.stringContaining(`(scheduled): calls`)]);
    expect(check(r, "allowedPrograms").findings[0]).toContain(DRIFT);
  });

  it("recipients: SOL, resolved token owners, approvals; unresolved owners and undecoded content are unverifiable", () => {
    const p = policy({ allowedRecipients: [TREASURY] });
    const d = decoded({
      solTransfers: [{ instruction: 0, from: VAULT, to: TREASURY, lamports: "1" }, { instruction: 1, from: VAULT, to: ATTACKER, lamports: "2000000000" }],
      tokenTransfers: [{ instruction: 2, program: "spl-token", source: "src", destination: "ataT", authority: VAULT, amountRaw: "5", mint: MINT, decimals: 0 }, { instruction: 3, program: "spl-token", source: "src", destination: "ataA", authority: VAULT, amountRaw: "5", mint: MINT, decimals: 0 }, { instruction: 4, program: "spl-token", source: "src", destination: "ataX", authority: VAULT, amountRaw: "5", mint: null, decimals: null }],
      approvals: [{ instruction: 5, account: "src", delegate: ATTACKER, owner: VAULT, amountRaw: "18446744073709551615", unlimited: true }],
    });
    const tokenChanges = [{ tokenAccount: "ataT", owner: TREASURY, mint: MINT, decimals: 0, preRaw: "0", postRaw: "5", deltaRaw: "5" }, { tokenAccount: "ataA", owner: ATTACKER, mint: MINT, decimals: 0, preRaw: "0", postRaw: "5", deltaRaw: "5" }];
    const r = check(evaluatePolicy(p, subject({ payloads: [payload({ decoded: d, effects: effects({ tokenChanges }) })] }), ctx), "allowedRecipients");
    expect(r.status).toBe("violation");
    expect(r.findings).toEqual([
      `Proposal #7: sends 2 SOL to ${ATTACKER}.`,
      expect.stringContaining(`to ${ATTACKER}.`),
      `Proposal #7: lets ${ATTACKER} spend the vault's tokens (unlimited).`,
      "Proposal #7: sends tokens to account ataX, whose owner could not be resolved.",
    ]);
    const partial = check(evaluatePolicy(p, subject({ payloads: [payload({ status: "PARTIAL" })] }), ctx), "allowedRecipients");
    expect(partial.status).toBe("unverifiable");
  });

  it("outflow limits use the vault's simulated net change, plus transfers scheduled through the guard", () => {
    const p = policy({ outflowLimits: { SOL: "100", [MINT]: "1000.5" } });
    const sol = (delta: bigint) => payload({ effects: effects({ solChanges: [{ address: VAULT, preLamports: "0", postLamports: "0", deltaLamports: delta.toString() }, { address: ATTACKER, preLamports: "0", postLamports: "0", deltaLamports: (-delta).toString() }] }) });
    expect(check(evaluatePolicy(p, subject({ payloads: [sol(-150_000_000_000n)] }), ctx), "outflowLimits").findings).toEqual(["Net outflow of 150 SOL exceeds the limit of 100."]);
    expect(check(evaluatePolicy(p, subject({ payloads: [sol(-50_000_000_000n)] }), ctx), "outflowLimits").status).toBe("pass");
    // Batch payloads add up.
    expect(check(evaluatePolicy(p, subject({ payloads: [sol(-60_000_000_000n), sol(-60_000_000_000n)] }), ctx), "outflowLimits").status).toBe("violation");
    const tokens = payload({ effects: effects({ tokenChanges: [{ tokenAccount: "a", owner: VAULT, mint: MINT, decimals: 6, preRaw: "0", postRaw: "0", deltaRaw: "-1000600000" }] }) });
    expect(check(evaluatePolicy(p, subject({ payloads: [tokens] }), ctx), "outflowLimits").findings[0]).toContain("exceeds the limit of 1000.5");
    expect(check(evaluatePolicy(p, subject({ payloads: [payload({ effects: null })] }), ctx), "outflowLimits").status).toBe("unverifiable");
    const later = scheduled({ decoded: decoded({ solTransfers: [{ instruction: 0, from: GUARD_SIGNER, to: ATTACKER, lamports: "101000000000" }] }) });
    expect(check(evaluatePolicy(p, subject({ payloads: [payload({ scheduled: [later] })] }), ctx), "outflowLimits").status).toBe("violation");
  });

  it("upgrades must match a verified build; an unchecked upgrade is unverifiable", () => {
    const p = policy({ requireVerifiedUpgrades: true });
    const up = (m: boolean | null) => payload({ upgrades: [{ program: DRIFT, buffer: "b", bufferStatus: "OK", bufferHash: "ab".repeat(32), registry: null, registryStatus: "OK", matchesVerifiedBuild: m }] });
    expect(check(evaluatePolicy(p, subject({ payloads: [up(false)] }), ctx), "requireVerifiedUpgrades").status).toBe("violation");
    expect(check(evaluatePolicy(p, subject({ payloads: [up(null)] }), ctx), "requireVerifiedUpgrades").status).toBe("unverifiable");
    expect(check(evaluatePolicy(p, subject({ payloads: [up(true)] }), ctx), "requireVerifiedUpgrades").status).toBe("pass");
    expect(check(evaluatePolicy(p, subject({ payloads: [payload({ privileged: [adminTo(undefined as never, null, "program-upgrade")] })] }), ctx), "requireVerifiedUpgrades").status).toBe("unverifiable");
  });

  it("durable nonces apply to signatures only; scope must match the multisig", () => {
    const p = policy({ forbidDurableNonce: true, multisig: MS });
    expect(check(evaluatePolicy(p, subject({ mode: "transaction", usesDurableNonce: true }), ctx), "forbidDurableNonce").status).toBe("violation");
    expect(check(evaluatePolicy(p, subject({ usesDurableNonce: true }), ctx), "forbidDurableNonce").status).toBe("not-applicable");
    expect(check(evaluatePolicy(p, subject({ multisig: TREASURY }), ctx), "scope").status).toBe("violation");
  });

  it("a multisig overview only checks setup rules", () => {
    const r = evaluatePolicy(policy(EXAMPLE_POLICY), subject({ mode: "multisig", account: account({ timeLock: 3600, threshold: 3 }) }), ctx);
    expect(r.status).toBe("compliant");
    expect(r.checks.filter((c) => c.status !== "not-applicable").map((c) => c.rule)).toEqual(["minTimeLockSeconds", "minThreshold"]);
  });
});

describe("policy files (Watchtower, MCP)", () => {
  it("routes a policy by multisig, falls back to the general one, and rejects malformed files", () => {
    const list = parsePolicyFile(JSON.stringify([{ version: 1, name: "General" }, { version: 1, name: "Council", multisig: MS }]));
    expect(policyFor(list, MS)?.name).toBe("Council");
    expect(policyFor(list, TREASURY)?.name).toBe("General");
    expect(policyFor(parsePolicyFile(JSON.stringify({ version: 1, name: "Only", multisig: MS })), TREASURY)?.name).toBe("Only");
    expect(() => parsePolicyFile("[]")).toThrow(/empty/);
    expect(() => parsePolicyFile(JSON.stringify({ name: "x" }))).toThrow(/version/);
    expect(firstAddress(`https://app.squads.so/squads/${MS}/transactions/7`)).toBe(MS);
    expect(firstAddress("#7")).toBeNull();
  });
});

describe("applying a policy to an assessment", () => {
  const safe = () => buildAssessment({ category: "proposal", signals: [], evidence: [], sources: [], status: "COMPLETE" });

  it("a compliant proposal keeps its verdict; a violation blocks; an unverifiable rule requires review", () => {
    const compliant = applyPolicy(safe(), evaluatePolicy(policy({ minThreshold: 2 }), subject(), ctx));
    expect([compliant.level, gateFor(compliant.level, compliant.status)]).toEqual(["SAFE", "no_known_risk"]);
    expect(compliant.sources.at(-1)).toMatchObject({ source: "TEAM_POLICY", detail: '"Council": compliant' });

    const broken = applyPolicy(safe(), evaluatePolicy(policy({ minThreshold: 3 }), subject(), ctx));
    expect(broken.signals[0]).toMatchObject({ code: "POLICY_minThreshold", severity: "HIGH", title: "Team policy: threshold below the minimum" });
    expect(broken.evidence.find((e) => e.id === broken.signals[0].evidenceIds[0])).toMatchObject({ source: "TEAM_POLICY" });
    expect(gateFor(broken.level, broken.status)).toBe("block");

    const unknown = applyPolicy(safe(), evaluatePolicy(policy({ minThreshold: 3 }), subject({ account: null }), ctx));
    expect([unknown.level, gateFor(unknown.level, unknown.status)]).toEqual(["MEDIUM", "require_human_review"]);

    const critical = applyPolicy(safe(), evaluatePolicy(policy({ minThreshold: 3, severity: "CRITICAL" }), subject(), ctx));
    expect(critical.level).toBe("CRITICAL");
  });
});
