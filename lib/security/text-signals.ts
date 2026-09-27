/**
 * Deterministic pattern detection over UNTRUSTED metadata text.
 * Matches are evidence of a scam *pattern*, not proof of a scam; an unknown
 * domain on its own is never treated as phishing.
 */

import { assessUrl, defang } from "./url-reputation";

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const BARE_DOMAIN =
  /\b[a-z0-9][a-z0-9-]{1,62}\.(?:com|io|xyz|app|net|org|site|online|fun|top|gift|live|click|link|pro|me|vip|claims?|so|finance|cc|to|win|bonus|pw|info|us)\b/gi;
const LURE_KEYWORDS = [
  "claim",
  "airdrop",
  "reward",
  "voucher",
  "redeem",
  "eligible",
  "congratulations",
  "congrats",
  "free mint",
  "visit",
  "bonus",
  "giveaway",
  "prize",
  "unclaimed",
  "whitelist",
];
const PROMPT_INJECTION =
  /(ignore (all |any )?(previous|prior|above) (instructions|prompts)|system prompt|you are now|disregard .*instructions|act as|mark (this|it) as safe|return (risk|level) ?(=|:)? ?safe)/i;

export interface TextSignals {
  urls: string[];
  domains: string[];
  lureKeywords: string[];
  promptInjection: boolean;
}

export function scanText(text: string | null | undefined): TextSignals {
  const t = (text ?? "").slice(0, 4_000);
  const lower = t.toLowerCase();
  const urls = [...new Set(t.match(URL_PATTERN) ?? [])].slice(0, 5);
  const domains = [...new Set((t.match(BARE_DOMAIN) ?? []).map((d) => d.toLowerCase()))].slice(0, 5);
  const lureKeywords = LURE_KEYWORDS.filter((k) => lower.includes(k));
  return { urls, domains, lureKeywords, promptInjection: PROMPT_INJECTION.test(t) };
}

export function hasLink(s: TextSignals): boolean {
  return s.urls.length > 0 || s.domains.length > 0;
}

/**
 * Display/AI-safe copy of untrusted text: every link is reduced to its defanged
 * host ("claim-orca[.]info/…"); paths and query strings are dropped, so the text
 * can never become a clickable link or carry tracking parameters.
 */
export function defangLinks(text: string): string {
  return text
    .replace(URL_PATTERN, (m) => {
      const a = assessUrl(m);
      if (!a.valid || !a.host) return "[link]";
      const rest = m.replace(/^(?:[a-z]+:\/\/)?[^/?#]+/i, ""); // path/query/fragment after the host
      return rest.length > 1 ? `${a.displayHost}/…` : a.displayHost;
    })
    .replace(BARE_DOMAIN, (d) => defang(d));
}
