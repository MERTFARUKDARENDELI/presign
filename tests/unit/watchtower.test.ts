import { describe, expect, it, vi } from "vitest";
import type { GuardActionInspection, GuardOverview } from "@/lib/guard/types";
import type { InspectResult, MultisigOverview, ProposalInspection, ProposalSummary } from "@/lib/multisig/types";
import { handleMessage, type BotDeps, type IncomingMessage } from "../../watchtower/bot";
import { diffGuard, diffOverview, emptyState, escapeHtml, formatAlert, formatGuardAlert, parseCommand, verifyLink } from "../../watchtower/core";
import { WatchStore } from "../../watchtower/store";

const MS = "2LW6PSEjp81xSEttWwXDB6Etb1eKdhYPbFEojYbyhx88";

const summary = (index: string, status: ProposalSummary["status"], stale = false): ProposalSummary => ({ transactionIndex: index, proposalAddress: `p${index}`, transactionAddress: `t${index}`, status, statusTimestamp: null, approvals: 0, rejections: 0, stale, verdict: null, topSignal: null });

const overview = (proposals: ProposalSummary[], posture = "MEDIUM"): MultisigOverview =>
  ({ multisig: MS, account: null, accountStatus: "OK", vaults: [], posture: { level: posture, signals: [] }, proposals, inspectedLimit: 5, cluster: "mainnet-beta", inspectedAt: "" }) as unknown as MultisigOverview;

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

const GUARD = "GuaRd11111111111111111111111111111111111111";
const guardOverview = (actions: Array<{ index: string; status: string; eta?: string }>): GuardOverview =>
  ({
    programId: "p",
    guard: GUARD,
    guardSigner: "s",
    account: { delaySeconds: 86_400, guardians: ["a", "b"], proposer: "v" },
    posture: { level: "SAFE", signals: [] },
    actions: actions.map((a) => ({ address: `act${a.index}`, index: a.index, status: a.status, scheduledAt: "0", eta: a.eta ?? "2000", memo: "", vetoedBy: null, instructions: 1 })),
    cluster: "devnet",
    inspectedAt: "",
  }) as unknown as GuardOverview;

describe("watchtower guard diff and alerts", () => {
  it("baselines, then alerts new actions and status changes", () => {
    const base = diffGuard(emptyState(), guardOverview([{ index: "0", status: "Executed" }]));
    expect(base.events).toEqual([]);
    const { events, next } = diffGuard(base.next, guardOverview([{ index: "1", status: "Pending" }, { index: "0", status: "Executed" }]));
    expect(events).toEqual([expect.objectContaining({ kind: "guard-action", index: "1", status: "Pending" })]);
    const after = diffGuard(next, guardOverview([{ index: "1", status: "Vetoed" }, { index: "0", status: "Executed" }]));
    expect(after.events).toEqual([expect.objectContaining({ kind: "guard-action-status", index: "1", from: "Pending", to: "Vetoed" })]);
  });

  it("a scheduled-action alert says when it executes, what it changes and where to veto", () => {
    const inspection = { risk: { level: "CRITICAL" }, scheduled: { privileged: [{ programName: "SPL Token", action: "setAuthority(MintTokens)", newAuthority: "H7PiGqqUaanBovwKgEtreJbKmQe6dbq6VTrw6guy7ZgL", control: "outside" }] } } as unknown as GuardActionInspection;
    const a = formatGuardAlert({ kind: "guard-action", guard: GUARD, action: "Act1on1111111111111111111111111111111111111", index: "1", status: "Pending", eta: String(1000 + 5 * 3600), memo: "<b>rotate</b>" }, "https://presign.example", 1000, inspection);
    expect(a.text).toContain("Executes in 5h 0m unless a guardian vetoes.");
    expect(a.text).toContain("setAuthority(MintTokens) → H7Pi…7ZgL (NOT controlled by the multisig or guard)");
    expect(a.text).toContain("Review or veto: https://presign.example/verify?q=Act1on");
    expect(a.html).not.toContain("<b>rotate</b>");
  });
});

describe("watchtower store", () => {
  it("keeps subscriptions, per-target state and offsets", () => {
    const store = new WatchStore(":memory:");
    store.subscribe("chat1", MS, "multisig");
    store.subscribe("chat2", MS, "multisig");
    store.subscribe("chat1", GUARD, "guard");
    expect(store.targets()).toEqual(expect.arrayContaining([{ target: MS, kind: "multisig" }, { target: GUARD, kind: "guard" }]));
    expect(store.chatsFor(MS).sort()).toEqual(["chat1", "chat2"]);
    expect(store.hasBaseline(MS)).toBe(false);
    store.saveTarget(MS, diffOverview(emptyState(), overview([summary("1", "Active")])).next);
    expect(store.hasBaseline(MS)).toBe(true);
    expect(store.state().proposals[MS]).toEqual({ "1": "Active" });
    expect(store.unsubscribe("chat2", MS)).toBe(true);
    expect(store.unsubscribe("chat2", MS)).toBe(false);
    store.setMeta("telegram_offset", "42");
    expect(store.getMeta("telegram_offset")).toBe("42");
    store.close();
  });
});

describe("watchtower bot", () => {
  const multisigResult = { kind: "multisig", overview: overview([summary("2", "Active"), summary("1", "Executed")], "HIGH") } as unknown as InspectResult;
  const msg = (text: string, chatType: IncomingMessage["chatType"] = "group"): IncomingMessage => ({ chat: "-100", chatType, user: "7", text });
  const deps = (over: Partial<BotDeps> = {}): BotDeps => ({ store: new WatchStore(":memory:"), inspect: vi.fn(async () => multisigResult), isAdmin: vi.fn(async () => true), baseUrl: "https://presign.example", now: () => 0, ...over });

  it("parses commands addressed to the bot and ignores chatter", () => {
    expect(parseCommand(`/watch@PresignBot  ${MS}`)).toEqual({ cmd: "watch", arg: MS });
    expect(parseCommand("/watch")).toEqual({ cmd: "help" });
    expect(parseCommand("/list")).toEqual({ cmd: "list" });
    expect(parseCommand("hello /watch x")).toBeNull();
    expect(parseCommand("/unknown")).toBeNull();
  });

  it("only group admins can add watches; the first watch records a baseline without alerts", async () => {
    const d = deps({ isAdmin: vi.fn(async () => false) });
    expect(await handleMessage(msg(`/watch ${MS}`), d)).toMatch(/Only group administrators/);
    expect(d.store.subscriptions("-100")).toEqual([]);
    const admin = deps();
    expect(await handleMessage(msg(`/watch ${MS}`), admin)).toContain("Watching multisig");
    expect(admin.store.subscriptions("-100")).toEqual([{ chat: "-100", target: MS, kind: "multisig" }]);
    expect(diffOverview(admin.store.state(), overview([summary("2", "Active"), summary("1", "Executed")], "HIGH")).events).toEqual([]);
  });

  it("anyone can /check; single proposals cannot be watched", async () => {
    const d = deps({ isAdmin: vi.fn(async () => false) });
    expect(await handleMessage(msg(`/check ${MS}`), d)).toContain("setup <b>HIGH</b>");
    const proposal = deps({ inspect: vi.fn(async () => ({ kind: "proposal" }) as unknown as InspectResult) });
    expect(await handleMessage(msg(`/watch ${MS} #2`, "private"), proposal)).toContain("For a single proposal use /check");
  });

  it("reports inspection errors with the message only", async () => {
    const d = deps({ inspect: vi.fn(async () => { throw new Error("No Squads account was found for this input on devnet."); }) });
    expect(await handleMessage(msg("/check abc", "private"), d)).toBe("Could not inspect that: No Squads account was found for this input on devnet.");
  });
});
