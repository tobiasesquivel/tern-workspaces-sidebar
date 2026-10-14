// runtime/state.test.mjs — behavioral contract tests for RuntimeState.
// Owner: RuntimeCore. Run: node --test runtime/state.test.mjs
// Parent runs suites after integration; no execution mid-flight by policy.
// These tests assert the arbitration contract, not wiring: seq/epoch rules,
// identity, done/focus semantics, blocked prevalence, release, discovery
// retention, startup grace, pane ids > 2^32, fresh-boot generation change,
// revision rule (every public-field mutation advances _seq), snapshot_at
// heartbeat, enrichFromDiscovery, union sweep scope.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RuntimeState, RuntimeError } from "./state.mjs";

const R = (pane_id, launch_id, extra = {}) => ({
  v: 1,
  pane_id,
  launch_id,
  source: "tern:omp",
  agent: "omp",
  session_epoch: 0,
  ...extra,
});

describe("claim", () => {
  it("reserves a pending identity, never done on initial idle", () => {
    const s = new RuntimeState();
    const a = s.claim({ pane_id: 7, agent: "omp", name: "alpha" });
    assert.equal(a.agent_status, "idle");
    assert.equal(a.launch_pending, true);
    assert.equal(a.completion_seq, null);
    assert.equal(a.name, "alpha");
    // Public stable number for the prompt startup activity gate.
    assert.equal(typeof a.state_change_seq, "number");
    assert.ok(a.state_change_seq > 0);
  });
  it("rejects duplicate names and busy panes", () => {
    const s = new RuntimeState();
    s.claim({ pane_id: 7, agent: "omp", name: "alpha" });
    assert.throws(() => s.claim({ pane_id: 8, agent: "omp", name: "alpha" }), (e) => e.code === "agent_name_taken");
    assert.throws(() => s.claim({ pane_id: 7, agent: "claude" }), (e) => e.code === "agent_busy");
    assert.throws(() => s.claim({ pane_id: 8, agent: "omp", name: "BAD" }), (e) => e.code === "invalid_agent_name");
  });
  it("same pane_id+launch_id+agent is idempotent (start pre-claim, wrapper re-claims)", () => {
    const s = new RuntimeState();
    const first = s.claim({ pane_id: 7, agent: "omp", name: "w1", launch_id: "Lx" });
    const before = s.seq;
    const second = s.claim({ pane_id: 7, agent: "omp", name: "w1", launch_id: "Lx" });
    assert.deepEqual(second, first);
    assert.equal(s.seq, before); // no revision: nothing changed
  });
  it("same launch_id, different agent is busy (no silent takeover)", () => {
    const s = new RuntimeState();
    s.claim({ pane_id: 7, agent: "omp", launch_id: "Lx" });
    assert.throws(() => s.claim({ pane_id: 7, agent: "claude", launch_id: "Lx" }), (e) => e.code === "agent_busy");
  });
  it("supports pane ids above 2^32 without truncation", () => {
    const s = new RuntimeState();
    const pane = 4294967299;
    const a = s.claim({ pane_id: pane, agent: "codex" });
    assert.equal(a.pane_id, pane);
    assert.equal(s.get(pane).pane_id, pane);
  });
});

describe("report seq + identity", () => {
  it("plain report on an empty pane is discarded (identity comes from claim/session_start)", () => {
    const s = new RuntimeState();
    const r = s.report(R(1, "L1", { state: "working", seq: 1 }));
    assert.equal(r.accepted, false);
    assert.equal(r.reason, "no-occupant");
    assert.throws(() => s.get(1), (e) => e.code === "agent_not_found");
  });
  it("a Claude hook never sets the state or readiness: the screen does (herdr)", () => {
    const s = new RuntimeState();
    const c = s.claim({ pane_id: 1, agent: "claude", name: "probe" });
    assert.equal(c.agent_status, "unknown");
    const r = s.report({ v: 1, pane_id: 1, launch_id: c.terminal_id, source: "tern:claude", agent: "claude", state: "idle", seq: 1, ready: true });
    assert.equal(r.accepted, true);
    const a = s.get(1);
    assert.equal(a.agent_status, "unknown");
    assert.equal(a.launch_pending, true);
    assert.equal(a.interactive_ready, false);
  });
  it("accepts increasing seq, rejects stale", () => {
    const s = new RuntimeState();
    s.claim({ pane_id: 1, agent: "omp", launch_id: "L1" });
    assert.equal(s.report(R(1, "L1", { state: "working", seq: 1 })).accepted, true);
    assert.equal(s.report(R(1, "L1", { state: "working", seq: 1 })).accepted, false);
    assert.equal(s.report(R(1, "L1", { state: "idle", seq: 2 })).accepted, true);
  });
  it("rejects source/agent mismatch and unknown states", () => {
    const s = new RuntimeState();
    assert.equal(s.report(R(1, "L1", { source: "tern:claude", seq: 1 })).accepted, false);
    assert.equal(s.report(R(1, "L1", { state: "bogus", seq: 1 })).accepted, false);
    assert.equal(s.report(R(1, "L1", { state: "working", seq: 0 })).accepted, false);
  });
  it("released launch_id never revives, even with session_start=true", () => {
    const s = new RuntimeState();
    s.claim({ pane_id: 1, agent: "omp", launch_id: "L1" });
    s.report(R(1, "L1", { state: "working", seq: 3 }));
    s.release({ pane_id: 1, launch_id: "L1" });
    const r = s.report(R(1, "L1", { state: "working", seq: 4, session_start: true }));
    assert.equal(r.accepted, false);
    assert.equal(r.reason, "stale-session");
  });
  it("switching occupant on a busy pane needs session_start", () => {
    const s = new RuntimeState();
    s.claim({ pane_id: 1, agent: "omp", launch_id: "L1" });
    s.report(R(1, "L1", { state: "working", seq: 1 }));
    assert.equal(s.report(R(1, "L2", { state: "working", seq: 1 })).reason, "pane-busy");
    assert.equal(s.report(R(1, "L2", { state: "working", seq: 1, session_start: true })).accepted, true);
  });
  it("session ref change needs a bigger epoch without session_start", () => {
    const s = new RuntimeState();
    s.claim({ pane_id: 1, agent: "omp", launch_id: "L1" });
    const sess = (v) => ({ kind: "id", value: v });
    s.report(R(1, "L1", { state: "working", seq: 1, session: sess("a"), session_epoch: 1, session_start: true }));
    const r = s.report(R(1, "L1", { state: "working", seq: 2, session: sess("b"), session_epoch: 1 }));
    assert.equal(r.accepted, false);
    assert.equal(r.reason, "stale-session");
    assert.equal(s.report(R(1, "L1", { state: "working", seq: 3, session: sess("b"), session_epoch: 2 })).accepted, true);
  });
  it("a report that names no session keeps the current one (claude/codex hooks)", () => {
    // Measured with claude 2.1.296: only SessionStart carries the session, so every
    // UserPromptSubmit/Stop after it was dropped as stale-session and a real turn
    // never left idle. Old-session reports are still told apart by their epoch.
    const s = new RuntimeState();
    s.claim({ pane_id: 1, agent: "codex", launch_id: "L1" });
    const C = (extra) => R(1, "L1", { source: "tern:codex", agent: "codex", ...extra });
    s.report(C({ state: "unknown", seq: 1, session: { kind: "id", value: "a" }, session_epoch: 0, session_start: true }));
    const r = s.report(C({ state: "working", seq: 2, session_epoch: 0 }));
    assert.equal(r.accepted, true);
    assert.equal(r.agent.agent_status, "working");
    assert.equal(s.get(1).agent_session.value, "a");
    assert.equal(s.report(C({ state: "idle", seq: 3, session_epoch: 1 })).reason, "stale-epoch");
  });
});

describe("done / seen / focus", () => {
  it("working->idle in background is done with completion_seq; reads never mark seen", () => {
    const s = new RuntimeState();
    s.claim({ pane_id: 9, agent: "omp", launch_id: "L1" });
    s.report(R(9, "L1", { state: "working", seq: 1 }));
    const done = s.report(R(9, "L1", { state: "idle", seq: 2 })).agent;
    assert.equal(done.agent_status, "done");
    assert.ok(done.completion_seq !== null);
    s.list();
    s.get(9);
    s.snapshot();
    assert.equal(s.get(9).agent_status, "done");
  });
  it("working->idle on the focused pane is plain idle", () => {
    const s = new RuntimeState();
    s.claim({ pane_id: 9, agent: "omp", launch_id: "L1" });
    s.report(R(9, "L1", { state: "working", seq: 1 }));
    s.observe({ v: 1, agents: [], panes: [], focused_pane: 9, focused_tab: 3 });
    const a = s.report(R(9, "L1", { state: "idle", seq: 2 })).agent;
    assert.equal(a.agent_status, "idle");
  });
  it("explicit focus on pane or whole tab marks done seen AND bumps revision", () => {
    const s = new RuntimeState();
    s.claim({ pane_id: 9, agent: "omp", launch_id: "L1" });
    s.claim({ pane_id: 10, agent: "omp", launch_id: "L2" });
    s.report(R(9, "L1", { state: "working", seq: 1 }));
    s.report(R(9, "L1", { state: "idle", seq: 2 }));
    const before = s.seq;
    s.observe({ v: 1, agents: [], panes: [{ pane: 9, tab: 3 }], focused_pane: 9, focused_tab: 3 });
    assert.equal(s.get(9).agent_status, "idle");
    assert.ok(s.seq > before); // seen flip ships in the next snapshot
    // tab-level focus marks every done pane of the tab seen (herdr parity)
    s.report(R(10, "L2", { state: "working", seq: 1 }));
    s.report(R(10, "L2", { state: "idle", seq: 2 }));
    s.observe({ v: 1, agents: [], panes: [{ pane: 10, tab: 5 }], focused_pane: 999, focused_tab: 5 });
  });
  it("focus-less discovery ticks preserve focus: focused completion stays idle", () => {
    const s = new RuntimeState();
    s.claim({ pane_id: 9, agent: "omp", launch_id: "L1" });
    s.report(R(9, "L1", { state: "working", seq: 1 }));
    // Plugin stream owns focus keys: user is looking at pane 9.
    s.observe({ v: 1, agents: [], panes: [{ pane: 9, tab: 3 }], focused_pane: 9, focused_tab: 3 });
    // Discovery probe carries NO focus keys: must not clear focus.
    s.observe({ v: 1, generation: "tern-discovery", agents: [], panes: [] });
    assert.equal(s.get(9).focused, true);
    const done = s.report(R(9, "L1", { state: "idle", seq: 2 })).agent;
    assert.equal(done.agent_status, "idle"); // focused => seen => never done
  });
  it("initial native idle is never done", () => {
    const s = new RuntimeState();
    s.observe({ v: 1, agents: [{ pane: 4, agent: "omp", state: "idle" }], panes: [{ pane: 4, alert: true }] });
    const a = s.get(4);
    assert.equal(a.agent_status, "idle");
  });
  it("blocked prevails while the connector lives; turn errors keep failed badge", () => {
    const s = new RuntimeState();
    s.claim({ pane_id: 2, agent: "omp", launch_id: "L1" });
    s.report(R(2, "L1", { state: "working", seq: 1 }));
    s.report(R(2, "L1", { state: "blocked", seq: 2, message: "need approval" }));
    s.observe({
      v: 1,
      agents: [{ pane: 2, agent: "omp", state: "idle" }],
      panes: [{ pane: 2 }],
      focused_pane: 2,
    });
    const a = s.get(2);
    assert.equal(a.agent_status, "blocked");
    assert.equal(a.message, "need approval");
    const b = s.report(R(2, "L1", { state: "idle", seq: 3, failed: true })).agent;
    assert.equal(b.failed, true);
  });
  it("resolved blocker clears its message: working/idle without message show no stale label", () => {
    const s = new RuntimeState();
    s.claim({ pane_id: 5, agent: "omp", launch_id: "L5" });
    s.report(R(5, "L5", { state: "blocked", seq: 1, message: "need approval" }));
    assert.equal(s.get(5).message, "need approval");
    // Question resolved: working with NO message field clears the old label.
    const w = s.report(R(5, "L5", { state: "working", seq: 2 })).agent;
    assert.equal(w.agent_status, "working");
    assert.equal(w.message, null);
    // Turn ends clean: idle with failed:false shows no old error either.
    const done = s.report(R(5, "L5", { state: "idle", seq: 3, failed: false })).agent;
    assert.equal(done.message, null);
  });
});
// A screen read from the daemon's detection loop (runtime/detection.mjs).
const S = (agent, state, extra = {}) => ({ agent, state, visible_blocker: false, visible_idle: false, rule: null, ...extra });

describe("screen state (herdr: the screen decides Claude, Codex hooks win but for a visible blocker)", () => {
  it("Claude: the screen moves the state; a hook only lends its message to a blocked screen", () => {
    let now = 1000;
    const s = new RuntimeState({ now: () => now });
    const c = s.claim({ pane_id: 1, agent: "claude", launch_id: "L1" });
    const C = (extra) => ({ v: 1, pane_id: 1, launch_id: c.terminal_id, source: "tern:claude", agent: "claude", ...extra });
    s.detect(1, S("claude", "idle", { visible_idle: true, at: now }));
    assert.equal(s.get(1).agent_status, "idle");
    s.detect(1, S("claude", "working", { at: (now += 500) }));
    assert.equal(s.get(1).agent_status, "working");
    // PermissionRequest hint: no state of its own.
    s.report(C({ state: "blocked", hint: true, message: "Bash: echo hi", seq: 1 }));
    assert.equal(s.get(1).agent_status, "working");
    s.detect(1, S("claude", "blocked", { visible_blocker: true, rule: "bash_permission_prompt", at: (now += 300) }));
    assert.deepEqual([s.get(1).agent_status, s.get(1).message], ["blocked", "Bash: echo hi"]);
    s.detect(1, S("claude", "working", { at: (now += 300) }));
    assert.deepEqual([s.get(1).agent_status, s.get(1).message], ["working", null]);
    // Without a hint the rule names the blocker.
    s.detect(1, S("claude", "blocked", { visible_blocker: true, rule: "live_blocked_form", at: (now += 300) }));
    assert.equal(s.get(1).message, "live_blocked_form");
  });

  it("Codex: the hook state wins over the screen, except a visible blocker no older than the hook", () => {
    let now = 1000;
    const s = new RuntimeState({ now: () => now });
    const c = s.claim({ pane_id: 2, agent: "codex", launch_id: "L2" });
    const X = (extra) => ({ v: 1, pane_id: 2, launch_id: c.terminal_id, source: "tern:codex", agent: "codex", ...extra });
    s.detect(2, S("codex", "idle", { visible_idle: true, at: now }));
    s.report(X({ state: "working", seq: 1 }));
    assert.equal(s.get(2).agent_status, "working");
    // A plain idle screen does not override the hook's working (herdr test
    // fallback_idle_does_not_override_hook_working).
    s.detect(2, S("codex", "idle", { at: (now += 300) }));
    assert.equal(s.get(2).agent_status, "working");
    // A visible blocker read after the hook does.
    s.detect(2, S("codex", "blocked", { visible_blocker: true, rule: "live_strong_blocker", at: (now += 300) }));
    assert.equal(s.get(2).agent_status, "blocked");
    // The blocker leaves the screen: the hook's state is back.
    s.detect(2, S("codex", "working", { at: (now += 300) }));
    assert.equal(s.get(2).agent_status, "working");
    // A blocker read before the newest hook does not override it.
    s.detect(2, S("codex", "blocked", { visible_blocker: true, rule: "x", at: now - 1 }));
    now += 10;
    s.report(X({ state: "idle", seq: 2 }));
    assert.equal(s.get(2).agent_status, "done");
  });

  it("a native Claude opened by hand follows its screen, done and all", () => {
    const s = new RuntimeState();
    s.observe({ v: 1, generation: "tern-discovery", agents: [{ pane: 5, agent: "claude", state: "unknown" }], panes: [{ pane: 5, tab: 9 }] });
    assert.equal(s.get(5).agent_status, "unknown");
    s.detect(5, S("claude", "idle", { visible_idle: true, at: 1 }));
    assert.equal(s.get(5).agent_status, "idle", "the first idle is never a completion");
    s.detect(5, S("claude", "working", { at: 2 }));
    s.detect(5, S("claude", "idle", { visible_idle: true, at: 3 }));
    assert.equal(s.get(5).agent_status, "done");
    assert.ok(s.get(5).completion_seq > 0);
  });

  it("a blocked startup dialog answered into idle is not a completion (acquisition)", () => {
    const s = new RuntimeState();
    s.claim({ pane_id: 6, agent: "claude", launch_id: "L6" });
    s.detect(6, S("claude", "blocked", { visible_blocker: true, rule: "live_blocked_form", at: 1 }));
    assert.equal(s.get(6).agent_status, "blocked");
    s.detect(6, S("claude", "idle", { visible_idle: true, at: 2 }));
    assert.equal(s.get(6).agent_status, "idle");
    assert.equal(s.get(6).completion_seq, null);
  });

  it("readiness: a pending Claude or Codex is ready on its first idle screen; blocked keeps it pending", () => {
    const s = new RuntimeState();
    s.claim({ pane_id: 7, agent: "codex", launch_id: "L7" });
    s.detect(7, S("codex", "blocked", { visible_blocker: true, rule: "trust_directory", at: 1 }));
    assert.deepEqual([s.get(7).agent_status, s.get(7).message, s.get(7).launch_pending], ["blocked", "trust_directory", true]);
    s.detect(7, S("codex", "idle", { visible_idle: true, at: 2 }));
    assert.deepEqual([s.get(7).agent_status, s.get(7).interactive_ready, s.get(7).launch_pending], ["idle", true, false]);
  });

  it("a screen read for another agent than the occupant is ignored", () => {
    const s = new RuntimeState();
    s.claim({ pane_id: 8, agent: "claude", launch_id: "L8" });
    assert.equal(s.detect(8, S("codex", "idle", { at: 1 })), false);
    assert.equal(s.get(8).agent_status, "unknown");
  });

  it("any state but idle marks the pane seen (herdr apply_pane_state_change)", () => {
    const s = new RuntimeState();
    s.claim({ pane_id: 9, agent: "omp", launch_id: "L9" });
    s.report(R(9, "L9", { state: "working", seq: 1 }));
    s.report(R(9, "L9", { state: "idle", seq: 2 }));
    assert.equal(s.get(9).agent_status, "done");
    s.report(R(9, "L9", { state: "unknown", seq: 3 }));
    s.report(R(9, "L9", { state: "idle", seq: 4 }));
    assert.equal(s.get(9).agent_status, "idle");
  });

  it("every state change is announced, with completion and seen", () => {
    const s = new RuntimeState();
    const seen = [];
    s.onTransition((t) => seen.push(`${t.prev}>${t.next}${t.completion ? "!" : ""}${t.seen ? "" : "~"}`));
    s.claim({ pane_id: 10, agent: "omp", launch_id: "L10" });
    s.report(R(10, "L10", { state: "working", seq: 1 }));
    s.report(R(10, "L10", { state: "blocked", seq: 2, message: "q" }));
    s.report(R(10, "L10", { state: "idle", seq: 3 }));
    assert.deepEqual(seen, ["idle>working", "working>blocked", "blocked>idle!~"]);
  });
});

describe("omp start readiness (bug: ready inside the first-run wizard)", () => {
  it("the extension's ready waits for a clean startup screen; a wizard on screen is blocked", () => {
    const s = new RuntimeState();
    const c = s.claim({ pane_id: 20, agent: "omp", launch_id: "L20" });
    s.report(R(20, "L20", { state: "idle", seq: 1, ready: true, session_start: true }));
    assert.equal(s.get(20).interactive_ready, false, "no screen read yet");
    s.detect(20, S("omp", "blocked", { visible_blocker: true, rule: "omp_setup_wizard", at: 1 }));
    assert.deepEqual([s.get(20).agent_status, s.get(20).message, s.get(20).launch_pending], ["blocked", "omp_setup_wizard", true]);
    s.detect(20, S("omp", "idle", { at: 2 }));
    assert.deepEqual([s.get(20).agent_status, s.get(20).interactive_ready, s.get(20).launch_pending], ["idle", true, false]);
    assert.equal(s.get(20).terminal_id, c.terminal_id);
  });

  it("the native surface never makes a pending omp ready", () => {
    const s = new RuntimeState();
    s.claim({ pane_id: 21, agent: "omp", launch_id: "L21" });
    s.observe({ v: 1, generation: "w1", agents: [{ pane: 21, agent: "omp", state: "idle", ready: true }], panes: [] });
    assert.equal(s.get(21).interactive_ready, false);
    assert.equal(s.get(21).launch_pending, true);
  });

  it("once ready, the screen no longer moves an omp: its extension owns the lifecycle", () => {
    const s = new RuntimeState();
    s.claim({ pane_id: 22, agent: "omp", launch_id: "L22" });
    s.report(R(22, "L22", { state: "idle", seq: 1, ready: true }));
    s.detect(22, S("omp", "idle", { at: 1 }));
    s.report(R(22, "L22", { state: "working", seq: 2 }));
    s.detect(22, S("omp", "blocked", { visible_blocker: true, rule: "omp_setup_wizard", at: 2 }));
    assert.equal(s.get(22).agent_status, "working");
  });
});

describe("native exit (bug: a stale native entry blocked start)", () => {
  it("a pane the process probe found free loses its native entry and keeps it off while free", () => {
    const s = new RuntimeState();
    s.observe({ v: 1, generation: "w1", agents: [{ pane: 30, agent: "omp", state: "idle" }], panes: [] });
    assert.equal(s.releaseNative(30), true);
    assert.throws(() => s.get(30), (e) => e.code === "agent_not_found");
    // The rail's stale list still names it: no new native while the pane is free.
    s.observe({ v: 1, generation: "w1", agents: [{ pane: 30, agent: "omp", state: "unknown" }], panes: [] });
    assert.throws(() => s.get(30), (e) => e.code === "agent_not_found");
    // A start can claim it.
    s.claim({ pane_id: 30, agent: "omp", launch_id: "L30" });
    assert.equal(s.get(30).launch_pending, true);
  });

  it("an agent seen again in the pane lifts the free mark", () => {
    const s = new RuntimeState();
    s.observe({ v: 1, generation: "w1", agents: [{ pane: 31, agent: "omp", state: "idle" }], panes: [] });
    s.releaseNative(31);
    s.clearFree(31);
    s.observe({ v: 1, generation: "w1", agents: [{ pane: 31, agent: "omp", state: "working" }], panes: [] });
    assert.equal(s.get(31).agent_status, "working");
  });

  it("never releases a connector occupant", () => {
    const s = new RuntimeState();
    s.claim({ pane_id: 32, agent: "omp", launch_id: "L32" });
    assert.equal(s.releaseNative(32), false);
    assert.equal(s.get(32).launch_pending, true);
  });
});

describe("release", () => {
  it("clean exit frees name and resume; wrong launch is stale; revision bumps", () => {
    const s = new RuntimeState();
    s.claim({ pane_id: 3, agent: "omp", name: "w1" });
    assert.deepEqual(s.release({ pane_id: 3, launch_id: "nope" }), { released: false, reason: "stale-release" });
    const live = s.list()[0];
    const before = s.seq;
    assert.equal(s.release({ pane_id: 3, launch_id: live.terminal_id }).released, true);
    assert.ok(s.seq > before);
    assert.throws(() => s.get("w1"), (e) => e.code === "agent_not_found");
    s.claim({ pane_id: 3, agent: "omp", name: "w1" }); // name reusable after release
  });
});

describe("observe discovery", () => {
  it("null agents retains; invalid file shape ignored", () => {
    const s = new RuntimeState();
    s.claim({ pane_id: 1, agent: "omp", launch_id: "L1" });
    s.report(R(1, "L1", { state: "working", seq: 1 }));
    assert.equal(s.observe({ v: 1, agents: null, panes: [] }).applied, false);
    assert.equal(s.observe({ v: 2, agents: [] }).applied, false);
    assert.equal(s.get(1).agent_status, "working");
  });
  it("empty list deletes absent natives but never a live connector", () => {
    const s = new RuntimeState();
    s.observe({ v: 1, generation: "g1", seq: 1, agents: [{ pane: 11, agent: "omp", state: "working" }], panes: [] });
    s.claim({ pane_id: 12, agent: "claude" }); // pending: wrapper not yet visible
    s.claim({ pane_id: 13, agent: "omp", launch_id: "L9" });
    s.report(R(13, "L9", { state: "working", seq: 1 })); // live connector, native silent
    s.observe({ v: 1, generation: "g1", seq: 2, agents: [], panes: [] });
    assert.throws(() => s.get(11), (e) => e.code === "agent_not_found");
    assert.equal(s.get(12).launch_pending, true);
    assert.equal(s.get(13).agent_status, "working");
  });
  it("startup grace: a fresh generation with an empty list sweeps nothing", () => {
    const s = new RuntimeState();
    s.observe({ v: 1, generation: "old", seq: 1, agents: [{ pane: 21, agent: "omp", state: "idle" }], panes: [] });
    const r = s.observe({ v: 1, generation: "brand-new", seq: 1, agents: [], panes: [] });
    assert.equal(r.applied, true);
    assert.equal(r.sweep, false);
    assert.equal(s.get(21).agent_status, "idle");
  });
  it("pending claim survives native exited; live connector exits via native signal", () => {
    const s = new RuntimeState();
    const c = s.claim({ pane_id: 30, agent: "omp" });
    s.observe({ v: 1, agents: [{ pane: 30, state: "exited" }], panes: [] });
    assert.equal(s.get(30).terminal_id, c.terminal_id); // still pending
    s.report({ v: 1, pane_id: 30, launch_id: c.terminal_id, source: "tern:omp", agent: "omp", state: "working", seq: 1 });
    s.observe({ v: 1, agents: [{ pane: 30, state: "exited" }], panes: [] });
    assert.throws(() => s.get(30), (e) => e.code === "agent_not_found");
  });
  it("waiting_input maps to blocked; unknown stays unknown, never busy", () => {
    const s = new RuntimeState();
    s.observe({ v: 1, agents: [{ pane: 40, agent: "omp", state: "waiting_input" }], panes: [] });
    s.observe({
      v: 1,
      agents: [{ pane: 41, state: "mystery" }],
      panes: [],
    });
    assert.throws(() => s.get(41), (e) => e.code === "agent_not_found");
  });
  it("honors explicit verified agent kind over shell command text", () => {
    const s = new RuntimeState();
    // LIVE shape: pane runs powershell.exe as the shell, codex.exe verified
    // in the foreground process by server matchAgent — the explicit agent
    // rides the block, not the command string.
    s.observe({
      v: 1,
      generation: "tern-discovery",
      agents: [{ pane: 10672993730563, agent: "codex", command: "powershell.exe", state: "unknown" }],
      panes: [],
    });
    assert.equal(s.get(10672993730563).agent, "codex");
  });
  it("blocks with no agent evidence are skipped, never fake omp", () => {
    const s = new RuntimeState();
    const before = s.seq;
    s.observe({ v: 1, agents: [{ pane: 42, command: "powershell.exe", state: "working" }], panes: [] });
    assert.throws(() => s.get(42), (e) => e.code === "agent_not_found");
    assert.equal(s.seq, before); // skipped before any mutation
  });
  it("sweep:false defers the absent-native sweep for union fusion", () => {
    const s = new RuntimeState();
    s.observe({ v: 1, generation: "w1", agents: [{ pane: 51, agent: "omp", state: "working" }], panes: [] });
    s.observe({ v: 1, generation: "w2", agents: [], panes: [] }, { sweep: false });
    assert.equal(s.get(51).agent_status, "working"); // other stream's empty list swept nothing
    assert.equal(s.sweepNativesExcept(new Set()).swept, true); // union decided: now it dies
  });
  it("snapshot carries fresh-boot generation + snapshot_at heartbeat", () => {
    const a = new RuntimeState().snapshot();
    const b = new RuntimeState().snapshot();
    assert.equal(a.v, 1);
    assert.notEqual(a.generation, b.generation);
    assert.ok(typeof a.snapshot_at === "number");
  });
  it("enrichFromDiscovery updates meta only: never creates, never deletes", () => {
    const s = new RuntimeState();
    s.observe({ v: 1, agents: [{ pane: 60, agent: "omp", state: "working" }], panes: [] });
    const before = s.seq;
    const r = s.enrichFromDiscovery({
      sessions: [{ id: 1, tabs: [{ id: 2, panes: undefined, blocks: [{ id: 60, cwd: "/x" }] }] }],
    });
    assert.equal(r.applied, false); // wrong nesting key: no panes walked
    assert.equal(s.seq, before);
    const r2 = s.enrichFromDiscovery({ panes: [{ pane: 60, tab: 9, session: 8, cwd: "/x" }] });
    assert.equal(r2.applied, true);
    assert.equal(s.get(60).tab_id, 9);
    assert.equal(s.get(60).cwd, "/x");
    assert.ok(s.seq > before);
    assert.throws(() => s.get(61), (e) => e.code === "agent_not_found");
  });
  it("get throws typed errors", () => {
    const s = new RuntimeState();
    assert.throws(() => s.get(999), (e) => e instanceof RuntimeError && e.code === "agent_not_found");
    assert.throws(() => s.get({}), (e) => e.code === "invalid_target");
  });
});

describe("single writer (owner lock)", () => {
  it("concurrent serve on one dir: one owner, one endpoint, no silent overwrite", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { serve } = await import("./server.mjs");
    const { request } = await import("./client.mjs");
    const dir = mkdtempSync(join(tmpdir(), "rt-lock-"));
    try {
      const first = await serve({ dataDir: dir });
      // Second concurrent boot loses with daemon_locked — never a writer.
      await assert.rejects(() => serve({ dataDir: dir }), (e) => e.code === "daemon_locked");
      // Winner owns the endpoint: a report through it survives (no loser
      // snapshot can overwrite it — the loser never wrote anything).
      await request(dir, "claim", { pane_id: 9001, agent: "omp", name: "solo", launch_id: "L1" });
      await request(dir, "report", {
        v: 1, pane_id: 9001, launch_id: "L1", source: "tern:omp", agent: "omp",
        state: "blocked", seq: 1, message: "need approval",
      });
      const got = await request(dir, "get", { target: 9001 });
      assert.equal(got.agent_status, "blocked");
      assert.equal(got.message, "need approval");
      await first.close();
      // After close the lock releases: a fresh boot takes over the same dir.
      const second = await serve({ dataDir: dir });
      await second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("discovery cadence", () => {
  // `tern ls` is a process spawn that costs ~250 ms against the user's Tern daemon:
  // the ingest loop (250 ms) must not pay it every cycle. Discovery runs on its own
  // slower cadence, at poll rate only while a launch is pending, and the cycles in
  // between keep what the last discovery found instead of sweeping it.
  async function withServe(fn) {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { serve } = await import("./server.mjs");
    const dir = mkdtempSync(join(tmpdir(), "rt-cadence-"));
    const calls = { list: 0, process: 0 };
    const tern = {
      async list() {
        calls.list += 1;
        return { sessions: [{ id: 1, tabs: [{ id: 2, blocks: [{ id: 500, kind: "agent", command: "omp" }] }] }] };
      },
      async process() {
        calls.process += 1;
        return { command: "omp" };
      },
      async capture() {
        return { text: "" };
      },
    };
    const handle = await serve({ dataDir: dir, tern, pollMs: 3600000, discoveryMs: 60000, classify: () => null });
    try {
      await fn({ handle, calls, dir });
    } finally {
      await handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("runs tern ls once per discovery interval, not once per ingest", async () => {
    await withServe(async ({ handle, calls }) => {
      await handle.ingest();
      await handle.ingest();
      await handle.ingest();
      assert.equal(calls.list, 1);
    });
  });

  it("keeps a discovered native across the cycles that skip discovery", async () => {
    await withServe(async ({ handle }) => {
      await handle.ingest();
      assert.equal(handle.state.get(500).agent, "omp");
      await handle.ingest();
      assert.equal(handle.state.get(500).agent, "omp");
    });
  });

  it("a pending launch does not speed discovery up: the detection loop watches it", async () => {
    await withServe(async ({ handle, calls }) => {
      handle.state.claim({ pane_id: 700, agent: "claude", name: "bot", launch_id: "L7" });
      await handle.ingest();
      await handle.ingest();
      assert.equal(calls.list, 1);
    });
  });

  it("deletes observation files whose publisher has been gone for a long time", async () => {
    await withServe(async ({ handle, dir }) => {
      const { writeFileSync, utimesSync, existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      const dead = join(dir, "observation-vm-dead.json");
      const live = join(dir, "observation-vm-live.json");
      writeFileSync(dead, JSON.stringify({ v: 1, agents: [], panes: [] }));
      writeFileSync(live, JSON.stringify({ v: 1, agents: [], panes: [] }));
      const old = (Date.now() - 60 * 60 * 1000) / 1000;
      utimesSync(dead, old, old);
      await handle.ingest();
      assert.equal(existsSync(dead), false);
      assert.equal(existsSync(live), true);
    });
  });
});

describe("ingest persistence", () => {
  // The aside reads only snapshot.json: a state change the ingest loop does not
  // persist never reaches the rail, and a snapshot that never rewrites reads as a
  // dead daemon (the rail then respawns `ensure` forever).
  it("an ingest writes the state it changed to snapshot.json", async () => {
    const { mkdtempSync, rmSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { serve } = await import("./server.mjs");
    const dir = mkdtempSync(join(tmpdir(), "rt-persist-"));
    const handle = await serve({ dataDir: dir, pollMs: 3600000 });
    try {
      handle.state.claim({ pane_id: 810, agent: "omp", name: "lab", launch_id: "L810" });
      await handle.ingest();
      const snap = JSON.parse(readFileSync(join(dir, "snapshot.json"), "utf8"));
      assert.deepEqual(snap.agents.map((a) => a.pane_id), [810]);
    } finally {
      await handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("snapshot pane index", () => {
  // Tern gives each client its own pane ids: the window's plugin API and the CLI
  // (`tern ls`, `TERN_PANE`) name the same pane differently. The daemon keys by the
  // CLI's, so the snapshot lists every pane it knows by that id and tab, and the
  // aside resolves each one to its own (`cx.session:resolve`).
  it("lists the panes discovery saw, by daemon pane and tab id", async () => {
    const { mkdtempSync, rmSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { serve } = await import("./server.mjs");
    const dir = mkdtempSync(join(tmpdir(), "rt-index-"));
    const tern = {
      async list() {
        return { sessions: [{ id: 1, tabs: [{ id: 2, blocks: [{ id: 500, program: "pwsh" }, { id: 501, program: "pwsh" }] }] }] };
      },
      async process() {
        return { command: "pwsh" };
      },
      async capture() {
        return { text: "" };
      },
    };
    const handle = await serve({ dataDir: dir, tern, pollMs: 3600000, classify: () => null });
    try {
      await handle.ingest();
      await handle.persist({ heartbeat: true });
      const snap = JSON.parse(readFileSync(join(dir, "snapshot.json"), "utf8"));
      assert.deepEqual(snap.panes, [{ pane_id: 500, tab_id: 2 }, { pane_id: 501, tab_id: 2 }]);
    } finally {
      await handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
