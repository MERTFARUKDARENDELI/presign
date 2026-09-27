import { hasLink, scanText } from "./text-signals";
import { assessLinksInText, urlEvidenceText, worstUrlLevel } from "./url-reputation";

/**
 * Deterministic classification of a wallet-history entry from the data
 * getSignaturesForAddress already returns (status + UNTRUSTED memo). No extra
 * RPC calls. Entries without a signal stay UNCLASSIFIED — that is not "safe";
 * the user can open the full transaction analysis.
 */

export type TimelineEventKind = "PHISHING_MEMO" | "SUSPICIOUS_MEMO" | "FAILED" | "MEMO" | "UNCLASSIFIED";

export interface TimelineEvent {
  kind: TimelineEventKind;
  severity: "HIGH" | "MEDIUM" | "LOW" | null;
  label: string;
  /** Short, display-safe evidence. Never the raw memo, never clickable. */
  evidence: string[];
}

export function classifyTimelineEntry(entry: { failed: boolean; memo: string | null }): TimelineEvent {
  const memo = entry.memo?.replace(/^\[\d+\]\s*/, "") ?? null;
  if (memo) {
    const s = scanText(memo);
    const link = hasLink(s);
    const links = link ? assessLinksInText([...s.urls, ...s.domains]) : [];
    const evidence = [
      // Defanged host + matched URL pattern codes; never the raw memo or path.
      ...links.slice(0, 3).map((a) => `link: ${urlEvidenceText(a)}`),
      ...s.lureKeywords.slice(0, 3).map((k) => `keyword: ${k}`),
      ...(s.promptInjection ? ["instruction-like text aimed at AI tools"] : []),
    ];
    if (s.promptInjection || (link && s.lureKeywords.length > 0) || worstUrlLevel(links) === "HIGH") {
      return { kind: "PHISHING_MEMO", severity: "HIGH", label: "Phishing-pattern memo — do not visit links from it", evidence };
    }
    if (link || s.lureKeywords.length > 0) {
      return { kind: "SUSPICIOUS_MEMO", severity: "MEDIUM", label: link ? "Memo contains a link (unverified)" : "Memo uses lure wording", evidence };
    }
  }
  if (entry.failed) return { kind: "FAILED", severity: "LOW", label: "Transaction failed on-chain", evidence: [] };
  if (memo) return { kind: "MEMO", severity: null, label: "Memo attached", evidence: [] };
  return { kind: "UNCLASSIFIED", severity: null, label: "Not classified — open to analyze", evidence: [] };
}
