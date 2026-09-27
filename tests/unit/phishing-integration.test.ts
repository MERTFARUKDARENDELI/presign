import { PublicKey, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { buildDemoWalletScan } from "@/lib/demo/scenario";
import { evaluateTransactionRisk } from "@/lib/security/rules/transaction";
import { classifyTimelineEntry } from "@/lib/security/timeline";
import { MEMO_PROGRAM_ID } from "@/lib/solana/constants";
import { decodeTransaction } from "@/lib/transaction/decoder";
import { buildTx, WALLET } from "../helpers/fixtures";

const W = WALLET.toBase58();
const memo = (text: string) =>
  new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM_ID), keys: [], data: Buffer.from(text, "utf8") });
const riskOf = (text: string) =>
  evaluateTransactionRisk({ decoded: decodeTransaction(VersionedTransaction.deserialize(buildTx([memo(text)]).bytes)), effects: null, wallet: W, effectsStatus: "COMPLETE" });

describe("memo links in a transaction", () => {
  it("a phishing-pattern link in a memo is a MEDIUM signal (a memo moves nothing) with defanged evidence", () => {
    const r = riskOf("verify your wallet at https://ph4ntom-support.xyz/restore");
    const s = r.signals.find((x) => x.code === "TX_MEMO_SUSPICIOUS_LINK")!;
    expect(s.severity).toBe("MEDIUM");
    const ev = r.evidence.find((e) => e.id === s.evidenceIds[0])!;
    expect(ev.source).toBe("DETERMINISTIC_RULE");
    expect(String(ev.observed)).toContain("ph4ntom-support[.]xyz");
    expect(String(ev.observed)).not.toContain("https://");
  });

  it("an unknown, pattern-free link in a memo is not flagged", () => {
    expect(riskOf("invoice 42 — see example.com").signals.map((x) => x.code)).not.toContain("TX_MEMO_SUSPICIOUS_LINK");
  });
});

describe("timeline + URL reputation", () => {
  it("a HIGH-pattern link is a phishing memo even without lure words", () => {
    expect(classifyTimelineEntry({ failed: false, memo: "gm ph4ntom.app" }).kind).toBe("PHISHING_MEMO");
  });
  it("an unknown link alone remains only 'unverified'", () => {
    const e = classifyTimelineEntry({ failed: false, memo: "gm example.com" });
    expect(e.kind).toBe("SUSPICIOUS_MEMO");
    expect(e.evidence[0]).toContain("reputation unknown");
  });
});

describe("Demo Mode never looks like a real security result", () => {
  const scan = buildDemoWalletScan();

  it("new URL evidence in demo token reports is DEMO-labelled, and no token age is claimed", () => {
    const scam = scan.tokens.find((t) => t.holding.metadata?.name?.includes("sol-airdrop"))!.report!;
    expect(scam.risk.signals.map((s) => s.code)).toEqual(expect.arrayContaining(["TOKEN_METADATA_LINK"]));
    expect(scam.risk.evidence.every((e) => e.source === "DEMO")).toBe(true);
    expect(scam.risk.sources).toEqual([expect.objectContaining({ source: "DEMO" })]);
    expect(scan.tokens.every((t) => t.report?.age === undefined)).toBe(true);
  });
});
