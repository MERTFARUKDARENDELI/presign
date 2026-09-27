import { defangLinks, scanText } from "@/lib/security/text-signals";

/**
 * Data sanitization for the AI layer.
 *  - Drops raw bytes / hex / huge logs that add tokens but no evidence.
 *  - Wraps creator/provider text (names, descriptions, memos, logs) as
 *    UNTRUSTED so the model treats it as data, never as instructions.
 *  - Keeps evidence ids, levels, statuses and amounts intact so explanations
 *    stay traceable to deterministic results.
 *  - Optionally replaces the user's wallet with a stable placeholder.
 */

const DROP_KEYS = new Set(["data", "raw", "bytes", "transaction", "image", "logsTruncated", "extensions", "rentEpoch"]);
const UNTRUSTED_KEYS = new Set(["name", "symbol", "description", "memo", "uri", "jsonUri", "externalUrl"]);
const MAX_STRING = 300;
const MAX_ARRAY = 25;
const MAX_LOGS = 8;

export interface UntrustedText {
  untrusted: string;
  containsInstructionLikeText?: true;
}

// Control chars plus zero-width and bidi-override characters used to hide instructions.
const HIDDEN_RANGES: Array<[number, number]> = [
  [0x00, 0x1f],
  [0x7f, 0x7f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];
const HIDDEN_CHARS = new RegExp(
  `[${HIDDEN_RANGES.map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join("")}]`,
  "g",
);

function cleanText(s: string): string {
  return s.replace(HIDDEN_CHARS, " ").slice(0, MAX_STRING);
}

export function wrapUntrusted(s: string): UntrustedText {
  const cleaned = cleanText(s);
  // Links reach the model only as defanged hosts, so it cannot echo a clickable phishing URL.
  const safe = defangLinks(cleaned);
  return scanText(cleaned).promptInjection
    ? { untrusted: safe, containsInstructionLikeText: true }
    : { untrusted: safe };
}

export interface SanitizeOptions {
  maskWallet?: string;
}

export function sanitizeForAi(value: unknown, options: SanitizeOptions = {}, key = "", depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    let s = value;
    if (options.maskWallet && s.includes(options.maskWallet)) s = s.split(options.maskWallet).join("<YOUR_WALLET>");
    if (key === "logs") return cleanText(s);
    if (UNTRUSTED_KEYS.has(key)) return wrapUntrusted(s);
    return cleanText(s);
  }
  if (typeof value !== "object") return value;
  if (value instanceof Uint8Array) return `[${value.length} bytes omitted]`;

  if (Array.isArray(value)) {
    const limit = key === "logs" ? MAX_LOGS : MAX_ARRAY;
    const items = value.slice(0, limit).map((v) => sanitizeForAi(v, options, key, depth + 1));
    if (value.length > limit) items.push(`[${value.length - limit} more omitted]`);
    return items;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (DROP_KEYS.has(k)) continue;
    out[k] = sanitizeForAi(v, options, k, depth + 1);
  }
  return out;
}

/** Hard cap on context size; returns JSON string. */
export function toAiContext(value: unknown, options: SanitizeOptions = {}, maxChars = 14_000): string {
  const json = JSON.stringify(sanitizeForAi(value, options));
  return json.length <= maxChars ? json : `${json.slice(0, maxChars)}…[context truncated]`;
}

/** Collect every evidence id present in (sanitized or raw) tool output. */
export function collectEvidenceIds(value: unknown, into = new Set<string>(), depth = 0): Set<string> {
  if (depth > 10 || value === null || typeof value !== "object") return into;
  if (Array.isArray(value)) {
    value.forEach((v) => collectEvidenceIds(v, into, depth + 1));
    return into;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.id === "string" && "source" in obj && "observed" in obj) into.add(obj.id);
  Object.values(obj).forEach((v) => collectEvidenceIds(v, into, depth + 1));
  return into;
}

const CITATION = /\[ev:([^\]\s]{1,160})\]/g;

/**
 * Evidence contract enforcement: citations must reference evidence that a
 * deterministic tool actually returned. Unknown citations are removed and
 * reported so the UI can warn.
 */
export function enforceEvidenceContract(text: string, known: Set<string>): { text: string; cited: string[]; invalid: string[] } {
  const cited: string[] = [];
  const invalid: string[] = [];
  const cleaned = text.replace(CITATION, (_m, id: string) => {
    if (known.has(id)) {
      cited.push(id);
      return `[ev:${id}]`;
    }
    invalid.push(id);
    return "";
  });
  return { text: cleaned, cited: [...new Set(cited)], invalid: [...new Set(invalid)] };
}
