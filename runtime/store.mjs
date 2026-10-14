// runtime/store.mjs — data-dir layout + atomic persistence.
// Owner: RuntimeCore (single resolver; import it directly from here).
// Layout inside dataDir:
//   snapshot.json            atomic, Node is the sole writer ({v,generation,seq,snapshot_at,agents})
//   pane-<pane_id>.json      atomic, one per live occupant (same AgentInfo shape)
//   observation-<id>.json    written by the plugin (its own writer), read by Node
//   endpoint.json            atomic, {v:1, port, token} for loopback auth
//   hooks/                   connector-owned seq/epoch files (server ignores them)
// Default (no override, no env): OUTSIDE the Tern config tree, as an isolation
// decision (keeps runtime file churn out of config):
//   <local>/tern-agent-runtime/<djb2hex(plugin-data-dir)>
// where <local> = %LOCALAPPDATA% (win32) | ~/.local/share (posix), and the hash
// input is the config-specific plugin data dir
// (<config>/plugin-data/workspaces-sidebar, forward slashes, lowercased on
// win32). djb2 over (numeric * 33) exact below 2^38 with a % 4294967296 fold,
// matching the Luau bridge. --data-dir / TERN_AGENT_RUNTIME_DIR still win
// (lab + tests); any explicit override is honored verbatim.
// No resurrection: server boots with a fresh RuntimeState (new generation) and
// overwrites snapshot.json; stale pane-*.json files are swept on first write.

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const SNAPSHOT_FILE = "snapshot.json";
export const ENDPOINT_FILE = "endpoint.json";

// djb2 over UTF-8 BYTES (Buffer.from(input, "utf8")), one % 4294967296 fold
// per byte: identical to the Luau bridge (string.byte loop over the UTF-8
// encoding). charCodeAt (UTF-16 units) diverges on non-ASCII paths (José,
// emoji), splitting the daemon dir. Returns 8 lowercase hex digits.
export function djb2hex(input) {
  const bytes = Buffer.from(String(input), "utf8");
  let h = 5381;
  for (let i = 0; i < bytes.length; i += 1) {
    h = (h * 33 + bytes[i]) % 4294967296;
  }
  return h.toString(16).padStart(8, "0");
}

// Normalize for hashing: backslashes to slashes, then ASCII-only lowercase on
// Windows ([A-Z] -> a-z). Full Unicode toLowerCase diverges from Luau
// string.lower (ASCII bytes only); non-ASCII bytes hash verbatim on both
// sides. All existing ASCII hashes unchanged.
export function normalizeHashInput(p) {
  const s = String(p).replace(/\\/g, "/");
  if (process.platform === "win32") return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  return s;
}

export function defaultConfigDir() {
  const override = process.env.TERN_CONFIG_DIR;
  if (override && override.length > 0) return override;
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (local) return join(local, "Tern");
    return join(tmpdir(), "tern");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) return join(xdg, "tern");
  const home = process.env.HOME ?? tmpdir();
  return join(home, ".config", "tern");
}

export function localDataRoot() {
  if (process.platform === "win32") {
    if (process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA;
    return tmpdir();
  }
  if (process.platform === "darwin") {
    const home = process.env.HOME ?? tmpdir();
    return join(home, "Library", "Application Support");
  }
  if (process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.length > 0) {
    return process.env.XDG_DATA_HOME;
  }
  const home = process.env.HOME ?? tmpdir();
  return join(home, ".local", "share");
}

export function pluginDataDir(configDir = null) {
  const cfg = configDir ?? defaultConfigDir();
  return join(cfg, "plugin-data", "workspaces-sidebar");
}

// Config-specific external default: stable per config dir, outside the
// config watcher tree.
export function defaultExternalDir(configDir = null) {
  const key = djb2hex(normalizeHashInput(pluginDataDir(configDir)));
  return join(localDataRoot(), "tern-agent-runtime", key);
}

// Explicit --data-dir wins; then TERN_AGENT_RUNTIME_DIR; then the external
// hashed default (isolation decision: runtime churn lives outside the config
// tree).
export function resolveDataDir(override = null) {
  if (override) return resolve(override);
  const fromEnv = process.env.TERN_AGENT_RUNTIME_DIR;
  if (fromEnv && fromEnv.length > 0) return resolve(fromEnv);
  return resolve(defaultExternalDir());
}

export async function ensureDir(dir, mode = undefined) {
  await fs.mkdir(dir, mode === undefined ? { recursive: true } : { recursive: true, mode });
  return dir;
}

function tmpName(file) {
  const uniq = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  return `${file}.tmp-${uniq}`;
}

export async function atomicWrite(file, text, mode = undefined) {
  await ensureDir(join(file, ".."), mode === 0o600 ? 0o700 : undefined);
  const tmp = tmpName(file);
  if (mode === undefined) await fs.writeFile(tmp, text, "utf8");
  else await fs.writeFile(tmp, text, { encoding: "utf8", mode });
  await fs.rename(tmp, file);
}

export async function writeSnapshot(dataDir, snapshot) {
  await atomicWrite(join(dataDir, SNAPSHOT_FILE), JSON.stringify(snapshot));
}

export function paneFile(dataDir, paneId) {
  return join(dataDir, `pane-${paneId}.json`);
}

export async function writePane(dataDir, agent) {
  await atomicWrite(paneFile(dataDir, agent.pane_id), JSON.stringify(agent));
}

export async function removePane(dataDir, paneId) {
  try {
    await fs.unlink(paneFile(dataDir, paneId));
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
}

// Delete pane files with no live occupant (stale after restart/crash).
export async function sweepPanes(dataDir, livePaneIds) {
  let entries;
  try {
    entries = await fs.readdir(dataDir);
  } catch (err) {
    if (err?.code === "ENOENT") return;
    throw err;
  }
  const live = new Set([...livePaneIds].map(String));
  await Promise.all(
    entries
      .filter((n) => /^pane-\d+\.json$/.test(n))
      .filter((n) => !live.has(n.slice("pane-".length, -".json".length)))
      .map((n) => removePane(dataDir, n.slice("pane-".length, -".json".length))),
  );
}

export async function writeEndpoint(dataDir, endpoint) {
  // Bearer token: owner-only on POSIX (0600 file, 0700 dir). No-op on Windows.
  await atomicWrite(join(dataDir, ENDPOINT_FILE), JSON.stringify(endpoint), 0o600);
}

export const LOCK_FILE = "daemon.lock";
const LOCK_TTL_MS = 10000;

function lockPath(dataDir) {
  return join(dataDir, LOCK_FILE);
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseLock(raw) {
  try {
    const o = JSON.parse(raw);
    if (o && Number.isInteger(o.pid) && typeof o.nonce === "string") return o;
  } catch {}
  return null;
}

// In-process owner registry: same-process serve() calls share the event loop,
// so a second serve on a live dir must fail fast with daemon_locked instead
// of taking over its own file lock (that path is only for sequential
// serve/close/serve after releaseLock removed the entry).
const liveOwners = new Map(); // resolved dataDir -> nonce

// Single-owner lock per dataDir, acquired BEFORE any state/snapshot/HTTP
// starts. Boring file lock: atomic "wx" create wins; the loser re-reads.
// A lock whose owner is dead (kill(pid,0) fails) may be taken over — but a
// freshly-written lock (mtime within TTL) is NEVER assumed stale: the owner
// may simply not have written its endpoint yet, so the loser waits instead
// of deleting a live owner's lock. Returns {held, pid, nonce} on success.
export async function acquireLock(dataDir, { ttlMs = LOCK_TTL_MS } = {}) {
  const key = resolve(dataDir);
  if (liveOwners.has(key)) {
    const e = new Error("daemon already running for this data dir");
    e.code = "daemon_locked";
    e.ownerPid = process.pid;
    throw e;
  }
  await ensureDir(dataDir);
  const path = lockPath(dataDir);
  const nonce = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const body = JSON.stringify({ v: 1, pid: process.pid, nonce, at: Date.now() });
  try {
    await fs.writeFile(path, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
    liveOwners.set(key, nonce);
    return { held: true, pid: process.pid, nonce };
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
  }
  const deadline = Date.now() + ttlMs;
  for (;;) {
    let raw = null;
    let mtime = 0;
    try {
      raw = await fs.readFile(path, "utf8");
      mtime = (await fs.stat(path)).mtimeMs;
    } catch (err) {
      if (err?.code === "ENOENT") {
        try {
          await fs.writeFile(path, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
          liveOwners.set(key, nonce);
          return { held: true, pid: process.pid, nonce };
        } catch (retry) {
          if (retry?.code !== "EEXIST") throw retry;
          continue;
        }
      }
      throw err;
    }
    const cur = parseLock(raw);
    const alive = cur ? isAlive(cur.pid) : false;
    const fresh = Date.now() - mtime < ttlMs;
    // A LIVE owner means a running daemon: fail fast (concurrent serve is a
    // caller error, not a wait). Same-process re-entry is handled by the
    // liveOwners registry at the top, never by file takeover.
    if (cur && alive) {
      const e = new Error("daemon already running for this data dir");
      e.code = "daemon_locked";
      e.ownerPid = cur.pid;
      throw e;
    }
    if (cur && fresh) {
      if (Date.now() >= deadline) {
        const e = new Error("lock held by starting daemon");
        e.code = "daemon_locked";
        e.ownerPid = cur.pid;
        throw e;
      }
      await new Promise((r) => setTimeout(r, 50));
      continue;
    }
    // Dead owner AND stale file: take over atomically (rename wins).
    const tmp = `${path}.takeover-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
    try {
      await fs.rename(tmp, path);
    } catch {
      try { await fs.unlink(tmp); } catch {}
      continue;
    }
    // Re-validate: we own it only if our nonce survived the race.
    try {
      raw = await fs.readFile(path, "utf8");
    } catch {
      continue;
    }
    const check = parseLock(raw);
    if (check && check.nonce === nonce && check.pid === process.pid) {
      liveOwners.set(key, nonce);
      return { held: true, pid: process.pid, nonce };
    }
  }
}

export async function releaseLock(dataDir, ticket) {
  if (!ticket?.held) return;
  liveOwners.delete(resolve(dataDir));
  try {
    const raw = await fs.readFile(lockPath(dataDir), "utf8");
    const cur = parseLock(raw);
    if (cur && cur.nonce === ticket.nonce && cur.pid === process.pid) {
      await fs.unlink(lockPath(dataDir));
    }
  } catch {}
}
export async function readEndpoint(dataDir) {
  const raw = await fs.readFile(join(dataDir, ENDPOINT_FILE), "utf8");
  const ep = JSON.parse(raw);
  if (!ep || typeof ep !== "object" || !Number.isInteger(ep.port) || typeof ep.token !== "string") {
    throw new Error("invalid endpoint.json");
  }
  return ep;
}

export async function waitForEndpoint(dataDir, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    try {
      return await readEndpoint(dataDir);
    } catch (err) {
      if (err?.code !== "ENOENT" && err?.message !== "invalid endpoint.json") throw err;
      if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for endpoint.json");
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

// Observation files published by the plugin (its own writer). Returns entries
// with mtime for freshness; read errors are reported per-file, never thrown.
export async function listObservations(dataDir) {
  let entries;
  try {
    entries = await fs.readdir(dataDir);
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const obs = entries.filter((n) => n.startsWith("observation-") && n.endsWith(".json")).sort();
  const out = [];
  for (const name of obs) {
    const path = join(dataDir, name);
    try {
      const st = await fs.stat(path);
      out.push({ name, path, mtimeMs: st.mtimeMs });
    } catch {
      // Raced deletion: skip.
    }
  }
  return out;
}

export async function readJsonFile(path, maxBytes = 65536) {
  const st = await fs.stat(path);
  if (st.size > maxBytes) throw new Error("observation too large");
  const raw = await fs.readFile(path, "utf8");
  return JSON.parse(raw);
}
