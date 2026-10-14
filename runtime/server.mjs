// runtime/server.mjs — loopback daemon: sole writer/arbitrator of final state.
// Owner: RuntimeCore.
// serve({dataDir, tern?, pollMs?, classify?}) -> {dataDir, port, token, state,
// close, ingest, persist, stats}.
// RPC: POST /rpc JSON {token, method, params} ->
//      {ok:true,result} | {ok:false,error:{code,message}}.
// Methods: claim/report/release/list/get (core, from ./state.mjs),
//          read/wait/prompt/start (delegated, from ./commands.mjs — CLI owner;
//          dispatches whatever createCommands returns, returning its result
//          envelopes directly: list->{type:agent_list,...}, get->{agent_info},
//          read/wait/prompt/start as commands returns).
// Ingest loop (default 250ms, single-flight: overlapping ticks skip instead
// of piling up): plugin observation-*.json files (freshness by mtime — stale
// files are ignored, never applied; per-stream observe with sweep:false, then
// ONE union sweep so one window's empty list never sweeps another stream's
// occupants; files dead for 10 min are deleted; a chime the aside hands over in
// its observation is played here, once per seq, so the window never spawns the
// player) + tern.list() discovery every
// 2 s, or every cycle while a launch is pending (raw `tern ls`
// {sessions,detached}: meta enrichment on each discovery, explicit exited blocks, per-pane process() probing
// for occupant-less panes with wrapper-guard (launch.mjs mid-launch never
// invents an occupant), agent-kind matching so pre-existing wrapper-less
// agents are discovered with the rail closed, and capture+classifySurface
// (ThirdConnectors) for ready/state; failure retains). Persists snapshot.json
// atomically + pane-<id>.json per occupant, sweeps stale pane files, plus a
// ~5s heartbeat rewrite (snapshot_at advances even when seq is unchanged, so
// the aside's advance-based freshness keeps working). Writes are serialized
// (RPC + timer share one queue) and lastPersistedSeq tracks the captured
// snapshot's seq, never post-await state.seq. Fresh boot always starts from a
// new RuntimeState generation: previous agents never revive. timeout: client
// request() supports indefinite waits (timeout 0 disables the deadline); CLI
// sends no timeout key then.

import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, promises as fsp } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeState, RuntimeError } from "./state.mjs";
import {
  ensureDir,
  readJsonFile,
  listObservations,
  sweepPanes,
  writeEndpoint,
  writePane,
  writeSnapshot,
} from "./store.mjs";

const POLL_MS = 250;
const HEARTBEAT_MS = 5000;
const MAX_BODY_BYTES = 1 << 20;
// Observation files older than this (by mtime) are stale publishers (closed
// window): ignored, never applied, never sweeping.
const OBS_FRESH_MS = 15000;
// Observation files untouched for this long belong to a VM that is gone (a live
// rail rewrites its file at least every 5 s): deleted, so a reload per edit does
// not leave one more file for every ingest to stat forever.
const OBS_PRUNE_MS = 10 * 60 * 1000;
// `tern ls` is a process spawn that costs ~250 ms against the Tern daemon, so
// discovery runs on its own cadence, not on every ingest — except while a
// launch is pending, when `start` waits on the capture+classify it carries.
const DISCOVERY_MS = 2000;
// A chime the aside handed over plays only while this fresh next to the observation's
// own clock (`observed_at - chime.at`): heartbeats keep carrying the last chime, and a
// daemon that starts later must not replay it.
const CHIME_FRESH_MS = 2000;
// herdr's bound on a player: long enough for either mp3.
const PLAY_MS = 15000;
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

// The aside's chime, started here instead of in the window: a spawn from a window hook
// can pass Tern's 50 ms budget on its own, and one past it disables every timer of the
// plugin. Same players as sound.luau: Windows wscript + play.vbs/play.ps1 (no console
// window), macOS afplay, Linux none (the README says so).
function defaultPlayChime(kind) {
  const file = join(PLUGIN_DIR, "sounds", `${kind}.mp3`);
  if (!existsSync(file)) return;
  let cmd;
  let args;
  if (process.platform === "win32") {
    cmd = "wscript.exe";
    args = ["//Nologo", join(PLUGIN_DIR, "scripts", "play.vbs"), file, join(PLUGIN_DIR, "scripts", "play.ps1")];
  } else if (process.platform === "darwin") {
    cmd = "afplay";
    args = [file];
  } else {
    return;
  }
  try {
    const child = spawn(cmd, args, { stdio: "ignore", windowsHide: true, timeout: PLAY_MS });
    child.on("error", () => {});
    child.unref();
  } catch {
    // a player that cannot start is a missed sound, never a daemon error
  }
}
// Discovery probe budgets per ingest cycle. process() is one spawn per pane;
// capture pulls surface text. Re-probe of unchanged panes at most every
// FULL_PROBE_MS so a shell that later starts an agent is still discovered.
const PROBE_BUDGET = 6;
const CAPTURE_BUDGET = 2;
const FULL_PROBE_MS = 15000;

function tokenEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    req.on("data", (c) => {
      bytes += c.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new RuntimeError("request_too_large", "body exceeds 1MiB"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function numId(v) {
  const n = typeof v === "string" && v !== "" ? Number(v) : v;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function paneIdOf(b) {
  if (!b || typeof b !== "object") return null;
  return numId(b.pane ?? b.pane_id ?? b.id);
}

// ---- raw `tern ls` ({sessions,detached} -> tabs -> blocks) ------------------
function walkLs(raw) {
  const out = [];
  if (!raw || typeof raw !== "object") return out;
  const groups = [];
  if (Array.isArray(raw.sessions)) groups.push(raw.sessions);
  if (Array.isArray(raw.detached)) groups.push(raw.detached);
  for (const s of groups.flat()) {
    if (!s || typeof s !== "object") continue;
    const sessionId = numId(s.id ?? s.session_id ?? s.session);
    const tabs = Array.isArray(s.tabs) ? s.tabs : [];
    for (const t of tabs) {
      if (!t || typeof t !== "object") continue;
      const tabId = numId(t.id ?? t.tab_id ?? t.tab);
      const blocks = Array.isArray(t.blocks) ? t.blocks : [];
      for (const b of blocks) {
        if (!b || typeof b !== "object") continue;
        const pane = paneIdOf(b);
        if (pane === null) continue;
        out.push({ pane, tab: tabId, session: sessionId, block: b });
      }
    }
  }
  return out;
}

function blockSig(b) {
  return JSON.stringify([
    b.kind ?? null,
    b.command ?? null,
    b.program ?? null,
    b.agent_command ?? null,
    b.model ?? null,
    b.title ?? null,
    b.cwd ?? null,
    b.exited ?? null,
    b.alive ?? null,
  ]);
}

function entryMeta(e) {
  const b = e.block;
  const cwd = typeof b.cwd === "string" ? b.cwd : null;
  const last = b.last && typeof b.last === "object" ? b.last.status : undefined;
  return {
    pane: e.pane,
    tab: e.tab,
    session: e.session,
    cwd,
    alert: b.alert === true,
    last_status: last ?? b.last_status ?? b.exited ?? undefined,
  };
}

// Bounded deep scan of a process() result for human-readable command strings.
function procStrings(proc) {
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

function blockStrings(b) {
  const out = [];
  for (const k of ["command", "program", "agent_command", "model", "title"]) {
    if (typeof b[k] === "string" && b[k].length > 0) out.push(b[k]);
  }
  return out;
}

function matchAgent(strs) {
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
// agent spawns. Never mistake that mid-launch shell for a free agent pane:
// the pending claim owns the pane until the wrapper reports or releases.
function isWrapper(strs) {
  return strs.some((s) => s.includes("launch.mjs"));
}

// classifySurface contract (ThirdConnectors owner, runtime/connectors/detect.mjs):
// SYNC classifySurface(agent:'claude'|'codex', text:string) ->
// {state:'idle'|'working'|'blocked'|'unknown', rule:string|null} | null.
// Surface-only: claude idle iff bare prompt box; codex surface alone never
// yields idle (unknown). No message/ready from the classifier — readiness is
// the connector's report `ready` flag, never inferred here. serve() also
// accepts an injected classify fn (tests / overrides). Missing module = no
// surface classification (discovery falls back to 'unknown', never silence).
let classifyCache;
async function loadClassify() {
  if (classifyCache !== undefined) return classifyCache;
  try {
    const mod = await import("./connectors/detect.mjs");
    if (typeof mod.classifySurface === "function") {
      classifyCache = mod.classifySurface;
      return classifyCache;
    }
  } catch {
    // module not landed yet: discovery falls back to unknown
  }
  classifyCache = null;
  return null;
}

export async function serve({
  dataDir,
  tern = null,
  pollMs = POLL_MS,
  discoveryMs = DISCOVERY_MS,
  classify = null,
  playChime = defaultPlayChime,
} = {}) {
  if (!dataDir || typeof dataDir !== "string") throw new RuntimeError("invalid_data_dir", "dataDir required");
  // Single writer: the owner lock is acquired BEFORE any state, snapshot,
  // or HTTP exists. A concurrent serve on the same dir loses here with
  // daemon_locked instead of double-writing snapshots/endpoint.
  const { acquireLock, releaseLock } = await import("./store.mjs");
  const ticket = await acquireLock(dataDir).catch((err) => {
    if (err?.code === "daemon_locked") throw new RuntimeError("daemon_locked", err.message);
    throw err;
  });
  await ensureDir(dataDir);
  const state = new RuntimeState();
  // Commands module is CLI-owner (runtime/commands.mjs). Loaded lazily so a
  let commands = null;
  async function getCommands() {
    if (commands) return commands;
    try {
      const mod = await import("./commands.mjs");
      if (typeof mod.createCommands !== "function") {
        throw new RuntimeError("commands_unavailable", "commands.mjs has no createCommands");
      }
      commands = mod.createCommands({ state, tern, dataDir });
      return commands;
    } catch (err) {
      if (err instanceof RuntimeError) throw err;
      throw new RuntimeError("commands_unavailable", `cannot load commands.mjs: ${err?.message ?? err}`);
    }
  }

  // Serialized persistence: RPC handlers and the timer share one queue, so
  // snapshots/pane files can never interleave, and lastPersistedSeq tracks
  // the captured snapshot's seq (not post-await state.seq).
  let lastPersistedSeq = -1;
  let lastPersistedAt = 0;
  // Every pane the last discovery saw, by the CLI's pane and tab ids. Tern gives each
  // client its own pane ids (the window's plugin API names a pane differently from
  // `tern ls` and `TERN_PANE`), so the snapshot carries this index for the aside to
  // resolve each pane to its own id. A change writes the snapshot like a state change.
  let paneIndex = [];
  let paneIndexKey = "[]";
  let lastPersistedIndexKey = null;
  let writeTail = Promise.resolve();
  function persist({ heartbeat = false } = {}) {
    const run = writeTail.then(() => doPersist({ heartbeat }), () => doPersist({ heartbeat }));
    writeTail = run.catch(() => {});
    return run;
  }
  async function doPersist({ heartbeat = false } = {}) {
    const now = Date.now();
    const indexKey = paneIndexKey;
    if (state.seq === lastPersistedSeq && indexKey === lastPersistedIndexKey) {
      if (!heartbeat || now - lastPersistedAt < HEARTBEAT_MS) return { wrote: false };
    }
    const snap = { ...state.snapshot(), panes: paneIndex };
    const snapSeq = snap.seq;
    await writeSnapshot(dataDir, snap);
    await Promise.all(snap.agents.map((a) => writePane(dataDir, a)));
    await sweepPanes(dataDir, snap.agents.map((a) => a.pane_id));
    lastPersistedSeq = snapSeq;
    lastPersistedIndexKey = indexKey;
    lastPersistedAt = Date.now();
    return { wrote: true, seq: snapSeq };
  }
  await persist();

  // ---- discovery from raw `tern ls` ---------------------------------------
  const sigCache = new Map(); // pane -> blockSig already probed
  let lastFullProbe = 0;
  const stats = {
    ingestRuns: 0,
    ingestSkipped: 0,
    staleSkipped: 0,
    probed: 0,
    classified: 0,
  };

  async function discover(classifyFn) {
    let raw;
    try {
      raw = await tern.list();
    } catch {
      return { lsFresh: false };
    }
    const entries = walkLs(raw);
    const lsPanes = new Set(entries.map((e) => e.pane));
    paneIndex = entries.map((e) => ({ pane_id: e.pane, tab_id: typeof e.tab === "number" ? e.tab : null }));
    paneIndexKey = JSON.stringify(paneIndex);
    // Meta enrichment for every listed pane (free: no spawn, never creates).
    state.enrichFromDiscovery({ panes: entries.map(entryMeta) });

    const live = new Map(state.list().map((a) => [a.pane_id, a]));

    // Explicit exits: a block carrying `exited` frees a genuinely live
    // occupant. Pending (claim/start, wrapper still launching) occupants are
    // exempt — discovery shells never release a launch in flight.
    for (const e of entries) {
      const exited = e.block.exited;
      if (exited === undefined || exited === null) continue;
      const cur = live.get(e.pane);
      if (cur && (cur.launch_pending !== true)) {
        state.observe(
          { v: 1, generation: "tern-discovery", agents: [{ pane: e.pane, state: "exited" }], panes: [] },
          { sweep: false },
        );
      }
    }

    // Pending-expiry: pending occupant whose pane is absent from ls AND whose
    // process() fails is a dead launch (pane closed mid-start). Either signal
    // alone never releases: ls may be window-scoped, process may flap.
    for (const a of live.values()) {
      if (a.launch_pending !== true || lsPanes.has(a.pane_id)) continue;
      let gone = false;
      try {
        await tern.process(String(a.pane_id));
      } catch {
        gone = true;
      }
      if (gone) {
        try {
          state.release({ pane_id: a.pane_id, launch_id: a.terminal_id });
        } catch {
          // occupant already gone: nothing to free
        }
      }
    }

    // Probe occupant-less panes: new/changed blocks immediately, unchanged
    // ones on the periodic full pass. Budgeted per cycle.
    const now = Date.now();
    const full = now - lastFullProbe > FULL_PROBE_MS;
    if (full) lastFullProbe = now;
    let probes = 0;
    let captures = 0;
    const agentObs = [];
    const unionExtra = new Set();
    // Pending-pane classify (claude/codex startup readiness, rail closed):
    // the occupant-less probe below skips live panes, so a start-claimed
    // pending occupant would never get capture+classify and start would stall
    // until first Stop. This pass runs FIRST (start's 30s timeout is tighter
    // than discovery freshness) and shares the capture budget. Only
    // unknown/idle pendings are probed — working/blocked reported states are
    // never touched. Only a classified idle surface pushes {idle, ready}:
    // honest evidence only. The observe() connector branch elevates
    // unknown->idle and clears pending; a release racing this pass is
    // re-verified at push time (still live + still pending), so a dead
    // occupant can never be minted from a surface.
    for (const a of live.values()) {
      if (a.launch_pending !== true) continue; // pending => connector (natives never pend)
      if (a.agent !== "claude" && a.agent !== "codex") continue; // omp has its own extension
      if (a.agent_status !== "unknown" && a.agent_status !== "idle") continue; // never touch working/blocked
      if (captures >= CAPTURE_BUDGET) break;
      let text = "";
      try {
        const cap = await tern.capture(String(a.pane_id), { surfaces: true });
        text = cap && typeof cap.text === "string" ? cap.text : "";
      } catch {
        continue; // failure retains, retry next cycle
      }
      const cls = classifyFn ? classifyFn(a.agent, text) : null;
      if (!cls || (cls.state !== "idle" && cls.state !== "blocked")) continue; // honest evidence only
      captures += 1;
      stats.classified += 1;
      try {
        if (state.get(a.pane_id).launch_pending !== true) continue;
      } catch {
        continue; // released mid-pass: never mint from a surface
      }
      if (cls.state === "blocked") {
        agentObs.push({
          pane: a.pane_id,
          agent: a.agent,
          state: "blocked",
          message: typeof cls.rule === "string" ? cls.rule : "awaiting input",
        });
      } else {
        agentObs.push({ pane: a.pane_id, agent: a.agent, state: "idle", ready: true });
      }
      unionExtra.add(a.pane_id);
    }

    for (const e of entries) {
      if (live.has(e.pane)) continue;
      const sig = blockSig(e.block);
      if (!full && sigCache.get(e.pane) === sig) continue;
      if (probes >= PROBE_BUDGET) break;
      probes += 1;
      sigCache.set(e.pane, sig);
      let proc = null;
      try {
        proc = await tern.process(String(e.pane));
      } catch {
        continue; // pane unreadable this cycle: retain, retry later
      }
      const strs = procStrings(proc);
      if (isWrapper(strs)) continue; // mid-launch: pending claim lives on
      const agent = matchAgent(strs) ?? matchAgent(blockStrings(e.block)) ?? (e.block.kind === "agent" ? "omp" : null);
      if (!agent) continue; // free shell: never invent an occupant from silence
      let st = "unknown";
      let rule = null;
      // Classifier is surface-only for claude/codex (detect.mjs). omp native
      // state comes from the connector hook + waiting_input, never from a
      // text classifier: probing an omp occupant-less pane yields unknown
      // (present, unclassified) until its reporter speaks.
      if ((agent === "claude" || agent === "codex") && classifyFn && captures < CAPTURE_BUDGET) {
        try {
          const cap = await tern.capture(String(e.pane), { surfaces: true });
          const text = cap && typeof cap.text === "string" ? cap.text : "";
          const cls = classifyFn(agent, text);
          if (cls && typeof cls.state === "string") {
            st = cls.state;
            rule = typeof cls.rule === "string" ? cls.rule : null;
            captures += 1;
            stats.classified += 1;
          }
        } catch {
          // capture/classify failure: keep unknown, retry on next full pass
        }
      }
      agentObs.push({
        pane: e.pane,
        agent, // verified against the live foreground process (matchAgent)
        command: blockStrings(e.block)[0] ?? strs[0] ?? agent,
        model: typeof e.block.model === "string" ? e.block.model : undefined,
        cwd: typeof e.block.cwd === "string" ? e.block.cwd : undefined,
        state: st,
        ...(rule !== null ? { rule } : {}),
      });
    }
    stats.probed += probes;
    for (const k of [...sigCache.keys()]) {
      if (!lsPanes.has(k)) sigCache.delete(k);
    }
    return { lsFresh: true, lsPanes, agentObs, unionExtra };
  }

  const observedFiles = new Map(); // name -> mtimeMs already ingested
  // The last chime seq played per publisher generation: a chime plays once.
  const chimeSeen = new Map();
  function maybeChime(raw) {
    const c = raw?.chime;
    if (!c || typeof c !== "object" || typeof c.seq !== "number") return;
    if (c.kind !== "done" && c.kind !== "request") return;
    const gen = typeof raw.generation === "string" ? raw.generation : "";
    if ((chimeSeen.get(gen) ?? 0) >= c.seq) return;
    chimeSeen.set(gen, c.seq);
    if (chimeSeen.size > 16) chimeSeen.delete(chimeSeen.keys().next().value);
    if (typeof raw.observed_at !== "number" || typeof c.at !== "number") return;
    if (raw.observed_at - c.at > CHIME_FRESH_MS) return;
    try {
      playChime(c.kind);
    } catch {
      // a missed sound, never an ingest failure
    }
  }
  // The last discovery that answered: when, and the panes it keeps alive. The
  // cycles in between reuse that keep set, so a native only discovery sees is
  // never swept by a cycle that did not look.
  let lastDiscovery = { at: -Infinity, keep: null };
  function discoveryDue(now) {
    if (now - lastDiscovery.at >= discoveryMs) return true;
    return state.list().some((a) => a.launch_pending === true);
  }
  let ingesting = false; // single-flight: overlapping ticks skip, never pile up
  async function ingest() {
    if (ingesting) {
      stats.ingestSkipped += 1;
      return;
    }
    ingesting = true;
    try {
      stats.ingestRuns += 1;
      const now = Date.now();
      const entries = await listObservations(dataDir);
      const unionKeep = new Set();
      let freshStreams = 0;
      let allEmptyFresh = true;
      for (const { name, path, mtimeMs } of entries) {
        if (now - mtimeMs > OBS_PRUNE_MS) {
          await fsp.unlink(path).catch(() => {});
          observedFiles.delete(name);
          continue;
        }
        if ((observedFiles.get(name) ?? -1) >= mtimeMs) continue;
        observedFiles.set(name, mtimeMs);
        if (now - mtimeMs > OBS_FRESH_MS) {
          stats.staleSkipped += 1;
          continue; // stale publisher: ignore, never apply, never sweep
        }
        let raw;
        try {
          raw = await readJsonFile(path);
        } catch {
          continue; // invalid file: retain previous state
        }
        maybeChime(raw);
        const r = state.observe(raw, { sweep: false });
        if (!r.applied) continue;
        freshStreams += 1;
        const agents = Array.isArray(raw.agents) ? raw.agents : [];
        if (agents.length > 0) allEmptyFresh = false;
        for (const b of agents) {
          if (b?.state === "exited") continue;
          const p = paneIdOf(b);
          if (p !== null) unionKeep.add(p);
        }
      }
      // Drop tracking for deleted observation files.
      const listed = new Set(entries.map((e) => e.name));
      for (const name of [...observedFiles.keys()]) {
        if (!listed.has(name)) observedFiles.delete(name);
      }
      if (tern && typeof tern.list === "function" && !discoveryDue(now)) {
        // Between discoveries: the last answer still stands for the sweep while
        // it is fresh, exactly as a fresh observation stream would.
        if (lastDiscovery.keep && now - lastDiscovery.at <= OBS_FRESH_MS) {
          freshStreams += 1;
          allEmptyFresh = false;
          for (const p of lastDiscovery.keep) unionKeep.add(p);
        }
      } else if (tern && typeof tern.list === "function") {
        const classifyFn = classify ?? (await loadClassify());
        const d = await discover(classifyFn);
        if (d.lsFresh) {
          const keep = new Set([...d.lsPanes, ...(d.unionExtra ?? []), ...d.agentObs.map((b) => b.pane)]);
          lastDiscovery = { at: now, keep };
          freshStreams += 1;
          // ls trees carry no agent signal by themselves: listed panes are
          // kept (a pane that still exists never sweeps), vanished panes
          // fall out of the union and their natives die.
          for (const p of d.lsPanes) unionKeep.add(p);
          for (const p of d.unionExtra ?? []) unionKeep.add(p);
          allEmptyFresh = false;
          if (d.agentObs.length > 0) {
            state.observe(
              {
                v: 1,
                generation: "tern-discovery",
                focused_pane: null,
                focused_tab: null,
                agents: d.agentObs,
                panes: [],
              },
              { sweep: false },
            );
            for (const b of d.agentObs) unionKeep.add(b.pane);
          }
        }
      }
      // One union sweep: a native dies only when absent from EVERY fresh
      // stream. No fresh streams, or all fresh streams brand-new-empty
      // (restarting publishers), means no sweep at all.
      if (freshStreams > 0 && !allEmptyFresh) state.sweepNativesExcept(unionKeep);
      // The aside reads only snapshot.json: write what changed, or rewrite it on the
      // ~5 s heartbeat so `snapshot_at` keeps advancing while nothing changes.
      if (state.seq !== lastPersistedSeq || paneIndexKey !== lastPersistedIndexKey) await persist();
      else await persist({ heartbeat: true });
    } finally {
      ingesting = false;
    }
  }

  async function dispatch(method, params) {
    switch (method) {
      case "claim":
        return state.claim(params ?? {});
      case "report": {
        return state.report(params ?? {});
      }
      case "release":
        return state.release(params ?? {});
      case "list":
        return state.list();
      case "get":
        return state.get(params?.target ?? params);
      case "read":
      case "wait":
      case "prompt":
      case "start": {
        const cmds = await getCommands();
        if (typeof cmds[method] !== "function") {
          throw new RuntimeError("unknown_method", `unknown method ${method}`);
        }
        return cmds[method](params ?? {});
      }
      default:
        throw new RuntimeError("unknown_method", `unknown method ${method}`);
    }
  }

  const token = randomBytes(16).toString("hex");
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
      sendJson(res, 200, { ok: true, result: { v: 1, generation: state.generation, seq: state.seq } });
      return;
    }
    if (req.method !== "POST" || (req.url !== "/rpc" && req.url !== "/")) {
      sendJson(res, 405, { ok: false, error: { code: "method_not_allowed", message: "POST /rpc only" } });
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { ok: false, error: { code: "bad_request", message: "invalid JSON" } });
      return;
    }
    if (!tokenEqual(body?.token, token)) {
      sendJson(res, 403, { ok: false, error: { code: "forbidden", message: "bad token" } });
      return;
    }
    try {
      const result = await dispatch(body?.method, body?.params);
      if (["claim", "report", "release"].includes(body?.method)) await persist();
      sendJson(res, 200, { ok: true, result: result ?? null });
    } catch (err) {
      const code = err instanceof RuntimeError ? err.code : "internal";
      sendJson(res, 200, { ok: false, error: { code, message: err?.message ?? String(err) } });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await writeEndpoint(dataDir, { v: 1, port, token, pid: process.pid });

  const timer = setInterval(() => {
    ingest().catch(() => {});
  }, pollMs);
  timer.unref?.();

  // Crash-signal cleanup: release the owner lock so the next boot takes over
  // without waiting out the TTL. once + removeListener-safe: close() guards.
  const onSignal = () => {
    clearInterval(timer);
    releaseLock(dataDir, ticket).catch(() => {});
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await new Promise((r) => server.close(r));
    // Remove endpoint so a stale port is never trusted after graceful stop.
    try {
      await fsp.unlink(join(dataDir, "endpoint.json"));
    } catch {}
    await releaseLock(dataDir, ticket).catch(() => {});
  }

  return { dataDir, port, token, state, close, ingest, persist, stats, owner: ticket };
}
