// Tern CLI adapter: spawns `tern` (tern.com on Windows) for read-only
// inspection plus send/run. No topology changes here: this module never
// calls new/split/move/rename/focus/close. Pane ids are full doubles;
// never truncate with bitwise ops (|0, >>>) since lab ids exceed 2^32.

import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
export class TernError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TernError';
    this.code = code;
  }
}

function execFileAsync(file, args, { timeout = 30000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    execFileCb(
      file,
      args,
      { timeout, env, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT') {
            reject(new TernError('tern_unavailable', `tern binary not found: ${file}`));
          } else {
            const detail = String(stderr || err.message || '').slice(0, 500);
            reject(new TernError('tern_command_failed', `tern ${args[0]} failed: ${detail}`));
          }
          return;
        }
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
      },
    );
  });
}

function parseJson(out, what) {
  try {
    return JSON.parse(out);
  } catch {
    throw new TernError('tern_command_failed', `tern ${what} returned non-JSON output`);
  }
}

// Shell-independent Node launcher. `tern run` joins words with spaces and
// types them RAW into the pane shell, so multi-word scripts must arrive as
// ONE double-quoted word: PowerShell then passes the script intact to node.
// The base64 blob carries all user data, so the static script needs no
// escaping inside the quotes: it contains zero double quotes, and base64
// has no shell metacharacters (A-Za-z0-9+/=). Single quotes inside are safe
// in PowerShell double-quoted strings, cmd (no quote processing on the
// typed line beyond grouping), and POSIX shells.
// Returns the typed command words (sans leading node exe; spawn uses
// process.execPath of the pane's own node).
export function nodeTrampolineArgv(argv) {
  const inner = (Array.isArray(argv) ? argv : [argv]).map(String);
  const blob = Buffer.from(JSON.stringify(inner), 'utf8').toString('base64');
  const script = "process.exitCode=1;require('node:child_process').spawn(process.execPath,JSON.parse(Buffer.from('BASE64','base64').toString()),{stdio:'inherit'}).on('exit',function(c){process.exit(c==null?1:c)}).on('error',function(){process.exit(1)})".replace(
    'BASE64',
    blob,
  );
  if (/["\r\n]/.test(script)) {
    throw new TernError('invalid_argument', 'trampoline script must not contain double quotes or newlines');
  }
  return ['node', '-e', `"${script}"`];
}
// Data-dir resolution lives in store.mjs (RuntimeCore owner). This module
// never resolves data dirs; callers import { resolveDataDir } from './store.mjs'.

// Resolve the tern binary without depending on PATH. Precedence:
// explicit arg > TERN_BIN env > conventional install location >
// bare 'tern' (PATH lookup by the OS). The production bridge calls
// `ensure` without --tern-bin, so the default must work there too.
export function resolveTernBinary(override) {
  if (override) return override;
  const fromEnv = process.env.TERN_BIN;
  if (fromEnv) return fromEnv;
  if (process.platform === 'win32') {
    const localApp = process.env.LOCALAPPDATA ||
      (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : null);
    if (localApp) {
      const conventional = path.join(localApp, 'Programs', 'Tern', 'tern.com');
      try {
        if (fs.existsSync(conventional)) return conventional;
      } catch {
        // Fall through to PATH lookup below.
      }
    }
  }
  return 'tern';
}

// options: { binary?, env?, window?, timeout? }
// window: explicit TERN window key; omitted lets tern pick (pane window else first).
// binary falls back to resolveTernBinary() (explicit > TERN_BIN >
// conventional install > PATH) so production ensure works without --tern-bin.
export function createTern({ binary, env = process.env, window, timeout } = {}) {
  const bin = resolveTernBinary(binary);
  // NOTE: --window goes AFTER the subcommand (`tern ls --window KEY`).
  // Placing it before the subcommand misparses and can hang.
  const win = window ? ['--window', window] : [];

  // process/capture take fixed positionals: flags may trail the command.
  // send/run take variadic trailing text and build their own argv with
  // --json before BLOCK instead of using runJson.
  async function runJson(cmd, args, opts = {}) {
    const { stdout } = await execFileAsync(bin, [cmd, ...win, ...args, '--json'], {
      timeout: opts.timeout ?? timeout,
      env,
    });
    return parseJson(stdout, cmd);
  }

  return {
    binary: bin,

    async list() {
      const { stdout } = await execFileAsync(bin, ['ls', ...win, '--json'], { timeout, env });
      return parseJson(stdout, 'ls');
    },

    async inspect() {
      const { stdout } = await execFileAsync(bin, ['inspect', ...win, '--json'], { timeout, env });
      return parseJson(stdout, 'inspect');
    },

    // Locate a pane across sessions. Returns { session, tab, block } or null.
    async findPane(paneId) {
      const wanted = Number(paneId);
      const data = await this.list();
      for (const session of data.sessions || []) {
        for (const tab of session.tabs || []) {
          for (const block of tab.blocks || []) {
            if (Number(block.id) === wanted) return { session, tab, block };
          }
        }
      }
      for (const session of data.detached || []) {
        for (const tab of session.tabs || []) {
          for (const block of tab.blocks || []) {
            if (Number(block.id) === wanted) return { session, tab, block };
          }
        }
      }
      return null;
    },

    async process(pane) {
      return runJson('process', [String(pane)]);
    },

    // opts: { scrollback?, surfaces?, ansi?, html? } -> parsed object (has .text).
    async capture(pane, { scrollback = false, surfaces = false, ansi = false, html = false } = {}) {
      const args = [String(pane)];
      if (scrollback) args.push('--scrollback');
      if (surfaces) args.push('--surfaces');
      if (ansi) args.push('--ansi');
      else if (html) args.push('--html');
      return runJson('capture', args);
    },

    // kind: 'keys' (combos...), 'text', or 'paste'. Returns parsed result.
    // --json goes before BLOCK: the payload is variadic trailing text, so a
    // trailing flag could be pasted into the pane instead of parsed.
    async send(pane, kind, ...payload) {
      if (!['keys', 'text', 'paste'].includes(kind)) {
        throw new TernError('invalid_argument', `tern send kind must be keys|text|paste, got ${kind}`);
      }
      const { stdout } = await execFileAsync(
        bin,
        ['send', ...win, '--json', String(pane), kind, ...payload.map(String)],
        { timeout, env },
      );
      return parseJson(stdout, 'send');
    },

    // Shell-independent Node launch: wraps argv (minus node exe) in the
    // base64 trampoline and types `node -e "<static>"` into the pane.
    // Single seam for all spawns through panes (start wrapper today).
    async runNode(pane, argv) {
      const inner = (Array.isArray(argv) ? argv : [argv]).map(String);
      // The pane already runs `node -e <trampoline>`: strip any leading
      // node exe AND the -e flag before encoding, else the child tries to
      // load a module literally named 'node' (live PowerShell proof).
      let stripped = inner[0] === process.execPath || /(^|[\\/])node(\.exe)?$/i.test(inner[0])
        ? inner.slice(1)
        : inner;
      if (stripped[0] === '-e') stripped = stripped.slice(1);
      const typed = nodeTrampolineArgv(stripped);
      const { stdout } = await execFileAsync(
        bin,
        ['run', ...win, '--json', String(pane), ...typed],
        { timeout, env },
      );
      const out = String(stdout || '').trim();
      if (!out) return { ok: true };
      return parseJson(out, 'run');
    },
  };
}
