import type { RiskLevel } from "./risk";

/**
 * Deterministic URL reputation from the URL itself (no network, no API key).
 *
 * Only pattern checks run: obfuscation, credential tricks, brand look-alikes,
 * link shorteners and lure wording. An unknown domain with no pattern is
 * "NO_SIGNAL" — its reputation is unknown, it is NOT treated as phishing and
 * NOT as safe. The known-domain list is identity only, never an endorsement.
 *
 * Output is display-safe: hosts are defanged ("example[.]com") and paths or
 * query strings are never echoed, so evidence cannot become a clickable link.
 */

export type UrlSeverity = Exclude<RiskLevel, "SAFE" | "CRITICAL">;

export type UrlSignalCode =
  | "URL_DANGEROUS_SCHEME"
  | "URL_USERINFO"
  | "URL_HIDDEN_CHARACTERS"
  | "URL_BRAND_LOOKALIKE"
  | "URL_BRAND_IMPERSONATION"
  | "URL_PUNYCODE"
  | "URL_IP_HOST"
  | "URL_SHORTENER"
  | "URL_SUSPICIOUS_TLD"
  | "URL_LURE_WORDING"
  | "URL_DEEP_SUBDOMAIN"
  | "URL_INSECURE_HTTP"
  | "URL_MULTIPLE_RED_FLAGS";

export interface UrlSignal {
  code: UrlSignalCode;
  severity: UrlSeverity;
  detail: string;
}

export type UrlVerdict = "LIKELY_PHISHING" | "SUSPICIOUS" | "WEAK_SIGNALS" | "NO_SIGNAL" | "KNOWN_DOMAIN" | "INVALID";

export interface UrlAssessment {
  valid: boolean;
  /** Lower-cased, punycode host (null for invalid URLs / dangerous schemes). */
  host: string | null;
  registrableDomain: string | null;
  /** Defanged host for display, e.g. "jup-claim[.]xyz". Never clickable. */
  displayHost: string;
  knownDomain: boolean;
  signals: UrlSignal[];
  /** Highest signal severity; null when no pattern matched (reputation unknown). */
  level: UrlSeverity | null;
  verdict: UrlVerdict;
  reputation: typeof URL_REPUTATION_CAPABILITY;
}

/**
 * External reputation lookup capability. No keyless, reliable service is
 * integrated, so this is reported as NOT_CONFIGURED instead of pretending a
 * lookup happened.
 */
export const URL_REPUTATION_CAPABILITY = {
  provider: "NONE",
  status: "NOT_CONFIGURED",
  detail: "No external URL reputation service is configured; only deterministic pattern checks ran.",
} as const;

/** Identity of well-known ecosystem domains (not an endorsement). */
const BRANDS: Array<{ token: string; exact: boolean; domains: string[] }> = [
  { token: "phantom", exact: false, domains: ["phantom.app", "phantom.com"] },
  { token: "solflare", exact: false, domains: ["solflare.com"] },
  { token: "backpack", exact: false, domains: ["backpack.app", "backpack.exchange"] },
  { token: "jupiter", exact: false, domains: ["jup.ag", "jupiterexchange.com"] },
  { token: "jup", exact: true, domains: ["jup.ag"] },
  { token: "raydium", exact: false, domains: ["raydium.io"] },
  { token: "orca", exact: true, domains: ["orca.so"] },
  { token: "magiceden", exact: false, domains: ["magiceden.io"] },
  { token: "tensor", exact: false, domains: ["tensor.trade"] },
  // Whole label-part only: on real mainnet metadata, substring matching flagged many
  // ordinary meme-coin sites ("catwifhatsolana.com") as impersonation.
  { token: "solana", exact: true, domains: ["solana.com", "solana.org", "solanabeach.io", "solana.fm"] },
  { token: "solscan", exact: false, domains: ["solscan.io"] },
  { token: "metamask", exact: false, domains: ["metamask.io"] },
  { token: "marinade", exact: false, domains: ["marinade.finance"] },
  { token: "jito", exact: true, domains: ["jito.network", "jito.wtf"] },
  { token: "pump", exact: true, domains: ["pump.fun"] },
  { token: "bonk", exact: true, domains: ["bonkcoin.com"] },
  { token: "drift", exact: true, domains: ["drift.trade"] },
  { token: "helius", exact: false, domains: ["helius.dev", "helius.xyz"] },
];
const KNOWN_DOMAINS = new Set(BRANDS.flatMap((b) => b.domains));

const SHORTENERS = new Set([
  "bit.ly", "tinyurl.com", "t.co", "goo.gl", "is.gd", "cutt.ly", "rebrand.ly", "shorturl.at", "t.ly", "ow.ly", "tiny.cc", "rb.gy", "buff.ly", "s.id", "v.gd",
]);
const SUSPICIOUS_TLDS = new Set(["xyz", "top", "click", "gift", "claim", "claims", "win", "bonus", "pw", "tk", "ml", "ga", "cf", "gq", "zip", "mov", "rest", "cfd", "sbs", "icu", "buzz"]);
const MULTI_PART_SUFFIXES = new Set(["co.uk", "org.uk", "ac.uk", "com.au", "net.au", "co.jp", "com.br", "co.in", "co.kr", "com.tr", "com.cn", "co.nz", "com.mx"]);
const LURE_WORDS = ["claim", "airdrop", "reward", "bonus", "giveaway", "freemint", "free-mint", "connect-wallet", "walletconnect", "verify", "validate", "restore", "recovery", "seed", "private-key", "unlock", "redeem", "voucher"];
const DANGEROUS_SCHEMES = new Set(["javascript:", "data:", "vbscript:", "file:", "blob:"]);
// Zero-width, bidi-override and soft-hyphen characters used to disguise links.
const HIDDEN_CLASS = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/.source;
const HAS_HIDDEN = new RegExp(HIDDEN_CLASS);
const ALL_HIDDEN = new RegExp(HIDDEN_CLASS, "g");
const LOOKALIKE: Record<string, string> = { "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "9": "g", "!": "i", "|": "l" };

export function defang(host: string): string {
  return host.replace(/\./g, "[.]");
}

function registrableOf(labels: string[]): string {
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  return MULTI_PART_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

function unLookalike(s: string): string {
  return [...s].map((ch) => LOOKALIKE[ch] ?? ch).join("").replace(/rn/g, "m").replace(/vv/g, "w");
}

function brandIn(text: string, brand: (typeof BRANDS)[number]): boolean {
  if (!brand.exact) return text.includes(brand.token);
  return text.split(/[.-]/).includes(brand.token);
}

function invalid(displayHost: string): UrlAssessment {
  return { valid: false, host: null, registrableDomain: null, displayHost, knownDomain: false, signals: [], level: null, verdict: "INVALID", reputation: URL_REPUTATION_CAPABILITY };
}

const RANK: Record<UrlSeverity, number> = { LOW: 1, MEDIUM: 2, HIGH: 3 };

export function assessUrl(raw: string): UrlAssessment {
  const signals: UrlSignal[] = [];
  const add = (code: UrlSignalCode, severity: UrlSeverity, detail: string) => {
    if (!signals.some((s) => s.code === code)) signals.push({ code, severity, detail });
  };

  let text = (raw ?? "").slice(0, 2_048).trim();
  if (HAS_HIDDEN.test(text)) add("URL_HIDDEN_CHARACTERS", "HIGH", "Invisible characters inside the link (used to disguise the real address).");
  text = text.replace(ALL_HIDDEN, "").replace(/^[<("'[]+|[>)"'\].,;:!?]+$/g, "");
  if (!text || /\s/.test(text)) return invalid("[invalid link]");

  const scheme = /^([a-z][a-z0-9+.-]*:)/i.exec(text)?.[1]?.toLowerCase() ?? null;
  if (scheme && DANGEROUS_SCHEMES.has(scheme)) {
    add("URL_DANGEROUS_SCHEME", "HIGH", `"${scheme}" link runs code or embeds content instead of opening a website.`);
    return finish({ valid: true, host: null, registrableDomain: null, displayHost: `[${scheme.slice(0, -1)} link]`, knownDomain: false }, signals);
  }

  const explicitScheme = scheme !== null && /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  let url: URL;
  try {
    url = new URL(explicitScheme ? text : `https://${text}`);
  } catch {
    return invalid("[invalid link]");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return invalid("[unsupported link]");

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || (!host.includes(".") && !host.startsWith("["))) return invalid("[invalid link]");

  if (url.username || url.password) add("URL_USERINFO", "HIGH", "Text before \"@\" disguises the real destination host.");
  if (url.protocol === "http:" && explicitScheme) add("URL_INSECURE_HTTP", "LOW", "Unencrypted http link.");

  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[");
  if (isIp) {
    add("URL_IP_HOST", "MEDIUM", "Link points to a raw IP address instead of a domain name.");
    return finish({ valid: true, host, registrableDomain: host, displayHost: defang(host), knownDomain: false }, signals);
  }

  const labels = host.split(".");
  const registrable = registrableOf(labels);
  const tld = labels[labels.length - 1];
  const knownDomain = KNOWN_DOMAINS.has(registrable) || KNOWN_DOMAINS.has(host);
  const subdomainDepth = labels.length - registrable.split(".").length;

  if (labels.some((l) => l.startsWith("xn--"))) add("URL_PUNYCODE", "MEDIUM", "Internationalized (punycode) domain — can imitate familiar names with look-alike letters.");
  if (SHORTENERS.has(registrable)) add("URL_SHORTENER", "MEDIUM", "Link shortener hides the real destination.");
  if (SUSPICIOUS_TLDS.has(tld)) add("URL_SUSPICIOUS_TLD", "LOW", `".${tld}" is a top-level domain frequently used for throwaway scam sites.`);
  if (subdomainDepth >= 3) add("URL_DEEP_SUBDOMAIN", "LOW", "Unusually deep subdomain chain.");

  if (!knownDomain) {
    const hostNoTld = labels.slice(0, -1).join(".");
    const lookalike = unLookalike(hostNoTld);
    for (const b of BRANDS) {
      if (b.domains.includes(registrable)) continue;
      if (brandIn(hostNoTld, b)) {
        add("URL_BRAND_IMPERSONATION", "MEDIUM", `Uses the name "${b.token}" on a domain that is not its known domain.`);
      } else if (lookalike !== hostNoTld && brandIn(lookalike, b)) {
        add("URL_BRAND_LOOKALIKE", "HIGH", `Look-alike spelling of "${b.token}" (character substitution).`);
      }
    }
  }

  const lureText = `${host} ${decodeSafe(url.pathname)} ${decodeSafe(url.search)}`.toLowerCase();
  const lure = LURE_WORDS.filter((w) => lureText.includes(w));
  if (lure.length > 0) add("URL_LURE_WORDING", "LOW", `Lure wording in the link: ${lure.slice(0, 3).join(", ")}.`);

  return finish({ valid: true, host, registrableDomain: registrable, displayHost: defang(host), knownDomain }, signals);
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function finish(base: Pick<UrlAssessment, "valid" | "host" | "registrableDomain" | "displayHost" | "knownDomain">, signals: UrlSignal[]): UrlAssessment {
  // Independent red flags combine: two or more MEDIUM+ patterns, or one MEDIUM+
  // with two weak ones, raise the link to HIGH. A URL alone never reaches CRITICAL.
  const strong = signals.filter((s) => RANK[s.severity] >= RANK.MEDIUM).length;
  const weak = signals.filter((s) => s.severity === "LOW").length;
  if (!signals.some((s) => s.severity === "HIGH") && (strong >= 2 || (strong >= 1 && weak >= 2))) {
    signals.push({ code: "URL_MULTIPLE_RED_FLAGS", severity: "HIGH", detail: "Several independent phishing patterns in one link." });
  }
  const level = signals.reduce<UrlSeverity | null>((acc, s) => (acc === null || RANK[s.severity] > RANK[acc] ? s.severity : acc), null);
  const verdict: UrlVerdict =
    level === "HIGH" ? "LIKELY_PHISHING"
    : level === "MEDIUM" ? "SUSPICIOUS"
    : level === "LOW" ? "WEAK_SIGNALS"
    : base.knownDomain ? "KNOWN_DOMAIN"
    : "NO_SIGNAL";
  return { ...base, signals, level, verdict, reputation: URL_REPUTATION_CAPABILITY };
}

/** Assess every link (URL or bare domain) found in a piece of untrusted text; at most 5. */
export function assessLinksInText(links: string[]): UrlAssessment[] {
  const seen = new Set<string>();
  const out: UrlAssessment[] = [];
  for (const l of links) {
    const a = assessUrl(l);
    const key = a.host ?? a.displayHost;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
    if (out.length >= 5) break;
  }
  return out;
}

/** Highest link level across several assessments (null = no pattern / unknown). */
export function worstUrlLevel(list: UrlAssessment[]): UrlSeverity | null {
  return list.reduce<UrlSeverity | null>((acc, a) => (a.level && (acc === null || RANK[a.level] > RANK[acc]) ? a.level : acc), null);
}

/** Short, display-safe evidence string: defanged host + matched pattern codes. */
export function urlEvidenceText(a: UrlAssessment): string {
  const codes = a.signals.map((s) => s.code.replace(/^URL_/, "")).join(", ");
  return `${a.displayHost}${codes ? ` — ${codes}` : a.knownDomain ? " — known domain (identity only)" : " — no pattern matched (reputation unknown)"}`;
}
