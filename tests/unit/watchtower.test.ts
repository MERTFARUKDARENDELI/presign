import { describe, expect, it, vi } from "vitest";
import type { GuardActionInspection, GuardOverview } from "@/lib/guard/types";
import type { InspectResult, MultisigOverview, ProposalInspection, ProposalSummary } from "@/lib/multisig/types";
import { handleMessage, type BotDeps, type IncomingMessage } from "../../watchtower/bot";
import { diffGuard, diffOverview, emptyState, escapeHtml, formatAlert, formatGuardAlert, parseCommand, verifyLink } from "../../watchtower/core";
import { createRateLimiter, cycleTargets, LIMITS, runLimited } from "../../watchtower/limits";
import { ENV_CHAT, WatchStore } from "../../watchtower/store";

const MS = "2LW6PSEjp81xSEttWwXDB6Etb1eKdhYPbFEojYbyhx88";

const summary = (index: string, status: ProposalSummary["status"], stale = false): ProposalSummary => ({ transactionIndex: index, proposalAddress: `p${index}`, transactionAddress: `t${index}`, status, statusTimestamp: null, approvals: 0, rejections: 0, stale, verdict: null, topSignal: null, signedInAdvance: null });

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

  it("states the team policy outcome", () => {
    const policy = { name: "Council", severity: "HIGH", status: "violation", checks: [{ rule: "requireGuardFor", label: "Critical actions go through Presign Guard", status: "violation", findings: [] }, { rule: "minThreshold", label: "Minimum threshold", status: "pass", findings: [] }] };
    const a = formatAlert({ kind: "new-proposal", multisig: MS, index: "7", status: "Active" }, "http://x", { ...inspection, policy } as unknown as ProposalInspection);
    expect(a.text).toContain('Team policy "Council": BROKEN — Critical actions go through Presign Guard');
    expect(a.html).toContain("<b>BROKEN</b>");
    const ok = formatAlert({ kind: "new-proposal", multisig: MS, index: "7", status: "Active" }, "http://x", { ...inspection, policy: { ...policy, status: "compliant", checks: [] } } as unknown as ProposalInspection);
    expect(ok.text).toContain('Team policy "Council": complies');
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
  const deps = (over: Partial<BotDeps> = {}): BotDeps => ({ store: new WatchStore(":memory:"), inspect: vi.fn(async () => multisigResult), isAdmin: vi.fn(async () => true), baseUrl: "https://presign.example", now: () => 0, limiter: createRateLimiter(), ...over });

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

describe("watchtower: votes signed through a durable nonce", () => {
  const voted = (index: string, status: ProposalSummary["status"], signedInAdvance: number | null): ProposalSummary => ({ ...summary(index, status), signedInAdvance });

  it("alerts when a watched pending proposal gains a vote that landed inside a durable nonce", () => {
    const base = diffOverview(emptyState(), overview([voted("2", "Active", 0)])).next;
    expect(base.nonceVotes[MS]).toEqual({ "2": 0 });
    const { events, next } = diffOverview(base, overview([voted("2", "Active", 1)]));
    expect(events).toEqual([{ kind: "nonce-vote", multisig: MS, index: "2", count: 1 }]);
    // Seen once, not again; an unreadable history (null) keeps the last count instead of resetting it.
    expect(diffOverview(next, overview([voted("2", "Active", 1)])).events).toEqual([]);
    const unread = diffOverview(next, overview([voted("2", "Active", null)]));
    expect(unread.events).toEqual([]);
    expect(unread.next.nonceVotes[MS]).toEqual({ "2": 1 });
  });

  it("leaves a new proposal's nonce votes to its new-proposal alert, and records the first sight silently", () => {
    const base = diffOverview(emptyState(), overview([voted("1", "Executed", 0)])).next;
    expect(diffOverview(base, overview([voted("2", "Active", 2), voted("1", "Executed", 0)])).events).toEqual([{ kind: "new-proposal", multisig: MS, index: "2", status: "Active" }]);
    expect(diffOverview(emptyState(), overview([voted("3", "Active", 1)])).events).toEqual([]);
  });

  it("persists the counts next to proposal statuses", () => {
    const store = new WatchStore(":memory:");
    store.saveTarget(MS, diffOverview(emptyState(), overview([voted("4", "Active", 2)])).next);
    expect(store.state().proposals[MS]).toEqual({ "4": "Active" });
    expect(store.state().nonceVotes[MS]).toEqual({ "4": 2 });
    store.close();
  });

  it("tells every signer to confirm with the member, with a link to verify", () => {
    const a = formatAlert({ kind: "nonce-vote", multisig: MS, index: "7", count: 2 }, "https://presign.example");
    expect(a.text).toContain("Proposal #7 of multisig 2LW6…hx88: a vote landed through a durable nonce (2 so far)");
    expect(a.text).toContain("Confirm with the member directly");
    expect(a.html).toContain("<b>durable nonce</b>");
    expect(a.text).toContain(verifyLink("https://presign.example", MS, "7"));
  });
});

describe("watchtower limits: one chat or one person cannot slow everyone's alerts", () => {
  const multisigAt = (address: string) => ({ kind: "multisig", overview: { ...(overview([]) as unknown as Record<string, unknown>), multisig: address } }) as unknown as InspectResult;
  const at = (n: number) => `Target-${n}`;
  const msg = (text: string, user = "7", chat = "-100"): IncomingMessage => ({ chat, chatType: "private", user, text });
  const deps = (over: Partial<BotDeps> = {}): BotDeps => {
    let n = 0;
    return { store: new WatchStore(":memory:"), inspect: vi.fn(async () => multisigAt(at(++n))), isAdmin: vi.fn(async () => true), baseUrl: "https://presign.example", now: () => 0, limiter: createRateLimiter(1_000, 1_000), ...over };
  };

  it(`a chat watches at most ${LIMITS.perChat} targets; the next /watch is refused before any inspection`, async () => {
    const d = deps();
    for (let i = 0; i < LIMITS.perChat; i++) expect(await handleMessage(msg(`/watch x${i}`), d)).toContain("Watching multisig");
    expect(await handleMessage(msg("/watch one-more"), d)).toMatch(new RegExp(`already watches ${LIMITS.perChat} targets`));
    expect(d.inspect).toHaveBeenCalledTimes(LIMITS.perChat);
    expect(d.store.countForChat("-100")).toBe(LIMITS.perChat);
    expect(await handleMessage(msg(`/unwatch ${at(1)}`), d)).toContain("Stopped watching");
    expect(await handleMessage(msg("/watch again"), d)).toContain("Watching multisig");
  });

  it(`at most ${LIMITS.botTargets} distinct targets through the bot; one already watched can still be added, and the environment's do not count`, async () => {
    const d = deps({ inspect: vi.fn(async (input: string) => multisigAt(input)) });
    for (let i = 0; i < LIMITS.botTargets; i++) d.store.subscribe(`chat${i % 40}`, at(i), "multisig");
    d.store.subscribe(ENV_CHAT, "EnvTarget1111111111111111111111111111111111", "multisig");
    expect(d.store.botTargetCount()).toBe(LIMITS.botTargets);
    expect(await handleMessage(msg("/watch Brand-new-target"), d)).toMatch(/as many targets as it can/);
    expect(d.store.isWatched("Brand-new-target")).toBe(false);
    // Already polled for someone else: no extra work, so it can be added.
    expect(await handleMessage(msg(`/watch ${at(3)}`), d)).toContain("Watching multisig");
    // Also watched by the environment: no extra work either.
    expect(await handleMessage(msg("/watch EnvTarget1111111111111111111111111111111111"), d)).toContain("Watching multisig");
  });

  it(`a person gets ${LIMITS.perUserPerMinute} inspections a minute and everyone together ${LIMITS.allPerMinute}; reading what a chat watches is never limited`, async () => {
    let now = 1_000;
    const d = deps({ now: () => now, limiter: createRateLimiter() });
    for (let i = 0; i < LIMITS.perUserPerMinute; i++) expect(await handleMessage(msg(`/check x${i}`), d)).toContain("setup");
    expect(await handleMessage(msg("/check again"), d)).toMatch(new RegExp(`${LIMITS.perUserPerMinute} checks in the last minute`));
    expect(await handleMessage(msg("/watch again"), d)).toMatch(/checks in the last minute/);
    expect(d.inspect).toHaveBeenCalledTimes(LIMITS.perUserPerMinute);
    expect(await handleMessage(msg("/list"), d)).toMatch(/watches nothing yet/);
    expect(await handleMessage(msg("/check other-user", "8"), d)).toContain("setup");
    now += 61;
    expect(await handleMessage(msg("/check after-a-minute"), d)).toContain("setup");

    const busy = deps({ now: () => now, limiter: createRateLimiter() });
    for (let i = 0; i < LIMITS.allPerMinute; i++) expect(await handleMessage(msg(`/check x${i}`, `user${i}`), busy)).toContain("setup");
    expect(await handleMessage(msg("/check one-more", "fresh-user"), busy)).toBe("Watchtower is busy. Try again in a minute.");
  });

  it("with 1,000 subscribed targets every cycle polls the environment's target first, stays bounded, runs at most 4 at once, and gives every target its turn", async () => {
    const store = new WatchStore(":memory:");
    for (let i = 0; i < 1_000; i++) store.subscribe(`chat${i % 50}`, at(i), "multisig");
    const ENV_TARGET = "EnvTarget1111111111111111111111111111111111";
    store.subscribe(ENV_CHAT, ENV_TARGET, "guard");
    const polled = new Map<string, number>();
    let active = 0;
    let maxActive = 0;
    let cursor = 0;
    const cycles = Math.ceil(1_000 / LIMITS.botPerCycle);
    for (let c = 0; c < cycles; c++) {
      const { batch, nextCursor } = cycleTargets(store.pollTargets(), cursor);
      cursor = nextCursor;
      expect(batch[0]).toEqual({ target: ENV_TARGET, kind: "guard", env: true });
      expect(batch).toHaveLength(1 + LIMITS.botPerCycle);
      const order: string[] = [];
      await runLimited(batch, LIMITS.concurrency, async (t) => {
        order.push(t.target);
        maxActive = Math.max(maxActive, ++active);
        await new Promise((r) => setImmediate(r));
        active--;
        if (!t.env) polled.set(t.target, (polled.get(t.target) ?? 0) + 1);
      });
      expect(order[0]).toBe(ENV_TARGET);
    }
    expect(maxActive).toBe(LIMITS.concurrency);
    expect(polled.size).toBe(1_000);
    expect([...polled.values()].every((n) => n === 1)).toBe(true);
    store.close();
  });

  it("a failing poll is reported and does not stop the rest of the cycle", async () => {
    const done: string[] = [];
    const failed: string[] = [];
    await runLimited(["a", "b", "c"], 2, async (t) => {
      if (t === "b") throw new Error("RPC down");
      done.push(t);
    }, (t) => failed.push(t));
    expect(done.sort()).toEqual(["a", "c"]);
    expect(failed).toEqual(["b"]);
  });
});
