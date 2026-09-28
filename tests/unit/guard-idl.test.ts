import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import idl from "../../guard/idl/presign_guard.json";
import { GUARD_ACCOUNT_DISCRIMINATOR, GUARD_IX_ACCOUNTS, GUARD_IX_DISCRIMINATOR, GUARD_LIMITS, GUARD_SEED } from "@/lib/guard/constants";

/**
 * Presign decodes and encodes Guard by hand; the IDL is what the compiled
 * program (guard/) actually exposes. They must agree byte for byte.
 */

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const hexOf = (d: number[]) => Buffer.from(d).toString("hex");
type Field = { name: string; type: unknown };
const fields = (name: string) => (idl.types.find((t) => t.name === name)!.type as { fields: Field[] }).fields.map((f) => [f.name, f.type]);

describe("Guard codec vs the compiled program's IDL", () => {
  it("has the same instructions, discriminators and account order", () => {
    expect(idl.instructions.map((i) => camel(i.name)).sort()).toEqual(Object.keys(GUARD_IX_DISCRIMINATOR).sort());
    for (const ix of idl.instructions) {
      const name = camel(ix.name) as keyof typeof GUARD_IX_DISCRIMINATOR;
      expect(hexOf(ix.discriminator), ix.name).toBe(GUARD_IX_DISCRIMINATOR[name]);
      expect(ix.accounts.map((a) => camel(a.name)), ix.name).toEqual(GUARD_IX_ACCOUNTS[name]);
    }
  });

  it("has the same account discriminators and field layout the decoders read", () => {
    for (const a of idl.accounts) expect(hexOf(a.discriminator), a.name).toBe(GUARD_ACCOUNT_DISCRIMINATOR[a.name as keyof typeof GUARD_ACCOUNT_DISCRIMINATOR]);
    // decodeGuardAccount: create_key, then readConfig (proposer, guardians, delay), action_count, bump, signer_bump.
    expect(fields("Guard")).toEqual([["create_key", "pubkey"], ["proposer", "pubkey"], ["guardians", { vec: "pubkey" }], ["delay_seconds", "u32"], ["action_count", "u64"], ["bump", "u8"], ["signer_bump", "u8"]]);
    expect(fields("Action")).toEqual([
      ["guard", "pubkey"], ["index", "u64"], ["proposer", "pubkey"], ["rent_payer", "pubkey"], ["scheduled_at", "i64"], ["eta", "i64"],
      ["status", { defined: { name: "ActionStatus" } }], ["vetoed_by", { option: "pubkey" }], ["executed_at", "i64"], ["memo", "string"],
      ["instructions", { vec: { defined: { name: "GuardInstruction" } } }], ["bump", "u8"],
    ]);
    expect(fields("GuardConfig")).toEqual([["proposer", "pubkey"], ["guardians", { vec: "pubkey" }], ["delay_seconds", "u32"]]);
    expect(fields("GuardInstruction")).toEqual([["program_id", "pubkey"], ["accounts", { vec: { defined: { name: "GuardAccountMeta" } } }], ["data", "bytes"]]);
    expect(fields("GuardAccountMeta")).toEqual([["pubkey", "pubkey"], ["is_signer", "bool"], ["is_writable", "bool"]]);
    const status = idl.types.find((t) => t.name === "ActionStatus")!.type as { variants: Array<{ name: string }> };
    expect(status.variants.map((v) => v.name)).toEqual(["Pending", "Executed", "Vetoed", "Cancelled"]);
  });

  it("is the program declared in Anchor.toml, with the seeds and limits of the source", () => {
    const toml = readFileSync("guard/Anchor.toml", "utf8");
    const ids = [...toml.matchAll(/presign_guard = "([1-9A-HJ-NP-Za-km-z]{32,44})"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids)).toEqual(new Set([idl.address]));
    const src = readFileSync("guard/programs/presign-guard/src/lib.rs", "utf8");
    expect(src).toContain(`declare_id!("${idl.address}")`);
    expect(src).toContain(`GUARD_SEED: &[u8] = b"${GUARD_SEED.guard}"`);
    expect(src).toContain(`SIGNER_SEED: &[u8] = b"${GUARD_SEED.signer}"`);
    expect(src).toContain(`ACTION_SEED: &[u8] = b"${GUARD_SEED.action}"`);
    expect(src).toContain(`MAX_GUARDIANS: usize = ${GUARD_LIMITS.maxGuardians};`);
    expect(src).toContain(`MIN_DELAY_SECONDS: u32 = ${GUARD_LIMITS.minDelaySeconds};`);
    expect(src).toContain(`MAX_INSTRUCTIONS: usize = ${GUARD_LIMITS.maxInstructions};`);
    expect(src).toContain(`MAX_ACCOUNTS_PER_INSTRUCTION: usize = ${GUARD_LIMITS.maxAccounts};`);
    expect(src).toContain(`MAX_DATA_LEN: usize = ${GUARD_LIMITS.maxData};`);
    expect(src).toContain(`MAX_MEMO_LEN: usize = ${GUARD_LIMITS.maxMemo};`);
  });
});
