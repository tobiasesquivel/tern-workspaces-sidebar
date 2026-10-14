// runtime/connectors/claude-codex.mjs — prepareLaunch for claude + codex.
//
// Ownership: ThirdConnectors. Called by runtime/launch.mjs (OmpConnector
// owner) as prepareLaunch(agent, nativeArgs, childEnv, context) where
// context = { dataDir, launchId, paneId, connectorDir } (camelCase, locked).
// Returns { command, args, env, cleanup? } — command is a bare name or
// absolute path, env is the COMPLETE child env, cleanup runs post-exit.
//
// Isolation (never write personal config, never auto-approve anything):
// - claude: the user's own config dir, untouched — saved trust, onboarding and
//   credentials as they are, and the transcript where `claude --resume <id>`
//   finds it (an ephemeral CLAUDE_CONFIG_DIR, removed on exit, took the session
//   with it, so the published resume command pointed at nothing). Our hooks
//   ride in an ephemeral --settings <file> (verified flag `--settings
//   <file-or-json>`, claude 2.1.288), which adds to the user's settings and is
//   removed on exit. No secret bytes copied or logged.
// - codex: the user's own CODEX_HOME, untouched — saved folder trust, sandbox
//   setup and auth as they are, and the rollout where `codex resume <id>`
//   finds it (an ephemeral CODEX_HOME, removed on exit, asked for folder trust
//   on every launch and took the session with it). Our hooks and their
//   trusted_hash entries ride as `-c` overrides in codex's session-flags layer
//   (`codexSessionFlags`), the only non-user layer codex reads hook trust from.
//   First-run dialogs (folder trust, sandbox setup) stay the user's and surface
//   as blocked + agent_not_ready, never faked ready.
//
// Hooks (same binary in both): node <connectorDir>/hook.mjs with baked
// --data-dir/--launch-id/--pane flags AND env fallback. Hook never blocks
// or decides: exit 0 silent (claude) / no-output success (codex).
// Event wiring, as herdr (research/herdr-agent-detection.md §1.3) — the screen
// is the state, read by the daemon's detection loop:
//   claude (--settings hooks): SessionStart (identity, as herdr), plus the
//     events that carry a question's text as a message hint, never a state:
//     PermissionRequest, PreToolUse(matcher AskUserQuestion), Notification
//     (permission_prompt|elicitation_*), Elicitation.
//   codex (-c hooks.<Event> overrides): herdr v9's SessionStart (identity),
//     UserPromptSubmit (working), Stop and Interrupt (idle), plus
//     PermissionRequest as a message hint.
//
// Resume: hook SessionStart reports session {kind id|path} + resume_argv
// (claude ["claude", "--resume", id], codex ["codex", "resume", id]); core stores per pane.
// Exit frees: launch.mjs releases after the child exits.
//
// Verified versions: claude 2.1.288, codex-cli 0.159.1 (`--version`,
// 2026-10-12). Flags verified via installed --help (no network).

import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CLAUDE_MIN_VERSION = "2.1.288";
export const CODEX_MIN_VERSION = "0.159.1";

const HERE = dirname(fileURLToPath(import.meta.url));

// Pure: build the claude --settings JSON object (hooks only). hookPath is the
// absolute hook.mjs path; ids are baked as flags (env fallback identical).
export function claudeSettingsJson({ hookPath, nodePath, dataDir, launchId, paneId }) {
  const hook = (event, extra = {}) => ({
    type: "command",
    command: nodePath,
    args: [
      hookPath,
      "--agent",
      "claude",
      "--event",
      event,
      "--data-dir",
      dataDir,
      "--launch-id",
      launchId,
      "--pane",
      String(paneId),
    ],
    timeout: 10,
    ...extra,
  });
  // herdr installs SessionStart only: Claude's state is its screen. The rest carry
  // the text of a question or a permission, a message hint the screen cannot give.
  return {
    hooks: {
      SessionStart: [{ matcher: "startup|resume|clear|compact|fork", hooks: [hook("SessionStart")] }],
      PermissionRequest: [{ matcher: "*", hooks: [hook("PermissionRequest")] }],
      // ONLY AskUserQuestion: the single tool whose UI is a user question.
      PreToolUse: [{ matcher: "AskUserQuestion", hooks: [hook("PreToolUse")] }],
      Notification: [
        {
          matcher: "permission_prompt|elicitation_dialog|elicitation_url_dialog",
          hooks: [hook("Notification")],
        },
      ],
      Elicitation: [{ hooks: [hook("Elicitation")] }],
    },
  };
}
// Shell-quote one argv array into a single Windows command string: bare
// words pass through, anything with whitespace/quotes is double-quoted
// with interior quotes backslash-escaped (honored by cmd, PowerShell,
// and codex hook spawning alike).
export function quoteWindows(argv) {
  return argv
    .map((w) => {
      const s = String(w);
      if (s.length === 0) return '""';
      if (!/[\s"]/.test(s)) return s;
      return `"${s.replace(/"/g, '\\"')}"`;
    })
    .join(" ");
}

// Node executable path WITHOUT surrounding quotes: codex 0.159.1 on Windows
// fails to spawn a `command` that begins with a quoted path (live bisect:
// quoted -> "Hook failed / hook exited with code 1" with zero invocations;
// unquoted short path -> hooks run, stdin closes, payloads delivered).
// Resolution order: explicit override (tests/lab) > raw execPath.
// quoteWindows still quotes every OTHER argv word that needs it — only the
// executable stays bare (it must be space-free to spawn; see resolveNodeBin).
export function unquotedNodePath(execPath = process.execPath) {
  return execPath;
}

// Resolve the node binary for hook `command` lines (live bisect 2026-10-13:
// codex 0.159.1 on Windows NEVER invokes a command beginning with a QUOTED
// path — zero invocations, "Hook failed / hook exited with code 1"; a
// space-free path works, stdin closes, payloads delivered).
// Order: TERN_NODE_BIN override (explicit, tests/lab) > "node" when it
// resolves on PATH (bare name needs no quoting at all) > execPath itself
// when space-free. NEVER a quoted spaced path: when nothing space-free is
// known, return "node" and let the start path report agent_not_ready if it
// is missing, rather than writing a silently-broken hook line.
export function resolveNodeBin(env = process.env, onPath = null) {
  const override = env.TERN_NODE_BIN ?? env.TERN_NODE ?? null;
  if (typeof override === "string" && override.length > 0) return override;
  const inPath = onPath ?? (() => true);
  let pathHasNode = false;
  try {
    pathHasNode = inPath("node");
  } catch {
    pathHasNode = false;
  }
  if (pathHasNode) return "node";
  if (!/[\s"]/.test(process.execPath)) return process.execPath;
  return "node";
}
// (codex 0.159.1 Windows cannot spawn a command beginning with a quoted
// path; every other word is shell-quoted as needed).
export function shellFor(executable, args) {
  const rest = (Array.isArray(args) ? args : []).map((w) => {
    const s = String(w);
    if (s.length === 0) return '""';
    if (!/[\s"]/.test(s)) return s;
    return `"${s.replace(/"/g, '\\"')}"`;
  });
  return [String(executable), ...rest].join(" ");
}

// Command shape: codex hook handlers take a single `command` SHELL STRING
// (plus optional `commandWindows`); there is NO `args` array field (verified
// against the official codex hooks reference + live bisect: `command` =
// bare node path opened a REPL that ate the stdin payload and exited 1,
// and a LEADING quoted path fails to spawn at all — zero invocations).
export function codexHooksJson({ hookPath, nodePath, dataDir, launchId, paneId }) {
  const hook = (event, extra = {}) => {
    const shell = shellFor(nodePath, [
      hookPath,
      "--agent",
      "codex",
      "--event",
      event,
      "--data-dir",
      dataDir,
      "--launch-id",
      launchId,
      "--pane",
      String(paneId),
    ]);
    return {
      type: "command",
      command: shell,
      commandWindows: shell,
      // codex clamps SessionEnd/Interrupt to 1..3 s (codexNormalizedTimeout).
      timeout: event === "SessionEnd" || event === "Interrupt" ? 3 : 10,
      ...extra,
    };
  };
  // herdr v9 (src/integration/targets.rs): SessionStart for the session, and
  // UserPromptSubmit/Stop/Interrupt for the turn. PermissionRequest is ours: a
  // message hint, never a state.
  return {
    hooks: {
      SessionStart: [{ matcher: "startup|resume|clear|compact", hooks: [hook("SessionStart")] }],
      UserPromptSubmit: [{ hooks: [hook("UserPromptSubmit")] }],
      Stop: [{ hooks: [hook("Stop")] }],
      Interrupt: [{ hooks: [hook("Interrupt")] }],
      PermissionRequest: [{ matcher: "*", hooks: [hook("PermissionRequest")] }],
    },
  };
}

// Exact trusted_hash algorithm (openai/codex @ rust-v0.159.1, byte-proven):
// sha256 over canonical JSON (recursively sorted keys, compact) of the
// normalized per-handler identity
//   {event_name, [matcher], hooks:[{type,command,timeout,async,[statusMessage],
//    [additionalContextLimit]}]}
// - event_name: snake label (session_start, user_prompt_submit, ...).
// - matcher: omitted entirely when the group has none, and force-dropped for
//   UserPromptSubmit/Stop/Interrupt (events/common.rs).
// - command: commandWindows-resolved on Windows; commandWindows never hashed.
// - timeout: normalized (SessionEnd/Interrupt clamp 1..3, else default 600).
// - additionalContextLimit: only when non-default (2500).
// Key: <absolute hooks.json>:<event_snake>:<groupIdx>:<handlerIdx>, state
// read only from User + SessionFlags layers — our ephemeral CODEX_HOME
// trusts ONLY our own generated hooks.json. No project auto-trust, no
// sandbox choice, no bypass flag. Ground truth: herdr SessionStart hook
// reproduces 032339d9…c102a6 byte-for-byte.
export const CODEX_EVENT_LABEL = {
  PreToolUse: "pre_tool_use",
  PermissionRequest: "permission_request",
  PostToolUse: "post_tool_use",
  PreCompact: "pre_compact",
  PostCompact: "post_compact",
  SessionStart: "session_start",
  SessionEnd: "session_end",
  UserPromptSubmit: "user_prompt_submit",
  SubagentStart: "subagent_start",
  SubagentStop: "subagent_stop",
  Stop: "stop",
  Interrupt: "interrupt",
};

const CODEX_MATCHER_IGNORED = new Set(["UserPromptSubmit", "Stop", "Interrupt"]);
const CODEX_DEFAULT_CTX_LIMIT = 2500;

export function codexCanonical(value) {
  if (Array.isArray(value)) return value.map(codexCanonical);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = codexCanonical(value[k]);
    return out;
  }
  return value;
}

export function codexNormalizedTimeout(event, timeout) {
  if (event === "SessionEnd" || event === "Interrupt") {
    return Math.min(3, Math.max(1, timeout ?? 1));
  }
  return Math.max(1, timeout ?? 600);
}

// handler: one hooks.json handler {type:"command", command, commandWindows?,
// timeout?, async?, statusMessage?, additionalContextLimit?}.
export function codexHookTrustHash({ event, matcher, handler }) {
  const m = CODEX_MATCHER_IGNORED.has(event) ? undefined : (matcher ?? undefined);
  const h = {
    type: "command",
    command: handler.commandWindows ?? handler.command,
    timeout: codexNormalizedTimeout(event, handler.timeout),
    async: handler.async === true,
  };
  if (handler.statusMessage != null) h.statusMessage = handler.statusMessage;
  if (
    handler.additionalContextLimit != null &&
    handler.additionalContextLimit !== CODEX_DEFAULT_CTX_LIMIT
  ) {
    h.additionalContextLimit = handler.additionalContextLimit;
  }
  const identity = { event_name: CODEX_EVENT_LABEL[event] };
  if (m != null) identity.matcher = m;
  identity.hooks = [h];
  const json = JSON.stringify(codexCanonical(identity));
  return `sha256:${createHash("sha256").update(json, "utf8").digest("hex")}`;
}
// The hooks' own source path in codex's session-flags layer (`-c` overrides):
// `discover_handlers` keys a session-flags handler as
// "<source>:<event_snake>:<group>:<handler>", with the source made absolute —
// measured on Windows (codex 0.159.1, hooks review screen): "Source  Session
// flags - C:\<session-flags>\config.toml". `resolve` does the same: the cwd's
// drive on Windows, "/<session-flags>/config.toml" elsewhere.
export function codexSessionFlagsSource() {
  return resolve("/<session-flags>/config.toml");
}

function tomlKey(k) {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
}

// A JSON-shaped value as a TOML inline value (a `-c` value is parsed as TOML).
export function tomlValue(v) {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(", ")}]`;
  if (v && typeof v === "object") {
    const parts = Object.entries(v)
      .filter(([, x]) => x !== undefined && x !== null)
      .map(([k, x]) => `${tomlKey(k)} = ${tomlValue(x)}`);
    return `{ ${parts.join(", ")} }`;
  }
  throw new Error(`toml: unsupported value ${typeof v}`);
}

// Our hooks as codex `-c` flags, in the session-flags layer: one
// `hooks.<Event>=[...]` per event, plus `hooks.state={...}` trusting exactly
// those handlers (trust is read from the User + SessionFlags layers). Nothing is
// written to the user's CODEX_HOME, and nothing of theirs is overridden: their
// own hooks load from their own layer. The state goes as one inline table
// because its keys hold a dot (`config.toml`) a dotted `-c` key would split.
export function codexSessionFlags(hooksFile) {
  const args = ["-c", "features.hooks=true"];
  const state = {};
  const source = codexSessionFlagsSource();
  for (const [event, groups] of Object.entries(hooksFile.hooks)) {
    args.push("-c", `hooks.${event}=${tomlValue(groups)}`);
    groups.forEach((group, gi) =>
      group.hooks.forEach((handler, hi) => {
        const key = `${source}:${CODEX_EVENT_LABEL[event]}:${gi}:${hi}`;
        state[key] = { trusted_hash: codexHookTrustHash({ event, matcher: group.matcher, handler }) };
      }),
    );
  }
  args.push("-c", `hooks.state=${tomlValue(state)}`);
  return args;
}

async function writeFilePrivate(file, text) {
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, text, { encoding: "utf8", mode: 0o600 });
}

// Remove a directory tree; failure is a stderr note, never throws.
export async function removeDir(dir) {
  try {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 2 });
  } catch (err) {
    process.stderr.write(`claude-codex: cleanup ${dir}: ${err?.message ?? err}\n`);
  }
}

// Remove this launch's hook state files (.seq/.epoch/.blockers.json).
// Called ONLY by prepareLaunch cleanup(), which the wrapper runs AFTER the
// child truly exits. SessionEnd/Interrupt hooks must NEVER remove these:
// SessionEnd can be /clear/resume/switch with the next SessionStart arriving
// on the same live occupant, and Interrupt is a turn-cancel (agent stays
// live) — deleting .seq would let a later report reuse seq and lose the
// monotonic gate; deleting .epoch/.blockers would lose session-epoch
// continuity and pending-question tracking.
export async function removeHookState(dataDir, launchId) {
  const dir = join(dataDir, "hooks");
  const base = String(launchId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
  for (const ext of [".seq", ".epoch", ".blockers.json"]) {
    try {
      await fs.unlink(join(dir, `${base}${ext}`));
    } catch (err) {
      if (err?.code !== "ENOENT") {
        process.stderr.write(`claude-codex: cleanup hook state: ${err?.message ?? err}\n`);
      }
    }
  }
}

async function setupClaudeEphemeral({ dataDir, launchId, paneId, connectorDir, nodePath }) {
  const base = join(tmpdir(), `tern-claude-${process.pid}-${randomBytes(4).toString("hex")}`);
  const hookPath = join(connectorDir, "hook.mjs");
  const settings = claudeSettingsJson({
    hookPath,
    nodePath,
    dataDir,
    launchId,
    paneId,
  });
  const settingsPath = join(base, "settings.json");
  await writeFilePrivate(settingsPath, JSON.stringify(settings));
  // No env of ours: the user's own config dir stays the config (see header).
  return { dir: base, env: {}, args: ["--settings", settingsPath] };
}

// codex in the user's own CODEX_HOME: saved folder trust, sandbox setup and auth
// as they are, and the session rollout where `codex resume <id>` finds it (an
// ephemeral CODEX_HOME, removed on exit, took the session with it and asked for
// folder trust on every launch). Our hooks and their trust ride as `-c` flags.
function codexArgs({ dataDir, launchId, paneId, connectorDir, nodePath }) {
  const hookPath = join(connectorDir, "hook.mjs");
  return codexSessionFlags(codexHooksJson({ hookPath, nodePath, dataDir, launchId, paneId }));
}

// prepareLaunch(agent, nativeArgs, childEnv, context) -> {command,args,env,cleanup?}.
// context = { dataDir, launchId, paneId, connectorDir } (camelCase, locked with
// OmpConnector). childEnv already carries TERN_AGENT_RUNTIME_DIR /
// TERN_AGENT_LAUNCH_ID / TERN_PANE (wrapper-set). Pane ids may exceed 2^32:
// stringified exactly, never bit-truncated.
export async function prepareLaunch(agent, nativeArgs, childEnv, context = {}) {
  if (agent !== "claude" && agent !== "codex") {
    throw new Error(`prepareLaunch: unsupported agent ${agent}`);
  }
  const args = Array.isArray(nativeArgs) ? [...nativeArgs] : [];
  const dataDir = context.dataDir ?? childEnv.TERN_AGENT_RUNTIME_DIR ?? null;
  const launchId = context.launchId ?? childEnv.TERN_AGENT_LAUNCH_ID ?? null;
  const paneRaw = context.paneId ?? childEnv.TERN_PANE ?? null;
  const paneId = typeof paneRaw === "number" ? paneRaw : Number(paneRaw);
  if (!dataDir || !launchId || !Number.isSafeInteger(paneId) || paneId <= 0) {
    throw new Error("prepareLaunch: missing dataDir/launchId/paneId");
  }
  const connectorDir = context.connectorDir ?? HERE;
  // Bare "node" when on PATH (live: codex never spawns a leading quoted
  // path); TERN_NODE_BIN overrides for tests/lab. NEVER a quoted spaced path.
  const nodePath = resolveNodeBin(childEnv);

  if (agent === "claude") {
    const eph = await setupClaudeEphemeral({
      dataDir: resolve(dataDir),
      launchId,
      paneId,
      connectorDir,
      nodePath,
    });
    return {
      command: "claude",
      args: [...eph.args, ...args],
      env: { ...childEnv, ...eph.env },
      cleanup: async () => {
        await removeDir(eph.dir);
        await removeHookState(resolve(dataDir), launchId);
      },
    };
  }

  const flags = codexArgs({ dataDir: resolve(dataDir), launchId, paneId, connectorDir, nodePath });
  return {
    command: "codex",
    args: [...flags, ...args],
    env: { ...childEnv },
    cleanup: async () => {
      await removeHookState(resolve(dataDir), launchId);
    },
  };
}
