// runtime/connectors/hook.mjs — one-shot hook reporter for claude/codex.
//
// Ownership: ThirdConnectors. Invoked by the hooks that prepareLaunch()
// installs (claude --settings file, codex `-c hooks.*` session flags) with:
//   node <connectorDir>/hook.mjs --agent claude|codex --event NAME
// stdin: the hook event JSON (claude/codex documented schemas, verified
// against https://code.claude.com/docs/en/hooks and
// https://developers.openai.com/codex/hooks on 2026-10-12).
//
// As herdr does (research/herdr-agent-detection.md §1.3), the screen decides an
// agent's state; hooks only add what the screen cannot know:
// - SessionStart (both): identity only — the session ref, the resume argv and
//   session_start. No state, no readiness.
// - Codex v9 turn events: UserPromptSubmit → working, Stop → idle, Interrupt →
//   idle. The daemon lets them win over the screen except for a visible blocker.
// - Message hints (both): PermissionRequest, PreToolUse AskUserQuestion,
//   Notification permission_prompt|elicitation_*, Elicitation. They report
//   `{state:"blocked", hint:true, message}`: the daemon keeps the message for the
//   next blocked screen and never takes the state from it. herdr installs none of
//   these; the question text is what the screen cannot give.
// - Everything else (Claude turn events, PostToolUse, SessionEnd, denials,
//   subagent traffic, unknown names): ignored, no report.
//
// Cross-process seq: file-backed counter per (launch_id) under
// <dataDir>/hooks/<launchId>.seq holding max(Date.now(), prev+1) so every
// one-shot invocation grows the seq even across processes (satisfies the
// core's per-source/launch monotonic gate). Session epochs likewise live in
// <dataDir>/hooks/<launchId>.epoch: a changed session ref bumps the epoch with
// session_start:true; the old session never revives (core tombstones it).
// This hook never approves or rejects anything (exit 0, no JSON decision
// output to the agent) — it only observes.

import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
      name === "--pane"
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

// Pure: map one hook event payload to a report or an honest ignore.
// Returns {kind:"report",fields} | {kind:"ignore"}.
export function mapEvent(agent, eventName, payload = {}) {
  const event = eventName ?? payload.hook_event_name ?? null;
  if (typeof event !== "string" || event.length === 0) return { kind: "ignore" };
  if (agent !== "claude" && agent !== "codex") return { kind: "ignore" };
  // Subagent traffic never moves the main pane occupant (claude/codex agent_id,
  // codex Subagent* events likewise).
  if (
    event === "SubagentStart" ||
    event === "SubagentStop" ||
    (payload.agent_id !== undefined && payload.agent_id !== null && payload.agent_id !== "")
  ) {
    return { kind: "ignore" };
  }
  const hint = (message) => ({ kind: "report", fields: { state: "blocked", hint: true, message } });
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
      return agent === "codex" ? { kind: "report", fields: { state: "working" } } : { kind: "ignore" };
    case "Stop":
    case "Interrupt":
      return agent === "codex" ? { kind: "report", fields: { state: "idle" } } : { kind: "ignore" };
    case "PermissionRequest":
      // Claude asks permission for its own question tool right after PreToolUse:
      // the hint is what was asked, not the permission for asking it.
      return hint(
        isAskUserQuestion(agent, payload)
          ? (questionFromAskPayload(payload) ?? "question asked")
          : (questionFromPermissionPayload(payload) ?? "permission requested"),
      );
    case "PreToolUse":
      if (!isAskUserQuestion(agent, payload)) return { kind: "ignore" };
      return hint(questionFromAskPayload(payload) ?? "question asked");
    case "Notification": {
      const t = payload.notification_type ?? payload.notificationType ?? null;
      if (t === "permission_prompt" || t === "elicitation_dialog" || t === "elicitation_url_dialog") {
        return hint(messageFromPayload(payload) ?? "permission requested");
      }
      return { kind: "ignore" };
    }
    case "Elicitation":
      return hint(messageFromPayload(payload, ["message", "prompt", "question", "title"]) ?? "input requested");
    default:
      return { kind: "ignore" };
  }
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
  if (!(process.stdin && process.stdin.isTTY === true)) {
    try {
      const raw = await readStdin();
      payload = raw.trim().length > 0 ? JSON.parse(raw) : {};
    } catch {
      payload = {};
    }
  }
  const action = mapEvent(agent, event, payload);
  if (action.kind === "ignore") process.exit(0);

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
  if (fields.session) {
    try {
      const e = await epochForSession(
        dataDir,
        launchId,
        fields.session,
        fields.session_start === true || fields.epochBump === true,
      );
      sessionEpoch = e.epoch;
      sessionStart = e.session_start;
    } catch {
      sessionEpoch = 0;
      sessionStart = fields.session_start === true;
    }
  } else {
    // A report without a session rides the current epoch: the core rejects
    // any other one as stale.
    sessionEpoch = await currentEpoch(dataDir, launchId).catch(() => 0);
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

