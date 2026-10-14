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

import { classifySurface } from "./detect.mjs";
import {
  addBlocker,
  blockerIdFor,
  resumeArgv,
  epochForSession,
  isIdentityEnding,
  mapEvent,
  nextSeq,
  resolveBlockers,
  resolveRuntimeIdentity,
} from "./hook.mjs";
import {
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

describe("classifySurface claude (herdr claude 2026.09.11.1)", () => {
  it("marks the bare prompt box idle", () => {
    assert.deepEqual(classifySurface("claude", "some work\n\n❯ "), {
      state: "idle",
      rule: "live_prompt_box",
    });
  });

  it("marks the Windows prompt box idle: `>` plus a no-break space (live 2.1.296)", () => {
    const surface = [
      " Claude Code v2.1.296",
      "──────────────────────────────",
      ">\u00a0Try a prompt",
      "──────────────────────────────",
      "  auto mode on (shift+tab to cycle)",
    ].join("\n");
    assert.deepEqual(classifySurface("claude", surface), { state: "idle", rule: "live_prompt_box" });
  });

  it("does not take a shell prompt for the Claude prompt box", () => {
    assert.equal(classifySurface("claude", "PS C:\\Users\\lab> ").state, "unknown");
    assert.equal(classifySurface("claude", "> plain quoted line").state, "unknown");
  });

  it("marks a permission dialog blocked, not idle", () => {
    const text = [
      "do you want to proceed?",
      "bash command: rm -rf build",
      "❯ 1. Yes",
      "  2. No",
      "esc to cancel",
    ].join("\n");
    const out = classifySurface("claude", text);
    assert.equal(out.state, "blocked");
  });

  it("marks AskUserQuestion-style select forms blocked", () => {
    const text = [
      "pick one ──────────────",
      "enter to select",
      "tab/arrow keys to navigate",
      "esc to cancel",
    ].join("\n");
    assert.equal(classifySurface("claude", text).state, "blocked");
  });

  it("marks spinner output working", () => {
    assert.equal(
      classifySurface("claude", "✶ Working… (12s · esc to interrupt)").state,
      "working",
    );
  });

  it("is honestly unknown on empty or foreign text", () => {
    assert.deepEqual(classifySurface("claude", ""), {
      state: "unknown",
      rule: null,
    });
    assert.deepEqual(classifySurface("claude", "omp turn output"), {
      state: "unknown",
      rule: null,
    });
    assert.deepEqual(classifySurface("nope", "❯ "), {
      state: "unknown",
      rule: null,
    });
  });
});

describe("classifySurface codex (herdr codex 2026.10.11.1)", () => {
  it("marks the startup update picker blocked (startup_update, live 0.159.1)", () => {
    const surface = [
      "  Update available · 0.159.1 → 0.162.1",
      "  Release notes: https://github.com/openai/codex/releases/latest",
      "› 1. Update now (runs `powershell -ExecutionPolicy Bypass -c",
      "  2. Skip",
      "  3. Skip until next version",
      "  enter continue · esc skip",
    ].join("\n");
    assert.deepEqual(classifySurface("codex", surface), { state: "blocked", rule: "startup_update" });
  });

  it("marks the resting composer idle without the agents hint (live 0.159.1, a warning in its place)", () => {
    const surface = [
      "  >_ OpenAI Codex (v0.159.1)",
      "  Practical, peculiar, or a little of both?",
      "› Ask Codex to do anything",
      "  GPT-6.1-Sol default · ~\\lab",
      "  ? for shortcuts                                      ⚠ 1 warning · f2 to view",
    ].join("\n");
    assert.deepEqual(classifySurface("codex", surface), { state: "idle", rule: "codex_composer_idle" });
  });

  it("does not take a passive update notice for the picker", () => {
    assert.notEqual(classifySurface("codex", "Update available · 0.162.1 is out\n› ").rule, "startup_update");
  });

  it("marks Action Required blocked", () => {
    assert.equal(
      classifySurface("codex", "Codex — Action Required").state,
      "blocked",
    );
  });

  it("marks the trust dialog blocked", () => {
    const text = [
      "> You are in C:\\work",
      "Do you trust the contents of this directory?",
      "Trust this folder? Codex can read, edit, and run files here",
      "Trust and continue",
    ].join("\n");
    assert.equal(classifySurface("codex", text).state, "blocked");
  });

  it("marks first-run dialogs blocked with reason (lab verbatim)", () => {

    assert.deepEqual(
      classifySurface("codex", "Hooks need review\n6 hooks are new or changed.\n\n› 1. Review hooks\n2. Trust all and continue\n\nenter confirm · esc skip"),
      { state: "blocked", rule: "codex_hooks_review" },
    );
    // codex sandbox-setup (evidence §4c verbatim head): blocked.
    assert.deepEqual(
      classifySurface("codex", "Set up the Codex agent sandbox to protect your files\n› 1. Set up default sandbox (requires Administrator permissions)\n2. Use non-admin sandbox\n\nenter select · esc back"),
      { state: "blocked", rule: "codex_sandbox_setup" },
    );
    // claude folder trust (lab 2.1.296 verbatim): blocked.
    assert.deepEqual(
      classifySurface("claude", "Is this a project you created or one you trust?\n> No, exit · Yes, I trust this folder"),
      { state: "blocked", rule: "claude_folder_trust" },
    );
  });


  it("marks the resting composer idle (evidence-backed rule)", () => {
    const idle = [
      "  >_ OpenAI Codex (v0.159.1)",
      "› Ask Codex to do anything",
      "",
      "  GPT-6.1-Sol default · C:\\scratch",
      "  ← for agents · ? for shortcuts",
    ].join("\n");
    assert.deepEqual(classifySurface("codex", idle), {
      state: "idle",
      rule: "codex_composer_idle",
    });
    // Same chrome mid-turn (working line present) stays working.
    const busy = `${idle}\n◦ Working (1s • esc to interrupt)`;
    assert.equal(classifySurface("codex", busy).state, "working");
    // Bare calm text with no composer chrome stays honestly unknown.
    assert.deepEqual(classifySurface("codex", "done, waiting"), {
      state: "unknown",
      rule: null,
    });
  });
});

describe("mapEvent (parent-corrected hook rules)", () => {
  it("resume argv names the executable first, as omp's does", () => {
    assert.deepEqual(resumeArgv("claude", {}, { kind: "id", value: "s1" }), ["claude", "--resume", "s1"]);
    assert.deepEqual(resumeArgv("codex", {}, { kind: "id", value: "r1" }), ["codex", "resume", "r1"]);
    assert.equal(resumeArgv("claude", {}, null), null);
  });

  it("SessionStart reports identity only: unknown + not ready", () => {
    const out = mapEvent("claude", "SessionStart", {
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
  });

  it("PreToolUse Bash is ignored (never a generic block)", () => {
    assert.deepEqual(
      mapEvent("claude", "PreToolUse", {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /tmp/x" },
      }),
      { kind: "ignore" },
    );
  });

  it("PreToolUse AskUserQuestion with payload is the only tool block", () => {
    const out = mapEvent("claude", "PreToolUse", {
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "Which region?" }] },
    });
    assert.equal(out.kind, "report");
    assert.equal(out.fields.state, "blocked");
    assert.match(out.fields.message, /Which region/);
  });

  it("PermissionRequest is blocked with the tool named", () => {
    const out = mapEvent("codex", "PermissionRequest", {
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "git push", description: "push branch" },
    });
    assert.equal(out.kind, "report");
    assert.equal(out.fields.state, "blocked");
    assert.match(out.fields.message, /Bash/);
  });

  it("PermissionRequest for AskUserQuestion keeps the question, not the permission", () => {
    // Claude asks permission for its own question tool right after PreToolUse;
    // the rail must still show what was asked.
    const out = mapEvent("claude", "PermissionRequest", {
      hook_event_name: "PermissionRequest",
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "Which region?", header: "Region" }] },
    });
    assert.equal(out.kind, "report");
    assert.equal(out.fields.state, "blocked");
    assert.equal(out.fields.message, "Which region?");
  });

  it("PermissionDenied is recovery: ignored, never an automatic state", () => {
    assert.deepEqual(
      mapEvent("claude", "PermissionDenied", {
        hook_event_name: "PermissionDenied",
        tool_name: "Bash",
      }),
      { kind: "ignore" },
    );
  });

  it("Elicitation is a question: blocked", () => {
    const out = mapEvent("claude", "Elicitation", {
      hook_event_name: "Elicitation",
      mcp_server_name: "tracker",
      message: "Project key?",
    });
    assert.equal(out.kind, "report");
    assert.equal(out.fields.state, "blocked");
  });

  it("idle Notification types are ignored; permission_prompt is blocked", () => {
    assert.deepEqual(
      mapEvent("claude", "Notification", {
        hook_event_name: "Notification",
        notification_type: "idle_prompt",
        message: "idle",
      }),
      { kind: "ignore" },
    );
    const out = mapEvent("claude", "Notification", {
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
      message: "needs approval",
    });
    assert.equal(out.fields.state, "blocked");
  });

  it("subagent traffic never moves the occupant", () => {
    assert.deepEqual(
      mapEvent("claude", "Stop", {
        hook_event_name: "Stop",
        agent_id: "sub-1",
      }),
      { kind: "ignore" },
    );
    assert.deepEqual(
      mapEvent("codex", "SubagentStop", { hook_event_name: "SubagentStop" }),
      { kind: "ignore" },
    );
  });

  it("Stop ends the turn idle+ready; Interrupt keeps the occupant live", () => {
    assert.deepEqual(mapEvent("claude", "Stop", { hook_event_name: "Stop" }), {
      kind: "report",
      fields: { state: "idle", ready: true },
    });
    // Interrupt is a turn-cancel: the agent stays live, so the hook reports
    // unknown (never releases name/session/resume — plan §3 exit-only).
    assert.deepEqual(
      mapEvent("codex", "Interrupt", { hook_event_name: "Interrupt" }),
      { kind: "report", fields: { state: "unknown" } },
    );
  });

  it("SessionEnd logout ends identity; switch reasons keep the occupant", () => {
    // logout/prompt_input_exit (documented claude reasons: user exits the CLI):
    // report unknown+not-ready; the wrapper releases after the child exits.
    for (const reason of ["logout", "prompt_input_exit"]) {
      assert.deepEqual(
        mapEvent("claude", "SessionEnd", { hook_event_name: "SessionEnd", reason }),
        { kind: "report", fields: { state: "unknown", ready: false } },
      );
    }
    // clear/resume/other (process stays alive, next SessionStart arrives on
    // the same occupant): no release, name/session/resume survive.
    for (const reason of ["clear", "resume", "other"]) {
      assert.deepEqual(
        mapEvent("claude", "SessionEnd", { hook_event_name: "SessionEnd", reason }),
        { kind: "ignore" },
      );
    }
  });

  it("blocker ids correlate per tool call; unrelated completions keep blockers", async () => {
    assert.equal(
      blockerIdFor("Elicitation", { elicitation_id: "e1", mcp_server_name: "s" }),
      "elicitation:e1",
    );
    assert.equal(blockerIdFor("PostToolUse", { tool_use_id: "t9" }), "tool:t9");
    assert.equal(blockerIdFor("Stop", {}), null);
    const dir = lab();
    try {
      await addBlocker(dir, "L1", "tool:AAA", { tool: "AskUserQuestion", message: "pick one" });
      // Unrelated PostToolUse(B) resolves nothing: blocker survives.
      const kept = await resolveBlockers(dir, "L1", "PostToolUse", { tool_use_id: "tB" });
      assert.deepEqual(kept.resolved, []);
      assert.ok(kept.remaining["tool:AAA"]);
      // Matching completion resolves exactly its own id.
      const cleared = await resolveBlockers(dir, "L1", "PostToolUse", { tool_use_id: "AAA" });
      assert.deepEqual(cleared.resolved, ["tool:AAA"]);
      assert.deepEqual(cleared.remaining, {});
      // PermissionDenied without a pending match resolves nothing (honest).
      await addBlocker(dir, "L1", "tool:QQ", { tool: "Bash", message: "approve?" });
      const denied = await resolveBlockers(dir, "L1", "PermissionDenied", { tool_use_id: "tZ" });
      assert.deepEqual(denied.resolved, []);
      assert.ok(denied.remaining["tool:QQ"]);
      const matched = await resolveBlockers(dir, "L1", "PermissionDenied", { tool_use_id: "QQ" });
      assert.deepEqual(matched.resolved, ["tool:QQ"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ReadyProbe reports idle+ready only on real prompt evidence", () => {
    const ready = mapEvent("claude", "ReadyProbe", {
      probe_text: "work done\n\n❯ ",
    });
    assert.deepEqual(ready, {
      kind: "report",
      fields: { state: "idle", ready: true },
    });
    assert.deepEqual(
      mapEvent("claude", "ReadyProbe", { probe_text: "✶ Working… (3s)" }),
      { kind: "ignore" },
    );
    // Codex resting composer (evidence-backed rule): placeholder + footer,
    // no working line. A bare calm line is still honestly unknown.
    assert.deepEqual(
      mapEvent("codex", "ReadyProbe", {
        probe_text: "› Ask Codex to do anything\nGPT-6.1-Sol default · C:\\w\n← for agents · ? for shortcuts",
      }),
      { kind: "report", fields: { state: "idle", ready: true } },
    );
    assert.deepEqual(
      mapEvent("codex", "ReadyProbe", {
        probe_text: "› Ask Codex to do anything\nGPT-6.1-Sol default · C:\\w\n← for agents · ? for shortcuts\n◦ Working (1s • esc to interrupt)",
      }),
      { kind: "ignore" },
    );
    assert.deepEqual(mapEvent("claude", "ReadyProbe", { probe_text: "  " }), {
      kind: "ignore",
    });
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
