import { PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeMultisig } from "@/lib/multisig/analyze";
import { buildSignerBrief } from "@/lib/multisig/brief";
import { clearProposalHistoryCache, loadProposalHistory, nonceSignedAction } from "@/lib/multisig/history";
import type { MultisigAnalysis } from "@/lib/multisig/types";
import { evaluateProposalRisk } from "@/lib/security/rules/multisig";
import { evaluateTransactionRisk } from "@/lib/security/rules/transaction";
import { rpcCall } from "@/lib/solana/client";
import { SQUADS_V4_PROGRAM_ID } from "@/lib/squads/constants";
import { decodeTransaction } from "@/lib/transaction/decoder";
import { parseV1Message } from "@/lib/transaction/offline-signers";
import fixture from "../fixtures/programmatic-signer-devnet.json";
import { buildTx, key } from "../helpers/fixtures";

// A real devnet vote cast through Anza's Ed25519 Programmatic Signer. Only the RPC edge is mocked.
vi.mock("@/lib/solana/client", async (importOriginal) => ({ ...(await importOriginal<object>()), rpcCall: vi.fn() }));
const rpc = vi.mocked(rpcCall);
const ok = (result: unknown) => ({ result, source: "HELIUS_RPC" as const, fallbackUsed: false });

const [create, relay, execute] = fixture.transactions;
const bytesOf = (t: (typeof fixture.transactions)[number]) => Buffer.from(t.transaction, "base64");
const metaOf = (t: (typeof fixture.transactions)[number]) => ({ signature: t.signature, slot: t.slot, blockTime: t.blockTime });
const ANZA = "Anza Ed25519 Programmatic Signer";

const emptyAnalysis = (): MultisigAnalysis => ({ programId: SQUADS_V4_PROGRAM_ID, multisig: fixture.multisig, account: null, accountStatus: "OK", instructions: [], proposals: [], payloads: [], configActions: [], controlled: [], malformed: [] });

beforeEach(() => {
  rpc.mockReset();
  clearProposalHistoryCache();
});

describe("v1 messages (durable-nonce replacements sign these)", () => {
  // The execution message from the Solana Foundation deprecation guide's devnet example: a System transfer from the PDA.
  const GUIDE_EXAMPLE = "gQEAAQAAAACu++caBvzUSDwm2qBzve4ky9k8NDfNg6bArz37HudiGgED3fMzTScu4ZMob98Da9+HJx/80+HBgbGB3zgfLZbSFrdJFtINAZ/jKgjE+s3gTtZRqVs3mO1ziJHfJ/TmEMvgKwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgIMAAABAgAAAEBCDwAAAAAA";

  it("parses the guide's example: header, the nonce in the blockhash field, accounts and the instruction", () => {
    const m = parseV1Message(Buffer.from(GUIDE_EXAMPLE, "base64"))!;
    expect(m).toMatchObject({ numSigners: 1, numReadonlySigners: 0, numReadonlyNonSigners: 1, lifetime: "Cn4ixkyHUg44Bz3GwaTaKPzqmJTJ1ZCRKTbcLC45weYH" });
    expect(m.staticAccounts).toEqual(["FwQBxMUs36eChAYDTRpCs2ojK4gkfn43NBAFZHUsK71G", "5vJwnLeyjV8uNJSp1zn7VLW8GwiQbcsQbGaVSwRmkE4r", "11111111111111111111111111111111"]);
    expect(m.instructions).toEqual([{ programIndex: 2, accounts: [0, 1], data: Uint8Array.from([2, 0, 0, 0, 64, 66, 15, 0, 0, 0, 0, 0]) }]);
  });

  it("refuses what it cannot read rather than guessing", () => {
    const bytes = Buffer.from(GUIDE_EXAMPLE, "base64");
    expect(parseV1Message(Uint8Array.from([0x80, ...bytes.subarray(1)]))).toBeNull(); // v0
    expect(parseV1Message(bytes.subarray(0, bytes.length - 1))).toBeNull(); // truncated
    expect(parseV1Message(Uint8Array.from([...bytes, 0]))).toBeNull(); // trailing bytes
    const withConfig = Uint8Array.from(bytes);
    withConfig[4] = 1; // a config value would follow
    expect(parseV1Message(withConfig)).toBeNull();
  });
});

describe("a Squads vote sent through Anza's programmatic signer (devnet)", () => {
  const tx = () => VersionedTransaction.deserialize(bytesOf(relay));

  it("decodes the envelope: who signed offline, the nonce it consumes, and the vote inside", () => {
    const decoded = decodeTransaction(tx());
    expect(decoded.usesDurableNonce).toBe(true);
    expect(decoded.offlineSigner).toMatchObject({
      kind: "programmatic-signer",
      instruction: 0,
      authorities: [fixture.coldAuthority],
      nonceAccount: fixture.nonceAccount,
      nonceAuthority: fixture.programmaticSigner,
      nonceValue: "8BigcBdFgQtrqYPAk4QysyR7WtMNqKbLo7ZUPjey6SZq",
    });
    expect(decoded.offlineSigner!.executes!.map((x) => x.programId)).toEqual([SQUADS_V4_PROGRAM_ID]);
    expect(decoded.instructions[0]).toMatchObject({ type: "programmatic-signer:submit", parsed: true, programTrust: "known", info: { authorities: fixture.coldAuthority, executes: "1 instruction(s): Squads Multisig v4" } });
    expect(decoded.undecodedInstructions).toEqual([]);
  });

  it("warns that the signature never expires, naming the envelope, and no longer calls the programs unknown", () => {
    const decoded = decodeTransaction(tx());
    const r = evaluateTransactionRisk({ decoded, effects: null, wallet: decoded.feePayer, effectsStatus: "COMPLETE" });
    const s = r.signals.find((x) => x.code === "TX_DURABLE_NONCE")!;
    expect(s.title).toBe("Signature that never expires");
    const e = r.evidence.find((x) => x.id === s.evidenceIds[0])!;
    expect(e.label).toBe(`Instruction #0 ${ANZA}`);
    expect(e.observed).toContain(fixture.coldAuthority);
    expect(e.observed).toContain(fixture.nonceAccount);
    expect(r.signals.some((x) => x.code === "TX_UNKNOWN_PROGRAM")).toBe(false);
  });

  it("is a CRITICAL multisig approval that never expires: the vote is read from the signed bytes", async () => {
    rpc.mockRejectedValue(new Error("offline"));
    const t = tx();
    const decoded = decodeTransaction(t);
    const ms = (await analyzeMultisig(t, decoded, decoded.feePayer))!;
    expect(ms.instructions).toMatchObject([{ index: 0, name: "proposalApprove", vote: "approve", member: fixture.programmaticSigner, proposal: fixture.proposal }]);
    const r = evaluateTransactionRisk({ decoded, effects: null, wallet: decoded.feePayer, effectsStatus: "COMPLETE", multisig: ms });
    const g = r.signals.find((x) => x.code === "MS_DURABLE_NONCE_GOVERNANCE")!;
    expect(g.severity).toBe("CRITICAL");
    expect(g.description).toContain(`signed offline through ${ANZA}`);
    expect(r.level).toBe("CRITICAL");
  });

  it("finds the vote in the proposal's history, from the executed record or from the signed bytes", () => {
    const vote = nonceSignedAction(bytesOf(relay), relay.meta.loadedAddresses, fixture.proposal, metaOf(relay), relay.meta.innerInstructions);
    expect(vote).toMatchObject({ envelope: ANZA, actions: ["proposalApprove"], members: [fixture.programmaticSigner], nonceAccount: fixture.nonceAccount, nonceAuthority: fixture.programmaticSigner });
    expect(nonceSignedAction(bytesOf(relay), undefined, fixture.proposal, metaOf(relay))).toMatchObject({ actions: ["proposalApprove"], members: [fixture.programmaticSigner] });
    // The relayer's own create and execute used fresh blockhashes.
    for (const t of [create, execute]) expect(nonceSignedAction(bytesOf(t), t.meta.loadedAddresses, fixture.proposal, metaOf(t), t.meta.innerInstructions)).toBeNull();
  });

  it("flags it as a vote signed in advance, in the risk and in the signer brief", async () => {
    rpc.mockImplementation((async (method: string, params: unknown[]) => {
      if (method === "getSignaturesForAddress" && params[0] === fixture.proposal) return ok([...fixture.transactions].reverse().map((t) => ({ signature: t.signature, slot: t.slot, blockTime: t.blockTime, err: null, memo: null })));
      if (method === "getSignaturesForAddress") return ok([{ signature: "3".repeat(88), slot: 1, blockTime: relay.blockTime! - 120, err: null }]);
      if (method === "getTransaction") {
        const t = fixture.transactions.find((x) => x.signature === params[0]);
        return ok(t ? { slot: t.slot, blockTime: t.blockTime, transaction: [t.transaction, "base64"], meta: t.meta } : null);
      }
      throw new Error(`unexpected rpc ${method}`);
    }) as unknown as typeof rpcCall);
    const history = await loadProposalHistory(fixture.proposal);
    expect(history).toMatchObject({ status: "OK", checked: 3 });
    expect(history.nonceSigned).toHaveLength(1);

    const r = evaluateProposalRisk(emptyAnalysis(), null, history);
    const s = r.signals.find((x) => x.code === "MS_VOTE_SIGNED_IN_ADVANCE")!;
    expect(s).toMatchObject({ severity: "HIGH", title: "Votes signed in advance, with no expiry" });
    expect(s.description).toContain(`through ${ANZA}`);
    expect(r.evidence.find((e) => e.id === s.evidenceIds[0])!.observed).toContain(`sent through ${ANZA} (nonce ${fixture.nonceAccount}`);

    const brief = buildSignerBrief({ mode: "proposal", multisig: emptyAnalysis(), usesDurableNonce: false, messageHash: null, proposal: { transactionIndex: fixture.transactionIndex, stale: false, transactionKind: "vault" }, history })!;
    expect(brief.signedInAdvance).toEqual([`35Bh…G3bo: approve landed through ${ANZA}, signed offline with no blockhash.`]);
  });
});

describe("a Squads vote sent through Blueshift Vector (not deployed: built here)", () => {
  const VECTOR = new PublicKey("vectorcLBXJ2TuoKuUygkEi6FWqvBnbHDEDWoYamfjV");
  const vector = key(20);
  const multisig = new PublicKey(fixture.multisig);
  const proposal = new PublicKey(fixture.proposal);
  const squads = new PublicKey(SQUADS_V4_PROGRAM_ID);
  // proposalApprove's data, as cast in the devnet vote above.
  const relayKeys = VersionedTransaction.deserialize(bytesOf(relay)).message.staticAccountKeys.map((k) => k.toBase58());
  const approveData = relay.meta.innerInstructions.flatMap((g) => g.instructions).find((ix) => relayKeys[ix.programIdIndex] === SQUADS_V4_PROGRAM_ID)!.data;

  function vectorVote() {
    const advance = new TransactionInstruction({ programId: VECTOR, keys: [{ pubkey: vector, isSigner: false, isWritable: true }, { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }], data: Buffer.from([1, ...new Uint8Array(64)]) });
    const passthrough = new TransactionInstruction({
      programId: VECTOR,
      keys: [vector, SYSVAR_INSTRUCTIONS_PUBKEY, multisig, proposal, squads].map((pubkey) => ({ pubkey, isSigner: false, isWritable: pubkey.equals(vector) || pubkey.equals(proposal) })),
      data: Buffer.from([4, 1, 2, 3]),
    });
    const built = buildTx([advance, passthrough]);
    const keys = VersionedTransaction.deserialize(built.bytes).message.staticAccountKeys.map((k) => k.toBase58());
    const at = (k: PublicKey) => keys.indexOf(k.toBase58());
    const inner = [{ index: 1, instructions: [{ programIdIndex: at(squads), accounts: [at(multisig), at(vector), at(proposal)], data: approveData, stackHeight: 2 }] }];
    return { bytes: built.bytes, inner };
  }

  it("is recognized at the top level; the passthrough payload is left to simulation", () => {
    const decoded = decodeTransaction(VersionedTransaction.deserialize(vectorVote().bytes));
    expect(decoded.usesDurableNonce).toBe(true);
    expect(decoded.offlineSigner).toMatchObject({ kind: "vector", instruction: 0, nonceAccount: vector.toBase58(), executes: null });
    expect(decoded.instructions.map((i) => i.type)).toEqual(["vector:advance", "vector:passthrough"]);
    expect(decoded.undecodedInstructions).toEqual([1]);
  });

  it("finds the vote in the proposal's history from the executed record's CPI", () => {
    const { bytes, inner } = vectorVote();
    const meta = { signature: "4".repeat(88), slot: 1, blockTime: 1 };
    expect(nonceSignedAction(bytes, undefined, fixture.proposal, meta, inner)).toMatchObject({ envelope: "Blueshift Vector (Ed25519)", actions: ["proposalApprove"], members: [vector.toBase58()], nonceAccount: vector.toBase58() });
    expect(bs58.decode(approveData).length).toBeGreaterThan(8);
    // Without the record, Vector's passthrough payload is not decoded, so no vote is claimed.
    expect(nonceSignedAction(bytes, undefined, fixture.proposal, meta)).toBeNull();
  });
});
