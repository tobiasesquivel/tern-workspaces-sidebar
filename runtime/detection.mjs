// runtime/detection.mjs — the daemon's detection loop: herdr's pane loop, on
// Tern's CLI.
//
// herdr reads each agent pane's screen in-process every 300 ms
// (src/pane.rs, src/pane/agent_detection.rs; research/herdr-agent-detection.md
// §2–§3). Tern gives the daemon two spawns instead: `tern capture <pane>
// --surfaces --json` for the screen and `tern process <pane> --json` for the
// foreground program, ~200 ms each on this machine (measured 2026-10-14: p50
// 202–281 ms, four in parallel ~500 ms each). So the loop keeps herdr's rules
// and spends its spawns in two lanes, one capture and one probe at a time:
//
// - Which panes: every Claude/Codex occupant (started or opened by hand), an
//   omp that `start` launched until its startup screen is clean, and every
//   native occupant for its process recheck.
// - Identification: a native was identified by discovery; a started agent
//   waits until `tern process` shows its program in the pane (the wrapper or the
//   shell is not the agent). Then herdr's 3 s startup grace (+1 tick) before the
//   first screen read.
// - Screen cadence: 300 ms (herdr's TICK_IDENTIFIED) while working, blocked or
//   unknown; 100 ms while a plain idle waits for confirmation; 1 s for a stable
//   idle, or at once when its OSC title changes. Deviation: herdr skips an idle
//   read only when no bytes arrived; Tern tells the daemon about titles
//   (`tern events`) but not about output, so a stable idle is re-read every
//   second instead of never.
// - Publishing: herdr's decide_screen_detection_publish — a plain working →
//   idle waits 3 more idle reads or 700 ms, a visible idle or blocker publishes
//   at once, a stable visible blocker is republished every 800 ms (it keeps
//   Codex's screen override newer than its hook), a `skip` read is dropped.
// - Process recheck (natives): every 5 s (herdr's PROCESS_RECHECK_IDENTIFIED),
//   sooner after a title change. A pane back at its shell is an exit at once
//   (herdr's ReportProcessExit); a probe that cannot confirm the agent is a
//   miss, and 6 misses in a row release it (AGENT_MISS_CONFIRMATION_ATTEMPTS).

import { classifySurface } from "./connectors/detect.mjs";

export const TIMING = Object.freeze({
  TICK_MS: 300,
  IDLE_READ_MS: 1000,
  PENDING_IDLE_RECHECK_MS: 100,
  PENDING_IDLE_CONFIRMATIONS: 3,
  PENDING_IDLE_CAP_MS: 700,
  VISIBLE_REFRESH_MS: 800,
  STARTUP_GRACE_MS: 3000,
  PROBE_IDENTIFIED_MS: 5000,
  PROBE_ACQUIRE_MS: 500,
  PROBE_AFTER_TITLE_MS: 1000,
  MISS_LIMIT: 6,
  STEP_MS: 50,
});

// ---- process probes ---------------------------------------------------------

// Bounded deep scan of a process() result for human-readable command strings.
export function procStrings(proc) {
  const out = [];
  const visit = (v, depth) => {
    if (out.length > 24 || depth > 3) return;
    if (typeof v === "string") {
      if (v.length > 0 && v.length <= 500) out.push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    if (v && typeof v === "object") {
      for (const k of ["command", "program", "cmdline", "cmd", "argv", "args", "line", "name", "process", "foreground", "child"]) {
        if (k in v) visit(v[k], depth + 1);
      }
    }
  };
  visit(proc, 0);
  return out;
}

export function matchAgent(strs) {
  for (const s of strs) {
    const first = String(s).split(/[\\/]/).pop().split(/\s+/)[0].toLowerCase().replace(/\.exe$/, "");
    if (first === "omp" || first === "claude" || first === "codex") return first;
  }
  const blob = strs.join("\n").toLowerCase();
  if (/(^|[\/\\])omp(\.exe)?(\s|$)/.test(blob)) return "omp";
  if (/(^|[\/\\])claude(\.exe)?(\s|$)/.test(blob)) return "claude";
  if (/(^|[\/\\])codex(\.exe)?(\s|$)/.test(blob)) return "codex";
  return null;
}

// The start wrapper runs `node runtime/launch.mjs ...` in the pane before the
// agent spawns.
export function isWrapper(strs) {
  return strs.some((s) => s.includes("launch.mjs"));
}

// One `tern process` answer: which agent runs in the pane, whether the start
// wrapper does, and whether the pane is back at its own shell (the foreground
// process is the pane's child, measured: `foreground.pid === child.pid`).
export function interpretProcess(proc) {
  if (!proc || typeof proc !== "object") return { agent: null, wrapper: false, free: false };
  const strs = procStrings(proc);
  const fg = proc.foreground;
  const child = proc.child;
  const free =
    fg != null &&
    child != null &&
    typeof fg.pid === "number" &&
    fg.pid === child.pid;
  return { agent: free ? null : matchAgent(strs), wrapper: isWrapper(strs), free };
}

// ---- herdr's publish decision ------------------------------------------------

export function freshTrack() {
  return {
    pub: { state: "unknown", visible_idle: false, visible_blocker: false, visible_working: false },
    pending: { startedAt: null, confirmations: 0 },
    lastRefresh: null,
  };
}

// herdr decide_screen_detection_publish (src/pane/agent_detection.rs). Mutates
// the track; returns {publish, state, visible_*}.
export function decidePublish(t, det, now, timing = TIMING) {
  const next = {
    state: det.state,
    visible_idle: det.visible_idle === true && det.state === "idle",
    visible_blocker: det.visible_blocker === true && det.state === "blocked",
    visible_working: det.visible_working === true && det.state === "working",
  };
  const prev = t.pub;
  const plainIdle = prev.state === "working" && next.state === "idle" && !next.visible_idle && !next.visible_blocker;
  if (plainIdle) {
    if (t.pending.startedAt === null) {
      t.pending = { startedAt: now, confirmations: 0 };
      return { publish: false, ...next };
    }
    if (now - t.pending.startedAt < timing.PENDING_IDLE_CAP_MS) {
      t.pending.confirmations += 1;
      if (t.pending.confirmations < timing.PENDING_IDLE_CONFIRMATIONS) return { publish: false, ...next };
    }
  }
  t.pending = { startedAt: null, confirmations: 0 };
  const refreshDue =
    next.visible_blocker &&
    prev.visible_blocker &&
    (t.lastRefresh === null || now - t.lastRefresh >= timing.VISIBLE_REFRESH_MS);
  const publish =
    next.state !== prev.state ||
    next.visible_idle !== prev.visible_idle ||
    next.visible_blocker !== prev.visible_blocker ||
    next.visible_working !== prev.visible_working ||
    refreshDue;
  if (!publish) return { publish: false, ...next };
  t.pub = next;
  if (next.visible_blocker) t.lastRefresh = now;
  return { publish: true, ...next };
}

// ---- the loop ------------------------------------------------------------------

export function createDetectionLoop({
  state,
  tern,
  classify = classifySurface,
  now = () => Date.now(),
  timing = TIMING,
} = {}) {
  const tracks = new Map(); // pane -> track
  const titles = new Map(); // pane -> last OSC title
  let probeBusy = false;
  let captureBusy = false;
  let timer = null;
  const stats = { captures: 0, probes: 0, published: 0, skipped: 0, released: 0, captureMs: 0, probeMs: 0 };

  function sync() {
    const t = now();
    const live = new Set();
    for (const a of state.list()) {
      const p = state.peek(a.pane_id);
      if (!p) continue;
      const screen =
        p.agent === "claude" ||
        p.agent === "codex" ||
        (p.agent === "omp" && !p.native && p.startup_gate !== "clear");
      if (!screen && !p.native) continue;
      live.add(p.pane_id);
      let tr = tracks.get(p.pane_id);
      if (!tr || tr.terminal_id !== p.terminal_id) {
        tr = {
          ...freshTrack(),
          pane: p.pane_id,
          terminal_id: p.terminal_id,
          agent: p.agent,
          native: p.native,
          identifiedAt: p.native ? t : null,
          graceUntil: p.native ? t + timing.STARTUP_GRACE_MS + timing.TICK_MS : Infinity,
          nextScreenAt: 0,
          nextProbeAt: p.native ? t + timing.PROBE_IDENTIFIED_MS : t,
          lastProbeAt: -Infinity,
          misses: 0,
        };
        tracks.set(p.pane_id, tr);
      }
      tr.screen = screen;
    }
    for (const k of [...tracks.keys()]) if (!live.has(k)) tracks.delete(k);
  }

  function probeDue(tr, t) {
    if (tr.native) return t >= tr.nextProbeAt;
    return tr.identifiedAt === null && t >= tr.nextProbeAt;
  }

  function screenDue(tr, t) {
    return tr.screen && tr.identifiedAt !== null && t >= tr.graceUntil && t >= tr.nextScreenAt;
  }

  function pick(due, key) {
    const t = now();
    let best = null;
    for (const tr of tracks.values()) {
      if (!due(tr, t)) continue;
      if (best === null || tr[key] < best[key]) best = tr;
    }
    return best;
  }

  async function probe(tr) {
    const t0 = now();
    let proc = null;
    try {
      proc = await tern.process(String(tr.pane));
    } catch {
      proc = null;
    }
    stats.probes += 1;
    stats.probeMs += now() - t0;
    if (tracks.get(tr.pane) !== tr) return;
    const r = proc ? interpretProcess(proc) : null;
    const t = now();
    tr.lastProbeAt = t;
    if (tr.native) {
      if (r && r.agent === tr.agent) {
        tr.misses = 0;
      } else if (r && (r.free || (r.agent !== null && r.agent !== tr.agent))) {
        // Back at its shell, or another agent took the pane: an exit now.
        if (state.releaseNative(tr.pane)) stats.released += 1;
        if (r.agent !== null) state.clearFree(tr.pane);
        tracks.delete(tr.pane);
        return;
      } else {
        tr.misses += 1;
        if (tr.misses >= timing.MISS_LIMIT) {
          if (state.releaseNative(tr.pane)) stats.released += 1;
          tracks.delete(tr.pane);
          return;
        }
      }
      tr.nextProbeAt = t + timing.PROBE_IDENTIFIED_MS;
      return;
    }
    if (r && r.agent === tr.agent) {
      tr.identifiedAt = t;
      tr.graceUntil = t + timing.STARTUP_GRACE_MS + timing.TICK_MS;
      tr.nextScreenAt = tr.graceUntil;
      return;
    }
    tr.nextProbeAt = t + timing.PROBE_ACQUIRE_MS;
  }

  async function read(tr) {
    const at = now();
    let text;
    try {
      const cap = await tern.capture(String(tr.pane), { surfaces: true });
      text = cap && typeof cap.text === "string" ? cap.text : "";
    } catch {
      tr.nextScreenAt = now() + timing.TICK_MS;
      return;
    }
    stats.captures += 1;
    stats.captureMs += now() - at;
    if (tracks.get(tr.pane) !== tr) return;
    const t = now();
    let det;
    try {
      det = classify(tr.agent, text, { title: titles.get(tr.pane) ?? "" });
    } catch {
      det = null;
    }
    if (!det || det.skip) {
      stats.skipped += 1;
      tr.pending = { startedAt: null, confirmations: 0 };
      tr.nextScreenAt = t + timing.TICK_MS;
      return;
    }
    let out;
    if (tr.agent === "omp") {
      // omp's startup gate reads every screen: its ready may arrive after the
      // first clean read, and only a read after it clears the gate.
      out = { publish: true, ...det };
    } else {
      out = decidePublish(tr, det, t, timing);
    }
    if (out.publish) {
      stats.published += 1;
      state.detect(tr.pane, {
        agent: tr.agent,
        state: out.state,
        visible_blocker: out.visible_blocker,
        visible_idle: out.visible_idle,
        rule: det.rule,
        at,
      });
    }
    if (tr.pending.startedAt !== null) tr.nextScreenAt = t + timing.PENDING_IDLE_RECHECK_MS;
    else if (tr.pub.state === "idle" && tr.agent !== "omp") tr.nextScreenAt = t + timing.IDLE_READ_MS;
    else tr.nextScreenAt = t + timing.TICK_MS;
  }

  // One scheduling pass: start the most overdue probe and the most overdue
  // read, one of each at most, and resolve when both are done.
  async function step() {
    sync();
    const work = [];
    if (!probeBusy) {
      const tr = pick(probeDue, "nextProbeAt");
      if (tr) {
        probeBusy = true;
        work.push(probe(tr).finally(() => (probeBusy = false)));
      }
    }
    if (!captureBusy) {
      const tr = pick(screenDue, "nextScreenAt");
      if (tr) {
        captureBusy = true;
        work.push(read(tr).finally(() => (captureBusy = false)));
      }
    }
    await Promise.all(work);
  }

  function setTitle(pane, title) {
    if (typeof title !== "string") return;
    const prev = titles.get(pane);
    titles.set(pane, title);
    if (prev !== undefined && prev !== title) noteActivity(pane);
  }

  // A title that changed is activity: a stable idle pane is read at once, and a
  // native's process is rechecked soon (at most once a second).
  function noteActivity(pane) {
    const tr = tracks.get(pane);
    if (!tr) return;
    const t = now();
    if (tr.pub.state === "idle" || tr.pub.state === "unknown") tr.nextScreenAt = Math.min(tr.nextScreenAt, t);
    if (tr.native) tr.nextProbeAt = Math.min(tr.nextProbeAt, Math.max(t, tr.lastProbeAt + timing.PROBE_AFTER_TITLE_MS));
  }

  function noteTitle(pane, title) {
    titles.set(pane, title);
    noteActivity(pane);
  }

  function forget(pane) {
    titles.delete(pane);
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      step().catch(() => {});
    }, timing.STEP_MS);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { step, start, stop, setTitle, noteTitle, forget, stats, tracks };
}
