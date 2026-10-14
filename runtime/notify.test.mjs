// runtime/notify.test.mjs — herdr's notification sounds, in the daemon.
// Manual timers and clock: no player, no waiting.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RuntimeState } from "./state.mjs";
import { createNotifier } from "./notify.mjs";

function world() {
  const timers = [];
  let now = 0;
  const played = [];
  const state = new RuntimeState({ now: () => now });
  let muted = false;
  const notifier = createNotifier({
    state,
    play: (kind) => played.push(kind),
    muted: () => muted,
    setTimer: (fn, ms) => {
      const t = { fn, at: now + ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) t.live = false;
    },
  });
  const advance = (ms) => {
    now += ms;
    for (const t of timers) {
      if (t.live && t.at <= now) {
        t.live = false;
        t.fn();
      }
    }
  };
  const R = (pane, extra) => state.report({ v: 1, pane_id: pane, launch_id: `L${pane}`, source: "tern:omp", agent: "omp", session_epoch: 0, ...extra });
  return { state, notifier, played, advance, R, mute: (v) => (muted = v) };
}

describe("notifier (herdr src/app/actions.rs: 1 s delay, delivered only if still true)", () => {
  it("a finished turn in the background chimes done one second later", () => {
    const w = world();
    w.state.claim({ pane_id: 1, agent: "omp", launch_id: "L1" });
    w.R(1, { state: "working", seq: 1 });
    w.R(1, { state: "idle", seq: 2 });
    w.advance(900);
    assert.deepEqual(w.played, []);
    w.advance(200);
    assert.deepEqual(w.played, ["done"]);
  });

  it("a turn that starts again within the second never chimes", () => {
    const w = world();
    w.state.claim({ pane_id: 1, agent: "omp", launch_id: "L1" });
    w.R(1, { state: "working", seq: 1 });
    w.R(1, { state: "idle", seq: 2 });
    w.advance(500);
    w.R(1, { state: "working", seq: 3 });
    w.advance(2000);
    assert.deepEqual(w.played, []);
  });

  it("a question chimes request even on the focused pane; a short-lived one does not", () => {
    const w = world();
    w.state.claim({ pane_id: 2, agent: "omp", launch_id: "L2" });
    w.state.observe({ v: 1, agents: [], panes: [{ pane: 2, tab: 4 }], focused_pane: 2, focused_tab: 4 });
    w.R(2, { state: "working", seq: 1 });
    w.R(2, { state: "blocked", seq: 2, message: "q" });
    w.advance(1100);
    assert.deepEqual(w.played, ["request"]);
    w.R(2, { state: "working", seq: 3 });
    w.R(2, { state: "blocked", seq: 4, message: "q2" });
    w.advance(400);
    w.R(2, { state: "working", seq: 5 });
    w.advance(2000);
    assert.deepEqual(w.played, ["request"]);
  });

  it("a completion on the focused tab is seen: no done", () => {
    const w = world();
    w.state.claim({ pane_id: 3, agent: "omp", launch_id: "L3" });
    w.state.observe({ v: 1, agents: [], panes: [{ pane: 3, tab: 5 }], focused_pane: 3, focused_tab: 5 });
    w.R(3, { state: "working", seq: 1 });
    w.R(3, { state: "idle", seq: 2 });
    w.advance(1100);
    assert.deepEqual(w.played, []);
  });

  it("focusing the pane before the second is up cancels the done", () => {
    const w = world();
    w.state.claim({ pane_id: 4, agent: "omp", launch_id: "L4" });
    w.R(4, { state: "working", seq: 1 });
    w.R(4, { state: "idle", seq: 2 });
    w.advance(500);
    w.state.observe({ v: 1, agents: [], panes: [{ pane: 4, tab: 6 }], focused_pane: 4, focused_tab: 6 });
    w.advance(1000);
    assert.deepEqual(w.played, []);
  });

  it("a new occupant in the pane, or a mute, never hears the old chime", () => {
    const w = world();
    w.state.claim({ pane_id: 5, agent: "omp", launch_id: "L5" });
    w.R(5, { state: "working", seq: 1 });
    w.R(5, { state: "idle", seq: 2 });
    w.state.release({ pane_id: 5, launch_id: "L5" });
    w.state.claim({ pane_id: 5, agent: "omp", launch_id: "L5b" });
    w.advance(1100);
    assert.deepEqual(w.played, []);
    w.state.claim({ pane_id: 6, agent: "omp", launch_id: "L6" });
    w.R(6, { state: "working", seq: 1 });
    w.R(6, { state: "blocked", seq: 2, message: "q" });
    w.mute(true);
    w.advance(1100);
    assert.deepEqual(w.played, []);
  });
});
