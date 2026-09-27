import { PublicKey } from "@solana/web3.js";

/**
 * Parses what a signer pastes to inspect a multisig: a Squads app link, a
 * proposal / transaction / multisig address, or "<multisig> #<index>".
 * Only well-formed 32-byte addresses and plain integers are extracted; the
 * account type is decided later from the chain, never from the text.
 */

export type InspectInput = { kind: "ok"; addresses: string[]; index: string | null } | { kind: "invalid"; reason: string };

const BASE58 = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
const MAX_INPUT = 500;

function isAddress(s: string): boolean {
  try {
    return new PublicKey(s).toBytes().length === 32 && new PublicKey(s).toBase58() === s;
  } catch {
    return false;
  }
}

export function parseInspectInput(raw: string): InspectInput {
  const text = raw.trim();
  if (!text) return { kind: "invalid", reason: "Paste a Squads link, a proposal or multisig address, or \"<multisig> #<index>\"." };
  if (text.length > MAX_INPUT) return { kind: "invalid", reason: "Input is too long." };

  // Numbers in a link's path win over its query string (e.g. /transactions/12?page=1).
  let parts: string[];
  let extra: string[] = [];
  if (/^https?:\/\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
      parts = url.pathname.split("/").map(decodeURIComponent);
      extra = [...url.searchParams.values(), decodeURIComponent(url.hash.replace(/^#/, ""))];
    } catch {
      return { kind: "invalid", reason: "This link could not be parsed." };
    }
  } else {
    parts = text.split(/[\s/#:,?=&]+/);
  }

  const addresses = [...new Set([...parts, ...extra].flatMap((p) => p.match(BASE58) ?? []).filter(isAddress))].slice(0, 3);
  const numbers = parts.filter((p) => /^\d{1,19}$/.test(p));
  const extraNumbers = extra.filter((p) => /^\d{1,19}$/.test(p));
  if (addresses.length === 0) return { kind: "invalid", reason: "No Solana address found in the input." };
  const index = numbers.length ? numbers[numbers.length - 1] : extraNumbers.length ? extraNumbers[extraNumbers.length - 1] : null;
  if (index !== null && BigInt(index) === 0n) return { kind: "invalid", reason: "Proposal numbers start at 1." };
  return { kind: "ok", addresses, index };
}
