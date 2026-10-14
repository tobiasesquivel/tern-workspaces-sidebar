// runtime/server.mjs — loopback daemon: sole writer/arbitrator of final state.
// Owner: RuntimeCore.
// serve({dataDir, tern?, pollMs?, classify?, detection?, notifyDelayMs?}) ->
// {dataDir, port, token, state, close, ingest, persist, stats, detection, notifier}.
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
// occupants; files dead for 10 min are deleted; the rail's `sound` flag mutes
// the notifier) + tern.list() discovery every 2 s (raw `tern ls`
// {sessions,detached}: meta enrichment and titles on each discovery, explicit
// exited blocks, per-pane process() probing for occupant-less panes with
// wrapper-guard (launch.mjs mid-launch never invents an occupant), agent-kind
// matching so agents opened by hand are discovered with the rail closed; a
// pane back at its shell is never an agent; failure retains). Beside it run
// the detection loop (./detection.mjs: herdr's screen and process loop over
// `tern capture`/`tern process`, with titles from `tern events`) and the
// notifier (./notify.mjs: herdr's sounds, 1 s delay). Persists snapshot.json
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
import { createDetectionLoop, interpretProcess } from "./detection.mjs";
import { createNotifier } from "./notify.mjs";
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
// discovery runs on its own cadence, not on every ingest. A pending launch is
// the detection loop's: it probes the pane until the agent is there.
const DISCOVERY_MS = 2000;
// herdr's bound on a player: long enough for either mp3.
const PLAY_MS = 15000;
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

// The notifier's player, started here instead of in the window: a spawn from a window
// hook can pass Tern's 50 ms budget on its own, and one past it disables every timer of
// the plugin. Same players as sound.luau: Windows wscript + play.vbs/play.ps1 (no
// console window), macOS afplay, Linux none (the README says so).
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
// Discovery probe budget per ingest cycle: process() is one spawn per pane.
// Re-probe of unchanged panes at most every FULL_PROBE_MS so a shell that later
// starts an agent is still discovered.
const PROBE_BUDGET = 6;
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

function blockStrings(b) {
  const out = [];
  for (const k of ["command", "program", "agent_command", "model", "title"]) {
    if (typeof b[k] === "string" && b[k].length > 0) out.push(b[k]);
  }
  return out;
}


// Titles from `tern events` (one long-lived child, never a hook): the OSC title
// region of herdr's manifests and the activity signal of the detection loop.
// Restarts after a pause when the child ends; a tern without `events` (tests,
// older builds) leaves titles to discovery's `tern ls`.
const TITLE_RESTART_MS = 5000;
function followTitles(tern, onTitle) {
  let child = null;
  let stopped = false;
  let timer = null;
  const begin = () => {
    if (stopped) return;
    try {
      child = tern.events(["title_changed"]);
    } catch {
      child = null;
    }
    if (!child || !child.stdout) {
      timer = setTimeout(begin, TITLE_RESTART_MS);
      timer.unref?.();
      return;
    }
    let buf = "";
    child.stdout.setEncoding?.("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          const pane = numId(ev?.pane);
          if (ev?.event === "title_changed" && pane !== null && typeof ev.title === "string") onTitle(pane, ev.title);
        } catch {
          // a line that is not JSON is skipped
        }
      }
    });
    child.on("error", () => {});
    child.on("exit", () => {
      child = null;
      if (stopped) return;
      timer = setTimeout(begin, TITLE_RESTART_MS);
      timer.unref?.();
    });
  };
  begin();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    try {
      child?.kill();
    } catch {}
  };
}

export async function serve({
  dataDir,
  tern = null,
  pollMs = POLL_MS,
  discoveryMs = DISCOVERY_MS,
  classify = null,
  playChime = defaultPlayChime,
  detection: detectionEnabled = true,
  notifyDelayMs = undefined,
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
  // The sounds are the daemon's (./notify.mjs): it sees every transition and
  // starts the player outside the window. The rail's `sound` flag mutes them.
  let soundOn = true;
  const notifier = createNotifier({
    state,
    play: (kind) => playChime(kind),
    muted: () => !soundOn,
    ...(typeof notifyDelayMs === "number" ? { delayMs: notifyDelayMs } : {}),
  });
  // The detection loop (./detection.mjs): screens and processes of the agent
  // panes, read through the tern CLI. Its timer runs unless a test drives it.
  const detection =
    tern && typeof tern.capture === "function" && typeof tern.process === "function"
      ? createDetectionLoop({ state, tern, ...(classify ? { classify } : {}) })
      : null;
  if (detection && detectionEnabled) detection.start();
  const stopTitles =
    detection && detectionEnabled && typeof tern.events === "function"
      ? followTitles(tern, (pane, title) => detection.noteTitle(pane, title))
      : () => {};
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
  };

  async function discover() {
    let raw;
    try {
      raw = await tern.list();
    } catch {
      return { lsFresh: false };
    }
    const entries = walkLs(raw);
    const lsPanes = new Set(entries.map((e) => e.pane));
    // Titles as `tern ls` has them: the OSC title region until `tern events`
    // brings a newer one.
    if (detection) {
      for (const e of entries) {
        if (typeof e.block.title === "string") detection.setTitle(e.pane, e.block.title);
      }
    }
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
    // ones on the periodic full pass. Budgeted per cycle. A pane whose process
    // names an agent becomes a native occupant, `unknown` until the detection
    // loop reads its screen after herdr's startup grace (Claude/Codex) or the
    // rail's list speaks for it (omp).
    const now = Date.now();
    const full = now - lastFullProbe > FULL_PROBE_MS;
    if (full) lastFullProbe = now;
    let probes = 0;
    const agentObs = [];
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
      const r = interpretProcess(proc);
      if (r.wrapper && !r.agent) continue; // mid-launch: pending claim lives on
      // A pane back at its own shell has no agent, whatever its block still
      // says (Tern kept `kind: "agent"` on a pane omp had left: the old
      // fallback minted a native omp there that blocked `start` forever).
      if (r.free || !r.agent) continue;
      state.clearFree(e.pane);
      agentObs.push({
        pane: e.pane,
        agent: r.agent, // verified against the live foreground process
        command: blockStrings(e.block)[0] ?? r.agent,
        model: typeof e.block.model === "string" ? e.block.model : undefined,
        cwd: typeof e.block.cwd === "string" ? e.block.cwd : undefined,
        state: "unknown",
      });
    }
    stats.probed += probes;
    for (const k of [...sigCache.keys()]) {
      if (!lsPanes.has(k)) sigCache.delete(k);
    }
    return { lsFresh: true, lsPanes, agentObs };
  }

  const observedFiles = new Map(); // name -> mtimeMs already ingested
  // The rail's sound switch rides its observation (`sound: false` mutes). A
  // `chime` an older rail still hands over is not played: the notifier already
  // chimed that transition, after herdr's delay.
  function takeSoundFlag(raw) {
    if (typeof raw?.sound === "boolean") soundOn = raw.sound;
  }
  // The last discovery that answered: when, and the panes it keeps alive. The
  // cycles in between reuse that keep set, so a native only discovery sees is
  // never swept by a cycle that did not look.
  let lastDiscovery = { at: -Infinity, keep: null };
  function discoveryDue(now) {
    return now - lastDiscovery.at >= discoveryMs;
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
        takeSoundFlag(raw);
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
        const d = await discover();
        if (d.lsFresh) {
          const keep = new Set([...d.lsPanes, ...d.agentObs.map((b) => b.pane)]);
          lastDiscovery = { at: now, keep };
          freshStreams += 1;
          // ls trees carry no agent signal by themselves: listed panes are
          // kept (a pane that still exists never sweeps), vanished panes
          // fall out of the union and their natives die.
          for (const p of d.lsPanes) unionKeep.add(p);
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
    detection?.stop();
    stopTitles();
    releaseLock(dataDir, ticket).catch(() => {});
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    detection?.stop();
    stopTitles();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await new Promise((r) => server.close(r));
    // Remove endpoint so a stale port is never trusted after graceful stop.
    try {
      await fsp.unlink(join(dataDir, "endpoint.json"));
    } catch {}
    await releaseLock(dataDir, ticket).catch(() => {});
  }

  return { dataDir, port, token, state, close, ingest, persist, stats, owner: ticket, detection, notifier };
}
