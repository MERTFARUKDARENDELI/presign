import { SystemProgram } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DRIFT_NONCE_ACCOUNTS } from "@/lib/demo/drift";
import { buildSignerBrief } from "@/lib/multisig/brief";
import { clearProposalHistoryCache, loadProposalHistory, nonceSignedAction } from "@/lib/multisig/history";
import type { MultisigAnalysis, ProposalHistory } from "@/lib/multisig/types";
import { evaluatePolicy } from "@/lib/policy/evaluate";
import { policySchema } from "@/lib/policy/schema";
import { evaluateProposalRisk } from "@/lib/security/rules/multisig";
import { rpcCall } from "@/lib/solana/client";
import { SQUADS_V4_PROGRAM_ID } from "@/lib/squads/constants";
import { proposalPda } from "@/lib/squads/pda";
import drift from "../fixtures/drift-2026-04-01.json";
import { buildTx, key } from "../helpers/fixtures";

// Real Drift exploit transactions (public mainnet data). Only the RPC edge is mocked.
vi.mock("@/lib/solana/client", async (importOriginal) => ({ ...(await importOriginal<object>()), rpcCall: vi.fn() }));
const rpc = vi.mocked(rpcCall);

const MULTISIG = "2LW6PSEjp81xSEttWwXDB6Etb1eKdhYPbFEojYbyhx88";
const PROPOSAL_7 = proposalPda(MULTISIG, 7n);
const SIGNER_1 = "39JyWrdbVdRqjzw9yyEjxNtTbTKcTPLdtdCgbz7C7Aq8";
const SIGNER_2 = "6UJbu9ut5VAsFYQFgPEa5xPfoyF5bB5oi4EknFPvu924";

const bytes = (i: number) => Buffer.from(drift.transactions[i].transaction, "base64");
const meta = (i: number) => ({ signature: drift.transactions[i].signature, slot: drift.transactions[i].slot, blockTime: drift.transactions[i].blockTime });
const ok = (result: unknown) => ({ result, source: "HELIUS_RPC" as const, fallbackUsed: false });

function serve(rows: Array<{ signature: string; err?: unknown }>) {
  rpc.mockImplementation((async (method: string, params: unknown[]) => {
    // A nonce account's previous transaction: eight days before the vote.
    if (method === "getSignaturesForAddress" && params[0] !== PROPOSAL_7) return ok([{ signature: "3".repeat(88), slot: 1, blockTime: drift.transactions[0].blockTime - 8 * 86_400, err: null }]);
    if (method === "getSignaturesForAddress") return ok(rows.map((r) => ({ slot: 1, blockTime: 1, err: null, memo: null, ...r })));
    if (method === "getTransaction") {
      const t = drift.transactions.find((x) => x.signature === params[0]);
      return ok(t ? { slot: t.slot, blockTime: t.blockTime, transaction: [t.transaction, "base64"], meta: t.meta } : null);
    }
    throw new Error(`unexpected rpc ${method}`);
  }) as unknown as typeof rpcCall);
}

const emptyAnalysis = (): MultisigAnalysis => ({ programId: SQUADS_V4_PROGRAM_ID, multisig: MULTISIG, account: null, accountStatus: "OK", instructions: [], proposals: [], payloads: [], configActions: [], controlled: [], malformed: [] });

beforeEach(() => {
  rpc.mockReset();
  clearProposalHistoryCache();
});

describe("votes signed with a durable nonce (proposal history)", () => {
  it("finds the nonce, its authority and the votes in both Drift transactions", () => {
    const create = nonceSignedAction(bytes(0), drift.transactions[0].meta.loadedAddresses, PROPOSAL_7, meta(0));
    expect(create).toMatchObject({ actions: ["proposalCreate", "proposalApprove"], members: [SIGNER_1], nonceAuthority: SIGNER_1, slot: 410344005 });
    const execute = nonceSignedAction(bytes(1), drift.transactions[1].meta.loadedAddresses, PROPOSAL_7, meta(1));
    expect(execute).toMatchObject({ actions: ["proposalApprove", "vaultTransactionExecute"], members: [SIGNER_2], nonceAuthority: SIGNER_2 });
    expect(create!.nonceAccount).not.toBe(execute!.nonceAccount);
  });

  it("matches the nonce accounts the Drift case page cites, created before the votes", () => {
    DRIFT_NONCE_ACCOUNTS.forEach((n, i) => {
      const a = nonceSignedAction(bytes(i), undefined, PROPOSAL_7, meta(i))!;
      expect({ account: a.nonceAccount, authority: a.nonceAuthority }).toEqual({ account: n.account, authority: n.authority });
      expect(n.slot).toBeLessThan(drift.transactions[i].slot);
    });
  });

  it("ignores transactions without a durable nonce, and nonce transactions that do not touch the proposal", () => {
    const plain = buildTx([SystemProgram.transfer({ fromPubkey: key(1), toPubkey: key(2), lamports: 1 })]);
    expect(nonceSignedAction(plain.bytes, undefined, PROPOSAL_7, meta(0))).toBeNull();
    expect(nonceSignedAction(bytes(0), undefined, proposalPda(MULTISIG, 8n), meta(0))).toBeNull();
    // AdvanceNonceAccount anywhere but first is not a durable nonce.
    const late = buildTx([SystemProgram.transfer({ fromPubkey: key(1), toPubkey: key(2), lamports: 1 }), SystemProgram.nonceAdvance({ noncePubkey: key(3), authorizedPubkey: key(1) })]);
    expect(nonceSignedAction(late.bytes, undefined, PROPOSAL_7, meta(0))).toBeNull();
  });

  it("loads the proposal's history oldest first, skips failed transactions and caches checked ones", async () => {
    serve([{ signature: drift.transactions[1].signature }, { signature: "5".repeat(88), err: { InstructionError: [0, "Custom"] } }, { signature: drift.transactions[0].signature }]);
    const h = await loadProposalHistory(PROPOSAL_7);
    expect(h).toMatchObject({ status: "OK", checked: 2 });
    expect(h.nonceSigned.map((n) => n.slot)).toEqual([410344005, 410344009]);
    await loadProposalHistory(PROPOSAL_7);
    expect(rpc.mock.calls.filter(([m]) => m === "getTransaction")).toHaveLength(2);
  });

  it("reports an unreachable history as FAILED and a missing transaction as PARTIAL", async () => {
    rpc.mockRejectedValue(new Error("down"));
    expect(await loadProposalHistory(PROPOSAL_7)).toEqual({ status: "FAILED", checked: 0, nonceSigned: [] });
    serve([{ signature: drift.transactions[0].signature }, { signature: "4".repeat(88) }]);
    const h = await loadProposalHistory(PROPOSAL_7);
    expect(h.status).toBe("PARTIAL");
    expect(h.nonceSigned).toHaveLength(1);
  });

  it("is a HIGH signal naming who signed in advance, and a failed lookup is a failed source, not a signal", async () => {
    serve([{ signature: drift.transactions[0].signature }]);
    const history = await loadProposalHistory(PROPOSAL_7);
    const r = evaluateProposalRisk(emptyAnalysis(), null, history);
    const s = r.signals.find((x) => x.code === "MS_VOTE_SIGNED_IN_ADVANCE")!;
    expect(s.severity).toBe("HIGH");
    expect(s.description).toContain("proposalCreate + proposalApprove by 39Jy…7Aq8");
    expect(s.description).toContain("its nonce account had sat unused for 8 days");
    expect(r.evidence.find((e) => e.id === s.evidenceIds[0])!.observed).toContain(`authority ${SIGNER_1}`);

    const failed: ProposalHistory = { status: "FAILED", checked: 0, nonceSigned: [] };
    const f = evaluateProposalRisk(emptyAnalysis(), null, failed);
    expect(f.signals.some((x) => x.code === "MS_VOTE_SIGNED_IN_ADVANCE")).toBe(false);
    expect(f.sources).toContainEqual(expect.objectContaining({ source: "ONCHAIN_RPC", status: "FAILED" }));
  });

  it("puts each vote signed in advance in the signer brief", async () => {
    serve([{ signature: drift.transactions[1].signature }, { signature: drift.transactions[0].signature }]);
    const history = await loadProposalHistory(PROPOSAL_7);
    const brief = buildSignerBrief({ mode: "proposal", multisig: emptyAnalysis(), usesDurableNonce: false, messageHash: null, proposal: { transactionIndex: "7", stale: false, transactionKind: "vault" }, history })!;
    expect(brief.signedInAdvance).toEqual([
      "39Jy…7Aq8: create + approve landed inside a durable nonce; its nonce account had sat unused for 8 days.",
      "6UJb…u924: approve + execute landed inside a durable nonce; its nonce account had sat unused for 8 days.",
    ]);
    expect(buildSignerBrief({ mode: "proposal", multisig: emptyAnalysis(), usesDurableNonce: false, messageHash: null })!.signedInAdvance).toEqual([]);
  });

  it("violates a no-durable-nonce policy, and is unverifiable when the history is unavailable", async () => {
    serve([{ signature: drift.transactions[0].signature }]);
    const history = await loadProposalHistory(PROPOSAL_7);
    const p = policySchema.parse({ version: 1, name: "Council", forbidDurableNonce: true });
    const subject = { mode: "proposal" as const, multisig: MULTISIG, account: null, controlled: [], payloads: [], configActions: [], usesDurableNonce: false };
    const check = (h: ProposalHistory) => evaluatePolicy(p, { ...subject, history: h }, { guardProgram: null }).checks.find((c) => c.rule === "forbidDurableNonce")!;
    expect(check(history).status).toBe("violation");
    expect(check({ status: "FAILED", checked: 0, nonceSigned: [] }).status).toBe("unverifiable");
    expect(check({ status: "OK", checked: 3, nonceSigned: [] }).status).toBe("pass");
  });
});
