import { computeScore } from "@/lib/security/engine";
import { assessUrl, brandClaimedBy, defang, registrableDomainOf } from "@/lib/security/url-reputation";
import type { DomainAnalysis, DomainStatus, SecurityFinding } from "./types";

/**
 * Domain / origin analysis for a dApp a wallet is about to connect to.
 *
 * Built on the deterministic URL reputation checks (punycode, look-alike
 * brands, shorteners, suspicious TLDs, hidden characters, userinfo tricks,
 * raw IPs) plus connection-specific rules (HTTPS required). No external
 * reputation provider is configured, so:
 *  - a domain with no finding is UNKNOWN, never SAFE;
 *  - a well-known ecosystem domain is LOW ("recognized", identity only).
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host) || host.endsWith(".localhost");
}

function scoreOf(findings: SecurityFinding[]): number | null {
  return findings.length ? computeScore(findings.map((f) => ({ code: f.code, title: f.title, description: f.detail, severity: f.severity, evidenceIds: [f.code] }))) : null;
}

function statusOf(findings: SecurityFinding[], knownDomain: boolean): DomainStatus {
  const order: SecurityFinding["severity"][] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
  for (const s of order) if (findings.some((f) => f.severity === s)) return s;
  return knownDomain ? "LOW" : "UNKNOWN";
}

export function analyzeDomain(raw: string, now: Date = new Date(), opts: { name?: string } = {}): DomainAnalysis {
  const checkedAt = now.toISOString();
  const text = (raw ?? "").trim();
  const invalid = (detail: string): DomainAnalysis => {
    const findings: SecurityFinding[] = [{ code: "DOMAIN_INVALID", severity: "HIGH", title: "Invalid application address", detail }];
    return { domain: "[invalid]", origin: null, valid: false, status: "HIGH", score: scoreOf(findings), findings, reasons: [detail], reputation: "NOT_CONFIGURED", checkedAt };
  };

  if (!text) return invalid("No application address was supplied.");
  if (text.length > 2_048) return invalid("The application address is too long.");

  // A dApp origin must be an explicit http(s) URL — bare words are not guessed into a domain.
  if (!/^https?:\/\//i.test(text)) return invalid("The application address must be a full https:// URL.");

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return invalid("The application address is not a valid URL.");
  }
  const host = url.hostname.toLowerCase();
  if (url.username || url.password) return invalid("The application address hides its real destination behind credentials.");

  // Local development (localhost): not a website reputation question.
  if (isLoopbackHost(host)) {
    const findings: SecurityFinding[] = url.protocol === "https:" ? [] : [{ code: "DOMAIN_LOCAL_DEVELOPMENT", severity: "LOW", title: "Local development address", detail: "Plain http on this computer (localhost) — acceptable only for local development." }];
    return { domain: defang(url.host), origin: url.origin, valid: true, status: statusOf(findings, false), score: scoreOf(findings), findings, reasons: findings.length ? findings.map((f) => `${f.severity}: ${f.title} — ${f.detail}`) : ["Local development address (this computer)."], reputation: "NOT_CONFIGURED", checkedAt };
  }

  const url2 = assessUrl(text);
  if (!url2.valid || !url2.host) {
    const hidden = url2.signals.find((s) => s.code === "URL_HIDDEN_CHARACTERS");
    return invalid(hidden ? hidden.detail : "The application address could not be parsed as a website.");
  }

  const findings: SecurityFinding[] = url2.signals
    .filter((s) => s.code !== "URL_INSECURE_HTTP")
    .map((s) => ({ code: s.code.replace(/^URL_/, "DOMAIN_"), severity: s.severity, title: titleOf(s.code), detail: s.detail }));

  // The name the request gives the application is untrusted: if it claims a known brand, the domain must be that brand's.
  const claimed = opts.name ? brandClaimedBy(opts.name) : null;
  if (claimed && !claimed.domains.includes(registrableDomainOf(host))) {
    findings.push({ code: "DOMAIN_NAME_IMPERSONATION", severity: "MEDIUM", title: `Claims to be "${claimed.token}" on another domain`, detail: `The request names the application after "${claimed.token}", whose known domains are ${claimed.domains.join(", ")} — not this one.` });
  }

  if (url.protocol !== "https:") {
    findings.push({ code: "DOMAIN_NOT_HTTPS", severity: "HIGH", title: "Connection is not encrypted", detail: "The application uses plain http: anyone on the network path can change what it asks your wallet to sign." });
  }

  const status = statusOf(findings, url2.knownDomain);
  const reasons = findings.length
    ? findings.map((f) => `${f.severity}: ${f.title} — ${f.detail}`)
    : url2.knownDomain
      ? ["Recognized ecosystem domain (identity only, not an endorsement). No external reputation service is configured."]
      : ["No phishing pattern matched. Reputation is unknown: no external reputation service is configured, so this is not a safety rating."];

  return {
    domain: defang(host),
    origin: url.origin,
    valid: true,
    status,
    score: scoreOf(findings),
    findings,
    reasons,
    reputation: "NOT_CONFIGURED",
    checkedAt,
  };
}

function titleOf(code: string): string {
  switch (code) {
    case "URL_DANGEROUS_SCHEME": return "Dangerous link type";
    case "URL_USERINFO": return "Disguised destination";
    case "URL_HIDDEN_CHARACTERS": return "Invisible characters";
    case "URL_BRAND_LOOKALIKE": return "Look-alike of a known brand";
    case "URL_BRAND_IMPERSONATION": return "Uses a known brand name on another domain";
    case "URL_PUNYCODE": return "Internationalized (punycode) domain";
    case "URL_IP_HOST": return "Raw IP address";
    case "URL_SHORTENER": return "Link shortener";
    case "URL_SUSPICIOUS_TLD": return "Top-level domain often used by scams";
    case "URL_LURE_WORDING": return "Lure wording";
    case "URL_DEEP_SUBDOMAIN": return "Unusually deep subdomain";
    case "URL_MULTIPLE_RED_FLAGS": return "Several phishing patterns combined";
    default: return code.replace(/^URL_/, "").replaceAll("_", " ").toLowerCase();
  }
}
