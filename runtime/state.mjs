// runtime/state.mjs — arbitration core for the Tern agent runtime.
// Owner: RuntimeCore. Single writer of final per-pane agent state.
// Contract: local://tern-runtime-contract.md (transporte/fuente única, modelo público,
// interfaz core). Herdr parity notes: seq gate (two-phase), session epochs + stale
// suppression, hook-vs-screen arbitration (reporter wins while occupant lives),
// done = idle-unseen with completion_seq, reads never mark seen, explicit focus
// (pane or whole tab) marks seen, blocked terminal while connector lives, exit
// releases only genuinely live occupants. No silence => idle: observe() never
// invents occupants; empty list deletes only native occupants, never a live
// connector (a claim/start pending occupant survives until its wrapper reports
// or releases, even if the native list does not show it yet).
// Revision rule: EVERY public-field mutation (state, message, seen, focus,
// tab/workspace/cwd, failed, release, sweep) advances the global _seq so
// persist() ships it; activity-only bumps also move state_change_seq, while
// enrich-only changes (seen flips, meta enrichment) move _seq alone.
//
// Where each agent's state comes from (herdr, research/herdr-agent-detection.md
// §1): omp — its extension's reports (full lifecycle); the screen is read only
// while `start` waits, for a startup dialog. Claude — the screen (`detect`, from
// the daemon's detection loop); its hooks bring identity and a message hint,
// never a state. Codex — its v9 hooks (UserPromptSubmit working, Stop/Interrupt
// idle) win over the screen except for a visible blocker read no earlier than
// the hook; the screen covers everything before the first hook. Every state
// change goes through `_setState`: herdr's seen rule (any non-idle state is
// seen), completion (working|blocked → idle, suppressed while the agent is
// still being acquired or launched) and the transition listeners (the
// daemon's notifier).

import { randomBytes } from "node:crypto";

export class RuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
  }
}

const AGENTS = new Set(["omp", "claude", "codex"]);
const SOURCE_AGENT = {
  "tern:omp": "omp",
  "tern:claude": "claude",
  "tern:codex": "codex",
};
const INTERNAL_STATES = new Set(["idle", "working", "blocked", "unknown"]);
const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_RESUME_ARGS = 64;
// A hook's message names the next blocked screen only while this fresh: an
// older one belongs to a dialog that already went away unseen.
const HINT_FRESH_MS = 30000;
const MAX_RESUME_BYTES = 8192;

function newGeneration() {
  return randomBytes(8).toString("hex");
}

function newLaunchId(paneId, n) {
  return `launch-${paneId}-${n.toString(36)}-${randomBytes(4).toString("hex")}`;
}

function isPositiveInt(v) {
  return Number.isSafeInteger(v) && v > 0;
}

function sessionRefKey(session) {
  if (session == null) return null;
  return `${session.kind}:${session.value}`;
}

function validSession(session) {
  if (session == null) return true;
  if (typeof session !== "object") return false;
  if (session.kind !== "id" && session.kind !== "path") return false;
  return typeof session.value === "string" && session.value.length > 0;
}

function validResumeArgv(v) {
  if (v == null) return true;
  if (!Array.isArray(v)) return false;
  if (v.length > MAX_RESUME_ARGS) return false;
  let bytes = 0;
  for (const a of v) {
    if (typeof a !== "string" || a.length === 0) return false;
    // No control characters (matches herdr argv validation intent).
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(a)) return false;
    bytes += Buffer.byteLength(a, "utf8");
  }
  return bytes <= MAX_RESUME_BYTES;
}

// Native agent identity (known sources only, no compat shims): honor an
// explicit `agent` when it names a known agent (omp|claude|codex) — the
// discoverer verified it against the live foreground process, and the bridge
// annotates agent:"omp" for native cx.agents blocks (Tern provably supports
// omp only). Otherwise match a verified executable token in command/model.
// No evidence => null: observe() skips the block (never a fake omp).
function nativeAgent(block) {
  if (block && (block.agent === "omp" || block.agent === "claude" || block.agent === "codex")) {
    return block.agent;
  }
  const hay = `${block?.command ?? ""} ${block?.model ?? ""}`.toLowerCase();
  if (/(^|[\/\\:\s])omp(\.exe)?(\s|$)/.test(hay)) return "omp";
  if (/(^|[\/\\:\s])claude(\.exe)?(\s|$)/.test(hay)) return "claude";
  if (/(^|[\/\\:\s])codex(\.exe)?(\s|$)/.test(hay)) return "codex";
  return null;
}

export class RuntimeState {
  constructor(opts = {}) {
    this._now = opts.now ?? (() => Date.now());
    this._generation = opts.generation ?? newGeneration();
    this._seq = 0;
    this._claimCount = 0;
    // pane_id -> occupant (internal)
    this._agents = new Map();
    // `${source}\0${launch_id}` -> last accepted seq
    this._seqByKey = new Map();
    // released keys kept to suppress late reports from the old session
    this._tombstones = new Map();
    // observation generation -> sightings; a brand-new generation with an
    // empty agent list is a restarting publisher, not a mass exit (startup
    // grace: skip the absent-native sweep until the stream is established).
    this._obsGen = new Map();
    this._focusedPane = null;
    this._focusedTab = null;
    // Transition listeners (the daemon's notifier): called after each change.
    this._listeners = [];
    // Panes the process probe found back at a free shell: a stale native list
    // must not bring their agent back until an agent is seen there again.
    this._free = new Set();
  }

  onTransition(fn) {
    if (typeof fn === "function") this._listeners.push(fn);
  }

  // Fields every occupant carries besides its public ones.
  _withInternals(o) {
    o.acq = o.acq ?? true; // herdr agent_process_acquisition_pending
    o.screen = o.screen ?? null; // last screen read: {state, visible_blocker, rule, at}
    o.hook = o.hook ?? null; // Codex hook authority: {state, at}
    o.hint = o.hint ?? null; // a hook's message for the next blocked screen: {message, at}
    // omp started by `start`: its ready waits for a clean startup screen.
    o.startup_gate = o.startup_gate ?? (o.agent === "omp" && !o.native ? "pending" : "clear");
    o.reported_ready = o.reported_ready ?? false;
    return o;
  }

  // The one place a state changes. Returns true when it did.
  _setState(o, next) {
    const prev = o.state;
    if (next === prev) return false;
    this._seq += 1;
    o.state = next;
    o.state_change_seq = this._seq;
    let completion = false;
    if (next !== "idle") o.seen = true;
    if ((prev === "working" || prev === "blocked") && next === "idle" && !o.acq) {
      completion = true;
      o.completion_seq = o.state_change_seq;
      o.seen = this._isSeen(o.pane_id, o.tab_id);
    } else {
      o.completion_seq = null;
    }
    if (next === "working" || next === "idle") o.acq = false;
    for (const fn of this._listeners) {
      try {
        fn({
          pane_id: o.pane_id,
          terminal_id: o.terminal_id,
          agent: o.agent,
          prev,
          next,
          completion,
          seen: o.seen,
        });
      } catch {
        // a listener never breaks arbitration
      }
    }
    return true;
  }

  // Claude/Codex (and omp's startup gate): the effective state from the screen
  // and the hook. Returns true when anything public changed.
  _recompute(o) {
    let rev = false;
    let next = o.state;
    let message = o.message;
    if (o.agent === "omp") {
      if (o.native || o.startup_gate === "clear") return false;
      const sc = o.screen;
      if (sc && sc.state === "blocked" && sc.visible_blocker) {
        o.startup_gate = "blocked";
        next = "blocked";
        message = sc.rule ?? "awaiting input";
      } else if (sc) {
        // A startup dialog answered is still the agent's acquisition, never a
        // finished turn.
        if (o.startup_gate === "blocked") o.acq = true;
        o.startup_gate = "clear";
        next = o.reported_state ?? o.state;
        if (o.state === "blocked" && o.reported_state !== "blocked") message = o.reported_message ?? null;
      }
    } else {
      const sc = o.screen;
      const hk = o.hook;
      if (hk && sc && sc.state === "blocked" && sc.visible_blocker && sc.at >= hk.at && hk.state !== "blocked") {
        next = "blocked";
      } else if (hk) {
        next = hk.state;
      } else if (sc) {
        next = sc.state;
      }
      if (next === "blocked") {
        const fresh = o.hint && this._now() - o.hint.at <= HINT_FRESH_MS;
        message = fresh ? o.hint.message : (o.state === "blocked" && o.message ? o.message : (sc?.rule ?? "awaiting input"));
      } else if (o.state === "blocked") {
        message = null;
        o.hint = null;
      }
    }
    if (message !== o.message) {
      o.message = message;
      rev = true;
    }
    if (!this._setState(o, next) && rev) this._seq += 1;
    // Readiness (herdr Pending → Active): Claude/Codex idle on screen; omp's
    // extension ready with a clean startup screen.
    const ready = o.agent === "omp" ? o.reported_ready && o.startup_gate === "clear" : o.state === "idle";
    if (o.launch_pending && ready) {
      o.interactive_ready = true;
      o.launch_pending = false;
      this._seq += 1;
    }
  }

  // A new identity minted by a report (session_start): Claude/Codex take no state
  // from it and wait for their screen; omp keeps what its extension said.
  _adopt(o, r) {
    if (o.agent === "omp") {
      o.reported_state = o.state;
      o.reported_message = o.message;
      o.reported_ready = r.ready === true;
      o.interactive_ready = false;
      o.launch_pending = true;
      this._withInternals(o);
      if (o.reported_ready && o.startup_gate === "clear") {
        o.interactive_ready = true;
        o.launch_pending = false;
      }
      return o;
    }
    o.state = "unknown";
    o.message = null;
    o.interactive_ready = false;
    o.launch_pending = true;
    this._withInternals(o);
    this._takeHook(o, r);
    this._recompute(o);
    return o;
  }

  // What a Claude/Codex report may change: the Codex hook authority, or a hint.
  _takeHook(o, r) {
    if (r.hint === true) {
      if (r.state === "blocked" && typeof r.message === "string" && r.message.length > 0) {
        o.hint = { message: r.message, at: this._now() };
      }
      return;
    }
    if (o.agent === "codex" && (r.state === "working" || r.state === "idle")) {
      o.hook = { state: r.state, at: this._now() };
    }
  }

  // ---- detect: one screen read from the daemon's detection loop -------------
  // d: {agent, state, visible_blocker?, visible_idle?, rule?, at?}. Applies to the
  // pane's occupant of that agent: claude/codex always, omp only while its
  // startup gate is open. Returns true when anything public changed.
  detect(paneId, d = {}) {
    const o = this._agents.get(paneId);
    if (!o || !d || o.agent !== d.agent) return false;
    if (!INTERNAL_STATES.has(d.state)) return false;
    if (o.agent === "omp" && (o.native || o.startup_gate === "clear")) return false;
    o.screen = {
      state: d.state,
      visible_blocker: d.visible_blocker === true && d.state === "blocked",
      rule: typeof d.rule === "string" ? d.rule : null,
      at: typeof d.at === "number" ? d.at : this._now(),
    };
    const before = this._seq;
    this._recompute(o);
    return this._seq !== before;
  }

  // ---- releaseNative: the process probe found the pane back at its shell ----
  // Drops a native occupant (never a connector: its wrapper releases it) and
  // keeps a stale native list from bringing it back until clearFree.
  releaseNative(paneId) {
    const o = this._agents.get(paneId);
    if (!o || o.native !== true) return false;
    this._agents.delete(paneId);
    this._free.add(paneId);
    this._seq += 1;
    return true;
  }

  // An agent process seen again in the pane: natives may come back.
  clearFree(paneId) {
    this._free.delete(paneId);
  }

  // Raw occupant fields the daemon's loops need (never shipped).
  peek(paneId) {
    const o = this._agents.get(paneId);
    if (!o) return null;
    return {
      pane_id: o.pane_id,
      terminal_id: o.terminal_id,
      agent: o.agent,
      native: o.native === true,
      launch_pending: o.launch_pending === true,
      startup_gate: o.startup_gate,
      agent_status: this._deriveStatus(o),
      screen: o.screen ? { ...o.screen } : null,
    };
  }

  get generation() {
    return this._generation;
  }

  get seq() {
    return this._seq;
  }

  _deriveStatus(o) {
    if (o.state === "blocked") return "blocked";
    if (o.state === "working") return "working";
    if (o.state === "unknown") return "unknown";
    return o.seen === false ? "done" : "idle";
  }

  // Herdr marks a whole tab seen on explicit tab focus, not just the pane.
  _isSeen(paneId, tabId) {
    if (typeof paneId === "number" && paneId === this._focusedPane) return true;
    if (this._focusedTab != null && typeof tabId === "number" && tabId === this._focusedTab) return true;
    return false;
  }

  _public(o) {
    return {
      pane_id: o.pane_id,
      terminal_id: o.terminal_id,
      name: o.name,
      agent: o.agent,
      agent_status: this._deriveStatus(o),
      state_change_seq: o.state_change_seq,
      completion_seq: o.completion_seq,
      focused: o.pane_id === this._focusedPane,
      interactive_ready: o.interactive_ready,
      launch_pending: o.launch_pending,
      message: o.message,
      agent_session: o.session ? { ...o.session } : null,
      resume_argv: o.resume_argv ? [...o.resume_argv] : null,
      workspace_id: o.workspace_id,
      tab_id: o.tab_id,
      cwd: o.cwd,
      failed: o.failed,
      source: o.source,
    };
  }

  // ---- claim: reserve a fresh identity for a pane -------------------------
  // Idempotent: claiming the same pane_id+launch_id (+agent) twice returns the
  // existing occupant instead of throwing (start pre-claims, then the wrapper
  // claims the identical tuple via request).
  claim(input = {}) {
    const { pane_id, agent, name = null, launch_id = null } = input;
    if (!isPositiveInt(pane_id)) throw new RuntimeError("invalid_pane", "pane_id must be a positive integer");
    if (!AGENTS.has(agent)) throw new RuntimeError("invalid_agent", "agent must be omp|claude|codex");
    if (typeof launch_id === "string" && launch_id.length > 0) {
      const cur = this._agents.get(pane_id);
      if (cur && cur.launch_id === launch_id) {
        if (cur.native === true || cur.agent !== agent) {
          throw new RuntimeError("agent_busy", `pane ${pane_id} already has an occupant`);
        }
        // Idempotent re-claim (start pre-claim, wrapper re-claims the tuple):
        // adopt tab/workspace/cwd discovered since the pre-claim so later
        // focus/testimony has the tab context. Revision bump, no activity.
        let rev = false;
        if (typeof input.tab_id === "number" && input.tab_id !== cur.tab_id) { cur.tab_id = input.tab_id; rev = true; }
        if (typeof input.workspace_id === "number" && input.workspace_id !== cur.workspace_id) {
          cur.workspace_id = input.workspace_id;
          rev = true;
        }
        if (typeof input.cwd === "string" && input.cwd !== cur.cwd) { cur.cwd = input.cwd; rev = true; }
        if (rev) this._seq += 1;
        return this._public(cur);
      }
    }
    let cleanName = null;
    if (name != null) {
      if (typeof name !== "string" || !NAME_RE.test(name)) {
        throw new RuntimeError("invalid_agent_name", "name must match [a-z][a-z0-9_-]{0,31}");
      }
      for (const o of this._agents.values()) {
        if (o.name === name) throw new RuntimeError("agent_name_taken", `name ${name} is taken`);
      }
      cleanName = name;
    }
    let lid = launch_id;
    if (lid == null) {
      this._claimCount += 1;
      lid = newLaunchId(pane_id, this._claimCount);
    } else {
      if (typeof lid !== "string" || lid.length === 0) {
        throw new RuntimeError("invalid_launch_id", "launch_id must be a non-empty string");
      }
      for (const o of this._agents.values()) {
        if (o.launch_id === lid) throw new RuntimeError("agent_busy", "launch_id already live");
      }
    }
    if (this._agents.has(pane_id)) throw new RuntimeError("agent_busy", `pane ${pane_id} already has an occupant`);
    this._seq += 1;
    const occupant = {
      pane_id,
      launch_id: lid,
      terminal_id: lid,
      name: cleanName,
      agent,
      source: `tern:${agent}`,
      native: false,
      // omp's extension reports from its first event; Claude and Codex are
      // unknown until their screen is read (herdr: unknown until the first
      // read after the startup grace).
      state: agent === "omp" ? "idle" : "unknown",
      message: null,
      interactive_ready: false,
      launch_pending: true,
      hasReported: false,
      session: null,
      session_epoch: 0,
      failed: false,
      seen: true, // initial idle is never done
      state_change_seq: this._seq,
      completion_seq: null,
      workspace_id: null,
      tab_id: null,
      cwd: null,
    };
    this._agents.set(pane_id, this._withInternals(occupant));
    return this._public(occupant);
  }

  // ---- report: connector state push ---------------------------------------
  report(r = {}) {
    const {
      v,
      pane_id,
      launch_id,
      source,
      agent,
      state,
      seq,
      session = null,
      session_epoch = 0,
      session_start = false,
    } = r;
    if (v !== 1) throw new RuntimeError("invalid_report", "v must be 1");
    if (!isPositiveInt(pane_id)) throw new RuntimeError("invalid_pane", "pane_id must be a positive integer");
    if (typeof launch_id !== "string" || launch_id.length === 0) {
      throw new RuntimeError("invalid_launch_id", "launch_id must be a non-empty string");
    }
    if (!(source in SOURCE_AGENT)) return { accepted: false, reason: "unknown-source" };
    if (!AGENTS.has(agent)) return { accepted: false, reason: "unknown-agent" };
    if (SOURCE_AGENT[source] !== agent) return { accepted: false, reason: "source-agent-mismatch" };
    if (!INTERNAL_STATES.has(state)) return { accepted: false, reason: "unknown-state" };
    if (!isPositiveInt(seq)) return { accepted: false, reason: "stale-seq" };
    if (!validSession(session)) return { accepted: false, reason: "invalid-session" };
    if (!Number.isSafeInteger(session_epoch) || session_epoch < 0) {
      return { accepted: false, reason: "invalid-session-epoch" };
    }
    const messageProvided = "message" in r;
    const message = r.message ?? null;
    if (messageProvided && message !== null && typeof message !== "string") {
      return { accepted: false, reason: "invalid-message" };
    }
    const readyProvided = "ready" in r;
    const resumeProvided = "resume_argv" in r;
    let resume = resumeProvided ? r.resume_argv ?? null : undefined;
    if (resumeProvided && !validResumeArgv(resume)) resume = null; // drop, keep report
    const failedProvided = "failed" in r;

    const key = `${source}\0${launch_id}`;
    const last = this._seqByKey.get(key);
    const tomb = this._tombstones.get(key);
    // A released launch_id NEVER revives: any report carrying a tombstoned
    // (source, launch_id) is a stale duplicate from the dead session, even
    // with session_start:true and a higher seq. Session switch rides the same
    // LIVE launch_id with a bigger epoch; a genuinely new process mints a NEW
    // launch_id via claim. Tombstones clear only on daemon restart (fresh
    // boot = fresh generation, no memory).
    if (session_start !== true && last !== undefined && seq <= last) {
      return { accepted: false, reason: "stale-seq" };
    }
    if (tomb !== undefined) return { accepted: false, reason: "stale-session" };
    const cur = this._agents.get(pane_id);
    if (!cur) {
      // Reports never mint a pending identity: identity comes from claim
      // (start pre-claim) or from an explicit session_start (SessionStart /
      // switch). A probe that arrives before either (ReadyProbe pre-hook) is
      // discarded, never enqueued — the surface poll re-probes every cycle,
      // so nothing is lost by dropping it.
      if (session_start !== true) return { accepted: false, reason: "no-occupant" };
      for (const o of this._agents.values()) {
        if (o.launch_id === launch_id) return { accepted: false, reason: "launch-id-elsewhere" };
      }
      this._seq += 1;
      const occupant = {
        pane_id,
        launch_id,
        terminal_id: launch_id,
        name: null,
        agent,
        source,
        native: false,
        state,
        message: messageProvided ? message : null,
        interactive_ready: readyProvided ? r.ready === true : false,
        launch_pending: readyProvided ? r.ready !== true : true,
        hasReported: true,
        session: session ? { source, agent, kind: session.kind, value: session.value } : null,
        session_epoch,
        failed: failedProvided ? r.failed === true : false,
        seen: true,
        state_change_seq: this._seq,
        completion_seq: null,
        workspace_id: null,
        tab_id: null,
        cwd: null,
      };
      this._agents.set(pane_id, this._adopt(occupant, r));
      this._seqByKey.set(key, seq);
      return { accepted: true, agent: this._public(occupant) };
    }

    if (cur.launch_id !== launch_id) {
      // Occupant switch on the same pane needs an explicit new identity.
      if (session_start !== true) return { accepted: false, reason: "pane-busy" };
      const oldKey = `${cur.source}\0${cur.launch_id}`;
      if (!this._seqByKey.has(oldKey)) this._seqByKey.set(oldKey, 0);
      this._tombstones.set(oldKey, this._seqByKey.get(oldKey));
      this._seq += 1;
      const occupant = {
        pane_id,
        launch_id,
        terminal_id: launch_id,
        name: null,
        agent,
        source,
        native: false,
        state,
        message: messageProvided ? message : null,
        interactive_ready: readyProvided ? r.ready === true : false,
        launch_pending: readyProvided ? r.ready !== true : true,
        hasReported: true,
        session_epoch,
        failed: failedProvided ? r.failed === true : false,
        seen: true,
        state_change_seq: this._seq,
        completion_seq: null,
        workspace_id: cur.workspace_id,
        tab_id: cur.tab_id,
        cwd: cur.cwd,
      };
      this._agents.set(pane_id, this._adopt(occupant, r));
      this._seqByKey.set(key, seq);
      return { accepted: true, agent: this._public(occupant) };
    }

    // Same occupant.
    if (cur.native === true) {
      // A connector takes over a natively discovered pane only as a new identity.
      if (session_start !== true) return { accepted: false, reason: "native-occupant" };
      this._seq += 1;
      const occupant = {
        pane_id,
        launch_id,
        terminal_id: launch_id,
        name: null,
        agent,
        source,
        native: false,
        state,
        message: messageProvided ? message : cur.message,
        interactive_ready: readyProvided ? r.ready === true : cur.interactive_ready,
        launch_pending: readyProvided ? r.ready !== true : cur.launch_pending,
        hasReported: true,
        session_epoch,
        failed: failedProvided ? r.failed === true : cur.failed,
        seen: true,
        state_change_seq: this._seq,
        completion_seq: null,
        workspace_id: cur.workspace_id,
        tab_id: cur.tab_id,
        cwd: cur.cwd,
      };
      this._agents.set(pane_id, this._adopt(occupant, r));
      this._seqByKey.set(key, seq);
      return { accepted: true, agent: this._public(occupant) };
    }
    if (cur.agent !== agent || cur.source !== source) {
      if (session_start !== true) return { accepted: false, reason: "identity-mismatch" };
      cur.agent = agent;
      cur.source = source;
    }

    // A report that names no session (claude/codex hooks carry it on SessionStart
    // only) keeps the current one; reports from an older session are still told
    // apart by their epoch below.
    const sessionProvided = "session" in r;
    const prevRef = sessionRefKey(cur.session);
    const nextRef = !sessionProvided ? prevRef : session ? `${session.kind}:${session.value}` : null;
    const refChanged = prevRef !== nextRef;
    if (refChanged) {
      if (session_start !== true && !(session_epoch > cur.session_epoch)) {
        return { accepted: false, reason: "stale-session" };
      }
      cur.session = session ? { source, agent, kind: session.kind, value: session.value } : null;
      cur.session_epoch = session_epoch;
      cur.failed = failedProvided ? r.failed === true : false;
      cur.seen = true;
      cur.completion_seq = null;
    } else if (session_epoch !== cur.session_epoch) {
      if (!(session_start === true && session_epoch > cur.session_epoch)) {
        return { accepted: false, reason: "stale-epoch" };
      }
      cur.session_epoch = session_epoch;
    }

    const prevResumeKey = cur.resume_argv ? JSON.stringify(cur.resume_argv) : null;
    const nextResume = resumeProvided ? resume : cur.resume_argv;
    const nextResumeKey = nextResume ? JSON.stringify(nextResume) : null;
    const nextFailed = failedProvided ? r.failed === true : cur.failed;

    if (agent !== "omp") {
      // Claude/Codex: identity, resume, failure, the Codex hook and hints. The
      // state is the screen's (and Codex's hook), arbitrated in _recompute.
      const rev = refChanged || nextResumeKey !== prevResumeKey || nextFailed !== cur.failed;
      cur.resume_argv = nextResume ?? null;
      cur.failed = nextFailed;
      cur.hasReported = true;
      this._takeHook(cur, r);
      const before = this._seq;
      this._recompute(cur);
      if (rev && this._seq === before) this._seq += 1;
      this._seqByKey.set(key, seq);
      return { accepted: true, agent: this._public(cur) };
    }

    const prevState = cur.state;
    const prevMessage = cur.message;
    const prevFailed = cur.failed;
    const prevReady = cur.interactive_ready;
    // Blocker reason is current, never stale: leaving blocked for
    // working/idle without a new message clears the old blocker text (the
    // question was resolved; the payload omits message when there is nothing
    // to say). An explicit message (incl. null) always wins. Native
    // last_message transcript is a different field, untouched.
    const leavingBlocked = prevState === "blocked" && state !== "blocked";
    const nextMessage = messageProvided ? message : (leavingBlocked ? null : cur.message);
    const reportedReady = readyProvided ? r.ready === true : cur.reported_ready;
    cur.reported_state = state;
    cur.reported_message = nextMessage;
    cur.reported_ready = reportedReady;
    // A startup dialog on screen holds the pane blocked until it goes away.
    const held = cur.startup_gate === "blocked";
    const nextReady = reportedReady && cur.startup_gate === "clear";
    const other =
      (!held && nextMessage !== prevMessage) ||
      nextFailed !== prevFailed ||
      nextReady !== prevReady ||
      nextResumeKey !== prevResumeKey ||
      refChanged;
    if (!held) cur.message = nextMessage;
    cur.failed = nextFailed;
    cur.interactive_ready = nextReady;
    cur.launch_pending = !nextReady;
    cur.resume_argv = nextResume ?? null;
    cur.hasReported = true;
    const moved = !held && this._setState(cur, state);
    if (!moved && other) {
      this._seq += 1;
      cur.state_change_seq = this._seq;
    }
    this._seqByKey.set(key, seq);
    return { accepted: true, agent: this._public(cur) };
  }

  // ---- observe: native Tern surface (agents:list + panes + focus) ------------
  // Observation: {v:1, observed_at?, generation?, seq?, focused_pane?,
  //   focused_tab?, agents:[{pane,command?,model?,cwd?,state,ready?,
  //   last_message?, delivery_error?}], panes:[{pane,tab?,session?,cwd?,alert?,
  //   last_status?|last?}]}. agents null/undefined = failed read: retain
  // everything. `ready:true` (or an idle surface) on a pending, non-blocked
  // connector occupant marks it interactive_ready (startup readiness via the
  // real surface); the reported state is never overwritten. agents [] =
  // valid empty: delete absent *native* occupants only — a live connector is
  // never deleted for missing from the native list. A brand-new publisher
  // generation with an empty list is a restart, not a mass exit: the
  // absent-native sweep waits for the stream to settle.
  // opts.sweep === false skips the absent-native sweep (multi-stream fusion:
  // the caller sweeps once against the union via sweepNativesExcept).
  observe(obs = {}, opts = {}) {
    if (!obs || obs.v !== 1) return { applied: false, reason: "invalid-observation" };
    const { agents, panes } = obs;
    if (agents == null) return { applied: false, reason: "failed-read" };
    if (!Array.isArray(agents)) return { applied: false, reason: "invalid-agents" };
    // Focus authority: only a stream that OWNS focus keys may move them. The
    // plugin always sends the real focused pane/tab; discovery (tern ls
    // probes) omits the keys, so a focus-less tick must preserve — never
    // clear — the last known focus. Otherwise a discovery pass would flip a
    // focused working->idle completion to done until the next heartbeat.
    if (typeof obs.focused_pane === "number") this._focusedPane = obs.focused_pane;
    if (typeof obs.focused_tab === "number") this._focusedTab = obs.focused_tab;

    let freshGenerationEmpty = false;
    const gen = typeof obs.generation === "string" ? obs.generation : null;
    if (gen !== null) {
      const rec = this._obsGen.get(gen) ?? { count: 0 };
      rec.count += 1;
      this._obsGen.set(gen, rec);
      if (this._obsGen.size > 8) this._obsGen.delete(this._obsGen.keys().next().value);
      freshGenerationEmpty = rec.count === 1 && agents.length === 0;
    }

    const panesById = new Map();
    if (Array.isArray(panes)) {
      for (const p of panes) {
        if (!p || typeof p !== "object") continue;
        const id = p.pane ?? p.pane_id ?? p.id;
        if (!isPositiveInt(id)) continue;
        panesById.set(id, p);
      }
    }
    const paneMeta = (id) => {
      const p = panesById.get(id);
      if (!p || typeof p !== "object") return {};
      const tab = p.tab ?? p.tab_id ?? null;
      const workspace = p.session ?? p.session_id ?? p.workspace_id ?? p.workspace ?? null;
      const cwd = typeof p.cwd === "string" ? p.cwd : null;
      const alert = p.alert === true;
      const lastStatus =
        p.last_status ?? (p.last && typeof p.last === "object" ? p.last.status : undefined);
      return {
        tab_id: typeof tab === "number" ? tab : null,
        workspace_id: typeof workspace === "number" ? workspace : null,
        cwd,
        alert,
        failed: lastStatus !== undefined && lastStatus !== null && lastStatus !== 0,
      };
    };

    // rev = enrich-only change: bump the snapshot revision (_seq) without
    // touching any occupant's state_change_seq.
    let rev = false;

    // Panes metadata enriches EVERY claimed occupant first — including panes
    // absent from the native agents list (claude/codex never appear in
    // cx.agents:list, only omp does). This runs before focus/seen so a
    // completion already has its tab context when seen is computed.
    for (const o of this._agents.values()) {
      if (o.native) continue;
      const meta = paneMeta(o.pane_id);
      if (meta.tab_id !== null && meta.tab_id !== undefined && meta.tab_id !== o.tab_id) { o.tab_id = meta.tab_id; rev = true; }
      if (meta.workspace_id !== null && meta.workspace_id !== undefined && meta.workspace_id !== o.workspace_id) {
        o.workspace_id = meta.workspace_id;
        rev = true;
      }
      if (meta.cwd !== null && meta.cwd !== o.cwd) { o.cwd = meta.cwd; rev = true; }
    }

    // Explicit focus marks done occupants seen (done -> idle), no activity bump.
    for (const o of this._agents.values()) {
      if (o.state === "idle" && o.seen === false && this._isSeen(o.pane_id, o.tab_id)) {
        o.seen = true;
        rev = true;
      }
    }

    const seenPanes = new Set();
    for (const b of agents) {
      if (!b || typeof b !== "object") continue;
      const pane = b.pane ?? b.pane_id ?? b.id;
      if (!isPositiveInt(pane)) continue;
      seenPanes.add(pane);
      const raw = b.state;
      if (raw === "exited") {
        const cur = this._agents.get(pane);
        // Only a pending occupant that never reported anything (initial claim,
        // wrapper still launching) is exempt: the wrapper has not spoken yet.
        // hasReported flips on the first accepted report of ANY state (idle
        // included: a SessionStart/ReadyProbe already established the
        // occupant). A stale native `exited` for a previous process must not
        // kill a fresh startup that already reported.
        if (cur && (cur.native || !cur.launch_pending || cur.hasReported)) {
          if (!cur.native) {
            this._tombstones.set(`${cur.source}\0${cur.launch_id}`, this._seqByKey.get(`${cur.source}\0${cur.launch_id}`) ?? 0);
          }
          this._agents.delete(pane);
          this._seq += 1;
        }
        continue;
      }
      const mapped = raw === "waiting_input" ? "blocked" : raw;
      if (mapped !== "idle" && mapped !== "working" && mapped !== "blocked" && mapped !== "unknown") continue;
      const meta = paneMeta(pane);
      const cur = this._agents.get(pane);
      if (cur) {
        // Reporter authority wins while the connector occupant lives, with one
        // evidence-based exception (see the connector branch below): the native
        // surface contributes readiness and tab/workspace/cwd. A reported
        // blocked is never overwritten by an observed idle/unknown: the
        // connector owns blockers until it clears them. The exception, with
        // real evidence: a connector occupant still `unknown` (unclassified)
        // with an observed idle surface (classified prompt box) is elevated
        // to idle — unknown means "no evidence yet", the prompt box IS the
        // evidence. working/blocked reported states are never touched.
        if (!cur.native) {
          // Adopt the tab the native block actually lives in (agents carry
          // their own pane id in b; the panes array may not cover it).
          const blockTab = typeof b.tab === "number" ? b.tab : (typeof b.tab_id === "number" ? b.tab_id : null);
          if (blockTab !== null && blockTab !== cur.tab_id) { cur.tab_id = blockTab; rev = true; }
          if (meta.tab_id !== null && meta.tab_id !== cur.tab_id) { cur.tab_id = meta.tab_id; rev = true; }
          if (meta.workspace_id !== null && meta.workspace_id !== cur.workspace_id) {
            cur.workspace_id = meta.workspace_id;
            rev = true;
          }
          if (meta.cwd !== null && meta.cwd !== cur.cwd) { cur.cwd = meta.cwd; rev = true; }
          // The native surface never decides a connector: its reports (omp) or
          // its screen (Claude/Codex, the detection loop) do. Readiness too:
          // a native idle once made an omp inside its setup wizard look ready.
          continue;
        }
        const prevTab = cur.tab_id;
        const prevWs = cur.workspace_id;
        const prevCwd = cur.cwd;
        const prevFailed = cur.failed;
        if (meta.tab_id !== null) cur.tab_id = meta.tab_id;
        if (meta.workspace_id !== null) cur.workspace_id = meta.workspace_id;
        if (meta.cwd !== null) cur.cwd = meta.cwd;
        if (meta.failed) cur.failed = true;
        if (
          cur.tab_id !== prevTab ||
          cur.workspace_id !== prevWs ||
          cur.cwd !== prevCwd ||
          cur.failed !== prevFailed
        ) {
          rev = true;
        }
        // A native Claude/Codex follows its screen (detect), not a list.
        if (cur.agent !== "omp") continue;
        const nextMessage =
          typeof b.last_message === "string"
            ? b.last_message
            : typeof b.message === "string"
              ? b.message
              : cur.message;
        const msgChanged = (nextMessage ?? null) !== cur.message;
        cur.message = nextMessage ?? null;
        if (!this._setState(cur, mapped) && msgChanged) {
          this._seq += 1;
          cur.state_change_seq = this._seq;
        }
        continue;
      }
      const kind = nativeAgent(b);
      if (kind === null) continue; // no known source: never invent an occupant
      // The process probe found this pane back at its shell: a stale list does
      // not bring the agent back (cleared when an agent is seen there again).
      if (this._free.has(pane)) continue;
      this._seq += 1;
      // Initial idle is never a completion: without a witnessed
      // working/blocked -> idle transition there is no completion_seq, so a
      // first-seen idle (alert or not) reads as idle, never done.
      const occupant = {
        pane_id: pane,
        launch_id: `native:${pane}`,
        terminal_id: `native:${pane}`,
        name: null,
        agent: kind,
        source: "native",
        native: true,
        state: mapped,
        message:
          typeof b.last_message === "string"
            ? b.last_message
            : typeof b.message === "string"
              ? b.message
              : null,
        interactive_ready: true,
        launch_pending: false,
        session: null,
        session_epoch: 0,
        failed: meta.failed,
        seen: true,
        state_change_seq: this._seq,
        completion_seq: null,
        workspace_id: meta.workspace_id,
        tab_id: meta.tab_id ?? (typeof b.tab === "number" ? b.tab : (typeof b.tab_id === "number" ? b.tab_id : null)),
        cwd: typeof b.cwd === "string" ? b.cwd : (meta.cwd ?? null),
      };
      this._withInternals(occupant);
      if (mapped === "working") occupant.acq = false;
      this._agents.set(pane, occupant);
    }

    let swept = false;
    if (opts.sweep !== false && !freshGenerationEmpty) {
      swept = this._sweepNativesExcept(seenPanes);
    }
    if (rev) this._seq += 1;
    return { applied: true, sweep: swept };
  }

  // Delete native occupants absent from keep (a Set of pane ids). Connectors
  // are never swept. Returns true when anything was deleted (and bumps _seq).
  _sweepNativesExcept(keep) {
    let n = 0;
    for (const [pane, o] of [...this._agents]) {
      if (o.native && !keep.has(pane)) {
        this._agents.delete(pane);
        n += 1;
      }
    }
    if (n > 0) this._seq += 1;
    return n > 0;
  }

  // Union sweep for multi-stream fusion: a native dies only when absent from
  // every fresh stream, so one window's empty list never sweeps another
  // stream's occupants. keepPanes: Set or array of pane ids.
  sweepNativesExcept(keepPanes) {
    const keep = keepPanes instanceof Set ? keepPanes : new Set(keepPanes ?? []);
    return { swept: this._sweepNativesExcept(keep) };
  }

  // ---- enrichFromDiscovery: ls-style discovery without agent blocks --------
  // Accepts {panes:[...]} or nested sessions->tabs->panes. Enrich-only:
  // updates tab/workspace/cwd on live occupants, never creates or deletes.
  // Unknown agent kinds are never invented from silence (no unknown occupants
  // conjured here); classification via connectors' classifySurface happens in
  // the server ingest once the discovery shape is agreed.
  enrichFromDiscovery(raw) {
    if (!raw || typeof raw !== "object") return { applied: false, reason: "invalid-discovery" };
    const entries = [];
    if (Array.isArray(raw.panes)) {
      for (const p of raw.panes) if (p && typeof p === "object") entries.push(p);
    }
    const tabs = Array.isArray(raw.tabs) ? [...raw.tabs] : [];
    if (Array.isArray(raw.sessions)) {
      for (const s of raw.sessions) {
        if (s && Array.isArray(s.tabs)) tabs.push(...s.tabs);
      }
    }
    for (const t of tabs) {
      if (t && Array.isArray(t.panes)) {
        for (const p of t.panes) if (p && typeof p === "object") entries.push(p);
      }
    }
    if (entries.length === 0) return { applied: false, reason: "no-panes" };
    let rev = false;
    for (const p of entries) {
      const id = p.pane ?? p.pane_id ?? p.id;
      if (!isPositiveInt(id)) continue;
      const cur = this._agents.get(id);
      if (!cur) continue;
      const tab = p.tab ?? p.tab_id ?? null;
      const workspace = p.session ?? p.session_id ?? p.workspace_id ?? p.workspace ?? null;
      const cwd = typeof p.cwd === "string" ? p.cwd : null;
      if (typeof tab === "number" && tab !== cur.tab_id) { cur.tab_id = tab; rev = true; }
      if (typeof workspace === "number" && workspace !== cur.workspace_id) {
        cur.workspace_id = workspace;
        rev = true;
      }
      if (cwd !== null && cwd !== cur.cwd) { cur.cwd = cwd; rev = true; }
    }
    if (rev) this._seq += 1;
    return { applied: true, enriched: rev };
  }

  // ---- release: clean exit frees occupant, name and resume ------------------
  release(input = {}) {
    const { pane_id, launch_id, source = null, seq = null } = input;
    if (!isPositiveInt(pane_id)) throw new RuntimeError("invalid_pane", "pane_id must be a positive integer");
    if (typeof launch_id !== "string" || launch_id.length === 0) {
      throw new RuntimeError("invalid_launch_id", "launch_id must be a non-empty string");
    }
    const cur = this._agents.get(pane_id);
    if (!cur) return { released: false, reason: "not-found" };
    if (cur.launch_id !== launch_id) return { released: false, reason: "stale-release" };
    if (source !== null && cur.source !== source && cur.native !== true) {
      return { released: false, reason: "source-mismatch" };
    }
    let rseq = null;
    if (seq !== null) {
      if (!isPositiveInt(seq)) throw new RuntimeError("invalid_seq", "seq must be a positive integer");
      const last = this._seqByKey.get(`${cur.source}\0${cur.launch_id}`);
      if (last !== undefined && seq < last) return { released: false, reason: "stale-seq" };
      rseq = seq;
    }
    if (!cur.native) {
      const accepted = this._seqByKey.get(`${cur.source}\0${cur.launch_id}`) ?? 0;
      this._tombstones.set(`${cur.source}\0${cur.launch_id}`, rseq !== null ? Math.max(accepted, rseq) : accepted);
    }
    this._agents.delete(pane_id);
    this._seq += 1;
    return { released: true };
  }

  get(target) {
    let pane = null;
    let name = null;
    if (typeof target === "number") pane = target;
    else if (typeof target === "string") {
      if (/^\d+$/.test(target)) pane = Number(target);
      else name = target;
    } else if (target && typeof target === "object") {
      if (target.pane_id != null) pane = target.pane_id;
      else if (target.pane != null) pane = target.pane;
      else if (typeof target.name === "string") name = target.name;
      else if (typeof target.terminal_id === "string" && target.terminal_id.startsWith("native:")) {
        pane = Number(target.terminal_id.slice("native:".length));
      }
    }
    if (pane != null) {
      if (!isPositiveInt(pane)) throw new RuntimeError("invalid_pane", "pane_id must be a positive integer");
      const o = this._agents.get(pane);
      if (!o) throw new RuntimeError("agent_not_found", `no agent on pane ${pane}`);
      return this._public(o);
    }
    if (name != null) {
      for (const o of this._agents.values()) {
        if (o.name === name) return this._public(o);
      }
      throw new RuntimeError("agent_not_found", `no agent named ${name}`);
    }
    throw new RuntimeError("invalid_target", "get needs a pane id or name");
  }

  list() {
    return [...this._agents.values()]
      .sort((a, b) => a.pane_id - b.pane_id)
      .map((o) => this._public(o));
  }

  snapshot() {
    return {
      v: 1,
      generation: this._generation,
      seq: this._seq,
      // Liveness proof for heartbeat rewrites: advances on every write even
      // when seq is unchanged. Aside watches snapshot_at, not just seq.
      snapshot_at: this._now(),
      agents: this.list(),
    };
  }
}
