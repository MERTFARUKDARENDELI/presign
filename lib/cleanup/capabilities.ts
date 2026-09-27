import type { DigitalAsset } from "@/lib/solana/das";
import type { MintInfo, TokenAccountState } from "@/lib/token/types";

/**
 * Capability & support matrix. Every cleanup operation has an explicit
 * support state; UNSUPPORTED / REQUIRES_MANUAL_REVIEW operations are never
 * prepared, simulated as success, or sent to a wallet.
 */

export type CapabilityStatus =
  | "SUPPORTED"
  | "PARTIALLY_SUPPORTED"
  | "UNSUPPORTED"
  | "REQUIRES_MANUAL_REVIEW"
  | "NOT_APPLICABLE";

export type CleanupAction = "BURN_AND_CLOSE" | "CLOSE" | "REVOKE";

export type AssetClass =
  | "SPL_TOKEN"
  | "TOKEN_2022"
  | "WRAPPED_SOL"
  | "NFT"
  | "COMPRESSED_NFT";

export interface Capability {
  status: CapabilityStatus;
  reason: string;
}

/** Static matrix — what the product can do per asset class, before looking at account state. */
export const CAPABILITY_MATRIX: Record<AssetClass, Record<CleanupAction, Capability>> = {
  SPL_TOKEN: {
    BURN_AND_CLOSE: { status: "SUPPORTED", reason: "SPL Token BurnChecked + CloseAccount." },
    CLOSE: { status: "SUPPORTED", reason: "CloseAccount for zero-balance accounts." },
    REVOKE: { status: "SUPPORTED", reason: "SPL Token Revoke for an active delegate." },
  },
  TOKEN_2022: {
    BURN_AND_CLOSE: { status: "PARTIALLY_SUPPORTED", reason: "Supported unless extensions (withheld fees, confidential balances, paused mint) block it." },
    CLOSE: { status: "PARTIALLY_SUPPORTED", reason: "Blocked by withheld transfer fees or confidential balances." },
    REVOKE: { status: "SUPPORTED", reason: "Revokes the account-level delegate. A mint Permanent Delegate cannot be revoked by holders." },
  },
  WRAPPED_SOL: {
    BURN_AND_CLOSE: { status: "UNSUPPORTED", reason: "Wrapped SOL is never burned; close the account to unwrap instead." },
    CLOSE: { status: "SUPPORTED", reason: "Closing unwraps SOL back to the wallet." },
    REVOKE: { status: "SUPPORTED", reason: "SPL Token Revoke." },
  },
  NFT: {
    BURN_AND_CLOSE: { status: "REQUIRES_MANUAL_REVIEW", reason: "Metaplex NFTs need a Metaplex burn to also close metadata/edition accounts; plain SPL burn would leave them." },
    CLOSE: { status: "REQUIRES_MANUAL_REVIEW", reason: "NFT token accounts are closed via the Metaplex burn flow." },
    REVOKE: { status: "SUPPORTED", reason: "SPL Token Revoke (not for programmable NFTs, which are frozen)." },
  },
  COMPRESSED_NFT: {
    BURN_AND_CLOSE: { status: "UNSUPPORTED", reason: "cNFTs are Merkle-tree leaves, not token accounts. Burning requires a Bubblegum burn with a Merkle proof, which this product does not implement." },
    CLOSE: { status: "NOT_APPLICABLE", reason: "cNFTs have no token account and hold no reclaimable rent." },
    REVOKE: { status: "UNSUPPORTED", reason: "cNFT delegate revocation requires Bubblegum; not implemented." },
  },
};

/**
 * What exactly a "revoke" would touch. There is no universal "revoke all":
 * only an account-level delegate set on this token account is revocable by
 * its owner. A Token-2022 mint Permanent Delegate and a foreign close
 * authority are reported but never treated as revocable.
 */
export interface DelegationInfo {
  kind: "ACCOUNT_DELEGATE" | "NONE";
  tokenProgram: "spl-token" | "token-2022";
  delegate: string | null;
  delegatedAmountRaw: string | null;
  /** Mint-level Token-2022 permanent delegate — cannot be revoked by holders. */
  permanentDelegate: string | null;
  /** Account close authority when it is not the owner — only that authority can change it. */
  foreignCloseAuthority: string | null;
}

export interface CleanupEligibility {
  target: string;
  mint: string;
  assetClass: AssetClass;
  delegation: DelegationInfo | null;
  actions: Record<CleanupAction, Capability>;
  labels: Array<"burnable" | "closeable" | "revokable" | "manual_review" | "unsupported">;
  /** Rent lamports reclaimable if the account is closed (null if not closeable/unknown). */
  grossReclaimLamports: string | null;
}

const BLOCKING_ACCOUNT_EXTENSIONS: Record<string, string> = {
  transferFeeAmount: "Account may hold withheld transfer fees that must be harvested before closing.",
  confidentialTransferAccount: "Confidential balances must be emptied before closing.",
};

function labelsFor(actions: Record<CleanupAction, Capability>): CleanupEligibility["labels"] {
  const l: CleanupEligibility["labels"] = [];
  const ok = (c: Capability) => c.status === "SUPPORTED" || c.status === "PARTIALLY_SUPPORTED";
  if (ok(actions.BURN_AND_CLOSE)) l.push("burnable");
  if (ok(actions.CLOSE)) l.push("closeable");
  if (ok(actions.REVOKE)) l.push("revokable");
  if (Object.values(actions).some((a) => a.status === "REQUIRES_MANUAL_REVIEW")) l.push("manual_review");
  if (l.length === 0) l.push("unsupported");
  return l;
}

export function classifyTokenAccount(account: TokenAccountState, isNft: boolean): AssetClass {
  if (account.isNative) return "WRAPPED_SOL";
  if (isNft) return "NFT";
  return account.program === "token-2022" ? "TOKEN_2022" : "SPL_TOKEN";
}

/**
 * Account-state-aware eligibility for one token account. `owner` is the wallet
 * requesting cleanup; ownership mismatches make every action UNSUPPORTED.
 */
export function evaluateTokenAccountCleanup(
  account: TokenAccountState,
  owner: string,
  options: { mint?: MintInfo | null; isNft?: boolean } = {},
): CleanupEligibility {
  const assetClass = classifyTokenAccount(account, options.isNft === true);
  const actions: Record<CleanupAction, Capability> = {
    BURN_AND_CLOSE: { ...CAPABILITY_MATRIX[assetClass].BURN_AND_CLOSE },
    CLOSE: { ...CAPABILITY_MATRIX[assetClass].CLOSE },
    REVOKE: { ...CAPABILITY_MATRIX[assetClass].REVOKE },
  };
  const block = (a: CleanupAction, status: CapabilityStatus, reason: string) => {
    if (actions[a].status === "UNSUPPORTED" || actions[a].status === "NOT_APPLICABLE") return;
    actions[a] = { status, reason };
  };
  const all = (status: CapabilityStatus, reason: string) =>
    (["BURN_AND_CLOSE", "CLOSE", "REVOKE"] as CleanupAction[]).forEach((a) => block(a, status, reason));

  const balance = BigInt(account.amountRaw);

  if (account.owner !== owner) {
    all("UNSUPPORTED", "Token account is not owned by the connected wallet.");
  } else if (account.state === "frozen") {
    all("UNSUPPORTED", "Account is frozen by the mint's freeze authority; burn, close and revoke will fail.");
  } else if (account.state !== "initialized") {
    all("UNSUPPORTED", "Account is not initialized.");
  } else {
    // Revoke
    if (!account.delegate) {
      actions.REVOKE = { status: "NOT_APPLICABLE", reason: "No active delegate on this account." };
    }

    // Close
    if (balance > 0n) {
      block("CLOSE", "NOT_APPLICABLE", "Account still holds tokens; use Burn & Close or transfer them first.");
    }
    if (account.closeAuthority && account.closeAuthority !== owner) {
      block("CLOSE", "UNSUPPORTED", "Close authority is another address; the wallet cannot close this account.");
      block("BURN_AND_CLOSE", "UNSUPPORTED", "Close authority is another address; the account could not be closed after burning.");
    }
    for (const ext of account.extensions) {
      const reason = BLOCKING_ACCOUNT_EXTENSIONS[ext];
      if (reason) {
        block("CLOSE", "REQUIRES_MANUAL_REVIEW", reason);
        block("BURN_AND_CLOSE", "REQUIRES_MANUAL_REVIEW", reason);
      }
    }

    // Burn
    if (balance === 0n) {
      block("BURN_AND_CLOSE", "NOT_APPLICABLE", "Nothing to burn; use Close to reclaim rent.");
    }
    const m = options.mint;
    if (m?.extensions.paused) {
      block("BURN_AND_CLOSE", "UNSUPPORTED", "Mint is paused; burning is blocked.");
    }
    if (assetClass === "TOKEN_2022" && !m) {
      block("BURN_AND_CLOSE", "REQUIRES_MANUAL_REVIEW", "Mint extensions could not be verified.");
    }
    if (m?.extensions.permanentDelegate && account.delegate === null) {
      // informational: the permanent delegate can't be revoked by the holder
      actions.REVOKE = { status: "NOT_APPLICABLE", reason: "No account delegate. The mint's Permanent Delegate cannot be revoked by holders." };
    }
  }

  const closeOk = (c: Capability) => c.status === "SUPPORTED" || c.status === "PARTIALLY_SUPPORTED";
  const grossReclaimLamports =
    account.lamports && (closeOk(actions.CLOSE) || closeOk(actions.BURN_AND_CLOSE)) ? account.lamports : null;

  const delegation: DelegationInfo = {
    kind: account.delegate ? "ACCOUNT_DELEGATE" : "NONE",
    tokenProgram: account.program,
    delegate: account.delegate,
    delegatedAmountRaw: account.delegatedAmountRaw,
    permanentDelegate: options.mint?.extensions.permanentDelegate ?? null,
    foreignCloseAuthority: account.closeAuthority && account.closeAuthority !== owner ? account.closeAuthority : null,
  };

  return { target: account.address, mint: account.mint, assetClass, delegation, actions, labels: labelsFor(actions), grossReclaimLamports };
}

/** cNFTs are never routed into the SPL burn/close pipeline. */
export function evaluateAssetCleanup(asset: DigitalAsset): CleanupEligibility | null {
  if (!asset.compressed) return null;
  const actions = { ...CAPABILITY_MATRIX.COMPRESSED_NFT };
  return {
    target: asset.id,
    mint: asset.id,
    assetClass: "COMPRESSED_NFT",
    delegation: null,
    actions,
    labels: ["unsupported", "manual_review"],
    grossReclaimLamports: null,
  };
}
