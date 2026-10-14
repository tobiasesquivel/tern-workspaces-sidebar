// runtime/launch.test.mjs — tests for the launch wrapper contract.
// Run (parent, after integration): node --test runtime/launch.test.mjs
// Pure helpers are tested in-process (importing this module must NOT launch
// anything — that itself proves the entry guard). Usage errors are tested
// through real subprocess exits; those paths exit before any claim, so no
// daemon is needed. Node >= 22, no deps.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  AGENTS,
  parseLaunchArgs,
  readPaneId,
  buildChildEnv,
  ompArgv,
  connectorDir,
} from "./launch.mjs";

const LAUNCH = fileURLToPath(new URL("./launch.mjs", import.meta.url));

function runLaunch(args) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [LAUNCH, ...args],
      { timeout: 30000 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({ code: error ? error.code : 0, stdout, stderr });
      },
    );
  });
}

describe("parseLaunchArgs", () => {
  it("accepts the full wrapper form with passthrough args", () => {
    assert.deepEqual(
      parseLaunchArgs([
        "--agent",
        "omp",
        "--data-dir",
        "D:\\lab",
        "--launch-id",
        "L1",
        "--",
        "--model",
        "opus",
        "--resume=abc",
      ]),
      {
        agent: "omp",
        dataDir: "D:\\lab",
        launchId: "L1",
        nativeArgs: ["--model", "opus", "--resume=abc"],
      },
    );
  });

  it("accepts --flag=value form and empty native args", () => {
    assert.deepEqual(
      parseLaunchArgs(["--agent=codex", "--data-dir=D", "--launch-id=L"]),
      { agent: "codex", dataDir: "D", launchId: "L", nativeArgs: [] },
    );
  });

  it("rejects missing, unknown and misplaced input", () => {
    for (const agent of AGENTS) {
      assert.ok(AGENTS.includes(agent));
    }
    assert.match(parseLaunchArgs([]).error, /missing --agent/);
    assert.match(
      parseLaunchArgs(["--agent", "bogus", "--data-dir", "D", "--launch-id", "L"]).error,
      /unknown agent/,
    );
    assert.match(
      parseLaunchArgs(["--agent", "omp", "--data-dir", "D", "--launch-id", "L", "--bogus"]).error,
      /unknown flag/,
    );
    assert.match(
      parseLaunchArgs(["--agent", "omp", "positional", "--data-dir", "D", "--launch-id", "L"]).error,
      /unexpected argument/,
    );
    assert.match(
      parseLaunchArgs(["--agent", "omp", "--data-dir", "D"]).error,
      /missing --launch-id/,
    );
  });
});

describe("readPaneId", () => {
  it("keeps ids above 2^32 exact and rejects the rest", () => {
    assert.equal(readPaneId({ TERN_PANE: "4294967299" }), 4294967299);
    assert.equal(readPaneId({}), null);
    assert.equal(readPaneId({ TERN_PANE: "" }), null);
    assert.equal(readPaneId({ TERN_PANE: "abc" }), null);
    assert.equal(readPaneId({ TERN_PANE: "1.5" }), null);
    assert.equal(readPaneId({ TERN_PANE: "-1" }), null);
    assert.equal(readPaneId({ TERN_PANE: "0" }), null);
  });
});

describe("buildChildEnv and ompArgv", () => {
  it("sets reporter vars and scrubs OMPCODE only for omp", () => {
    const ompEnv = buildChildEnv(
      { OMPCODE: "1", KEEP: "yes" },
      { dataDir: "D", launchId: "L", paneId: 4294967299, scrubOmpcode: true },
    );
    assert.equal(ompEnv.TERN_AGENT_RUNTIME_DIR, "D");
    assert.equal(ompEnv.TERN_AGENT_LAUNCH_ID, "L");
    assert.equal(ompEnv.TERN_PANE, "4294967299");
    assert.equal(ompEnv.KEEP, "yes");
    assert.ok(!("OMPCODE" in ompEnv));
    const other = buildChildEnv(
      { OMPCODE: "1" },
      { dataDir: "D", launchId: "L", paneId: 7, scrubOmpcode: false },
    );
    assert.equal(other.OMPCODE, "1");
  });

  it("drops foreign herdr routing env on every agent branch", () => {
    // Boundary invariant: a Tern root launched from a herdr pane must never
    // leak HERDR_* report routing into the child — the managed extension
    // gates on exactly this trio, and the pane would report to the wrong
    // daemon. Tern roots carry TERN_* context only.
    for (const scrubOmpcode of [true, false]) {
      const env = buildChildEnv(
        {
          HERDR_ENV: "1",
          HERDR_SOCKET_PATH: "herdr-sock",
          HERDR_PANE_ID: "w1:p1",
          KEEP: "yes",
        },
        { dataDir: "D", launchId: "L", paneId: 7, scrubOmpcode },
      );
      assert.ok(!("HERDR_ENV" in env));
      assert.ok(!("HERDR_SOCKET_PATH" in env));
      assert.ok(!("HERDR_PANE_ID" in env));
      assert.equal(env.TERN_AGENT_RUNTIME_DIR, "D");
      assert.equal(env.KEEP, "yes");
    }
  });

  it("drops another Claude Code session's markers on every agent branch", () => {
    // Measured: claude 2.1.296 started with an inherited CLAUDE_CODE_CHILD_SESSION
    // prints "Transcript saving is off" — no transcript, no resume. A root agent in
    // its own pane is no other session's child.
    const markers = {
      CLAUDECODE: "1",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_EXECPATH: "C:/claude.exe",
      CLAUDE_CODE_MESSAGING_SOCKET: "sock",
      CLAUDE_CODE_MESSAGING_TOKEN: "token",
      CLAUDE_CODE_SESSION_ID: "s1",
      CLAUDE_CODE_SESSION_ATTENDED: "1",
      CLAUDE_PID: "42",
    };
    for (const scrubOmpcode of [true, false]) {
      const env = buildChildEnv(
        { ...markers, CLAUDE_EFFORT: "high", KEEP: "yes" },
        { dataDir: "D", launchId: "L", paneId: 7, scrubOmpcode },
      );
      for (const key of Object.keys(markers)) assert.ok(!(key in env), key);
      assert.equal(env.CLAUDE_EFFORT, "high", "a preference is not a session marker");
      assert.equal(env.KEEP, "yes");
    }
  });

  it("appends the extension after native args", () => {
    const ext = process.platform === "win32" ? "C:\\ext\\omp.ts" : "/ext/omp.ts";
    const args = ompArgv(["--model", "x"], ext);
    assert.deepEqual(args, ["--model", "x", `--extension=${ext}`]);
    assert.deepEqual(ompArgv([], ext), [`--extension=${ext}`]);
  });

  it("connectorDir is the absolute connectors directory", () => {
    assert.ok(connectorDir().endsWith("connectors"));
    assert.ok(connectorDir().length > "connectors".length);
  });
});

describe("usage-error exits (real subprocess, no daemon touched)", () => {
  it("unknown agent exits 2 with a stderr reason", async () => {
    const r = await runLaunch(["--agent", "bogus", "--data-dir", "D", "--launch-id", "L"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown agent/);
  });

  it("missing flags exit 2", async () => {
    const r = await runLaunch(["--agent", "omp"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /missing --data-dir/);
  });

  it("--help exits 0 with usage", async () => {
    const r = await runLaunch(["--help"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /--agent KIND/);
  });
});

describe("botched start releases the claim (isolated wrapper copy)", () => {
  // A start that claims and then fails BEFORE spawning must still send
  // release for the same {pane_id, launch_id} — otherwise name/status/resume
  // stay reserved. The failure is forced deterministically: a temp copy of
  // the real launch.mjs + client.mjs runs with NO connectors/ directory, so
  // the claude/codex import fails without ever touching a real agent binary.
  // The daemon is a real loopback HTTP server speaking the client.mjs
  // protocol ({token, method, params} -> {ok:true,result}); assertions are on
  // the observed RPC sequence, not on wrapper source bytes.
  it("claim then connector-import failure still releases", async (t) => {
    const os = await import("node:os");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const http = await import("node:http");
    const seen = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          res.writeHead(400).end("{}");
          return;
        }
        if (body.token !== "test-token") {
          res.end(JSON.stringify({ ok: false, error: { code: "bad_token" } }));
          return;
        }
        seen.push({ method: body.method, params: body.params });
        res.end(JSON.stringify({ ok: true, result: {} }));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tern-launch-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.writeFile(
      path.join(dir, "endpoint.json"),
      JSON.stringify({ v: 1, port: server.address().port, token: "test-token" }),
    );
    // Isolated wrapper: real launch.mjs + its real client.mjs/store.mjs
    // dependency chain, but no connectors/ — the third-party import fails
    // before any spawn, deterministically, in any environment.
    const repoRuntime = path.dirname(LAUNCH);
    const iso = await fs.mkdtemp(path.join(os.tmpdir(), "tern-launch-iso-"));
    t.after(() => fs.rm(iso, { recursive: true, force: true }));
    await fs.copyFile(path.join(repoRuntime, "launch.mjs"), path.join(iso, "launch.mjs"));
    await fs.copyFile(path.join(repoRuntime, "client.mjs"), path.join(iso, "client.mjs"));
    await fs.copyFile(path.join(repoRuntime, "store.mjs"), path.join(iso, "store.mjs"));
    const r = await new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [path.join(iso, "launch.mjs"), "--agent", "codex", "--data-dir", dir, "--launch-id", "L9"],
        { timeout: 30000, env: { ...process.env, TERN_PANE: "4294967299" } },
        (error, stdout, stderr) => {
          if (error && typeof error.code !== "number") {
            reject(error);
            return;
          }
          resolve({ code: error ? error.code : 0, stdout, stderr });
        },
      );
    });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /claude-codex/);
    const methods = seen.map((s) => s.method);
    assert.deepEqual(methods, ["claim", "release"]);
    assert.equal(seen[0].params.pane_id, 4294967299);
    assert.equal(seen[0].params.launch_id, "L9");
    assert.equal(seen[1].params.pane_id, 4294967299);
    assert.equal(seen[1].params.launch_id, "L9");
    assert.equal(seen[1].params.source, "tern:codex");
  });
});

describe("omp spawn shape (fake executable, isolated wrapper copy)", () => {
  // The live root once opened with an unsolicited "what to do with omp" turn:
  // spawn("omp", ["omp", ...]) put the executable name in MESSAGES position.
  // This runs the real isolated wrapper against a fake `omp` found via PATH
  // and asserts the exact argv the executable receives: native args verbatim
  // + exactly one --extension flag, never a leading executable name.
  // POSIX-only (see below): the skip option keeps the report honest (shown
  // as skipped, never a silent pass).
  it("fake omp receives native args and extension only", { skip: process.platform === "win32" }, async (t) => {
    const path = await import("node:path");
    const http = await import("node:http");
    const seen = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          res.writeHead(400).end("{}");
          return;
        }
        if (body.token !== "test-token") {
          res.end(JSON.stringify({ ok: false, error: { code: "bad_token" } }));
          return;
        }
        seen.push({ method: body.method, params: body.params });
        res.end(JSON.stringify({ ok: true, result: {} }));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tern-launch-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.writeFile(
      path.join(dir, "endpoint.json"),
      JSON.stringify({ v: 1, port: server.address().port, token: "test-token" }),
    );
    const repoRuntime = path.dirname(LAUNCH);
    const iso = await fs.mkdtemp(path.join(os.tmpdir(), "tern-launch-iso-"));
    t.after(() => fs.rm(iso, { recursive: true, force: true }));
    await fs.copyFile(path.join(repoRuntime, "launch.mjs"), path.join(iso, "launch.mjs"));
    await fs.copyFile(path.join(repoRuntime, "client.mjs"), path.join(iso, "client.mjs"));
    await fs.copyFile(path.join(repoRuntime, "store.mjs"), path.join(iso, "store.mjs"));
    // Fake `omp` first on PATH: logs its argv as JSON, exits 0 fast (no agent).
    const bindir = await fs.mkdtemp(path.join(os.tmpdir(), "tern-fakebin-"));
    t.after(() => fs.rm(bindir, { recursive: true, force: true }));
    const argvFile = path.join(dir, "argv.json");
    // Skipped on win32 (see `skip` above): libuv cannot spawn script fakes
    // without a shell, so only the POSIX fake lives here.
    await fs.writeFile(
      path.join(bindir, "omp"),
      `#!/bin/sh\nnode -e "require('fs').writeFileSync(${JSON.stringify(argvFile)},JSON.stringify(process.argv.slice(1)))" "$@"\n`,
      { mode: 0o755 },
    );
    const pathSep = ":";
    const r = await new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [
          path.join(iso, "launch.mjs"),
          "--agent",
          "omp",
          "--data-dir",
          dir,
          "--launch-id",
          "Lomp",
          "--",
          "--model",
          "opus",
        ],
        {
          timeout: 30000,
          env: {
            ...process.env,
            TERN_PANE: "4294967299",
            PATH: `${bindir}${pathSep}${process.env.PATH ?? ""}`,
          },
        },
        (error, stdout, stderr) => {
          if (error && typeof error.code !== "number") {
            reject(error);
            return;
          }
          resolve({ code: error ? error.code : 0, stdout, stderr });
        },
      );
    });
    assert.equal(r.code, 0);
    const argv = JSON.parse(await fs.readFile(argvFile, "utf8"));
    assert.deepEqual(argv, ["--model", "opus", `--extension=${path.join(iso, "connectors", "omp.ts")}`]);
    assert.ok(argv[0] !== "omp");
    assert.deepEqual(
      seen.map((s) => s.method),
      ["claim", "release"],
    );
  });
});
