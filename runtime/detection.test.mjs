// runtime/detection.test.mjs — the daemon's detection loop (herdr's pane loop,
// adapted to Tern's CLI). Fake tern and a manual clock: no spawn, no timers.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RuntimeState } from "./state.mjs";
import { createDetectionLoop, decidePublish, freshTrack, TIMING } from "./detection.mjs";

const D = (state, extra = {}) => ({ state, rule: null, visible_idle: false, visible_blocker: false, visible_working: false, skip: false, ...extra });

describe("decidePublish (herdr decide_screen_detection_publish)", () => {
  it("a plain working → idle waits 3 more idle reads", () => {
    const t = freshTrack();
    assert.equal(decidePublish(t, D("working"), 0).publish, true);
    assert.equal(decidePublish(t, D("idle"), 100).publish, false);
    assert.equal(decidePublish(t, D("idle"), 200).publish, false);
    assert.equal(decidePublish(t, D("idle"), 300).publish, false);
    assert.equal(decidePublish(t, D("idle"), 400).publish, true);
    assert.equal(t.pub.state, "idle");
  });
  it("…or 700 ms, whichever comes first", () => {
    const t = freshTrack();
    decidePublish(t, D("working"), 0);
    assert.equal(decidePublish(t, D("idle"), 1000).publish, false);
    assert.equal(decidePublish(t, D("idle"), 1700).publish, true);
  });
  it("a visible idle publishes at once; a working read cancels the wait", () => {
    const t = freshTrack();
    decidePublish(t, D("working"), 0);
    assert.equal(decidePublish(t, D("idle"), 100).publish, false);
    assert.equal(decidePublish(t, D("working"), 200).publish, false, "same state: nothing to publish");
    assert.equal(t.pending.startedAt, null);
    assert.equal(decidePublish(t, D("idle", { visible_idle: true }), 300).publish, true);
  });
  it("a stable visible blocker is republished every 800 ms", () => {
    const t = freshTrack();
    assert.equal(decidePublish(t, D("blocked", { visible_blocker: true }), 0).publish, true);
    assert.equal(decidePublish(t, D("blocked", { visible_blocker: true }), 500).publish, false);
    assert.equal(decidePublish(t, D("blocked", { visible_blocker: true }), 900).publish, true);
  });
});

function world({ processes = {}, screens = {}, titles = {} } = {}) {
  let now = 0;
  const calls = { capture: [], process: [] };
  const tern = {
    async process(pane) {
      calls.process.push(pane);
      const p = processes[pane];
      if (p instanceof Error) throw p;
      if (typeof p === "function") return p();
      return p;
    },
    async capture(pane) {
      calls.capture.push(pane);
      const s = screens[pane];
      return { text: typeof s === "function" ? s() : (s ?? "") };
    },
  };
  const state = new RuntimeState({ now: () => now });
  const loop = createDetectionLoop({ state, tern, now: () => now });
  for (const [pane, title] of Object.entries(titles)) loop.setTitle(Number(pane), title);
  return {
    state,
    loop,
    calls,
    processes,
    screens,
    at: (ms) => {
      now = ms;
    },
    get now() {
      return now;
    },
  };
}

const shell = { child: { pid: 1, name: "powershell.exe" }, foreground: { pid: 1, name: "powershell.exe" } };
const claude = { child: { pid: 1, name: "powershell.exe" }, foreground: { pid: 7, name: "claude.exe", argv: [] } };
const PROMPT = "──────\n❯ \n──────\n  ? for shortcuts\n";
const BUSY = "✶ Thinking… (3s · esc to interrupt)\n──────\n❯ \n──────\n";

async function run(w, until, step = 50) {
  for (let t = w.now; t <= until; t += step) {
    w.at(t);
    await w.loop.step();
  }
}

describe("detection loop", () => {
  it("a Claude opened by hand: 3 s grace, then its screen drives the state", async () => {
    const w = world({ processes: { 5: claude }, screens: { 5: PROMPT } });
    w.state.observe({ v: 1, generation: "tern-discovery", agents: [{ pane: 5, agent: "claude", state: "unknown" }], panes: [] });
    await run(w, 2900);
    assert.equal(w.calls.capture.length, 0, "no screen read during the startup grace");
    await run(w, 3600);
    assert.ok(w.calls.capture.length >= 1);
    assert.equal(w.state.get(5).agent_status, "idle");
    w.screens[5] = BUSY;
    // Claude retitles its pane when a turn starts: the idle pane is read at once.
    w.loop.noteTitle(5, "⠂ Claude Code");
    await run(w, 4000);
    assert.equal(w.state.get(5).agent_status, "working");
    w.loop.noteTitle(5, "✳ Claude Code");
    w.screens[5] = PROMPT;
    await run(w, 5000);
    assert.equal(w.state.get(5).agent_status, "done");
  });

  it("reads a busy pane every ~300 ms and a stable idle one every second", async () => {
    const w = world({ processes: { 5: claude }, screens: { 5: PROMPT } });
    w.state.observe({ v: 1, generation: "tern-discovery", agents: [{ pane: 5, agent: "claude", state: "unknown" }], panes: [] });
    await run(w, 3500);
    const n = w.calls.capture.length;
    await run(w, 6500);
    const idleReads = w.calls.capture.length - n;
    assert.ok(idleReads >= 2 && idleReads <= 4, `idle reads in 3 s: ${idleReads}`);
    w.screens[5] = BUSY;
    w.loop.noteTitle(5, "✶ Claude Code");
    const m = w.calls.capture.length;
    await run(w, 9500);
    const busyReads = w.calls.capture.length - m;
    assert.ok(busyReads >= 8, `busy reads in 3 s: ${busyReads}`);
  });

  it("the OSC title is read as its own region", async () => {
    const w = world({ processes: { 5: claude }, screens: { 5: "plain\n" }, titles: { 5: "⠂ Claude Code" } });
    w.state.observe({ v: 1, generation: "tern-discovery", agents: [{ pane: 5, agent: "claude", state: "unknown" }], panes: [] });
    await run(w, 3600);
    assert.equal(w.state.get(5).agent_status, "working");
  });

  it("a started Claude is read only once its process is in the pane, after the grace", async () => {
    const w = world({ processes: { 6: shell }, screens: { 6: "PS C:\\> node launch.mjs\n" } });
    w.state.claim({ pane_id: 6, agent: "claude", launch_id: "L6" });
    await run(w, 5000);
    assert.equal(w.calls.capture.length, 0, "a shell or the wrapper is not the agent yet");
    assert.equal(w.state.get(6).agent_status, "unknown");
    w.processes[6] = claude;
    w.screens[6] = PROMPT;
    await run(w, 9000);
    assert.equal(w.state.get(6).agent_status, "idle");
    assert.equal(w.state.get(6).interactive_ready, true);
  });

  it("a native whose pane is back at its shell is released at once", async () => {
    const w = world({ processes: { 7: { child: { pid: 1, name: "powershell.exe" }, foreground: { pid: 9, name: "omp.exe" } } } });
    w.state.observe({ v: 1, generation: "w1", agents: [{ pane: 7, agent: "omp", state: "idle" }], panes: [] });
    await run(w, 6000);
    assert.equal(w.state.get(7).agent, "omp");
    w.processes[7] = shell;
    await run(w, 12000);
    assert.throws(() => w.state.get(7), (e) => e.code === "agent_not_found");
  });

  it("a native the probe cannot confirm is released after 6 misses", async () => {
    const w = world({ processes: { 8: new Error("pane unreadable") } });
    w.state.observe({ v: 1, generation: "w1", agents: [{ pane: 8, agent: "omp", state: "idle" }], panes: [] });
    await run(w, 5 * TIMING.PROBE_IDENTIFIED_MS + 1000, 100);
    assert.equal(w.state.get(8).agent, "omp", "5 misses keep it");
    await run(w, 7 * TIMING.PROBE_IDENTIFIED_MS + 1000, 100);
    assert.throws(() => w.state.get(8), (e) => e.code === "agent_not_found");
  });

  it("a transcript viewer read is dropped, not published", async () => {
    const w = world({ processes: { 5: claude }, screens: { 5: BUSY } });
    w.state.observe({ v: 1, generation: "tern-discovery", agents: [{ pane: 5, agent: "claude", state: "unknown" }], panes: [] });
    await run(w, 3600);
    assert.equal(w.state.get(5).agent_status, "working");
    w.screens[5] = "lots\nShowing detailed transcript · ctrl+o to toggle\n";
    await run(w, 6000);
    assert.equal(w.state.get(5).agent_status, "working");
  });

  it("a started omp: its setup wizard on screen holds start; the screen is then left alone", async () => {
    const omp = { child: { pid: 1, name: "powershell.exe" }, foreground: { pid: 9, name: "omp.exe" } };
    const wizard = "Setup\nstep 1 of 5\n  Sign in to your providers\n↑/↓ select · ⏎ confirm · ⎋ skip · Ctrl+C exit setup\n";
    const w = world({ processes: { 9: omp }, screens: { 9: wizard } });
    w.state.claim({ pane_id: 9, agent: "omp", launch_id: "L9" });
    w.state.report({ v: 1, pane_id: 9, launch_id: "L9", source: "tern:omp", agent: "omp", state: "idle", seq: 1, ready: true });
    await run(w, 4000);
    assert.deepEqual([w.state.get(9).agent_status, w.state.get(9).launch_pending], ["blocked", true]);
    // omp's splash first: no prompt on screen, no ready.
    w.screens[9] = "   ✧      ·        ✦\n        ████████\n";
    await run(w, 4600);
    assert.equal(w.state.get(9).interactive_ready, false);
    w.screens[9] = " π > ⬢ model > scratch ▶────\n────\n╰─\n";
    await run(w, 5000);
    assert.deepEqual([w.state.get(9).agent_status, w.state.get(9).interactive_ready], ["idle", true]);
    const n = w.calls.capture.length;
    await run(w, 8000);
    assert.equal(w.calls.capture.length, n, "a ready omp is its extension's");
  });
});
