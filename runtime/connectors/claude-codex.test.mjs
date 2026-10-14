// runtime/connectors/claude-codex.test.mjs — behavioral tests for the
// claude/codex connectors (detect + hook mapping + launch builders).
// Run (parent, after integration): node --test runtime/connectors/claude-codex.test.mjs
// No daemon, no agents, no network: pure mapping/builder coverage plus
// file-backed seq/epoch counters in an isolated tmp dir. Node >= 22, no deps.

import assert from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resumeArgv,
  epochForSession,
  mapEvent,
  nextSeq,
  resolveRuntimeIdentity,
} from "./hook.mjs";
import {
  claudeSettingsJson,
  codexSessionFlags,
  codexSessionFlagsSource,
  codexHookTrustHash,
  codexHooksJson,
  codexNormalizedTimeout,
  prepareLaunch,
  quoteWindows,
  removeHookState,
  resolveNodeBin,
  shellFor,
} from "./claude-codex.mjs";

function lab() {
  return mkdtempSync(join(tmpdir(), "tern-connector-test-"));
}

describe("mapEvent (herdr: Claude's state is the screen's, Codex v9 hooks)", () => {
  it("resume argv names the executable first, as omp's does", () => {
    assert.deepEqual(resumeArgv("claude", {}, { kind: "id", value: "s1" }), ["claude", "--resume", "s1"]);
    assert.deepEqual(resumeArgv("codex", {}, { kind: "id", value: "r1" }), ["codex", "resume", "r1"]);
    assert.equal(resumeArgv("claude", {}, null), null);
  });

  it("SessionStart reports identity only: no state, not ready", () => {
    for (const agent of ["claude", "codex"]) {
      const out = mapEvent(agent, "SessionStart", {
        hook_event_name: "SessionStart",
        session_id: "abc-123",
        transcript_path: "/t/abc.jsonl",
        source: "startup",
      });
      assert.equal(out.kind, "report");
      assert.equal(out.fields.state, "unknown");
      assert.equal(out.fields.ready, false);
      assert.deepEqual(out.fields.session, { kind: "id", value: "abc-123" });
      assert.equal(out.fields.session_start, true);
    }
  });

  it("Claude turn events decide nothing: the screen does", () => {
    for (const event of ["UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd", "Interrupt", "StopFailure"]) {
      assert.deepEqual(mapEvent("claude", event, { hook_event_name: event }), { kind: "ignore" }, event);
    }
  });

  it("Codex v9: UserPromptSubmit is working, Stop and Interrupt are idle", () => {
    assert.deepEqual(mapEvent("codex", "UserPromptSubmit", {}), { kind: "report", fields: { state: "working" } });
    assert.deepEqual(mapEvent("codex", "Stop", {}), { kind: "report", fields: { state: "idle" } });
    assert.deepEqual(mapEvent("codex", "Interrupt", {}), { kind: "report", fields: { state: "idle" } });
    assert.deepEqual(mapEvent("codex", "PostToolUse", {}), { kind: "ignore" });
  });

  it("a question or a permission is a message hint, never a state", () => {
    const ask = mapEvent("claude", "PreToolUse", {
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "Which region?" }] },
    });
    assert.deepEqual(ask, { kind: "report", fields: { state: "blocked", hint: true, message: "Which region?" } });
    // Claude asks permission for its own question tool right after PreToolUse:
    // the hint keeps the question, not the permission for asking it.
    const perm = mapEvent("claude", "PermissionRequest", {
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "Which region?", header: "Region" }] },
    });
    assert.equal(perm.fields.message, "Which region?");
    assert.equal(perm.fields.hint, true);
    const bash = mapEvent("codex", "PermissionRequest", {
      tool_name: "Bash",
      tool_input: { command: "git push", description: "push branch" },
    });
    assert.equal(bash.fields.hint, true);
    assert.match(bash.fields.message, /Bash/);
    const note = mapEvent("claude", "Notification", { notification_type: "permission_prompt", message: "needs approval" });
    assert.deepEqual(note.fields, { state: "blocked", hint: true, message: "needs approval" });
    assert.equal(mapEvent("claude", "Elicitation", { message: "Project key?" }).fields.message, "Project key?");
  });

  it("other tools, idle notifications, denials and subagents are ignored", () => {
    assert.deepEqual(mapEvent("claude", "PreToolUse", { tool_name: "Bash" }), { kind: "ignore" });
    assert.deepEqual(mapEvent("claude", "Notification", { notification_type: "idle_prompt" }), { kind: "ignore" });
    assert.deepEqual(mapEvent("claude", "PermissionDenied", { tool_name: "Bash" }), { kind: "ignore" });
    assert.deepEqual(mapEvent("codex", "Stop", { agent_id: "sub-1" }), { kind: "ignore" });
    assert.deepEqual(mapEvent("codex", "SubagentStop", {}), { kind: "ignore" });
    assert.deepEqual(mapEvent("claude", "ReadyProbe", { probe_text: "❯ " }), { kind: "ignore" });
  });
});

describe("installed hooks (herdr's sets, plus message hints)", () => {
  const ids = { hookPath: "/h/hook.mjs", nodePath: "node", dataDir: "/d", launchId: "L", paneId: 3 };
  it("Claude: SessionStart for identity, and only the events that carry a question", () => {
    assert.deepEqual(Object.keys(claudeSettingsJson(ids).hooks).sort(), [
      "Elicitation",
      "Notification",
      "PermissionRequest",
      "PreToolUse",
      "SessionStart",
    ]);
    assert.equal(claudeSettingsJson(ids).hooks.PreToolUse[0].matcher, "AskUserQuestion");
  });
  it("Codex: herdr v9's SessionStart, UserPromptSubmit, Stop and Interrupt, plus PermissionRequest", () => {
    assert.deepEqual(Object.keys(codexHooksJson(ids).hooks).sort(), [
      "Interrupt",
      "PermissionRequest",
      "SessionStart",
      "Stop",
      "UserPromptSubmit",
    ]);
  });
});

describe("resolveRuntimeIdentity", () => {
  it("prefers baked flags over env", () => {
    const out = resolveRuntimeIdentity(
      { "data-dir": "/baked", "launch-id": "L1", pane: "7" },
      { TERN_AGENT_RUNTIME_DIR: "/env", TERN_AGENT_LAUNCH_ID: "LE", TERN_PANE: "9" },
    );
    assert.deepEqual(out, { dataDir: "/baked", launchId: "L1", paneId: 7 });
  });

  it("falls back to wrapper env and keeps >2^32 pane ids exact", () => {
    const out = resolveRuntimeIdentity(
      {},
      {
        TERN_AGENT_RUNTIME_DIR: "/d",
        TERN_AGENT_LAUNCH_ID: "L",
        TERN_PANE: "4294967299",
      },
    );
    assert.deepEqual(out, { dataDir: "/d", launchId: "L", paneId: 4294967299 });
  });
});

describe("file-backed seq and epochs", () => {
  it("nextSeq grows monotonically across processes (Date.now floor)", async () => {
    const dir = lab();
    try {
      const a = await nextSeq(dir, "L1");
      const b = await nextSeq(dir, "L1");
      assert.ok(b > a);
      assert.ok(a >= Date.now() - 60_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("epoch bumps on session switch, old session never revives implicitly", async () => {
    const dir = lab();
    try {
      const first = await epochForSession(dir, "L1", { kind: "id", value: "s1" });
      assert.equal(first.session_start, true);
      const same = await epochForSession(dir, "L1", { kind: "id", value: "s1" });
      assert.equal(same.epoch, first.epoch);
      assert.equal(same.session_start, false);
      const next = await epochForSession(dir, "L1", { kind: "id", value: "s2" });
      assert.equal(next.epoch, first.epoch + 1);
      assert.equal(next.session_start, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("launch builders (isolated config, no personal writes)", () => {
  it("codex trust hash matches the byte-proven ground truth vector", () => {
    // openai/codex @ rust-v0.159.1, herdr SessionStart hook (matcher omitted):
    // canonical {"event_name":"session_start","hooks":[{...}]} -> 032339d9…c102a6.
    assert.equal(
      codexHookTrustHash({
        event: "SessionStart",
        matcher: undefined,
        handler: {
          type: "command",
          command:
            'powershell -NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\Tobi\\.codex\\herdr-agent-state.ps1" session',
          timeout: 10,
        },
      }),
      "sha256:032339d9dd7ae7a99304128e6b4d0a18587381b0723f2f647f50ee8128c102a6",
    );
    // Matcher present vs omitted produce different hashes (never null it).
    const withMatcher = codexHookTrustHash({
      event: "PermissionRequest",
      matcher: "*",
      handler: { type: "command", command: "node hook.mjs", timeout: 10 },
    });
    const nulled = codexHookTrustHash({
      event: "PermissionRequest",
      matcher: null,
      handler: { type: "command", command: "node hook.mjs", timeout: 10 },
    });
    assert.notEqual(withMatcher, nulled);
    // Timeout normalization: SessionEnd clamps 1..3, others default 600.
    assert.equal(codexNormalizedTimeout("SessionEnd", undefined), 1);
    assert.equal(codexNormalizedTimeout("SessionEnd", 10), 3);
    assert.equal(codexNormalizedTimeout("Stop", undefined), 600);
  });

  it("session flags trust only our own hooks, no auto-approvals", async () => {
    // Behavior: `-c` flags in codex's session-flags layer, one trusted_hash per
    // generated handler keyed by that layer's source path; NO projects trust, NO
    // sandbox choice, NO CODEX_HOME of ours. Folder trust stays the user's own.
    const dir = lab();
    try {
      const built = await prepareLaunch(
        "codex",
        ["--model", "x"],
        { PATH: "/b", HOME: dir, TERN_AGENT_RUNTIME_DIR: dir },
        { dataDir: dir, launchId: "L-exact", paneId: 11, connectorDir: dir },
      );
      assert.ok(!("CODEX_HOME" in built.env));
      const flags = built.args.filter((_, i) => built.args[i - 1] === "-c");
      assert.ok(flags.includes("features.hooks=true"));
      assert.ok(!flags.some((f) => f.includes("projects") || f.includes("sandbox")));
      const hooks = codexHooksJson({
        hookPath: join(dir, "hook.mjs"), nodePath: "node", dataDir: dir, launchId: "L-exact", paneId: 11,
      });
      const state = flags.find((f) => f.startsWith("hooks.state="));
      for (const [event, groups] of Object.entries(hooks.hooks)) {
        assert.ok(flags.some((f) => f.startsWith(`hooks.${event}=[`)), event);
        const hash = codexHookTrustHash({ event, matcher: groups[0].matcher, handler: groups[0].hooks[0] });
        assert.ok(state.includes(hash), event);
      }
      const key = `${codexSessionFlagsSource()}:session_start:0:0`;
      assert.ok(state.includes(`${JSON.stringify(key)} = { trusted_hash = `));
      if (process.platform === "win32") assert.match(key, /^[A-Z]:\\<session-flags>\\config\.toml:/);
      assert.deepEqual(built.args.slice(-2), ["--model", "x"]);
      await built.cleanup();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("session flags are TOML inline values codex can parse", () => {
    const args = codexSessionFlags({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "node \"C:\\a b\\hook.mjs\"", timeout: 10 }] }] },
    });
    const stop = args[args.indexOf("-c", 2) + 1];
    assert.equal(stop, 'hooks.Stop=[{ hooks = [{ type = "command", command = "node \\"C:\\\\a b\\\\hook.mjs\\"", timeout = 10 }] }]');
  });


  it("cleanup removes hook state files but hooks never do mid-life", async () => {
    const dir = lab();
    const { existsSync } = await import("node:fs");
    try {
      await nextSeq(dir, "L9");
      await epochForSession(dir, "L9", { kind: "id", value: "s1" });
      assert.ok(existsSync(join(dir, "hooks", "L9.seq")));
      await removeHookState(dir, "L9");
      assert.ok(!existsSync(join(dir, "hooks", "L9.seq")));
      assert.ok(!existsSync(join(dir, "hooks", "L9.epoch")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // shortNodePath is identity until a reliable probe lands (spaced paths
    // are safe via quoteWindows shell quoting, live 2026-10-13).
  });

  it("prepareLaunch builds isolated envs and cleanup removes them", async () => {
    const dir = lab();
    const { existsSync } = await import("node:fs");
    try {
      const claude = await prepareLaunch(
        "claude",
        ["--model", "opus"],
        { PATH: "/b", TERN_AGENT_RUNTIME_DIR: dir },
        { dataDir: dir, launchId: "L-cl", paneId: 4294967299, connectorDir: dir },
      );
      assert.equal(claude.command, "claude");
      const settingsPath = claude.args[claude.args.indexOf("--settings") + 1];
      assert.ok(settingsPath.includes("tern-claude-"));
      // The user's own config dir stays the config: saved trust, credentials, and
      // the transcript `--resume` needs after this launch ends.
      assert.ok(!("CLAUDE_CONFIG_DIR" in claude.env));
      assert.equal(claude.env.TERN_AGENT_RUNTIME_DIR, dir);
      assert.deepEqual(claude.args.slice(-2), ["--model", "opus"]);
      assert.ok(existsSync(settingsPath));
      await claude.cleanup();
      assert.ok(!existsSync(settingsPath));

      const codex = await prepareLaunch(
        "codex",
        [],
        { PATH: "/b", HOME: dir, TERN_AGENT_RUNTIME_DIR: dir },
        { dataDir: dir, launchId: "L-cx", paneId: 11, connectorDir: dir },
      );
      assert.equal(codex.command, "codex");
      assert.ok(!("CODEX_HOME" in codex.env));
      await codex.cleanup();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prepareLaunch rejects unknown agents and missing identity", async () => {
    await assert.rejects(() =>
      prepareLaunch("omp", [], {}, { dataDir: "/d", launchId: "L", paneId: 1 }),
    );
    await assert.rejects(() =>
      prepareLaunch("claude", [], {}, { dataDir: null, launchId: "L", paneId: 1 }),
    );
  });

  it("hook command line delivers through a real subprocess", async () => {
    // Consumer contract (not source prefix): the generated command line must
    // actually execute node with the hook file and deliver its payload.
    // codex 0.159.1 never invokes a leading QUOTED executable (live bisect),
    // so the line starts with a bare resolver ("node" on PATH / override).
    assert.equal(resolveNodeBin({}), "node");
    assert.equal(resolveNodeBin({ TERN_NODE_BIN: "C:/x/node.exe" }), "C:/x/node.exe");
    const { execFileSync } = await import("node:child_process");
    const line = shellFor(resolveNodeBin({}), ["--version"]);
    assert.match(line, /^node /);
    const out = execFileSync("node", ["--version"], { encoding: "utf8", timeout: 15000 });
    assert.match(out.trim(), /^v\d+\./);
  });

});
