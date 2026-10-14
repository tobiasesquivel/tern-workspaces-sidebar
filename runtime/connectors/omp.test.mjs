// runtime/connectors/omp.test.mjs — behavioral tests for the omp connector.
// Run (parent, after integration): node --test runtime/connectors/omp.test.mjs
// The machine is driven through its real event-handler surface; one suite asserts
// consumer-visible service state through a real RuntimeState over the real
// reporter transport (no echo mocks, no serialization policy pins).
// Node >= 22, no deps. Timers use tiny debounce/grace via machine opts.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SOURCE,
  readConfig,
  isRetryableError,
  sessionRefFromCtx,
  resumeArgvFor,
  askBlockedMessage,
  retryableErrorMessage,
  createMachine,
} from "./omp.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Lab pane ids exceed 2^32; the connector must keep them exact end to end.
const PANE_ID = 4294967299;
const LAUNCH_ID = "test-launch-1";
// Session file fixtures: must be absolute (path wins over id) on the running
// platform, built portably — never a personal home path.
const SESSION_FILE =
  process.platform === "win32" ? "C:\\sessions\\abc123.jsonl" : "/tmp/sessions/abc123.jsonl";
const SESSION_FILE_2 =
  process.platform === "win32" ? "C:\\sessions\\def456.jsonl" : "/tmp/sessions/def456.jsonl";

function makeCtx(over = {}) {
  return {
    hasUI: true,
    isIdle: () => false,
    sessionManager: {
      getSessionFile: () => SESSION_FILE,
      getSessionId: () => "abc123",
    },
    ...over,
  };
}

function makeSink() {
  const sessions = [];
  const states = [];
  let releases = 0;
  return {
    sessions,
    states,
    releaseCount: () => releases,
    sink: {
      session: (fields) => {
        sessions.push(fields);
      },
      state: (fields) => {
        states.push(fields);
      },
      release: () => {
        releases += 1;
        return Promise.resolve();
      },
    },
  };
}

function makeMachine(opts = {}) {
  const rec = makeSink();
  const machine = createMachine(rec.sink, {
    paneId: PANE_ID,
    launchId: LAUNCH_ID,
    idleDebounceMs: 5,
    retryGraceMs: 15,
    ...opts,
  });
  return { ...rec, h: machine.handlers };
}

function assertKnownStatesOnly(rec) {
  for (const s of rec.states) {
    assert.ok(
      s.state === "working" || s.state === "blocked" || s.state === "idle",
      `connector emitted ${s.state}; done/unknown belong to the daemon`,
    );
  }
}

describe("begin/end lifecycle", () => {
  it("session_start + agent_start report working; agent_end settles idle", async () => {
    const rec = makeMachine();
    rec.h.sessionStart({}, makeCtx());
    assert.equal(rec.sessions.length, 1);
    assert.equal(rec.sessions[0].session_start, true);
    assert.equal(rec.sessions[0].session_epoch, 1);
    assert.deepEqual(rec.sessions[0].session, {
      kind: "path",
      value: SESSION_FILE,
    });
    rec.h.agentStart({}, makeCtx());
    assert.equal(rec.states.at(-1).state, "working");
    rec.h.agentEnd({ messages: [] });
    await sleep(30);
    const last = rec.states.at(-1);
    assert.equal(last.state, "idle");
    assert.equal(last.failed, false);
    assertKnownStatesOnly(rec);
  });

  it("stays silent without a UI session", () => {
    const rec = makeMachine();
    rec.h.sessionStart({}, makeCtx({ hasUI: false }));
    rec.h.agentStart({}, makeCtx({ hasUI: false }));
    assert.equal(rec.sessions.length, 0);
    assert.equal(rec.states.length, 0);
  });

  it("duplicate agent_end without an active turn never idles", async () => {
    const rec = makeMachine();
    rec.h.sessionStart({}, makeCtx());
    rec.h.agentStart({}, makeCtx());
    rec.h.agentEnd({ messages: [] });
    await sleep(30);
    assert.equal(rec.states.at(-1).state, "idle");
    const n = rec.states.length;
    rec.h.agentEnd({ messages: [] });
    await sleep(25);
    assert.equal(rec.states.length, n);
  });

  it("every payload carries exact pane/launch identity, source and epoch", async () => {
    const rec = makeMachine();
    rec.h.sessionStart({}, makeCtx());
    rec.h.agentStart({}, makeCtx());
    rec.h.approvalRequested({ toolName: "edit", reason: "ok?" }, makeCtx());
    rec.h.agentEnd({ messages: [] });
    await sleep(30);
    for (const p of [...rec.sessions, ...rec.states]) {
      assert.equal(p.pane_id, PANE_ID);
      assert.equal(p.launch_id, LAUNCH_ID);
      assert.equal(p.source, "tern:omp");
      assert.equal(p.agent, "omp");
      assert.equal(p.session_epoch, 1);
    }
    assert.equal(SOURCE, "tern:omp");
  });
});

describe("ask and approval block", () => {
  it("approval request blocks with the label; resolve returns to working", () => {
    const rec = makeMachine();
    rec.h.sessionStart({}, makeCtx());
    rec.h.agentStart({}, makeCtx());
    rec.h.approvalRequested({ toolName: "edit", reason: "Allow this edit?" }, makeCtx());
    const blocked = rec.states.at(-1);
    assert.equal(blocked.state, "blocked");
    assert.equal(blocked.message, "Allow this edit?");
    rec.h.approvalResolved({}, makeCtx());
    assert.equal(rec.states.at(-1).state, "working");
    assertKnownStatesOnly(rec);
  });

  it("ask tool start blocks with the first question; only ask matters", () => {
    const rec = makeMachine();
    rec.h.sessionStart({}, makeCtx());
    rec.h.agentStart({}, makeCtx());
    rec.h.toolExecutionStart(
      { toolName: "ask", args: { questions: [{ question: "Which file?" }] } },
      makeCtx(),
    );
    assert.equal(rec.states.at(-1).state, "blocked");
    assert.equal(rec.states.at(-1).message, "Which file?");
    const n = rec.states.length;
    rec.h.toolExecutionStart({ toolName: "bash", args: { command: "ls" } }, makeCtx());
    rec.h.toolExecutionEnd({ toolName: "bash" }, makeCtx());
    assert.equal(rec.states.length, n);
    rec.h.toolExecutionEnd({ toolName: "ask" }, makeCtx());
    assert.equal(rec.states.at(-1).state, "working");
  });
});

describe("retries and failures", () => {
  it("retryable provider error holds working, then flips to blocked", async () => {
    const rec = makeMachine();
    rec.h.sessionStart({}, makeCtx());
    rec.h.agentStart({}, makeCtx());
    rec.h.agentEnd({
      messages: [
        { role: "assistant", stopReason: "error", errorMessage: "429 too many requests" },
      ],
    });
    assert.equal(rec.states.at(-1).state, "working");
    await sleep(45);
    const last = rec.states.at(-1);
    assert.equal(last.state, "blocked");
    assert.match(last.message, /429/);
    assert.ok(!rec.states.some((s) => s.state === "idle"));
  });

  it("non-retryable error settles failed idle for the badge", async () => {
    const rec = makeMachine();
    rec.h.sessionStart({}, makeCtx());
    rec.h.agentStart({}, makeCtx());
    rec.h.agentEnd({
      messages: [
        { role: "assistant", stopReason: "error", errorMessage: "user denied the edit" },
      ],
    });
    await sleep(30);
    const last = rec.states.at(-1);
    assert.equal(last.state, "idle");
    assert.equal(last.failed, true);
    assert.match(last.message, /denied/);
  });

  it("agent_end with willContinue is not a settle", async () => {
    const rec = makeMachine();
    rec.h.sessionStart({}, makeCtx());
    rec.h.agentStart({}, makeCtx());
    const n = rec.states.length;
    rec.h.agentEnd({ willContinue: true, messages: [] });
    await sleep(30);
    assert.equal(rec.states.length, n);
    assert.equal(rec.states.at(-1).state, "working");
  });
});

describe("session identity and resume", () => {
  it("session_switch bumps the epoch and later states carry it", () => {
    const rec = makeMachine();
    rec.h.sessionStart({}, makeCtx());
    rec.h.agentStart({}, makeCtx());
    rec.h.sessionSwitch(
      { reason: "resume" },
      makeCtx({
        sessionManager: {
          getSessionFile: () => SESSION_FILE_2,
          getSessionId: () => "def456",
        },
      }),
    );
    assert.equal(rec.sessions.length, 2);
    const second = rec.sessions[1];
    assert.equal(second.session_start, true);
    assert.equal(second.session_epoch, 2);
    assert.deepEqual(second.session, {
      kind: "path",
      value: SESSION_FILE_2,
    });
    assert.deepEqual(second.resume_argv, ["omp", `--resume=${SESSION_FILE_2}`]);
    assert.equal(rec.states.at(-1).session_epoch, 2);
  });

  it("absolute path wins over id; id is the fallback; nothing yields null", () => {
    assert.deepEqual(sessionRefFromCtx(makeCtx()), {
      kind: "path",
      value: SESSION_FILE,
    });
    const throwing = makeCtx({
      sessionManager: {
        getSessionFile: () => {
          throw new Error("gone");
        },
        getSessionId: () => "abc123",
      },
    });
    assert.deepEqual(sessionRefFromCtx(throwing), { kind: "id", value: "abc123" });
    const empty = makeCtx({
      sessionManager: { getSessionFile: () => undefined, getSessionId: () => "" },
    });
    assert.equal(sessionRefFromCtx(empty), null);
  });

  it("resume argv uses the bare omp name on PATH, never a path", () => {
    assert.equal(resumeArgvFor(null), null);
    const argv = resumeArgvFor({ kind: "id", value: "abc123" });
    assert.deepEqual(argv, ["omp", "--resume=abc123"]);
    assert.ok(!argv[0].includes("/") && !argv[0].includes("\\"));
  });
});

describe("config guards", () => {
  const full = {
    TERN_AGENT_RUNTIME_DIR:
      process.platform === "win32" ? "D:\\lab\\agent-runtime" : "/tmp/lab/agent-runtime",
    TERN_AGENT_LAUNCH_ID: LAUNCH_ID,
    TERN_PANE: String(PANE_ID),
  };
  it("nested omp (OMPCODE=1) stays silent", () => {
    const cfg = readConfig({ ...full, OMPCODE: "1" });
    assert.equal(cfg.ok, false);
  });
  it("valid env keeps the pane id exact", () => {
    const cfg = readConfig({ ...full });
    assert.equal(cfg.ok, true);
    assert.equal(cfg.paneId, PANE_ID);
  });
  it("missing dir, launch id, or bad pane id refuse", () => {
    assert.equal(readConfig({ ...full, TERN_AGENT_RUNTIME_DIR: "" }).ok, false);
    assert.equal(readConfig({ ...full, TERN_AGENT_LAUNCH_ID: "" }).ok, false);
    assert.equal(readConfig({ ...full, TERN_PANE: "abc" }).ok, false);
    assert.equal(readConfig({ ...full, TERN_PANE: "1.5" }).ok, false);
    // Number("") is 0: empty must refuse, and 0 is never a valid pane id.
    assert.equal(readConfig({ ...full, TERN_PANE: "" }).ok, false);
    assert.equal(readConfig({ ...full, TERN_PANE: "0" }).ok, false);
    const { TERN_PANE: _drop, ...noPane } = full;
    void _drop;
    assert.equal(readConfig(noPane).ok, false);
  });
});

describe("helpers", () => {
  it("ask message falls back when no question is present", () => {
    assert.equal(askBlockedMessage({ questions: [{ question: "Q?" }] }), "Q?");
    assert.equal(askBlockedMessage({}), "waiting for user input");
  });
  it("retryable matcher follows the proven pattern exactly", () => {
    assert.equal(isRetryableError("429 too many requests"), true);
    assert.equal(isRetryableError("socket hang up"), true);
    assert.equal(isRetryableError("user denied the edit"), false);
    assert.equal(
      retryableErrorMessage({ messages: [{ role: "user" }] }),
      undefined,
    );
    assert.equal(
      retryableErrorMessage({
        messages: [{ role: "assistant", stopReason: "endTurn" }],
      }),
      undefined,
    );
  });
});

describe("shutdown release", () => {
  it("session_shutdown releases without blocking the agent", () => {
    const rec = makeMachine();
    rec.h.sessionStart({}, makeCtx());
    const returned = rec.h.sessionShutdown();
    assert.equal(returned, undefined);
    assert.equal(rec.releaseCount(), 1);
  });
});

describe("end to end against the real RuntimeState", () => {
  // No echo assertions, no JSON-serialization policy pins: the connector's
  // payloads reach a real RuntimeState through the real reporter HTTP
  // transport after real seq assignment. What the suite asserts is
  // consumer-visible service state: blocked + question message + session
  // identity + resume argv, then idle after the turn settles. Undefined
  // fields may or may not survive the wire; service state is what matters.
  it("approval question surfaces as blocked with identity and resume", async (t) => {
    const core = await import("../state.mjs");
    const client = await import("../client.mjs");
    const os = await import("node:os");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const http = await import("node:http");
    const state = new core.RuntimeState();
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          res.end(JSON.stringify({ ok: false, error: { code: "bad_request" } }));
          return;
        }
        if (body.token !== "test-token") {
          res.end(JSON.stringify({ ok: false, error: { code: "forbidden" } }));
          return;
        }
        try {
          let result = null;
          if (body.method === "claim") result = state.claim(body.params ?? {});
          else if (body.method === "report") result = state.report(body.params ?? {});
          else if (body.method === "release") result = state.release(body.params ?? {});
          else if (body.method === "get") result = state.get(body.params?.target ?? body.params);
          res.end(JSON.stringify({ ok: true, result }));
        } catch (err) {
          res.end(
            JSON.stringify({
              ok: false,
              error: { code: err?.code ?? "internal", message: err?.message ?? String(err) },
            }),
          );
        }
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tern-omp-e2e-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.writeFile(
      path.join(dir, "endpoint.json"),
      JSON.stringify({ v: 1, port: server.address().port, token: "test-token" }),
    );
    await client.request(dir, "claim", {
      pane_id: PANE_ID,
      agent: "omp",
      launch_id: LAUNCH_ID,
    });
    const reporter = client.createReporter({
      dataDir: dir,
      pane_id: PANE_ID,
      launch_id: LAUNCH_ID,
      agent: "omp",
    });
    // Drive the real machine with real events; payloads cross the real wire.
    const machine = createMachine(
      {
        session: (f) => {
          void reporter.report(f);
        },
        state: (f) => {
          void reporter.report(f);
        },
        release: () => reporter.release().catch(() => {}),
      },
      { paneId: PANE_ID, launchId: LAUNCH_ID, idleDebounceMs: 5, retryGraceMs: 15 },
    );
    const sessionFile = makeCtx().sessionManager.getSessionFile();
    machine.handlers.sessionStart({}, makeCtx());
    machine.handlers.agentStart({}, makeCtx());
    machine.handlers.approvalRequested(
      { toolName: "edit", reason: "Allow this edit?" },
      makeCtx(),
    );
    await reporter.flush();
    // The daemon's detection loop reads the startup screen once: no setup
    // wizard, so the extension's ready stands.
    state.detect(PANE_ID, { agent: "omp", state: "idle", at: Date.now() });
    const blocked = state.get(String(PANE_ID));
    assert.equal(blocked.agent_status, "blocked");
    assert.equal(blocked.message, "Allow this edit?");
    assert.equal(blocked.agent, "omp");
    assert.equal(blocked.launch_pending, false);
    assert.deepEqual(blocked.agent_session, {
      source: "tern:omp",
      agent: "omp",
      kind: "path",
      value: sessionFile,
    });
    assert.deepEqual(blocked.resume_argv, ["omp", `--resume=${sessionFile}`]);
    machine.handlers.approvalResolved({}, makeCtx());
    machine.handlers.agentEnd({ messages: [] });
    await reporter.flush();
    await sleep(30);
    await reporter.flush();
    // The turn ended unseen (no focus observation ever marked it seen), so
    // the service correctly derives `done`, not bare `idle` — and the reads
    // above never marked it seen. completion_seq proves the working→idle
    // transition was witnessed, not a silent idle.
    const settled = state.get(String(PANE_ID));
    assert.equal(settled.agent_status, "done");
    assert.equal(settled.failed, false);
    assert.equal(typeof settled.completion_seq, "number");
  });
});
