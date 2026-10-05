import { z } from "zod";
import type { AccountStateChange, ConcurrentChange, SolBalanceChange, TokenBalanceChange } from "./types";

/**
 * Pure diffing of account state snapshots → balance and state changes.
 * Used for both simulation (pre snapshot vs simulated post) and executed
 * transactions (meta pre/post balances).
 */

interface LiteAccount {
  lamports: bigint;
  owner: string;
  token: { mint: string; owner: string; amount: string; decimals: number; delegate: string | null } | null;
}

const liteSchema = z.object({
  lamports: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]),
  owner: z.string(),
  data: z.unknown(),
});

const tokenInfoSchema = z.object({
  parsed: z.object({
    type: z.literal("account"),
    info: z.object({
      mint: z.string(),
      owner: z.string(),
      tokenAmount: z.object({ amount: z.string().regex(/^\d+$/), decimals: z.number().int() }),
      delegate: z.string().optional(),
    }),
  }),
});

export function toLiteAccount(raw: unknown): LiteAccount | null {
  const r = liteSchema.safeParse(raw);
  if (!r.success) return null;
  const tok = tokenInfoSchema.safeParse(r.data.data);
  return {
    lamports: BigInt(r.data.lamports),
    owner: r.data.owner,
    token: tok.success
      ? {
          mint: tok.data.parsed.info.mint,
          owner: tok.data.parsed.info.owner,
          amount: tok.data.parsed.info.tokenAmount.amount,
          decimals: tok.data.parsed.info.tokenAmount.decimals,
          delegate: tok.data.parsed.info.delegate ?? null,
        }
      : null,
  };
}

export interface SnapshotDiff {
  solChanges: SolBalanceChange[];
  tokenChanges: TokenBalanceChange[];
  accountChanges: AccountStateChange[];
  /** Addresses whose snapshot could not be parsed (reduces confidence). */
  unparsed: string[];
}

export function diffSnapshots(addresses: string[], pre: unknown[], post: unknown[]): SnapshotDiff {
  const out: SnapshotDiff = { solChanges: [], tokenChanges: [], accountChanges: [], unparsed: [] };

  addresses.forEach((address, i) => {
    const rawPre = pre[i] ?? null;
    const rawPost = post[i] ?? null;
    const a = rawPre === null ? null : toLiteAccount(rawPre);
    const b = rawPost === null ? null : toLiteAccount(rawPost);
    if ((rawPre !== null && !a) || (rawPost !== null && !b)) {
      out.unparsed.push(address);
      return;
    }

    const preL = a?.lamports ?? 0n;
    const postL = b?.lamports ?? 0n;
    if (preL !== postL) {
      out.solChanges.push({ address, preLamports: preL.toString(), postLamports: postL.toString(), deltaLamports: (postL - preL).toString() });
    }

    const tokenMint = a?.token?.mint ?? b?.token?.mint;
    if (tokenMint) {
      const preAmt = BigInt(a?.token?.amount ?? "0");
      const postAmt = BigInt(b?.token?.amount ?? "0");
      if (preAmt !== postAmt) {
        out.tokenChanges.push({
          tokenAccount: address,
          owner: a?.token?.owner ?? b?.token?.owner ?? null,
          mint: tokenMint,
          decimals: a?.token?.decimals ?? b?.token?.decimals ?? 0,
          preRaw: preAmt.toString(),
          postRaw: postAmt.toString(),
          deltaRaw: (postAmt - preAmt).toString(),
        });
      }
    }

    const created = a === null && b !== null;
    const closed = a !== null && (b === null || (b.lamports === 0n));
    const ownerChanged = a && b && a.owner !== b.owner;
    const delegateChanged = a?.token && b?.token && a.token.delegate !== b.token.delegate;
    const tokenOwnerChanged = a?.token && b?.token && a.token.owner !== b.token.owner;
    if (created || closed || ownerChanged || delegateChanged || tokenOwnerChanged) {
      out.accountChanges.push({
        address,
        ownerBefore: a?.owner ?? null,
        ownerAfter: b && b.lamports > 0n ? b.owner : null,
        created,
        closed,
        ...(a?.token || b?.token
          ? {
              delegateBefore: a?.token?.delegate ?? null,
              delegateAfter: b?.token?.delegate ?? null,
              tokenOwnerBefore: a?.token?.owner ?? null,
              tokenOwnerAfter: b?.token?.owner ?? null,
            }
          : {}),
      });
    }
  });

  return out;
}

/** Diff-relevant state of a raw account; accounts that cannot be parsed compare by their raw JSON. */
function fingerprint(raw: unknown): string {
  if (raw === null || raw === undefined) return "absent";
  const a = toLiteAccount(raw);
  return a ? JSON.stringify([a.lamports.toString(), a.owner, a.token]) : `raw:${JSON.stringify(raw)}`;
}

/**
 * Accounts whose diff-relevant state differs between the pre-state snapshot and a later one —
 * i.e. other transactions changed them in between — with the simulated post-state alongside.
 * Accounts already left out of the diff as unparseable are skipped. Returns null when a changed
 * account cannot be parsed in the later snapshot only: its concurrent change cannot be measured.
 */
export function concurrentChanges(addresses: string[], pre: unknown[], later: unknown[], post: unknown[]): ConcurrentChange[] | null {
  const out: ConcurrentChange[] = [];
  for (const [i, address] of addresses.entries()) {
    const rawPre = pre[i] ?? null;
    const rawLater = later[i] ?? null;
    const rawPost = post[i] ?? null;
    if (fingerprint(rawPre) === fingerprint(rawLater)) continue;
    const a = rawPre === null ? null : toLiteAccount(rawPre);
    const l = rawLater === null ? null : toLiteAccount(rawLater);
    const b = rawPost === null ? null : toLiteAccount(rawPost);
    if ((rawPre !== null && !a) || (rawPost !== null && !b)) continue;
    if (rawLater !== null && !l) return null;
    const tok = a?.token ?? l?.token;
    out.push({
      address,
      lamports: { pre: (a?.lamports ?? 0n).toString(), later: (l?.lamports ?? 0n).toString(), post: (b?.lamports ?? 0n).toString() },
      token: tok
        ? { mint: tok.mint, owner: tok.owner, decimals: tok.decimals, pre: a?.token?.amount ?? "0", later: l?.token?.amount ?? "0", post: b?.token?.amount ?? "0" }
        : null,
    });
  }
  return out;
}

/** Wallet-perspective net SOL change (lamports) and per-mint token change. */
export function walletNetChanges(
  wallet: string,
  sol: SolBalanceChange[],
  tokens: TokenBalanceChange[],
): { solDelta: bigint; tokenDeltas: Map<string, { delta: bigint; decimals: number }> } {
  const solDelta = sol.filter((c) => c.address === wallet).reduce((s, c) => s + BigInt(c.deltaLamports), 0n);
  const tokenDeltas = new Map<string, { delta: bigint; decimals: number }>();
  for (const t of tokens) {
    if (t.owner !== wallet) continue;
    const cur = tokenDeltas.get(t.mint) ?? { delta: 0n, decimals: t.decimals };
    cur.delta += BigInt(t.deltaRaw);
    tokenDeltas.set(t.mint, cur);
  }
  return { solDelta, tokenDeltas };
}
