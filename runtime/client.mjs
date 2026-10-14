// runtime/client.mjs — loopback-authenticated client + non-blocking reporter.
// Owner: RuntimeCore.
// request(dataDir, method, params, {timeout?}) reads endpoint.json
// ({v:1, port, token}) and POSTs {token, method, params} to 127.0.0.1.
// Methods: claim/report/release/list/get/read/wait/prompt/start.
// createReporter({dataDir, pane_id, launch_id, agent, source?}):
//   reporter.report(fields) queues non-blocking, assigns seq, keeps order;
//   reporter.release() flushes the queue then releases, and resolves delivery.
//   Session fields ride on report(fields): session/session_epoch/session_start.
// Env convention (connectors): TERN_AGENT_RUNTIME_DIR, TERN_AGENT_LAUNCH_ID,
// TERN_PANE. Local-only endpoint; never a public HTTP server.

import { createRequire } from "node:module";
import { readEndpoint, resolveDataDir } from "./store.mjs";

const require = createRequire(import.meta.url);
const http = require("node:http");

const DEFAULT_TIMEOUT_MS = 30000;

function post(port, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    let timer = null;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/rpc",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(text) },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          clearTimeout(timer);
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch {
            reject(new Error("invalid daemon response"));
            return;
          }
          if (parsed?.ok === true) resolve(parsed.result);
          else {
            reject(Object.assign(new Error(parsed?.error?.message ?? "daemon error"), { code: parsed?.error?.code }));
          }
        });
      },
    );
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        req.destroy(new Error(`request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end(text);
  });
}

export async function request(dataDir, method, params, opts = {}) {
  const dir = dataDir ?? resolveDataDir();
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  const ep = await readEndpoint(dir);
  return post(ep.port, { token: ep.token, method, params: params ?? {} }, timeout);
}

export function endpointFromEnv() {
  return {
    dataDir: process.env.TERN_AGENT_RUNTIME_DIR ?? null,
    launchId: process.env.TERN_AGENT_LAUNCH_ID ?? null,
    paneId: process.env.TERN_PANE != null ? Number(process.env.TERN_PANE) : null,
  };
}

// Non-blocking ordered reporter. report(fields) never blocks the agent loop:
// it enqueues, assigns the next seq, and flushes in order in the background.
// Fields: state, message?, ready?, resume_argv?, failed?, session?,
// session_epoch?, session_start?. Source defaults to `tern:<agent>`.
// release() drains the queue (all queued reports delivered in order) and then
// issues the release; the returned promise resolves when the release lands.
export function createReporter({ dataDir = null, pane_id, launch_id, agent, source = null, seqBase = 0 } = {}) {
  if (!Number.isSafeInteger(pane_id) || pane_id <= 0) {
    throw new Error("createReporter needs a positive pane_id");
  }
  if (typeof launch_id !== "string" || launch_id.length === 0) {
    throw new Error("createReporter needs a non-empty launch_id");
  }
  if (agent !== "omp" && agent !== "claude" && agent !== "codex") {
    throw new Error("createReporter needs agent omp|claude|codex");
  }
  const dir = dataDir ?? resolveDataDir();
  const src = source ?? `tern:${agent}`;
  // seqBase lets file-backed one-shot hooks start above any previously used
  // seq (e.g. max(prev+1, Date.now())); default 0 = in-process counter from 1.
  let seq = Number.isSafeInteger(seqBase) && seqBase > 0 ? seqBase : 0;
  let tail = Promise.resolve();

  function enqueue(op) {
    const run = tail.then(op, op);
    tail = run.catch(() => {});
    return run;
  }

  const reporter = {
    pane_id,
    launch_id,
    agent,
    source: src,
    get seq() {
      return seq;
    },
    report(fields = {}) {
      const next = (seq += 1);
      const payload = {
        v: 1,
        pane_id,
        launch_id,
        source: src,
        agent,
        state: fields.state,
        seq: next,
      };
      for (const k of ["message", "ready", "resume_argv", "failed", "session", "session_epoch", "session_start"]) {
        if (k in fields) payload[k] = fields[k];
      }
      return enqueue(() => request(dir, "report", payload).catch(() => {}));
    },
    release(opts = {}) {
      return enqueue(() =>
        request(dir, "release", {
          pane_id,
          launch_id,
          source: opts.source ?? src,
          ...(opts.seq != null ? { seq: opts.seq } : {}),
        }),
      );
    },
    flush() {
      return enqueue(() => {});
    },
  };
  return reporter;
}
