import "server-only";
import { z } from "zod";
import { rpcCall } from "@/lib/solana/client";
import { formatLamports } from "@/lib/token/amount";
import type { TransactionAnalysis } from "@/lib/transaction/types";
import type { ContextFindings } from "./context-rules";

/**
 * Address poisoning: a scammer sends a tiny amount ("dust") to the wallet from
 * an address that looks like one the user really sends to, so the fake address
 * appears in the user's history and gets copied next time. Its fingerprint is
 * on-chain: the recipient's ONLY contact with the wallet is dust it sent, and
 * the wallet never initiated anything with it.
 *
 * Checked for direct (top-level) SOL and token transfers the wallet makes —
 * not for program interactions such as swaps. Bounded RPC cost; a failure is
 * reported (analysis becomes PARTIAL), never read as "no risk".
 */

export const POISONING = {
  maxRecipients: 3,
  /** Signatures read per address (RPC maximum). */
  historyLimit: 1_000,
  /** Shared transactions inspected per recipient; more contact than this is treated as a real relationship. */
  maxSharedChecked: 5,
  /** At most this much SOL received counts as dust. */
  dustLamports: 1_000_000n,
  /** At most this many whole tokens received counts as dust. */
  dustTokenUi: 0.01,
} as const;

const sigList = z.array(z.object({ signature: z.string() }).passthrough());
const parsedTx = z.object({
  transaction: z.object({ message: z.object({ accountKeys: z.array(z.object({ pubkey: z.string(), signer: z.boolean().optional() }).passthrough()) }).passthrough() }).passthrough(),
  meta: z
    .object({
      preBalances: z.array(z.number()),
      postBalances: z.array(z.number()),
      preTokenBalances: z.array(z.object({ mint: z.string(), owner: z.string().optional(), uiTokenAmount: z.object({ uiAmountString: z.string().optional() }).passthrough() }).passthrough()).nullable().optional(),
      postTokenBalances: z.array(z.object({ mint: z.string(), owner: z.string().optional(), uiTokenAmount: z.object({ uiAmountString: z.string().optional() }).passthrough() }).passthrough()).nullable().optional(),
    })
    .passthrough()
    .nullable(),
});

async function signatures(address: string): Promise<string[]> {
  const res = await rpcCall<unknown>("getSignaturesForAddress", [address, { limit: POISONING.historyLimit, commitment: "confirmed" }]);
  const parsed = sigList.safeParse(res?.result);
  if (!parsed.success) throw new Error("malformed signature list");
  return parsed.data.map((s) => s.signature);
}

type Contact = { kind: "dust"; lamports: bigint } | { kind: "real" };

/** What one shared transaction was for the wallet: dust it received unasked, or a real interaction. */
async function contactIn(signature: string, wallet: string): Promise<Contact> {
  const res = await rpcCall<unknown>("getTransaction", [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
  const tx = parsedTx.safeParse(res?.result);
  if (!tx.success || !tx.data.meta) throw new Error("malformed transaction");
  const keys = tx.data.transaction.message.accountKeys;
  const i = keys.findIndex((k) => k.pubkey === wallet);
  if (i < 0 || keys[i].signer) return { kind: "real" };
  const solDelta = BigInt(tx.data.meta.postBalances[i] ?? 0) - BigInt(tx.data.meta.preBalances[i] ?? 0);
  if (solDelta < 0n || solDelta > POISONING.dustLamports) return { kind: "real" };
  const ui = (list: typeof tx.data.meta.preTokenBalances) => {
    const m = new Map<string, number>();
    for (const b of list ?? []) if (b.owner === wallet) m.set(b.mint, (m.get(b.mint) ?? 0) + Number(b.uiTokenAmount.uiAmountString ?? "0"));
    return m;
  };
  const pre = ui(tx.data.meta.preTokenBalances);
  const post = ui(tx.data.meta.postTokenBalances);
  for (const mint of new Set([...pre.keys(), ...post.keys()])) {
    const gain = (post.get(mint) ?? 0) - (pre.get(mint) ?? 0);
    if (gain < 0 || gain > POISONING.dustTokenUi) return { kind: "real" };
  }
  return { kind: "dust", lamports: solDelta };
}

/** Addresses the wallet pays directly in this transaction (top-level transfers, owners resolved from the simulation). */
export function directRecipients(a: TransactionAnalysis, wallet: string): string[] {
  const d = a.decoded;
  const ownerOf = (tokenAccount: string) => a.effects?.tokenChanges.find((c) => c.tokenAccount === tokenAccount)?.owner ?? tokenAccount;
  const out = [
    ...d.solTransfers.filter((t) => !t.cpi && t.from === wallet).map((t) => t.to),
    ...d.tokenTransfers.filter((t) => !t.cpi && t.authority === wallet).map((t) => ownerOf(t.destination)),
  ].filter((r) => r !== wallet);
  return [...new Set(out)].slice(0, POISONING.maxRecipients);
}

export async function recipientHistorySignals(a: TransactionAnalysis, wallet: string): Promise<ContextFindings> {
  const out: ContextFindings = { signals: [], evidence: [], sources: [] };
  const recipients = directRecipients(a, wallet);
  if (recipients.length === 0) return out;

  try {
    const [walletSigs, ...recipientSigs] = await Promise.all([wallet, ...recipients].map(signatures));
    const mine = new Set(walletSigs);
    let n = 0;
    for (const [k, r] of recipients.entries()) {
      const shared = recipientSigs[k].filter((s) => mine.has(s));
      if (shared.length === 0 || shared.length > POISONING.maxSharedChecked) continue;
      const contacts = await Promise.all(shared.map((s) => contactIn(s, wallet)));
      if (contacts.some((c) => c.kind === "real")) continue;
      const received = contacts.reduce((sum, c) => sum + (c.kind === "dust" ? c.lamports : 0n), 0n);
      const id = `presign-poisoning-${++n}`;
      out.evidence.push({ id, source: "ONCHAIN_RPC", label: `History between your wallet and ${r.slice(0, 4)}…${r.slice(-4)}`, observed: `${shared.length} earlier transaction(s), none signed by you; you received at most ${formatLamports(received.toString())} SOL / ${POISONING.dustTokenUi} tokens`, condition: "the recipient's only contact was unsolicited dust" });
      out.signals.push({
        code: `PRESIGN_POISONED_RECIPIENT:${r}`,
        title: "Recipient matches the address-poisoning pattern",
        description: `Your only earlier contact with ${r.slice(0, 4)}…${r.slice(-4)} is a tiny amount it sent you, and you have never sent to it. Scammers send such dust from an address that looks like one you use, so you copy it from your history. Compare every character with the address you intend to pay.`,
        severity: "HIGH",
        evidenceIds: [id],
      });
    }
    out.sources!.push({ source: "ONCHAIN_RPC", status: "OK", detail: `recipient history (${recipients.length} address(es), last ${POISONING.historyLimit} transactions)` });
  } catch {
    out.sources!.push({ source: "ONCHAIN_RPC", status: "FAILED", detail: "recipient history unavailable (address-poisoning check did not run)" });
    out.degraded = true;
  }
  return out;
}
