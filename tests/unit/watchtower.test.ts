import { describe, expect, it } from "vitest";
import type { MultisigOverview, ProposalInspection, ProposalSummary } from "@/lib/multisig/types";
import { diffOverview, emptyState, escapeHtml, formatAlert, verifyLink } from "../../watchtower/core";

const MS = "2LW6PSEjp81xSEttWwXDB6Etb1eKdhYPbFEojYbyhx88";

const summary = (index: string, status: ProposalSummary["status"], stale = false): ProposalSummary => ({ transactionIndex: index, proposalAddress: `p${index}`, transactionAddress: `t${index}`, status, statusTimestamp: null, approvals: 0, rejections: 0, stale, verdict: null, topSignal: null });

const overview = (proposals: ProposalSummary[], posture = "MEDIUM"): MultisigOverview =>
  ({ multisig: MS, account: null, accountStatus: "OK", vaults: [], posture: { level: posture }, proposals, inspectedLimit: 5, cluster: "mainnet-beta", inspectedAt: "" }) as unknown as MultisigOverview;

describe("watchtower diff", () => {
  it("records a baseline on first sight without alerting", () => {
    const { events, next } = diffOverview(emptyState(), overview([summary("2", "Active"), summary("1", "Executed")]));
    expect(events).toEqual([]);
    expect(next.proposals[MS]).toEqual({ "2": "Active", "1": "Executed" });
  });

  it("can alert proposals that are already pending at start (not stale ones)", () => {
    const { events } = diffOverview(emptyState(), overview([summary("3", "Active", true), summary("2", "Approved"), summary("1", "Executed")]), true);
    expect(events).toEqual([{ kind: "new-proposal", multisig: MS, index: "2", status: "Approved" }]);
  });

  it("alerts new proposals, meaningful status changes and setup changes", () => {
    const base = diffOverview(emptyState(), overview([summary("2", "Active"), summary("1", "Active")])).next;
    const { events } = diffOverview(base, overview([summary("3", "Draft"), summary("2", "Approved"), summary("1", "Active"), summary("0", "NOT_FOUND")], "HIGH"));
    expect(events).toEqual([
      { kind: "new-proposal", multisig: MS, index: "3", status: "Draft" },
      { kind: "status-change", multisig: MS, index: "2", from: "Active", to: "Approved" },
      { kind: "posture-change", multisig: MS, from: "MEDIUM", to: "HIGH" },
    ]);
  });

  it("does not alert Draft → Active", () => {
    const base = diffOverview(emptyState(), overview([summary("1", "Draft")])).next;
    expect(diffOverview(base, overview([summary("1", "Active")])).events).toEqual([]);
  });
});

describe("watchtower alerts", () => {
  const inspection = {
    risk: { level: "CRITICAL", status: "PARTIAL", signals: [{ severity: "CRITICAL", title: "Admin moves outside the multisig" }, { severity: "HIGH", title: "No time lock" }] },
    analysis: { payloads: [{ privileged: [{ programName: "Drift Protocol v2", action: "updateAdmin", newAuthority: "H7PiGqqUaanBovwKgEtreJbKmQe6dbq6VTrw6guy7ZgL", control: "outside" }] }] },
  } as unknown as ProposalInspection;

  it("summarizes a new proposal with its verdict, authority changes and a verify link", () => {
    const a = formatAlert({ kind: "new-proposal", multisig: MS, index: "7", status: "Active" }, "https://presign.example/", inspection);
    expect(a.text).toContain("🛑 New proposal #7 on multisig 2LW6…hx88 — CRITICAL");
    expect(a.text).toContain("Drift Protocol v2 updateAdmin → H7Pi…7ZgL (NOT controlled by the multisig)");
    expect(a.text).toContain("Analysis PARTIAL");
    expect(a.text).toContain(verifyLink("https://presign.example", MS, "7"));
    expect(a.html).toContain("<b>CRITICAL</b>");
  });

  it("never presents an uninspected proposal as fine", () => {
    const a = formatAlert({ kind: "new-proposal", multisig: MS, index: "8", status: "Active" }, "http://localhost:3000", null);
    expect(a.text).toContain("UNKNOWN");
    expect(a.text).toContain("could not be inspected");
  });

  it("escapes untrusted text in Telegram HTML", () => {
    expect(escapeHtml("<b>&")).toBe("&lt;b&gt;&amp;");
    const hostile = { ...inspection, risk: { ...inspection.risk, signals: [{ severity: "HIGH", title: "<script>x</script>" }] } } as unknown as ProposalInspection;
    expect(formatAlert({ kind: "new-proposal", multisig: MS, index: "9", status: "Active" }, "http://x", hostile).html).not.toContain("<script>");
  });
});
