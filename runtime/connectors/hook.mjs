// runtime/connectors/hook.mjs — one-shot hook reporter for claude/codex.
//
// Ownership: ThirdConnectors. Invoked by the hooks that prepareLaunch()
// installs (claude --settings file, codex CODEX_HOME hooks.json) with:
//   node <connectorDir>/hook.mjs --agent claude|codex --event NAME
// stdin: the hook event JSON (claude/codex documented schemas, verified
// against https://code.claude.com/docs/en/hooks and
// https://developers.openai.com/codex/hooks on 2026-10-12).
//
// Behavior per event (parent-corrected rules):
// - SessionStart: identity only — report {state:"unknown", ready:false,
//   session, session_epoch, session_start} (+ resume_argv). Never proves
//   ready; readiness needs a prompt surface or a turn event.
// - UserPromptSubmit: working.
// - PermissionRequest: blocked + message (the ONLY generic tool-event block
//   besides PreToolUse AskUserQuestion, elicitation, permission notifications).
// - PreToolUse: blocked ONLY for AskUserQuestion tool (user question UI,
//   confirmed by payload) — NEVER for any other tool.
// - PostToolUse: working (turn continues; NOT idle).
// - Stop: idle + ready:true (turn ended, prompt surface back).
// - StopFailure / SessionEnd / Interrupt: release the occupant.
// - Notification: blocked ONLY when notification_type is
//   "permission_prompt" (or elicitation_* dialog types = Elicitation UI,
//   confirmed); otherwise ignored (no report).
// - Elicitation: blocked + message (MCP elicitation dialog = user question).
// - PermissionDenied: recovery signal — ignored (no automatic state;
//   a retry, if any, will surface as its own events).
// - SubagentStart/SubagentStop (+ agent_id present on any event): ignored —
//   subagent identity must never move the main pane occupant.
// - Unknown event names: ignored (honest, no report).
//
// Cross-process seq: file-backed counter per (launch_id) under
// <dataDir>/hooks/<launchId>.seq holding max(Date.now(), prev+1) so every
// one-shot invocation grows the seq even across processes (satisfies the
// core's per-source/launch monotonic gate). Session epochs likewise live in
// <dataDir>/hooks/<launchId>.epoch: startup/resume/clear source keeps the
// epoch, a changed session ref (id or transcript path) bumps it with
// session_start:true; the old session never revives (core tombstones it).
// request() (RuntimeCore client.mjs) is awaited before exit — reports are
// never fire-and-forget from a one-shot hook.
//
// Parent corrections honored:
// - PreToolUse→blocked is NEVER generic.
// - PermissionDenied is recovery, not an automatic state.
// - SessionStart proves identity, not readiness (state unknown, ready false).
// - unknown is honest: unmapped events produce no report at all.
// - This hook never approves or rejects anything (exit 0, no JSON decision
//   output to the agent) — it only observes.

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { classifySurface } from "./detect.mjs";

// Sync wrapper: detect.mjs classifySurface is sync; keep a local alias so
// mapEvent stays pure-sync for tests (no async import inside the mapper).
function classifySurfaceSync(agent, text) {
  try {
    return classifySurface(agent, text);
  } catch {
    return null;
  }
}

const USAGE =
  "usage: node hook.mjs --agent claude|codex --event NAME [--data-dir DIR --launch-id ID --pane ID]";

export const AGENTS = ["claude", "codex"];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) return { error: `unexpected argument ${arg}` };
    const eq = arg.indexOf("=");
    const name = eq < 0 ? arg : arg.slice(0, eq);
    const inline = eq < 0 ? undefined : arg.slice(eq + 1);
    const next = () => argv[(i += 1)];
    if (name === "--help" || name === "-h") return { help: true };
    if (
      name === "--agent" ||
      name === "--event" ||
      name === "--data-dir" ||
      name === "--launch-id" ||
      name === "--pane" ||
      name === "--probe-text"
    ) {
      out[name.slice(2)] = inline !== undefined ? inline : next();
      continue;
    }
    return { error: `unknown flag ${name}` };
  }
  return out;
}

export function resolveRuntimeIdentity(opts = {}, env = process.env) {
  // Baked flags win (prepareLaunch bakes them in); env is the fallback the
  // launch wrapper always sets (TERN_AGENT_RUNTIME_DIR/LAUNCH_ID/PANE).
  const dataDir =
    opts["data-dir"] ?? env.TERN_AGENT_RUNTIME_DIR ?? env.TERN_AGENT_RUNTIME ?? null;
  const launchId =
    opts["launch-id"] ?? env.TERN_AGENT_LAUNCH_ID ?? env.TERN_LAUNCH_ID ?? null;
  const paneRaw = opts.pane ?? env.TERN_PANE ?? null;
  const paneId = paneRaw == null || paneRaw === "" ? null : Number(paneRaw);
  return {
    dataDir,
    launchId,
    paneId:
      paneId !== null && Number.isSafeInteger(paneId) && paneId > 0 ? paneId : null,
  };
}

// Pure: map one hook event payload to a report/release action or null
// (null = honestly ignore: subagent, recovery, unknown, unmapped).
// Returns {kind:"report",fields} | {kind:"release"} | {kind:"ignore"}.
export function mapEvent(agent, eventName, payload = {}) {
  const event = eventName ?? payload.hook_event_name ?? null;
  if (typeof event !== "string" || event.length === 0) return { kind: "ignore" };
  // Subagent traffic never moves the main pane occupant (claude agent_id,
  // codex agent_id; codex Subagent* events likewise).
  if (
    event === "SubagentStart" ||
    event === "SubagentStop" ||
    (payload.agent_id !== undefined &&
      payload.agent_id !== null &&
      payload.agent_id !== "")
  ) {
    return { kind: "ignore" };
  }

  // Readiness probe (NOT a hook event — invoked by launch.mjs with the live
  // pane surface). Reports idle+ready ONLY on real prompt evidence via
  // classifySurface; anything else (working/blocked/unknown) is honestly
  // ignored so start keeps waiting for real readiness. Never fabricates.
  if (event === "ReadyProbe") {
    if (agent !== "claude" && agent !== "codex") return { kind: "ignore" };
    const text =
      typeof payload.probe_text === "string"
        ? payload.probe_text
        : typeof payload.text === "string"
          ? payload.text
          : "";
    if (text.trim().length === 0) return { kind: "ignore" };
    const verdict = classifySurfaceSync(agent, text);
    if (verdict !== null && verdict.state === "idle") {
      return { kind: "report", fields: { state: "idle", ready: true } };
    }
    return { kind: "ignore" };
  }

  if (agent === "claude" || agent === "codex") {
    switch (event) {
      case "SessionStart": {
        const session = sessionFromPayload(agent, payload);
        const resume = resumeArgv(agent, payload, session);
        return {
          kind: "report",
          fields: {
            state: "unknown",
            ready: false,
            ...(session ? { session } : {}),
            ...(resume ? { resume_argv: resume } : {}),
            session_start: true,
            ...(sessionRefChangedHint(payload) ? { epochBump: true } : {}),
          },
        };
      }
      case "UserPromptSubmit":
        return { kind: "report", fields: { state: "working" } };
      case "PermissionRequest": {
        // Claude asks permission for its own question tool right after
        // PreToolUse: show what was asked, not the permission for asking.
        const message = isAskUserQuestion(agent, payload)
          ? (questionFromAskPayload(payload) ?? "question asked")
          : (questionFromPermissionPayload(payload) ?? "permission requested");
        return {
          kind: "report",
          fields: { state: "blocked", message },
        };
      }
      case "PreToolUse": {
        // ONLY AskUserQuestion (user-facing question UI, payload-confirmed).
        if (!isAskUserQuestion(agent, payload)) return { kind: "ignore" };
        return {
          kind: "report",
          fields: {
            state: "blocked",
            message: questionFromAskPayload(payload) ?? "question asked",
          },
        };
      }
      case "PostToolUse":
        return { kind: "report", fields: { state: "working" } };
      case "PostToolUseFailure":
        return { kind: "report", fields: { state: "working", failed: true } };
      case "Stop":
        return { kind: "report", fields: { state: "idle", ready: true } };
      case "StopFailure":
        // Turn died on API error: mark failed but stay reportable (the
        // agent is still alive and may retry). Never release from a hook:
        // only the wrapper (post child-exit) owns release.
        return { kind: "report", fields: { state: "unknown", failed: true } };
      case "Notification": {
        const t = payload.notification_type ?? payload.notificationType ?? null;
        if (
          t === "permission_prompt" ||
          t === "elicitation_dialog" ||
          t === "elicitation_url_dialog"
        ) {
          return {
            kind: "report",
            fields: {
              state: "blocked",
              message: messageFromPayload(payload) ?? "permission requested",
            },
          };
        }
        return { kind: "ignore" };
      }
      case "Elicitation":
      case "ElicitationResult":
        return {
          kind: "report",
          fields: {
            state: "blocked",
            message:
              messageFromPayload(payload, [
                "message",
                "prompt",
                "question",
                "title",
              ]) ?? "input requested",
          },
        };
      // SessionEnd/Interrupt NEVER release from a hook: Interrupt is a
      // turn-cancel (agent stays live); SessionEnd can be /clear/resume/switch
      // with the next SessionStart arriving on the same occupant (identity
      // ending events report unknown+not-ready, keeping name/session/resume).
      // Only the wrapper releases, after the child truly exits. Unknown
      // reasons stay honest: ignore, no state change.
      case "SessionEnd": {
        if (isIdentityEnding(payload)) {
          return { kind: "report", fields: { state: "unknown", ready: false } };
        }
        return { kind: "ignore" };
      }
      case "Interrupt":
        // Cancelled turn: back to unknown (agent live, prompt evidence comes
        // from the next surface/Stop — never fabricate idle here).
        return { kind: "report", fields: { state: "unknown" } };
      default:
        return { kind: "ignore" };
    }
  }
  return { kind: "ignore" };
}

function sessionFromPayload(agent, payload) {
  // claude: session_id (uuid) + transcript_path.
  // codex: session_id (thread id) + transcript_path (rollout path, required).
  const id =
    typeof payload.session_id === "string" && payload.session_id.length > 0
      ? payload.session_id
      : null;
  const transcript =
    typeof payload.transcript_path === "string" &&
    payload.transcript_path.length > 0
      ? payload.transcript_path
      : null;
  if (id) return { kind: "id", value: id };
  if (transcript) return { kind: "path", value: transcript };
  void agent;
  return null;
}

// True when the payload hints at a *different* session than the recorded one
// (caller compares against stored ref): resume/fork/clear sources. Kept
// conservative — main() compares against the stored ref file; this only flags
// payload-level hints.
function sessionRefChangedHint(payload) {
  const source = payload.source ?? null;
  return source === "resume" || source === "fork" || source === "clear";
}
// SessionEnd reasons, per primary docs (claude hooks ref: clear/resume/logout/
// prompt_input_exit/other; codex hooks ref: reason always "other" today).
// Identity-ending (process actually going away): logout and prompt_input_exit
// (user exits the CLI). clear/resume/other/compact keep the process alive —
// the next SessionStart arrives on the same occupant, so the hook must NOT
// release (only the wrapper releases, after the child truly exits).
// Unknown/absent reasons stay honest: not identity-ending, no state change.
export function isIdentityEnding(payload = {}) {
  const reason = payload.reason ?? null;
  return reason === "logout" || reason === "prompt_input_exit";
}


// The command that resumes this session in a fresh shell: argv[0] is the bare name
// on PATH, as omp's `resume_argv` is (`omp --resume=<ref>`).
export function resumeArgv(agent, payload, session) {
  void payload;
  if (!session || (session.kind !== "id" && session.kind !== "path")) return null;
  if (agent === "claude") return ["claude", "--resume", session.value];
  if (agent === "codex") return ["codex", "resume", session.value];
  return null;
}

function messageFromPayload(payload, keys = ["message", "text", "title", "prompt"]) {
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === "string" && v.trim().length > 0) {
      return v.trim().slice(0, 500);
    }
  }
  const toolInput = payload.tool_input;
  if (toolInput && typeof toolInput === "object") {
    const desc = toolInput.description ?? toolInput.command ?? null;
    if (typeof desc === "string" && desc.trim().length > 0) {
      return desc.trim().slice(0, 500);
    }
  }
  return null;
}

function questionFromPermissionPayload(payload) {
  // PermissionRequest carries tool_name + tool_input; surface both.
  const tool = payload.tool_name ?? payload.tool ?? null;
  const detail = messageFromPayload(payload, ["description", "message", "text"]);
  if (typeof tool === "string" && tool.length > 0) {
    return detail ? `${tool}: ${detail}`.slice(0, 500) : `${tool}: permission requested`;
  }
  return detail;
}

function isAskUserQuestion(agent, payload) {
  const tool = payload.tool_name ?? payload.tool ?? "";
  if (agent === "claude") {
    // Claude Code's user-question tool (docs: AskUserQuestion). Match exact
    // name only — never a substring.
    if (tool === "AskUserQuestion") return true;
    return false;
  }
  // codex: no AskUserQuestion tool; user questions arrive as PermissionRequest
  // / elicitation / strong-blocker surfaces — never PreToolUse.
  void agent;
  return false;
}

function questionFromAskPayload(payload) {
  const input = payload.tool_input;
  if (input && typeof input === "object") {
    const qs = input.questions ?? input.question ?? null;
    if (Array.isArray(qs)) {
      const first = qs
        .map((q) =>
          typeof q === "string"
            ? q
            : typeof q?.question === "string"
              ? q.question
              : typeof q?.text === "string"
                ? q.text
                : null,
        )
        .find((s) => typeof s === "string" && s.trim().length > 0);
      if (first) return first.trim().slice(0, 500);
    } else if (typeof qs === "string" && qs.trim().length > 0) {
      return qs.trim().slice(0, 500);
    }
    const header = input.header ?? null;
    if (typeof header === "string" && header.trim().length > 0) {
      return header.trim().slice(0, 500);
    }
  }
  return messageFromPayload(payload, ["question", "prompt", "message", "text"]);
}

// ---- per-launch pending-blocker store --------------------------------------
// Parallel tool calls need per-tool resolution: PostToolUse(B) must not clear
// a blocked question from AskUserQuestion(A). Hooks carry real correlation
// ids (claude: tool_use_id on Pre/Post/PermissionDenied; elicitation_id on
// Elicitation/ElicitationResult; codex: turn-scoped tool ids where present).
// The store is file-backed per launch (<dataDir>/hooks/<launch>.blockers.json,
// bounded) so parallel one-shot hook processes serialize through it.

export const MAX_BLOCKERS = 32;

// Pure: correlation id for a blocker-creating event, or null when the payload
// carries none (falls back to tool-name matching at report time).
export function blockerIdFor(event, payload = {}) {
  if (payload.tool_use_id !== undefined && payload.tool_use_id !== null && String(payload.tool_use_id).length > 0) {
    return `tool:${payload.tool_use_id}`;
  }
  if (payload.elicitation_id !== undefined && payload.elicitation_id !== null && String(payload.elicitation_id).length > 0) {
    return `elicitation:${payload.elicitation_id}`;
  }
  if (event === "Elicitation" || event === "ElicitationResult") {
    const server = payload.mcp_server_name ?? payload.mcp_server ?? null;
    if (typeof server === "string" && server.length > 0) return `elicitation-server:${server}`;
  }
  const tool = payload.tool_name ?? payload.tool ?? null;
  if ((event === "PermissionRequest" || event === "PreToolUse") && typeof tool === "string" && tool.length > 0) {
    return `tool-name:${tool}`;
  }
  return null;
}

// SessionStart with a new epoch resets old blockers (old-session events must
// neither add nor clear current blockers). resetBlockers is called with the
// fresh epoch right after epochForSession bumps it.
async function readBlockers(dataDir, launchId) {
  const file = join(hooksDir(dataDir), `${safeLaunchFile(launchId)}.blockers.json`);
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // Missing/corrupt: start empty.
  }
  return {};
}

async function writeBlockers(dataDir, launchId, store) {
  const dir = hooksDir(dataDir);
  await fs.mkdir(dir, { recursive: true });
  const file = join(dir, `${safeLaunchFile(launchId)}.blockers.json`);
  const entries = Object.entries(store).slice(-MAX_BLOCKERS);
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(entries)), "utf8");
  await fs.rename(tmp, file);
  return Object.fromEntries(entries);
}

// Reset blockers on a new session epoch. Called from main() right after
// epochForSession reports a bumped epoch (new SessionStart identity).
export async function resetBlockers(dataDir, launchId) {
  await writeBlockers(dataDir, launchId, {});
}
// Register a pending blocker. Returns the stored entry.
export async function addBlocker(dataDir, launchId, id, detail = {}) {
  const store = await readBlockers(dataDir, launchId);
  const entry = {
    id,
    tool: typeof detail.tool === "string" ? detail.tool : null,
    message: typeof detail.message === "string" ? detail.message : null,
    at: Date.now(),
  };
  store[id] = entry;
  await writeBlockers(dataDir, launchId, store);
  return entry;
}

// Resolve blockers matching an event: exact id wins; tool_use_id always exact;
// elicitation results match elicitation ids or same-server entries; PostToolUse
// matches ONLY the same tool_use_id (never an unrelated pending blocker).
// Returns {resolved: string[], remaining: Record}.
export async function resolveBlockers(dataDir, launchId, event, payload = {}) {
  const store = await readBlockers(dataDir, launchId);
  const ids = Object.keys(store);
  if (ids.length === 0) return { resolved: [], remaining: store };
  const resolved = [];
  const id = blockerIdFor(event, payload);
  const toolUseId = payload.tool_use_id != null ? String(payload.tool_use_id) : null;
  if (id !== null && store[id] !== undefined) {
    resolved.push(id);
  } else if (event === "PostToolUse" || event === "PostToolUseFailure") {
    // Completion without a matching id resolves NOTHING: an unrelated turn
    // finishing must not clear a still-open question (the parent invariant).
    // tool_use_id present but unknown => likewise nothing.
  } else if (event === "ElicitationResult") {
    const server = payload.mcp_server_name ?? payload.mcp_server ?? null;
    for (const key of ids) {
      if (key === id || (typeof server === "string" && store[key] && store[key].server === server)) {
        resolved.push(key);
      }
    }
  } else if (event === "PermissionDenied" && toolUseId !== null) {
    const key = `tool:${toolUseId}`;
    if (store[key] !== undefined) resolved.push(key);
  }
  if (resolved.length === 0) return { resolved: [], remaining: store };
  for (const key of resolved) delete store[key];
  await writeBlockers(dataDir, launchId, store);
  return { resolved, remaining: store };
}

export async function pendingBlockers(dataDir, launchId) {
  return readBlockers(dataDir, launchId);
}

function hooksDir(dataDir) {
  return join(dataDir, "hooks");
}

function safeLaunchFile(launchId) {
  return launchId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
}

async function readNumberFile(file) {
  try {
    const raw = await fs.readFile(file, "utf8");
    const n = Number(raw.trim());
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

// Monotonic cross-process seq: max(prev+1, Date.now()). Best-effort atomic
// via write-tmp+rename; races resolve to a still-monotonic value on next read.
export async function nextSeq(dataDir, launchId) {
  const dir = hooksDir(dataDir);
  await fs.mkdir(dir, { recursive: true });
  const file = join(dir, `${safeLaunchFile(launchId)}.seq`);
  const prev = await readNumberFile(file);
  const next = Math.max(Date.now(), (prev ?? 0) + 1);
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, String(next), "utf8");
  await fs.rename(tmp, file);
  return next;
}

// Session epoch file: {ref, epoch}. A changed session ref bumps the epoch;
// same ref keeps it. Returns {epoch, session_start}.
export async function epochForSession(dataDir, launchId, session, forceStart) {
  const dir = hooksDir(dataDir);
  await fs.mkdir(dir, { recursive: true });
  const file = join(dir, `${safeLaunchFile(launchId)}.epoch`);
  let stored = null;
  try {
    stored = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    stored = null;
  }
  const ref = session ? `${session.kind}:${session.value}` : null;
  const prevRef = typeof stored?.ref === "string" ? stored.ref : null;
  const prevEpoch =
    Number.isSafeInteger(stored?.epoch) && stored.epoch >= 0 ? stored.epoch : 0;
  if (ref !== null && prevRef !== null && ref !== prevRef) {
    const epoch = prevEpoch + 1;
    const tmp = `${file}.tmp-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify({ ref, epoch }), "utf8");
    await fs.rename(tmp, file);
    return { epoch, session_start: true };
  }
  if (ref !== null && prevRef === null) {
    const epoch = prevEpoch;
    const tmp = `${file}.tmp-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify({ ref, epoch }), "utf8");
    await fs.rename(tmp, file);
    return { epoch, session_start: true };
  }
  return { epoch: prevEpoch, session_start: forceStart === true };
}

// Read the current stored epoch without mutating (0 when absent/corrupt).
export async function currentEpoch(dataDir, launchId) {
  const file = join(hooksDir(dataDir), `${safeLaunchFile(launchId)}.epoch`);
  try {
    const stored = JSON.parse(await fs.readFile(file, "utf8"));
    if (Number.isSafeInteger(stored?.epoch) && stored.epoch >= 0) return stored.epoch;
  } catch {
    // Absent/corrupt: epoch 0.
  }
  return 0;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  if (parsed.error) {
    process.stderr.write(`hook: ${parsed.error}\n${USAGE}\n`);
    process.exit(2);
  }
  const { agent, event } = parsed;
  if (!AGENTS.includes(agent)) {
    process.stderr.write(`hook: --agent must be claude|codex\n${USAGE}\n`);
    process.exit(2);
  }
  if (typeof event !== "string" || event.length === 0) {
    process.stderr.write(`hook: --event is required\n${USAGE}\n`);
    process.exit(2);
  }
  const { dataDir, launchId, paneId } = resolveRuntimeIdentity(parsed);
  if (!dataDir || !launchId || paneId === null) {
    process.stderr.write(
      "hook: missing runtime identity (need --data-dir/--launch-id/--pane or TERN_AGENT_RUNTIME_DIR/TERN_AGENT_LAUNCH_ID/TERN_PANE)\n",
    );
    process.exit(2);
  }

  let payload = {};
  // ReadyProbe carries everything in --probe-text; never touch stdin there
  // (a prober spawn without a pipe would block forever reading it).
  const skipStdin =
    event === "ReadyProbe" || (process.stdin && process.stdin.isTTY === true);
  if (!skipStdin) {
    try {
      const raw = await readStdin();
      payload = raw.trim().length > 0 ? JSON.parse(raw) : {};
    } catch {
      payload = {};
    }
  }

  // ReadyProbe carries its surface as --probe-text (launch.mjs prober);
  // hook events carry theirs on stdin JSON.
  if (event === "ReadyProbe" && typeof parsed["probe-text"] === "string") {
    payload.probe_text = parsed["probe-text"];
  }
  const action = mapEvent(agent, event, payload);
  if (action.kind === "ignore") process.exit(0);

  // Per-tool blocker tracking (parallel tool calls): register on block,
  // gate completions on matching ids. Pure mapEvent decides the state;
  // the store only decides whether a completion clears it.
  const blockerEvents = new Set([
    "PermissionRequest",
    "PreToolUse",
    "Elicitation",
    "Notification",
  ]);
  const resolutionEvents = new Set([
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionDenied",
    "ElicitationResult",
    "Stop",
  ]);
  if (blockerEvents.has(event) && action.kind === "report" && action.fields?.state === "blocked") {
    const id = blockerIdFor(event, payload);
    if (id !== null) {
      await addBlocker(dataDir, launchId, id, {
        tool: payload.tool_name ?? payload.tool ?? null,
        message: action.fields.message ?? null,
        ...(payload.mcp_server_name ? { server: payload.mcp_server_name } : {}),
      }).catch(() => null);
    }
  } else if (resolutionEvents.has(event)) {
    const { resolved, remaining } = await resolveBlockers(dataDir, launchId, event, payload).catch(() => ({
      resolved: [],
      remaining: null,
    }));
    const matchedOwn = resolved.length > 0;
    // ANY remaining pending blocker keeps `blocked`, regardless of how many
    // this event resolved: a resolved A must not clear a still-open B question.
    const pendingKeys = remaining !== null ? Object.keys(remaining) : [];
    if (event === "PostToolUse" || event === "PostToolUseFailure") {
      if (pendingKeys.length > 0) {
        const first = remaining[pendingKeys[0]];
        action.kind = "report";
        action.fields = { state: "blocked", message: first?.message ?? "awaiting input" };
      }
    } else if (event === "PermissionDenied") {
      // Denial resolves ONLY its own pending request (same tool_use_id):
      // resolveBlockers already removed exactly that id. Anything still
      // pending keeps `blocked`; a lone matched denial leaves unknown
      // (turn needs input/retry — never infer working); no match at all
      // is an honest ignore.
      if (pendingKeys.length > 0) {
        const first = remaining[pendingKeys[0]];
        action.fields = { state: "blocked", message: first?.message ?? "awaiting input" };
      } else if (matchedOwn) {
        action.fields = { state: "unknown" };
      } else {
        process.exit(0);
      }
    } else if (event === "ElicitationResult") {
      // Answered elicitation resolves its own id; other pending blockers stay.
      if (pendingKeys.length > 0) {
        const first = remaining[pendingKeys[0]];
        action.kind = "report";
        action.fields = { state: "blocked", message: first?.message ?? "awaiting input" };
      }
      // else: fall through to mapEvent's own resolution (turn continues).
    }
  }

  let request;
  try {
    ({ request } = await import("../client.mjs"));
  } catch (err) {
    process.stderr.write(`hook: cannot load client: ${err?.message ?? err}\n`);
    process.exit(1);
  }

  const source = `tern:${agent}`;
  const fields = action.fields ?? {};
  const seq = await nextSeq(dataDir, launchId).catch(() => null);
  if (seq === null) {
    process.stderr.write("hook: cannot allocate seq\n");
    process.exit(1);
  }
  let sessionEpoch = 0;
  let sessionStart = fields.session_start === true;
  let epochBumped = false;
  if (fields.session) {
    const prevEpoch = await currentEpoch(dataDir, launchId).catch(() => 0);
    try {
      const e = await epochForSession(
        dataDir,
        launchId,
        fields.session,
        fields.session_start === true || fields.epochBump === true,
      );
      sessionEpoch = e.epoch;
      sessionStart = e.session_start;
      epochBumped = e.epoch > prevEpoch;
    } catch {
      sessionEpoch = 0;
      sessionStart = fields.session_start === true;
    }
    // New session identity resets old blockers BEFORE any blocker mutation:
    // old-session events must neither add nor clear current blockers.
    if (epochBumped) {
      await resetBlockers(dataDir, launchId).catch(() => null);
    }
  }
  const { epochBump: _drop, ...rest } = fields;
  void _drop;
  let result;
  try {
    result = await request(resolve(dataDir), "report", {
      v: 1,
      pane_id: paneId,
      launch_id: launchId,
      source,
      agent,
      ...rest,
      seq,
      session_epoch: sessionEpoch,
      ...(sessionStart ? { session_start: true } : {}),
    });
  } catch (err) {
    process.stderr.write(`hook: report failed: ${err?.message ?? err}\n`);
    process.exit(1);
  }
  // A dropped report must never look like success: stale seq/epoch (normal
  // races) exit 0 deliberately — the next event re-reports. Anything else
  // (invalid schema, unknown source, unexpected occupant) is a real bug:
  // stderr + nonzero exit, never suppressed.
  if (result && result.accepted === false) {
    const reason = result.reason ?? "rejected";
    if (reason === "stale-seq" || reason === "stale-session" || reason === "stale-epoch") {
      process.exit(0);
    }
    process.stderr.write(`hook: report rejected: ${reason}\n`);
    process.exit(1);
  }
  process.exit(0);
}

// Real entry path (Node CLI pattern): compare the resolved script path, not
// a loose suffix match that any file named hook.mjs would satisfy.
const entryArg = process.argv[1] ?? "";
let isHookEntry = false;
try {
  isHookEntry = import.meta.url === pathToFileURL(entryArg).href;
} catch {
  isHookEntry = false;
}
if (isHookEntry) {
  void main();
}

