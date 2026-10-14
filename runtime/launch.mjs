// runtime/launch.mjs — common agent launch wrapper.
//
// Invoked by the daemon's `start` through tern.run:
//   node runtime/launch.mjs --agent KIND --data-dir DIR --launch-id ID -- ...nativeArgs
//
// Contract:
// - --agent: omp|claude|codex (anything else → exit 2, usage on stderr).
// - --data-dir, --launch-id: required non-empty (missing → exit 2).
// - Everything after a bare `--` passes through verbatim as native agent args
//   (may be empty; the `--` may then be omitted).
// - TERN_PANE (numeric pane id, may exceed 2^32 — never truncated) arrives via
//   env inherited from the wrapper; missing/invalid → exit 2, nothing spawned.
// - The wrapper claims the pane first (claim failure → exit 1, no spawn),
//   spawns the agent with stdio inherited, propagates the exit code
//   (signal death → 1 with a stderr note), then best-effort releases the pane
//   without ever changing the agent's exit code.
// - omp loads this repo's extension in place via --extension=<abs path>
//   (verified flag `-e, --extension=<value>` in `omp --help` 18.10.3); personal
//   config and ~/.omp stay untouched. OMPCODE is scrubbed for the omp child so
//   the extension's nested-session guard does not silence the pane root; a
//   manually nested omp keeps its own OMPCODE and stays silent. Correct.
// - claude/codex delegate to prepareLaunch() in ./connectors/claude-codex.mjs;
//   no third-party stubs live here.
// - ./client.mjs is imported lazily inside main() so unit
//   tests can import this module without the daemon present. Node >= 22, no deps.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const AGENTS = ["omp", "claude", "codex"];
export const SOURCE_BY_AGENT = {
  omp: "tern:omp",
  claude: "tern:claude",
  codex: "tern:codex",
};
export const RELEASE_TIMEOUT_MS = 2000;

const USAGE =
  "usage: node runtime/launch.mjs --agent KIND --data-dir DIR --launch-id ID -- ...args\n" +
  "  KIND: omp | claude | codex";

// Pure: parse argv (without the node/script prefix). Returns
// { agent, dataDir, launchId, nativeArgs } or { error } or { help:true }.
export function parseLaunchArgs(argv) {
  let agent;
  let dataDir;
  let launchId;
  let nativeArgs = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      nativeArgs = argv.slice(i + 1);
      break;
    }
    if (arg === "-h") return { help: true };
    if (!arg.startsWith("--")) {
      return { error: `unexpected argument ${arg}` };
    }
    const eq = arg.indexOf("=");
    const name = eq < 0 ? arg : arg.slice(0, eq);
    const inline = eq < 0 ? undefined : arg.slice(eq + 1);
    if (name === "--help") return { help: true };
    if (name === "--agent" || name === "--data-dir" || name === "--launch-id") {
      const value = inline !== undefined ? inline : argv[(i += 1)];
      if (name === "--agent") agent = value;
      else if (name === "--data-dir") dataDir = value;
      else launchId = value;
      continue;
    }
    return { error: `unknown flag ${name}` };
  }
  if (!agent) return { error: "missing --agent (omp|claude|codex)" };
  if (!AGENTS.includes(agent)) return { error: `unknown agent ${agent}` };
  if (!dataDir) return { error: "missing --data-dir" };
  if (!launchId) return { error: "missing --launch-id" };
  return { agent, dataDir, launchId, nativeArgs };
}

// Pure: exact pane id or null. Never truncates (>2^32 lab ids stay exact).
// Pane ids are positive (core isPositiveInt); "" and "0" are both invalid.
export function readPaneId(env = process.env) {
  const raw = env.TERN_PANE;
  if (raw === undefined || raw === "") return null;
  const paneId = Number(raw);
  if (!Number.isSafeInteger(paneId) || paneId <= 0) return null;
  return paneId;
}

// Pure: child env with reporter vars set. Two scrubs, both unconditional
// across all three agents:
// - OMPCODE only for the omp child (see header); other agents inherit it so
//   their own nested omp stays silent.
// - HERDR_ENV/HERDR_SOCKET_PATH/HERDR_PANE_ID always: the managed herdr
//   extension gates on exactly this trio, and a Tern root launched from a
//   herdr pane (or with claude settings carrying a herdr hook) must never
//   leak foreign report routing into the child — the pane would file reports
//   to the wrong daemon. Tern roots carry TERN_* context only.
// - Another Claude Code session's markers always: a root agent in its own pane is
//   no session's child, and claude 2.1.296 with an inherited
//   CLAUDE_CODE_CHILD_SESSION turns transcript saving off (no transcript, no
//   resume). The messaging socket and token would route to that other session.
const FOREIGN_ROUTING_ENV = [
  "HERDR_ENV",
  "HERDR_SOCKET_PATH",
  "HERDR_PANE_ID",
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_PID",
];
export function buildChildEnv(
  baseEnv,
  { dataDir, launchId, paneId, scrubOmpcode },
) {
  const env = {
    ...baseEnv,
    TERN_AGENT_RUNTIME_DIR: dataDir,
    TERN_AGENT_LAUNCH_ID: launchId,
    TERN_PANE: String(paneId),
  };
  if (scrubOmpcode) delete env.OMPCODE;
  for (const key of FOREIGN_ROUTING_ENV) delete env[key];
  return env;
}

// Pure: args for spawn(command, args) — native args verbatim, extension
// appended as one --flag=value. NEVER includes the executable itself:
// spawn() takes it separately, and a leading "omp" would become a positional
// initial prompt. Same {command, args} split as prepareLaunch returns.
export function ompArgv(nativeArgs, extensionPath) {
  return [...nativeArgs, `--extension=${extensionPath}`];
}

export function connectorDir() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "connectors");
}

function spawnWait(command, args, env) {
  return new Promise((resolve) => {
    let done = false;
    const child = spawn(command, args, {
      stdio: "inherit",
      env,
      windowsHide: false,
    });
    child.on("error", (err) => {
      if (done) return;
      done = true;
      process.stderr.write(`launch: spawn failed: ${err.message}\n`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (done) return;
      done = true;
      if (signal) {
        process.stderr.write(`launch: agent died on ${signal}\n`);
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function main() {
  const parsed = parseLaunchArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  if (parsed.error) {
    process.stderr.write(`launch: ${parsed.error}\n${USAGE}\n`);
    process.exit(2);
  }
  const paneId = readPaneId();
  if (paneId === null) {
    process.stderr.write("launch: missing or invalid TERN_PANE\n");
    process.exit(2);
  }

  const client = await loadClient();
  if (!client) process.exit(1);

  let claimError = null;
  try {
    await client(parsed.dataDir, "claim", {
      pane_id: paneId,
      agent: parsed.agent,
      launch_id: parsed.launchId,
    });
  } catch (err) {
    claimError = err;
  }
  if (claimError) {
    process.stderr.write(
      `launch: claim failed: ${claimError?.message ?? claimError}\n`,
    );
    process.exit(1);
  }

  // Everything below runs under an owned claim. Any failure before or during
  // the agent run releases {pane_id, launch_id} first (best effort, 2s cap)
  // so a botched start never leaves name/status/resume reserved.
  let code = 1;
  try {
    code = await runAgent(client, parsed, paneId);
  } catch (err) {
    process.stderr.write(`launch: ${err?.message ?? err}\n`);
    code = 1;
  } finally {
    await releaseBestEffort(client, parsed, paneId);
  }
  process.exit(code);
}

async function loadClient() {
  let request;
  try {
    ({ request } = await import("./client.mjs"));
  } catch (err) {
    process.stderr.write(
      `launch: cannot load client.mjs: ${err?.message ?? err}\n`,
    );
    return null;
  }
  if (typeof request !== "function") {
    process.stderr.write("launch: client.mjs has no request export\n");
    return null;
  }
  return request;
}

async function releaseBestEffort(request, parsed, paneId) {
  try {
    await Promise.race([
      request(parsed.dataDir, "release", {
        pane_id: paneId,
        launch_id: parsed.launchId,
        source: SOURCE_BY_AGENT[parsed.agent],
      }),
      new Promise((resolve) => setTimeout(resolve, RELEASE_TIMEOUT_MS)),
    ]);
  } catch {
    // Best effort: the release must never change the agent's exit code.
  }
}

async function runAgent(request, parsed, paneId) {

  let command;
  let args;
  let env;
  let cleanup;
  if (parsed.agent === "omp") {
    env = buildChildEnv(process.env, {
      dataDir: parsed.dataDir,
      launchId: parsed.launchId,
      paneId,
      scrubOmpcode: true,
    });
    command = "omp";
    args = ompArgv(parsed.nativeArgs, path.join(connectorDir(), "omp.ts"));
  } else {
    const mod = await loadThirdParty();
    const built = await invokePrepare(mod, parsed, paneId);
    ({ command, args, env, cleanup } = built);
  }

  const code = await spawnWait(command, args, env);
  if (typeof cleanup === "function") {
    try {
      await cleanup();
    } catch (err) {
      process.stderr.write(`launch: cleanup failed: ${err?.message ?? err}\n`);
    }
  }
  return code;
}

// Pure-ish builders that fail(): runAgent callers are inside try/finally, so
// throwing here still releases the claim. NEVER process.exit below this line
// except in spawnWait paths that already ran the agent.
function fail(message) {
  throw new Error(message);
}

async function loadThirdParty() {
  let mod;
  try {
    mod = await import("./connectors/claude-codex.mjs");
  } catch (err) {
    fail(`cannot load claude-codex connector: ${err?.message ?? err}`);
  }
  if (typeof mod.prepareLaunch !== "function") {
    fail("claude-codex.mjs has no prepareLaunch export");
  }
  return mod;
}

async function invokePrepare(mod, parsed, paneId) {
  const childEnv = buildChildEnv(process.env, {
    dataDir: parsed.dataDir,
    launchId: parsed.launchId,
    paneId,
    scrubOmpcode: false,
  });
  const context = {
    dataDir: parsed.dataDir,
    launchId: parsed.launchId,
    paneId,
    connectorDir: connectorDir(),
  };
  let built;
  try {
    built = await mod.prepareLaunch(
      parsed.agent,
      parsed.nativeArgs,
      childEnv,
      context,
    );
  } catch (err) {
    fail(`prepareLaunch failed: ${err?.message ?? err}`);
  }
  // ThirdConnectors own `prepareLaunch(agent, args, env, context)`.
  // Results arrive as { command, args, env, cleanup? }; command may be an
  // argv array whose first element is the executable.
  if (
    built &&
    Array.isArray(built.command) &&
    typeof built.command[0] === "string" &&
    built.command[0].length > 0 &&
    built.env &&
    typeof built.env === "object"
  ) {
    const args =
      built.args !== undefined && built.args !== null
        ? built.args
        : built.command.slice(1);
    if (!Array.isArray(args)) {
      fail("prepareLaunch args must be an array");
    }
    return {
      command: built.command[0],
      args,
      env: built.env,
      cleanup: built.cleanup,
    };
  }
  if (
    built &&
    typeof built.command === "string" &&
    Array.isArray(built.args) &&
    built.env &&
    typeof built.env === "object"
  ) {
    return {
      command: built.command,
      args: built.args,
      env: built.env,
      cleanup: built.cleanup,
    };
  }
  fail("prepareLaunch returned invalid {command,args,env}");

}

const entryArg = process.argv[1] ?? "";
let isEntry = false;
try {
  isEntry = import.meta.url === pathToFileURL(entryArg).href;
} catch {
  isEntry = false;
}
if (isEntry) {
  void main();
}
