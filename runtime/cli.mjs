// CLI: `node runtime/cli.mjs <command> [args] [flags]`.
//
// Commands (herdr-compatible surface):
//   ensure                    spawn daemon detached when needed, wait for endpoint
//   serve                     run daemon in foreground (smoke/diagnostics)
//   list [--json] [--data-dir DIR]
//   get <target> [--json] [--data-dir DIR]
//   read <target> [--source S] [--lines N] [--format text|ansi] [--ansi]
//        [--json] [--data-dir DIR]            (prints plain text unless --json)
//   wait <target> [--until S]... [--timeout MS] [--json] [--data-dir DIR]
//   prompt <target> <text> [--wait] [--until S]... [--timeout MS] [--json]
//   start <name> --kind KIND --pane ID [--timeout MS] [--json] [--data-dir DIR]
//         [-- AGENT_ARGS...]
//
// Global flags: --data-dir DIR, --json, --timeout MS (where applicable),
// --window KEY (forwarded to tern for pane commands), --tern-bin PATH.
// Exit codes: 0 success, 1 server error (stderr JSON envelope), 2 usage.
//
// list/get/read/wait/prompt/start run against the daemon via endpoint
// request(). ensure/serve manage the daemon process itself.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTernBinary } from './tern.mjs';
import { resolveDataDir } from './store.mjs';

const CLI_IDS = {
  ensure: 'cli:ensure',
  serve: 'cli:serve',
  list: 'cli:agent:list',
  get: 'cli:agent:get',
  read: 'cli:agent:read',
  wait: 'cli:agent:wait',
  prompt: 'cli:agent:prompt',
  start: 'cli:agent:start',
};

const VALID_STATUSES = ['idle', 'working', 'blocked', 'done', 'unknown'];
const VALID_SOURCES = ['visible', 'recent', 'recent-unwrapped', 'detection'];
const VALID_FORMATS = ['text', 'ansi'];
const START_KINDS = ['omp', 'claude', 'codex'];

const ENSURE_TIMEOUT_DEFAULT = 15000;
const POLL_MS = 100;

function usageError(message) {
  const err = new Error(message);
  err.code = 'usage';
  return err;
}

function parseArgs(argv) {
  const positional = [];
  const flags = { until: [] };
  let endOfFlags = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (endOfFlags) {
      positional.push(arg);
      continue;
    }
    if (arg === '--') {
      endOfFlags = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const inline = eq === -1 ? null : arg.slice(eq + 1);
      const takeValue = (name) => {
        if (inline !== null) return inline;
        const next = argv[++i];
        if (next === undefined) throw usageError(`missing value for --${name}`);
        return next;
      };
      switch (key) {
        case 'json':
        case 'wait':
        case 'ansi':
          if (inline !== null) throw usageError(`--${key} takes no value`);
          flags[key] = true;
          break;
        case 'until':
          flags.until.push(takeValue('until'));
          break;
        case 'source':
        case 'lines':
        case 'format':
        case 'timeout':
        case 'kind':
        case 'pane':
        case 'data-dir':
        case 'window':
        case 'tern-bin':
          flags[key] = takeValue(key);
          break;
        default:
          throw usageError(`unknown flag --${key}`);
      }
      continue;
    }
    positional.push(arg);
  }
  return { positional, flags };
}

function usage() {
  return `Usage:
  node runtime/cli.mjs ensure [--data-dir DIR] [--timeout MS]
  node runtime/cli.mjs serve [--data-dir DIR]
  node runtime/cli.mjs list [--json]
  node runtime/cli.mjs get <target> [--json]
  node runtime/cli.mjs read <target> [--source visible|recent|recent-unwrapped|detection] [--lines N] [--format text|ansi] [--ansi] [--json]
  node runtime/cli.mjs wait <target> [--until STATUS]... [--timeout MS] [--json]
  node runtime/cli.mjs prompt <target> <text> [--wait] [--until STATUS]... [--timeout MS] [--json]
  node runtime/cli.mjs start <name> --kind omp|claude|codex --pane ID [--timeout MS] [--json] [-- AGENT_ARGS...]

STATUS is one of idle|working|blocked|done|unknown. Global flags: --data-dir DIR, --window KEY, --tern-bin PATH.`;
}

function errorEnvelope(id, err) {
  const code = err?.code || 'internal_error';
  return { id, error: { code, message: String(err?.message || err) } };
}

// --- daemon lifecycle ---

function endpointPath(dataDir) {
  return path.join(dataDir, 'endpoint.json');
}

function readEndpoint(dataDir) {
  try {
    const raw = fs.readFileSync(endpointPath(dataDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed?.port !== 'number' || typeof parsed?.token !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function endpointReady(dataDir) {
  return readEndpoint(dataDir) !== null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Graceful daemon shutdown: close the server handle on SIGINT/SIGTERM so
// the port/token file is cleaned up, then let the loop below exit.
function installShutdown(handle) {
  let closing = false;
  const onSignal = async () => {
    if (closing) return;
    closing = true;
    try {
      await handle?.close?.();
    } catch {
      // Best effort during shutdown.
    }
    process.exit(0);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
}

async function waitForEndpoint(dataDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (endpointReady(dataDir)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
  }
}

async function ensureDaemon({ dataDir, timeoutMs, spawnFn = null, requestFn = null, spawnArgs = [] }) {
  const spawn = spawnFn || ((dir) => defaultSpawnDaemon(dir, spawnArgs));
  fs.mkdirSync(dataDir, { recursive: true });
  const startedAt = Date.now();
  if (await waitForEndpoint(dataDir, 0)) {
    if (!requestFn) return { spawned: false, ready: true, elapsedMs: Date.now() - startedAt };
    try {
      // An endpoint file alone may be stale (crashed daemon): only skip
      // the spawn when the endpoint answers a live RPC.
      await requestFn(dataDir, 'list', {});
      return { spawned: false, ready: true, elapsedMs: Date.now() - startedAt };
    } catch {
      // Stale endpoint: fall through and spawn a fresh daemon.
    }
  }
  const child = await spawn(dataDir);
  void child;
  // The old endpoint file may still exist right after spawn: waitForEndpoint
  // alone returns instantly on the stale file and a single RPC then fails
  // against the dead daemon (the <=1s "timeout" of 2026-10-13). Poll a live
  // RPC until the deadline so the fresh child has time to replace it.
  // Never delete endpoint.json here: another live ensure may own it.
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    if (requestFn) {
      try {
        await requestFn(dataDir, 'list', {});
        return { spawned: true, ready: true, elapsedMs: Date.now() - startedAt };
      } catch (err) {
        lastError = err;
      }
    } else if (await waitForEndpoint(dataDir, 0)) {
      return { spawned: true, ready: true, elapsedMs: Date.now() - startedAt };
    }
    if (Date.now() >= deadline) {
      return { spawned: true, ready: false, elapsedMs: Date.now() - startedAt, error: lastError };
    }
    await sleep(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
  }
}

function defaultSpawnDaemon(dataDir, extraArgs = []) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Detached child logs to a private file in the data dir so startup
  // failures are never silent.
  const logFd = fs.openSync(path.join(dataDir, 'daemon.log'), 'a');
  const child = spawn(
    process.execPath,
    [path.join(here, 'cli.mjs'), 'serve', '--data-dir', dataDir, ...extraArgs],
    {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
      env: { ...process.env },
    },
  );
  fs.closeSync(logFd);
  child.unref();
  return child;
}

// Client-side transport deadline: always beyond the server's own wait so a
// user --timeout surfaces the server's clean `timeout` envelope, never a
// transport error. Undefined = indefinite (herdr parity when no --timeout).
function clientTimeout(serverMs, marginMs) {
  return serverMs === undefined ? undefined : serverMs + marginMs;
}

function parseTimeoutMs(raw, def) {
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw usageError(`invalid --timeout: ${raw}`);
  return n;
}

function checkStatuses(list) {
  for (const s of list) {
    if (!VALID_STATUSES.includes(s)) throw usageError(`invalid --until: ${s}`);
  }
  return list;
}

function checkSource(raw) {
  const aliased = raw === 'recent_unwrapped' ? 'recent-unwrapped' : raw;
  if (!VALID_SOURCES.includes(aliased)) throw usageError(`invalid --source: ${raw}`);
  return aliased;
}

function checkFormat(raw) {
  if (!VALID_FORMATS.includes(raw)) throw usageError(`invalid --format: ${raw}`);
  return raw;
}

export async function main(argv, deps = {}) {
  const [command, ...rest] = argv;
  // Where main writes: the process streams, or the caller's (the suites pass their own,
  // since under `node --test` the process stdout is the runner's report channel).
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const lazy = {
    get client() {
      return deps.client || import('./client.mjs');
    },
    get server() {
      return deps.server || import('./server.mjs');
    },
    get ternMod() {
      return deps.ternMod || import('./tern.mjs');
    },
  };

  if (!command || command === '-h' || command === '--help' || command === 'help') {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  if (command === 'serve') {
    const { positional, flags } = parseArgs(rest);
    if (positional.length > 0) throw usageError('serve takes no arguments');
    const dataDir = resolveDataDir(flags['data-dir']);
    const { serve } = await lazy.server;
    const { createTern } = await lazy.ternMod;
    const tern = createTern({ binary: resolveTernBinary(flags['tern-bin']), window: flags.window });
    const handle = await serve({ dataDir, tern });
    // serve() resolves with a live handle; keep this process alive as the
    // daemon. Never return to the exit path: process.exit() in the entry
    // would kill the freshly created server (main's bug, 2026-10-13).
    installShutdown(handle);
    await new Promise(() => {});
    return 0;
  }

  if (command === 'ensure') {
    const { positional, flags } = parseArgs(rest);
    if (positional.length > 0) throw usageError('ensure takes no arguments');
    const dataDir = resolveDataDir(flags['data-dir']);
    const timeoutMs = parseTimeoutMs(flags.timeout, ENSURE_TIMEOUT_DEFAULT);
    const client = await lazy.client;
    // Propagate pane-access flags so the spawned daemon reaches the same
    // window/tern binary the user invoked with.
    const spawnArgs = [];
    if (flags.window !== undefined) spawnArgs.push('--window', flags.window);
    if (flags['tern-bin'] !== undefined) spawnArgs.push('--tern-bin', flags['tern-bin']);
    const { spawned, ready, elapsedMs, error } = await ensureDaemon({
      dataDir,
      timeoutMs,
      spawnFn: deps.spawnDaemon,
      spawnArgs,
      requestFn: (dir, method, params) => client.request(dir, method, params, { timeout: 5000 }),
    });
    if (!ready) {
      const detail = error?.message ? `: ${error.message}` : '';
      stderr.write(`${JSON.stringify(errorEnvelope(CLI_IDS.ensure, { code: 'timeout', message: `daemon endpoint not ready within ${timeoutMs} ms (waited ${elapsedMs} ms)${detail}` }))}\n`);
      return 1;
    }
    const out = { id: CLI_IDS.ensure, result: { type: 'daemon_ensured', data_dir: dataDir, spawned, elapsed_ms: elapsedMs } };
    stdout.write(`${JSON.stringify(out)}\n`);
    return 0;
  }

  // Agent commands go through the daemon endpoint.
  const { positional, flags } = parseArgs(rest);
  const dataDir = resolveDataDir(flags['data-dir']);
  const json = Boolean(flags.json);
  const id = CLI_IDS[command] || `cli:agent:${command}`;
  const client = await lazy.client;

  async function call(method, params, timeoutMs) {
    // RuntimeCore request(): timeout 0 = indefinite local wait.
    const opts = timeoutMs === undefined ? { timeout: 0 } : { timeout: timeoutMs };
    return client.request(dataDir, method, params, opts);
  }

  async function emit(promise) {
    try {
      const result = await promise;
      if (command === 'read' && !json) {
        stdout.write(`${result?.read?.text ?? ''}\n`);
        return 0;
      }
      stdout.write(`${JSON.stringify({ id, result })}\n`);
      return 0;
    } catch (err) {
      stderr.write(`${JSON.stringify(errorEnvelope(id, err))}\n`);
      return err?.code === 'usage' ? 2 : 1;
    }
  }

  switch (command) {
    case 'list': {
      if (positional.length > 0) throw usageError('usage: agent-runtime list');
      // Server returns a bare array; herdr envelope is {type,agents}.
      return emit(call('list', {}).then((agents) => ({ type: 'agent_list', agents })));
    }
    case 'get': {
      if (positional.length !== 1) throw usageError('usage: agent-runtime get <target>');
      // Server returns a bare AgentInfo; herdr envelope is {type,agent}.
      // read/wait/prompt/start already return envelopes: pass through.
      return emit(call('get', { target: positional[0] }).then((agent) => ({ type: 'agent_info', agent })));
    }
    case 'read': {
      if (positional.length !== 1) throw usageError('usage: agent-runtime read <target>');
      const params = { target: positional[0] };
      if (flags.source !== undefined) params.source = checkSource(flags.source);
      if (flags.lines !== undefined) {
        const n = Number(flags.lines);
        if (!Number.isInteger(n) || n <= 0) throw usageError(`invalid --lines: ${flags.lines}`);
        params.lines = n;
      }
      if (flags.format !== undefined) params.format = checkFormat(flags.format);
      if (flags.ansi) params.ansi = true;
      return emit(call('read', params));
    }
    case 'wait': {
      if (positional.length !== 1) throw usageError('usage: agent-runtime wait <target>');
      const params = { target: positional[0] };
      if (flags.until.length > 0) params.until = checkStatuses(flags.until);
      if (flags.timeout !== undefined) params.timeout = parseTimeoutMs(flags.timeout, undefined);
      return emit(call('wait', params, clientTimeout(params.timeout, 15000)));
    }
    case 'prompt': {
      if (positional.length < 2) throw usageError('usage: agent-runtime prompt <target> <text>');
      const params = { target: positional[0], text: positional.slice(1).join(' ') };
      if (flags.wait) params.wait = true;
      if (flags.until.length > 0) {
        if (!flags.wait) throw usageError('--until requires --wait');
        params.until = checkStatuses(flags.until);
      }
      if (flags.timeout !== undefined) {
        if (!flags.wait) throw usageError('--timeout requires --wait');
        params.timeout = parseTimeoutMs(flags.timeout, undefined);
      }
      return emit(call('prompt', params, clientTimeout(params.timeout, 15000)));
    }
    case 'start': {
      if (positional.length < 1) throw usageError('usage: agent-runtime start <name> --kind KIND --pane ID');
      const name = positional[0];
      const agentArgs = positional.slice(1);
      if (flags.kind === undefined) throw usageError('start requires --kind');
      if (!START_KINDS.includes(flags.kind)) {
        stderr.write(`${JSON.stringify({ id, error: { code: 'unsupported_agent_kind', message: `unsupported agent kind: ${flags.kind}` } })}\n`);
        return 1;
      }
      if (flags.pane === undefined) throw usageError('start requires --pane');
      const params = { name, kind: flags.kind, pane: flags.pane };
      if (flags.timeout !== undefined) {
        const n = Number(flags.timeout);
        if (!Number.isInteger(n) || n <= 3000 || n > 300000) {
          throw usageError(`invalid --timeout: ${flags.timeout}; expected an integer >3000 and <=300000`);
        }
        params.timeout = n;
      }
      if (agentArgs.length > 0) params.args = agentArgs;
      return emit(call('start', params, (params.timeout ?? 30000) + 30000));
    }
    default:
      throw usageError(`unknown command: ${command}`);
  }
}

function isMainModule() {
  const script = process.argv[1];
  if (!script) return false;
  // Direct-execution detection must survive drive-letter case, slashes, and
  // junctions: compare realpaths (case-insensitive on Windows) instead of
  // exact string equality.
  try {
    const a = fs.realpathSync(path.resolve(script));
    const b = fs.realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return path.resolve(script) === fileURLToPath(import.meta.url);
  }
}

const isMain = isMainModule();
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => {
      // serve never returns (it awaits forever); reaching here means the
      // daemon died. exitCode never cuts a live loop short, unlike exit().
      process.exitCode = code;
    },
    (err) => {
      if (err?.code === 'usage') {
        process.stderr.write(`usage: node runtime/cli.mjs <command>\n${err.message}\n`);
        process.exitCode = 2;
        return;
      }
      const id = 'cli:unknown';
      process.stderr.write(`${JSON.stringify(errorEnvelope(id, err))}\n`);
      process.exitCode = 1;
    },
  );
}
