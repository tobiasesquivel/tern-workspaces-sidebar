// tern omp connector — own extension, beside (never editing) the herdr-managed file.
//
// Loaded by omp via flag (verified `omp --help` 18.10.3): `-e, --extension=<value>`.
// The launch wrapper passes this file's absolute path as `--extension=<abs>`.
// NEVER copy this file into ~/.omp/agent/extensions by hand; the wrapper loads
// it in place so personal config stays untouched.
//
// Event surface evidence: the herdr-managed omp extension (managed v8) and the
// v10 asset add OMPCODE + willContinue guards, both included here. Event flow
// and retryable-error pattern ported from the herdr omp extension (Apache-2.0,
// github.com/herdrdev/herdr); the source license text ships with the sounds
// in sounds/LICENSE. This connector only emits working|blocked|idle;
// done/unknown are derived by the daemon. Transport is RuntimeCore's
// createReporter (dynamically imported so unit tests never need the daemon).
//
// Env (set by runtime/launch.mjs):
//   TERN_AGENT_RUNTIME_DIR, TERN_AGENT_LAUNCH_ID, TERN_PANE (numeric, >2^32 kept
//   exact — never bitwise ops, Number.isSafeInteger only).
//   Optional tuning: TERN_OMP_IDLE_DEBOUNCE_MS (default 250),
//   TERN_OMP_RETRY_GRACE_MS (default 2500).
// process.env.OMPCODE === "1" means a nested omp inside a pane shell: silent no-op.

// @ts-nocheck
import path from "node:path";

export const SOURCE = "tern:omp";
export const AGENT = "omp";

// Exact retryable pattern proven in the herdr asset; do not widen on a hunch.
export const RETRYABLE_ERROR_PATTERN =
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

export function readConfig(env = process.env) {
  if (env.OMPCODE === "1") {
    return { ok: false, nested: true, reason: "nested omp session (OMPCODE=1)" };
  }
  const dataDir = env.TERN_AGENT_RUNTIME_DIR || "";
  const launchId = env.TERN_AGENT_LAUNCH_ID || "";
  if (!dataDir) return { ok: false, reason: "missing TERN_AGENT_RUNTIME_DIR" };
  if (!launchId) return { ok: false, reason: "missing TERN_AGENT_LAUNCH_ID" };
  const rawPane = env.TERN_PANE;
  if (rawPane === undefined || rawPane === "") {
    return { ok: false, reason: "missing TERN_PANE" };
  }
  const paneId = Number(rawPane);
  if (!Number.isSafeInteger(paneId) || paneId <= 0) {
    return { ok: false, reason: "missing or invalid TERN_PANE" };
  }
  return { ok: true, dataDir, launchId, paneId };
}

export function isRetryableError(text) {
  return RETRYABLE_ERROR_PATTERN.test(String(text ?? ""));
}

// Session identity: absolute path wins over id (matches herdr resume order).
export function sessionRefFromCtx(ctx) {
  let file;
  try {
    file = ctx?.sessionManager?.getSessionFile?.();
  } catch {
    file = undefined;
  }
  if (
    typeof file === "string" &&
    (path.posix.isAbsolute(file) || path.win32.isAbsolute(file))
  ) {
    return { kind: "path", value: file };
  }
  let id;
  try {
    id = ctx?.sessionManager?.getSessionId?.();
  } catch {
    id = undefined;
  }
  if (typeof id === "string" && id.length > 0) {
    return { kind: "id", value: id };
  }
  return null;
}

export function resumeArgvFor(ref) {
  if (!ref) return null;
  // argv[0] is the bare name on PATH, never a path; matches omp --resume=<value>.
  return ["omp", `--resume=${ref.value}`];
}

export function askBlockedMessage(args) {
  const questions = Array.isArray(args?.questions) ? args.questions : [];
  const first = questions.find((q) => typeof q?.question === "string");
  if (first?.question) return first.question;
  return "waiting for user input";
}

function lastAssistantMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "assistant") return messages[i];
  }
  return undefined;
}

export function retryableErrorMessage(event) {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  const assistant = lastAssistantMessage(messages);
  if (assistant?.stopReason !== "error") return undefined;
  const text = String(assistant.errorMessage ?? "");
  if (!isRetryableError(text)) return undefined;
  return text || "retryable provider error";
}

function numEnv(env, name, fallback) {
  const raw = env?.[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

// Pure state machine. sink = { session(fields), state(fields), release() }.
// Every payload carries the current session ref + epoch so the daemon can pin
// reports to the occupant; session_start:true authorizes a new identity.
export function createMachine(sink, opts = {}) {
  const paneId = opts.paneId;
  const launchId = opts.launchId;
  const idleDebounceMs = opts.idleDebounceMs ?? 250;
  const retryGraceMs = opts.retryGraceMs ?? 2500;

  let rootSession = false;
  let agentActive = false;
  let retryHoldActive = false;
  let failureBlocked = false;
  let failureMessage;
  let failed = false;
  let failedMessage;
  let blockedCount = 0;
  let blockedMessage;
  let lastState;
  let lastMessage;
  let lastFailed;
  let idleTimer;
  let retryTimer;
  let sessionEpoch = 0;
  let sessionRef = null;
  let resumeArgv = null;

  function clearPendingTimers() {
    clearTimeout(idleTimer);
    clearTimeout(retryTimer);
    idleTimer = undefined;
    retryTimer = undefined;
  }

  function clearFailureState() {
    retryHoldActive = false;
    failureBlocked = false;
    failureMessage = undefined;
  }

  function base() {
    return {
      pane_id: paneId,
      launch_id: launchId,
      source: SOURCE,
      agent: AGENT,
      session: sessionRef,
      session_epoch: sessionEpoch,
      ready: true,
    };
  }

  function emitSession() {
    // Session reports ride the same `report` method as states, and the core
    // rejects reports without a valid state — so the session payload carries
    // the current desired state too. The state report that always follows
    // (publishState) converges anything transient; identity + resume are what
    // must survive even if later reports drop.
    const d = desired();
    sink.session({
      ...base(),
      session_start: true,
      resume_argv: resumeArgv,
      state: d.state,
      message: d.message,
      failed,
    });
  }

  function desired() {
    if (blockedCount > 0) return { state: "blocked", message: blockedMessage };
    if (failureBlocked) return { state: "blocked", message: failureMessage };
    if (agentActive || retryHoldActive) {
      return { state: "working", message: undefined };
    }
    return { state: "idle", message: failed ? failedMessage : undefined };
  }

  function publishState(force = false) {
    const next = desired();
    if (
      !force &&
      next.state === lastState &&
      next.message === lastMessage &&
      failed === lastFailed
    ) {
      return;
    }
    lastState = next.state;
    lastMessage = next.message;
    lastFailed = failed;
    sink.state({ ...base(), state: next.state, message: next.message, failed });
  }

  function scheduleIdle() {
    clearPendingTimers();
    clearFailureState();
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      publishState();
    }, idleDebounceMs);
    idleTimer.unref?.();
  }

  function holdForRetry(message) {
    clearPendingTimers();
    retryHoldActive = true;
    failureBlocked = false;
    failureMessage = message;
    publishState();
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      retryHoldActive = false;
      failureBlocked = true;
      publishState();
    }, retryGraceMs);
    retryTimer.unref?.();
  }

  function noteSessionRef(ctx) {
    const ref = sessionRefFromCtx(ctx);
    const changed = JSON.stringify(ref) !== JSON.stringify(sessionRef);
    if (changed) {
      sessionRef = ref;
      resumeArgv = resumeArgvFor(ref);
      sessionEpoch += 1;
      return true;
    }
    return false;
  }

  function activateRootSession(ctx) {
    if (ctx?.hasUI !== true) return false;
    const first = !rootSession;
    rootSession = true;
    if (first && sessionEpoch === 0) {
      sessionRef = sessionRefFromCtx(ctx);
      resumeArgv = resumeArgvFor(sessionRef);
      sessionEpoch = 1;
      emitSession();
    } else if (noteSessionRef(ctx)) {
      emitSession();
    }
    return true;
  }

  function resetSessionState() {
    clearPendingTimers();
    clearFailureState();
    agentActive = false;
    failed = false;
    failedMessage = undefined;
    blockedCount = 0;
    blockedMessage = undefined;
  }

  function activateBlocked(message) {
    clearPendingTimers();
    blockedCount += 1;
    blockedMessage = message;
    publishState();
  }

  function deactivateBlocked() {
    blockedCount = Math.max(0, blockedCount - 1);
    if (blockedCount === 0) blockedMessage = undefined;
    publishState();
  }

  const handlers = {
    sessionStart(_event, ctx) {
      if (!activateRootSession(ctx)) return;
      // A reload can replace this extension mid-run without another agent_start.
      agentActive = ctx?.isIdle?.() === false;
      publishState(true);
    },
    sessionSwitch(_event, ctx) {
      if (ctx?.hasUI !== true) return;
      rootSession = true;
      resetSessionState();
      sessionRef = sessionRefFromCtx(ctx);
      resumeArgv = resumeArgvFor(sessionRef);
      sessionEpoch += 1;
      emitSession();
      publishState(true);
    },
    agentStart(_event, ctx) {
      if (!rootSession && !activateRootSession(ctx)) return;
      if (noteSessionRef(ctx)) emitSession();
      clearPendingTimers();
      clearFailureState();
      failed = false;
      failedMessage = undefined;
      agentActive = true;
      publishState();
    },
    approvalRequested(event, ctx) {
      if (!rootSession && !activateRootSession(ctx)) return;
      activateBlocked(event?.reason || `${event?.toolName || "Tool"} approval`);
    },
    approvalResolved(_event, ctx) {
      if (!rootSession && !activateRootSession(ctx)) return;
      deactivateBlocked();
    },
    toolExecutionStart(event, ctx) {
      if (event?.toolName !== "ask") return;
      if (!rootSession && !activateRootSession(ctx)) return;
      activateBlocked(askBlockedMessage(event?.args));
    },
    toolExecutionEnd(event, ctx) {
      if (event?.toolName !== "ask") return;
      if (!rootSession && !activateRootSession(ctx)) return;
      deactivateBlocked();
    },
    agentEnd(event) {
      if (!rootSession) return;
      if (!agentActive) {
        // Duplicate/late end while a retry hold owns the pane: keep Working.
        return;
      }
      if (event?.willContinue === true) {
        // A continuation is already scheduled; this end is not a settle.
        return;
      }
      agentActive = false;
      const retryable = retryableErrorMessage(event);
      if (retryable) {
        failed = false;
        failedMessage = undefined;
        holdForRetry(retryable);
        return;
      }
      const messages = Array.isArray(event?.messages) ? event.messages : [];
      const assistant = lastAssistantMessage(messages);
      if (assistant?.stopReason === "error") {
        failed = true;
        failedMessage = String(assistant.errorMessage || "agent error");
      } else {
        failed = false;
        failedMessage = undefined;
      }
      scheduleIdle();
    },
    sessionShutdown() {
      if (!rootSession) return;
      clearPendingTimers();
      // Release promises delivery; never blocks the agent.
      void sink.release();
    },
    customBlocked(data) {
      if (!rootSession) return;
      if (!data?.active) {
        deactivateBlocked();
        return;
      }
      activateBlocked(data.label);
    },
  };

  return { handlers, _debug: () => ({ sessionEpoch, sessionRef }) };
}

function wire(pi, machine) {
  const h = machine.handlers;
  pi.on("session_start", (e, ctx) => h.sessionStart(e, ctx));
  pi.on("session_switch", (e, ctx) => h.sessionSwitch(e, ctx));
  pi.on("agent_start", (e, ctx) => h.agentStart(e, ctx));
  pi.on("tool_approval_requested", (e, ctx) => h.approvalRequested(e, ctx));
  pi.on("tool_approval_resolved", (e, ctx) => h.approvalResolved(e, ctx));
  pi.on("tool_execution_start", (e, ctx) => h.toolExecutionStart(e, ctx));
  pi.on("tool_execution_end", (e, ctx) => h.toolExecutionEnd(e, ctx));
  pi.on("agent_end", (e) => h.agentEnd(e));
  pi.on("session_shutdown", () => h.sessionShutdown());
  pi.events?.on?.("tern:blocked", (data) => h.customBlocked(data));
}

// Entry point used by omp. Synchronous wiring; the reporter attaches
// asynchronously and buffered payloads replay in order. Never throws into omp.
export default function ternOmpConnector(pi) {
  const cfg = readConfig();
  if (!cfg.ok) return;

  const pending = [];
  let reporter = null;
  const sink = {
    session: (fields) => {
      if (reporter) {
        void reporter.report(fields).catch(() => {});
        return;
      }
      pending.push(fields);
      if (pending.length > 64) pending.shift();
    },
    state: (fields) => {
      if (reporter) {
        void reporter.report(fields).catch(() => {});
        return;
      }
      // Coalesce: only the newest state matters, session reports stay ordered.
      const idx = pending.findIndex((p) => p.session_start !== true);
      if (idx >= 0) pending[idx] = fields;
      else pending.push(fields);
      if (pending.length > 64) pending.shift();
    },
    release: () => {
      if (reporter) {
        void reporter.release().catch(() => {});
      }
    },
  };

  const machine = createMachine(sink, {
    paneId: cfg.paneId,
    launchId: cfg.launchId,
    idleDebounceMs: numEnv(process.env, "TERN_OMP_IDLE_DEBOUNCE_MS", 250),
    retryGraceMs: numEnv(process.env, "TERN_OMP_RETRY_GRACE_MS", 2500),
  });
  try {
    wire(pi, machine);
  } catch {
    return;
  }

  import("../client.mjs")
    .then((m) =>
      m.createReporter({
        dataDir: cfg.dataDir,
        pane_id: cfg.paneId,
        launch_id: cfg.launchId,
        agent: AGENT,
      }),
    )
    .then((r) => {
      reporter = r;
      const flush = pending.splice(0, pending.length);
      for (const fields of flush) {
        void reporter.report(fields).catch(() => {});
      }
    })
    .catch(() => {
      // Daemon unreachable: stay silent, keep the agent usable.
      pending.length = 0;
    });
}
