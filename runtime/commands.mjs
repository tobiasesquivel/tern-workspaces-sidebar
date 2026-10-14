// Agent commands over shared runtime state + Tern terminal access.
//
// createCommands({ state, tern, dataDir, clock? }) -> { read, wait, prompt, start }.
// `state` is the RuntimeCore-owned store (list/get/claim/release; get throws
// RuntimeError with code agent_not_found). `tern` is the adapter from
// ./tern.mjs. `clock` ({ now, sleep }) is injectable for tests; defaults to
// wall-clock timers.
//
// Returned payloads are herdr-compatible `result` envelopes; the CLI/server
// wraps them as { id, result }. Errors are RuntimeError with herdr codes:
// agent_not_found, agent_target_ambiguous, agent_not_running,
// agent_name_taken, invalid_agent_name, unsupported_agent_kind,
// invalid_agent_timeout, invalid_agent_argument, invalid_argument,
// agent_pane_not_found, agent_pane_busy, agent_pane_unavailable,
// agent_start_transport_failed, agent_name_not_found, agent_kind_mismatch,
// agent_not_ready, agent_start_failed, empty_agent_prompt, agent_blocked,
// agent_prompt_failed, agent_prompt_stalled, timeout.

import { RuntimeError } from './state.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VALID_STATUSES = ['idle', 'working', 'blocked', 'done', 'unknown'];
const DEFAULT_UNTIL = ['idle', 'done', 'blocked'];
const VALID_SOURCES = ['visible', 'recent', 'recent-unwrapped', 'detection'];
const VALID_FORMATS = ['text', 'ansi'];
// Kinds startable through runtime/launch.mjs (wrapper contract with
// connector owners). CLI help lists exactly these; anything else is
// unsupported_agent_kind, not a usage error.
const START_KINDS = ['omp', 'claude', 'codex'];
const VALID_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const CONTROL_ARG_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
const START_TIMEOUT_DEFAULT = 30000;
const START_TIMEOUT_MIN_EXCLUSIVE = 3000;
const START_TIMEOUT_MAX = 300000;
const PROMPT_GATE_MS = 5000;
const AGENT_PROMPT_SUBMIT_DELAY_MS = 300;
const POLL_MS = 100;
const READ_DEFAULT_LINES = 80;
const READ_MAX_LINES = 1000;

const realClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function fail(code, message) {
  throw new RuntimeError(code, message);
}

function seqOf(agent) {
  const seq = agent?.state_change_seq ?? 0;
  return typeof seq === 'number' && Number.isFinite(seq) ? seq : 0;
}

function labelOf(target) {
  return typeof target === 'string' ? target : String(target?.name ?? target?.pane_id ?? target);
}

function normalizeUntil(until) {
  if (until === undefined || until === null) return [...DEFAULT_UNTIL];
  const list = Array.isArray(until) ? until : [until];
  if (list.length === 0) return [...DEFAULT_UNTIL];
  for (const status of list) {
    if (!VALID_STATUSES.includes(status)) {
      fail('invalid_argument', `invalid status: ${status}; expected one of ${VALID_STATUSES.join('|')}`);
    }
  }
  return [...list];
}

// Timeout in ms, or undefined for indefinite. Rejects non-integers/negatives.
function normalizeTimeout(timeout, what = 'timeout') {
  if (timeout === undefined || timeout === null) return undefined;
  const ms = typeof timeout === 'string' && timeout.trim() !== '' ? Number(timeout) : timeout;
  if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 0) {
    fail('invalid_argument', `invalid ${what}: ${timeout}; expected a non-negative integer of milliseconds`);
  }
  return ms;
}

function pinOf(agent) {
  return {
    terminal_id: agent.terminal_id,
    name: agent.name ?? null,
    agent: agent.agent ?? null,
  };
}

function checkPin(agent, pin, target) {
  if (
    agent.terminal_id !== pin.terminal_id ||
    (agent.name ?? null) !== (pin.name ?? null) ||
    (agent.agent ?? null) !== (pin.agent ?? null)
  ) {
    fail('agent_not_running', `agent ${labelOf(target)} is no longer running`);
  }
}

function normalizeKind(kind) {
  if (typeof kind !== 'string' || !START_KINDS.includes(kind)) {
    fail('unsupported_agent_kind', `unsupported agent kind: ${kind}; expected one of ${START_KINDS.join('|')}`);
  }
  return kind;
}
function getChecked(state, target) {
  try {
    return state.get(target);
  } catch (err) {
    if (err && (err.code === 'agent_not_found' || err.code === 'agent_target_ambiguous')) {
      fail('agent_not_running', `agent ${labelOf(target)} is no longer running`);
    }
    throw err;
  }
}

async function waitLoop(state, clock, target, pin, wanted, deadlineMs) {
  for (;;) {
    const remaining = deadlineMs - clock.now();
    if (!(remaining > 0)) {
      const recheck = getChecked(state, target);
      checkPin(recheck, pin, target);
      if (wanted.includes(recheck.agent_status)) return recheck;
      fail(
        'timeout',
        `timed out waiting for agent to reach ${wanted.join('|')}; current status is ${recheck.agent_status}`,
      );
    }
    await clock.sleep(Math.min(POLL_MS, remaining));
    const next = getChecked(state, target);
    checkPin(next, pin, target);
    if (wanted.includes(next.agent_status)) return next;
  }
}

function normalizeSource(source) {
  const raw = source === undefined || source === null || source === '' ? 'recent' : String(source);
  const aliased = raw === 'recent_unwrapped' ? 'recent-unwrapped' : raw;
  if (!VALID_SOURCES.includes(aliased)) {
    fail('invalid_argument', `invalid source: ${raw}; expected one of ${VALID_SOURCES.join('|')}`);
  }
  return aliased;
}

function normalizeLines(lines) {
  if (lines === undefined || lines === null) return READ_DEFAULT_LINES;
  const n = typeof lines === 'string' && lines.trim() !== '' ? Number(lines) : lines;
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
    fail('invalid_argument', `invalid lines: ${lines}; expected a positive integer`);
  }
  return Math.min(n, READ_MAX_LINES);
}

function stripAnsi(text) {
  return String(text).replace(ANSI_RE, '');
}

function takeLastLines(text, count) {
  const normalized = String(text).replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  // A trailing newline terminates the last line; it is not content.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const truncated = lines.length > count;
  return { text: lines.slice(-count).join('\n'), truncated };
}

function normalizeName(name) {
  if (typeof name !== 'string' || !VALID_NAME_RE.test(name)) {
    fail(
      'invalid_agent_name',
      `invalid agent name: ${name}; must start with a-z, up to 32 chars of a-z 0-9 - _`,
    );
  }
  return name;
}
function normalizeStartTimeout(timeout) {
  const ms = timeout === undefined || timeout === null ? START_TIMEOUT_DEFAULT : timeout;
  const n = typeof ms === 'string' && ms.trim() !== '' ? Number(ms) : ms;
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= START_TIMEOUT_MIN_EXCLUSIVE || n > START_TIMEOUT_MAX) {
    fail(
      'invalid_agent_timeout',
      `invalid timeout: ${timeout}; expected an integer >${START_TIMEOUT_MIN_EXCLUSIVE} and <=${START_TIMEOUT_MAX} ms`,
    );
  }
  return n;
}

function normalizeStartArgs(args) {
  const list = args === undefined || args === null ? [] : args;
  if (!Array.isArray(list)) fail('invalid_agent_argument', 'agent args must be an array of strings');
  for (const arg of list) {
    if (typeof arg !== 'string') fail('invalid_agent_argument', 'agent args must be an array of strings');
    if (CONTROL_ARG_RE.test(arg)) fail('invalid_agent_argument', 'agent args must not contain control characters');
  }
  return [...list];
}

function normalizePaneId(pane) {
  const id = typeof pane === 'number' ? pane : Number(pane);
  if (!Number.isSafeInteger(id) || id < 0) {
    fail('agent_pane_not_found', `pane not found: ${pane}`);
  }
  return id;
}

function exitedFlag(info) {
  if (!info || typeof info !== 'object') return null;
  return info.exited ?? info.block?.exited ?? info.pane?.exited ?? null;
}

function makeLaunchId() {
  const rand = Math.floor(Math.random() * 0xffffff).toString(36);
  return `cli-${process.pid}-${Date.now().toString(36)}-${rand}`;
}

export function createCommands({ state, tern, dataDir, clock } = {}) {
  if (!state || !tern || !dataDir) {
    throw new TypeError('createCommands requires { state, tern, dataDir }');
  }
  const clk = clock || realClock;
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const launchFile = path.join(thisDir, 'launch.mjs');

  async function read(params = {}) {
    const { target } = params;
    const source = normalizeSource(params.source);
    const lines = normalizeLines(params.lines);
    const format = params.format === undefined || params.format === null ? 'text' : String(params.format);
    if (!VALID_FORMATS.includes(format)) {
      fail('invalid_argument', `invalid format: ${params.format}; expected one of ${VALID_FORMATS.join('|')}`);
    }
    const ansi = Boolean(params.ansi) || format === 'ansi';
    const agent = state.get(target);
    const pane = agent.pane_id;
    const cap = await tern.capture(String(pane), {
      scrollback: source !== 'visible',
      // omp renders question/permission UI outside the main region: recent
      // reads include surfaces (human question visible) unless the caller
      // explicitly asked for the bare visible viewport.
      surfaces: source !== 'visible',
      ansi,
    });
    const raw = typeof cap?.text === 'string' ? cap.text : '';
    const normalized = raw.replace(/\r\n/g, '\n');
    const cleaned = ansi ? normalized : stripAnsi(normalized);
    const { text, truncated } = takeLastLines(cleaned, lines);
    return {
      type: 'pane_read',
      read: {
        pane_id: pane,
        workspace_id: agent.workspace_id ?? null,
        tab_id: agent.tab_id ?? null,
        source,
        format: ansi ? 'ansi' : 'text',
        text,
        revision: 0,
        truncated,
      },
    };
  }

  async function wait(params = {}) {
    const { target } = params;
    const wanted = normalizeUntil(params.until);
    const timeout = normalizeTimeout(params.timeout);
    const first = state.get(target);
    const pin = pinOf(first);
    if (wanted.includes(first.agent_status)) return { type: 'agent_info', agent: first };
    const deadlineMs = timeout === undefined ? Number.POSITIVE_INFINITY : clk.now() + timeout;
    const matched = await waitLoop(state, clk, target, pin, wanted, deadlineMs);
    return { type: 'agent_info', agent: matched };
  }

  async function prompt(params = {}) {
    // The total --timeout budget starts BEFORE send: paste/transport delays
    // consume the same deadline the settled wait uses.
    const acceptedAt = clk.now();
    const { target } = params;
    const text = params.text;
    if (typeof text !== 'string' || text.trim().length === 0) {
      fail('empty_agent_prompt', 'prompt text must not be empty');
    }
    const waitForSettled = Boolean(params.wait);
    const wanted = normalizeUntil(params.until);
    const timeout = normalizeTimeout(params.timeout);
    const deadlineMs = timeout === undefined ? Number.POSITIVE_INFINITY : acceptedAt + timeout;
    const before = state.get(target);
    if (before.agent_status === 'blocked') {
      const reason = before.message ? `: ${before.message}` : '';
      fail('agent_blocked', `agent ${labelOf(target)} is blocked${reason}`);
    }
    // Never type into an agent that is not ready for input: startup/auth UI
    // (launch_pending, unknown, not interactive) cannot accept a prompt.
    if (before.launch_pending || !before.interactive_ready || before.agent_status === 'unknown') {
      fail('agent_not_ready', `agent ${labelOf(target)} is not ready for input`);
    }
    const pin = pinOf(before);
    const pane = before.pane_id;
    const baseline = seqOf(before);
    const baselineCompletion = typeof before.completion_seq === 'number' ? before.completion_seq : null;
    try {
      await tern.send(String(pane), 'paste', text);
      // Reference submit delay (herdr AGENT_PROMPT_SUBMIT_DELAY=300ms):
      // the paste is async at the TSP layer; Enter immediately after can
      // submit before the text lands. Inside the overall timeout, not extra.
      await clk.sleep(Math.min(AGENT_PROMPT_SUBMIT_DELAY_MS, Math.max(0, deadlineMs - clk.now())));
      await tern.send(String(pane), 'keys', 'Enter');
    } catch (err) {
      fail('agent_prompt_failed', `failed to submit prompt to agent ${labelOf(target)}: ${err?.message || err}`);
    }
    const sent = getChecked(state, target);
    checkPin(sent, pin, target);
    if (!waitForSettled) return { type: 'agent_prompted', agent: sent };

    // Activity gate: from a non-working state the submission must produce
    // observed activity within 5s, else stalled. A fast turn that completes
    // between polls (working->idle before we observe working) still counts:
    // accept completion_seq past baseline as proof, not just a currently
    // visible working|blocked state.
    if (before.agent_status !== 'working') {
      let observed = false;
      // Gate runs from SUBMIT completion (after paste+delay+Enter), not from
      // acceptance: transport time must not eat the 5s activity window.
      const gateStart = clk.now();
      const gateDeadline = gateStart + Math.min(Math.max(0, deadlineMs - gateStart), PROMPT_GATE_MS);
      while (clk.now() < gateDeadline) {
        await clk.sleep(Math.min(POLL_MS, Math.max(1, gateDeadline - clk.now())));
        const cur = getChecked(state, target);
        checkPin(cur, pin, target);
        const completion = typeof cur.completion_seq === 'number' ? cur.completion_seq : null;
        if (seqOf(cur) > baseline && (
          cur.agent_status === 'working' ||
          cur.agent_status === 'blocked' ||
          (completion !== null && (baselineCompletion === null || completion > baselineCompletion))
        )) {
          observed = true;
          break;
        }
      }
      if (!observed) {
        const cur = getChecked(state, target);
        checkPin(cur, pin, target);
        // Only a budget that never allowed the full 5s gate reports
        // timeout; a full gate with no activity is stalled even when the
        // total timeout is larger.
        if (timeout !== undefined && deadlineMs - acceptedAt <= PROMPT_GATE_MS) {
          fail(
            'timeout',
            `timed out waiting for agent activity after prompt; current status is ${cur.agent_status}`,
          );
        }
        fail(
          'agent_prompt_stalled',
          `agent prompt produced no observed working or blocked state within 5000 ms; current status is ${cur.agent_status}`,
        );
      }
    }
    const matched = await waitLoop(state, clk, target, pin, wanted, deadlineMs);
    return { type: 'agent_prompted', agent: matched };
  }

  async function start(params = {}) {
    const name = normalizeName(params.name);
    const kind = normalizeKind(params.kind);
    const agentArgs = normalizeStartArgs(params.args);
    const timeout = normalizeStartTimeout(params.timeout);
    const paneId = normalizePaneId(params.pane);

    const found = await tern.findPane(paneId);
    if (!found) fail('agent_pane_not_found', `pane not found: ${params.pane}`);

    try {
      const existing = state.get(name);
      void existing;
      fail('agent_name_taken', `agent name is already taken: ${name}`);
    } catch (err) {
      if (err && err.code === 'agent_name_taken') throw err;
      if (!(err && err.code === 'agent_not_found')) throw err;
    }

    if (state.list().some((a) => Number(a.pane_id) === paneId)) {
      fail('agent_pane_busy', `pane already hosts an agent: ${params.pane}`);
    }

    let proc;
    try {
      proc = await tern.process(String(paneId));
    } catch (err) {
      fail('agent_pane_unavailable', `pane is not available for start: ${err?.message || err}`);
    }
    if (exitedFlag(proc) !== null && exitedFlag(proc) !== undefined) {
      fail('agent_pane_not_found', `pane not found: ${params.pane}`);
    }

    const launchId = makeLaunchId();
    const claimed = state.claim({ pane_id: paneId, agent: kind, name, launch_id: launchId });
    const pinnedTerminal = claimed.terminal_id;
    const wrapperArgv = [
      process.execPath,
      launchFile,
      '--agent', kind,
      '--data-dir', dataDir,
      '--launch-id', launchId,
      '--',
      ...agentArgs,
    ];
    try {
      await tern.runNode(String(paneId), wrapperArgv);
    } catch (err) {
      try {
        state.release({ pane_id: paneId, launch_id: launchId });
      } catch {
        // Best effort: the name frees when the occupant exits anyway.
      }
      fail('agent_start_transport_failed', `failed to launch ${kind} in pane ${params.pane}: ${err?.message || err}`);
    }

    const START_SETTLE_MS = 3000;
    const deadlineMs = clk.now() + timeout;
    // Settle: a first idle+ready snapshot is NOT success (live proof: native
    // hint reported idle+ready 250ms before the connector crashed). The
    // ready condition must hold continuously for START_SETTLE_MS; any state
    // change, identity change, or process exit resets the settle window.
    // Connector session metadata (agent_session/resume) is NOT required:
    // identity + stable ready is the contract; OmpConnector reports sessions
    // separately once the extension loads.
    let settledSince = null;
    let lastSeq = null;
    for (;;) {
      let cur = null;
      try {
        cur = state.get(name);
      } catch (err) {
        if (!(err && err.code === 'agent_not_found')) throw err;
        try {
          cur = state.get(String(paneId));
        } catch (inner) {
          if (!(inner && inner.code === 'agent_not_found')) throw inner;
          cur = null;
        }
      }
      if (cur === null) {
        fail('agent_name_not_found', `agent ${name} disappeared during startup`);
      }
      if (cur.terminal_id !== pinnedTerminal) {
        fail('agent_name_not_found', `agent ${name} was replaced during startup`);
      }
      if (cur.agent !== kind) {
        fail('agent_kind_mismatch', `expected ${kind}, detected ${cur.agent}`);
      }
      const status = cur.agent_status;
      if (status === 'blocked') {
        fail('agent_not_ready', `agent ${name} is blocked during startup${cur.message ? `: ${cur.message}` : ''}`);
      }
      // Readiness requires idle|done + interactive_ready. `unknown` never
      // proves ready on state alone (claude/codex SessionStart reports
      // unknown + ready:false); unknown keeps waiting for Stop->idle.
      // Surface-based early accept (classifySurface) stays in connector
      // ownership; this poll does not duplicate detection rules.
      const readyNow = (status === 'idle' || status === 'done') && cur.interactive_ready;
      if (readyNow && (settledSince === null || lastSeq === null || seqOf(cur) !== lastSeq)) {
        // Fresh ready observation (or any state change): restart settle. A
        // readiness flip alone moves no state_change_seq (codex: the claim's own
        // idle turns ready), so "not settling yet" starts the window too.
        settledSince = clk.now();
        lastSeq = seqOf(cur);
      } else if (!readyNow) {
        settledSince = null;
        lastSeq = seqOf(cur);
      }
      if (readyNow && settledSince !== null && clk.now() - settledSince >= START_SETTLE_MS) {
        return { type: 'agent_started', agent: cur, argv: wrapperArgv };
      }
      if ((status === 'idle' || status === 'done') && !cur.launch_pending && !cur.interactive_ready) {
        // Process-exited occupant that will never become ready: fail fast
        // instead of burning the whole timeout. No name cleanup beyond the
        // transport-failure release above: the occupant record is live state.
        fail('agent_start_failed', `agent ${name} exited before becoming interactive`);
      }
      if (!(clk.now() < deadlineMs)) {
        fail('timeout', 'timed out waiting for agent startup');
      }
      await clk.sleep(Math.min(POLL_MS, Math.max(1, deadlineMs - clk.now())));
    }
  }

  return { read, wait, prompt, start };
}
