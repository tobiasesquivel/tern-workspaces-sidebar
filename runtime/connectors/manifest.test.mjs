// runtime/connectors/manifest.test.mjs — the herdr manifest engine, ported.
// Pure: no daemon, no agents, no network. Node >= 22, no deps.

import assert from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compileManifest,
  detectionText,
  evaluate,
  loadManifest,
  parseToml,
  region,
  translateRegex,
} from "./manifest.mjs";
import { classifySurface } from "./detect.mjs";

describe("parseToml (the manifest subset)", () => {
  it("reads keys, [[rules]], literal and basic strings, arrays and nested inline tables", () => {
    const doc = parseToml(`
id = "x"   # trailing comment
version = "1.2"
min_engine_version = 3
aliases = ["a", 'b']

[[rules]]
id = "r1"
priority = 950
visible_idle = true
regex = ['^\\s*\\x{276F}']
any = [
  { contains = ["Esc to cancel"] },
  { contains = ["enter"], any = [{ contains = ["yes"] }] },
]

[[rules]]
id = "r2"
`);
    assert.equal(doc.id, "x");
    assert.equal(doc.min_engine_version, 3);
    assert.deepEqual(doc.aliases, ["a", "b"]);
    assert.equal(doc.rules.length, 2);
    assert.equal(doc.rules[0].regex[0], "^\\s*\\x{276F}");
    assert.equal(doc.rules[0].visible_idle, true);
    assert.deepEqual(doc.rules[0].any[1].any, [{ contains: ["yes"] }]);
    assert.equal(doc.rules[1].id, "r2");
  });

  it("unescapes basic strings and keeps literal strings raw", () => {
    const doc = parseToml(`a = "q\\"x\\\\y\\u00e9"\nb = 'q\\"x'`);
    assert.equal(doc.a, 'q"x\\yé');
    assert.equal(doc.b, 'q\\"x');
  });
});

describe("translateRegex (Rust regex to JavaScript)", () => {
  it("maps \\x{HHHH}, leading inline flags, \\A and \\z", () => {
    const re = translateRegex("(?i)^\\x{276F} yes\\s*\\z");
    assert.equal(re.flags.includes("i"), true);
    assert.equal(re.test("❯ YES  "), true);
    assert.equal(re.test("❯ yes\nmore"), false);
    const m = translateRegex("(?m)^a\\z");
    assert.equal(m.test("x\na"), true);
    assert.equal(m.test("a\nx"), false);
    assert.equal(translateRegex("\\Afoo").test("foo bar"), true);
    assert.equal(translateRegex("\\Afoo").test("bar\nfoo"), false);
  });
});

describe("regions (herdr src/detect/manifest.rs)", () => {
  const text = detectionText("top\n\nmid\n──────\n❯ hi\n──────\nfooter\n\n");
  it("detection text trims lines, drops trailing blanks and ends in one newline", () => {
    assert.equal(detectionText("a  \r\nb\n\n\n"), "a\nb\n");
    assert.equal(detectionText(""), "");
  });
  it("bottom_non_empty_lines keeps the blank lines in between", () => {
    assert.equal(region({ screen: text }, "bottom_non_empty_lines(5)"), "mid\n──────\n❯ hi\n──────\nfooter\n");
    assert.equal(region({ screen: "a\n\nb\nc\n" }, "bottom_non_empty_lines(3)"), "a\n\nb\nc\n");
  });
  it("prompt_box_body is between the top border and the next rule", () => {
    assert.equal(region({ screen: text }, "prompt_box_body"), "❯ hi\n");
    assert.equal(region({ screen: "no box\n" }, "prompt_box_body"), "");
  });
  it("after_last_horizontal_rule and above_prompt_box", () => {
    assert.equal(region({ screen: text }, "after_last_horizontal_rule"), "footer\n");
    assert.equal(region({ screen: text }, "above_prompt_box"), "top\n\nmid\n");
    assert.equal(region({ screen: text }, "last_non_empty_above_prompt_box"), "mid");
  });
  it("a titled rule counts only with 3+ dashes", () => {
    assert.equal(region({ screen: "a\n─── title\nb\n" }, "after_last_horizontal_rule"), "b\n");
    assert.equal(region({ screen: "a\n─ title\nb\n" }, "after_last_horizontal_rule"), "a\n─ title\nb\n");
  });
  it("top_non_empty_lines and the codex prompt regions", () => {
    assert.equal(region({ screen: "\na\n\nb\nc\n" }, "top_non_empty_lines(2)"), "\na\n\nb\n");
    const codex = "• did it\n› next\nfooter\n";
    assert.equal(region({ screen: codex }, "after_last_prompt_marker"), "footer\n");
    assert.equal(region({ screen: codex }, "before_current_prompt_marker"), "• did it\n");
    assert.equal(region({ screen: codex }, "whole_recent_without_current_prompt_marker"), "");
    // A block line after the prompt makes the prompt stale: no current prompt.
    assert.equal(region({ screen: "› old\n• answer\n" }, "whole_recent_without_current_prompt_marker"), "› old\n• answer\n");
  });
  it("osc regions read only their own field", () => {
    assert.equal(region({ screen: "✳ on screen\n", title: "t" }, "osc_title"), "t");
    assert.equal(region({ screen: "x\n", progress: "4;0;" }, "osc_progress"), "4;0;");
  });
});

describe("evaluate (priority, case, fallback)", () => {
  const m = compileManifest(
    parseToml(`
id = "t"
version = "1"
[[rules]]
id = "low"
state = "blocked"
priority = 10
contains = ["Do You"]
[[rules]]
id = "high"
state = "working"
priority = 20
visible_working = true
contains = ["do you"]
[[rules]]
id = "tie"
state = "idle"
priority = 20
contains = ["do you"]
[[rules]]
id = "skip"
state = "unknown"
priority = 5
skip_state_update = true
contains = ["viewer"]
`),
  );
  it("contains is case-insensitive and the highest priority wins, first in file on a tie", () => {
    const r = evaluate(m, { screen: "DO YOU WANT\n" });
    assert.equal(r.rule, "high");
    assert.equal(r.state, "working");
    assert.equal(r.visible_working, true);
  });
  it("no matching rule is idle for a known agent", () => {
    const r = evaluate(m, { screen: "nothing\n" });
    assert.deepEqual([r.state, r.rule, r.skip], ["idle", null, false]);
  });
  it("skip_state_update passes through", () => {
    assert.equal(evaluate(m, { screen: "viewer\n" }).skip, true);
  });
});

describe("bundled manifests", () => {
  it("are the herdr remote 2026.10.11.1 copies", () => {
    assert.equal(loadManifest("claude", { remoteDir: null }).version, "2026.10.11.1");
    assert.equal(loadManifest("codex", { remoteDir: null }).version, "2026.10.11.1");
  });
  it("a newer remote copy wins, an older or broken one is ignored", () => {
    const dir = mkdtempSync(join(tmpdir(), "tern-manifest-test-"));
    try {
      writeFileSync(join(dir, "codex.toml"), `id = "codex"\nversion = "2099.1.1.1"\nmin_engine_version = 3\n[[rules]]\nid = "only"\nstate = "blocked"\ncontains = ["zzz"]\n`);
      writeFileSync(join(dir, "claude.toml"), `id = "claude"\nversion = "2000.1.1.1"\n[[rules]]\nid = "old"\nstate = "blocked"\ncontains = ["zzz"]\n`);
      assert.equal(loadManifest("codex", { remoteDir: dir }).version, "2099.1.1.1");
      assert.equal(loadManifest("claude", { remoteDir: dir }).version, "2026.10.11.1");
      writeFileSync(join(dir, "codex.toml"), `id = "codex"\nversion = "2099.1.1.1"\n[[rules]]\nid = "bad"\nregex = ['(']\n`);
      assert.equal(loadManifest("codex", { remoteDir: dir }).version, "2026.10.11.1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("classifySurface claude (herdr claude.toml 2026.10.11.1 + tern overrides)", () => {
  const c = (screen, title = "") => classifySurface("claude", screen, { title });

  it("the prompt box is visibly idle", () => {
    const s = c("some work\n──────\n❯ \n──────\n  ? for shortcuts\n");
    assert.deepEqual([s.state, s.rule, s.visible_idle], ["idle", "live_prompt_box", true]);
  });

  it("the Windows prompt box (`>` + no-break space, 2.1.296) is visibly idle (tern override)", () => {
    const s = c([" Claude Code v2.1.296", "──────────────────────────────", ">\u00a0Try a prompt", "──────────────────────────────", "  auto mode on (shift+tab to cycle)"].join("\n"));
    assert.deepEqual([s.state, s.visible_idle], ["idle", true]);
  });

  it("no rule matched is idle, not unknown (herdr's known-agent fallback)", () => {
    assert.deepEqual([c("PS C:\\Users\\lab> ").state, c("PS C:\\Users\\lab> ").rule], ["idle", null]);
  });

  it("a working turn line beats an older permission text above it (priorities, not file order)", () => {
    const s = c(["Do you want to proceed? yes", "", "✶ Thinking… (12s · esc to interrupt)", "──────", "❯ ", "──────"].join("\n"));
    assert.equal(s.state, "working");
    assert.equal(s.rule, "live_turn_working");
  });

  it("the Bash permission dialog is a visible blocker", () => {
    const s = c(["Bash command", "  echo hi", "Do you want to proceed?", "❯ 1. Yes", "  2. No", "Esc to cancel"].join("\n"));
    assert.deepEqual([s.state, s.visible_blocker], ["blocked", true]);
  });

  it("a question form with Title Case controls is blocked (case-insensitive contains)", () => {
    const s = c(["──────", "Pick one", "❯ 1. A", "  2. B", "Enter to select · ↑/↓ to navigate · Esc to cancel"].join("\n"));
    assert.deepEqual([s.state, s.rule], ["blocked", "live_blocked_form"]);
  });

  it("the folder trust dialog (lab 2.1.296 verbatim) is blocked by live_blocked_form", () => {
    const s = c([
      "────────────────────────────────────────────────────────────────────────────────",
      " Accessing workspace:",
      "",
      " C:\\Users\\Tobi\\AppData\\Local\\Temp\\lab\\scratch",
      "",
      " Quick safety check: Is this a project you created or one you trust? (Like your",
      " own code, a well-known open source project, or work from your team). If not,",
      " take a moment to review what's in this folder first.",
      "",
      " > No, exit",
      "   Yes, I trust this folder",
      "",
      " Enter to confirm · Esc to cancel",
    ].join("\n"));
    assert.deepEqual([s.state, s.rule, s.visible_blocker], ["blocked", "live_blocked_form", true]);
  });

  it("the OSC title is its own region: a title spinner is working, `✳` on screen is not the title", () => {
    assert.equal(c("plain\n", "⠂ Claude Code").state, "working");
    assert.equal(c("plain\n", "◐ Claude Code").rule, "osc_title_working");
    const onScreen = c("✳ Claude Code\n", "");
    assert.equal(onScreen.rule, null);
    const titled = c("plain\n", "✳ Claude Code");
    assert.deepEqual([titled.state, titled.rule, titled.visible_idle], ["idle", "osc_title_idle", true]);
  });

  it("the transcript viewer skips the update", () => {
    assert.equal(c("lots\nShowing detailed transcript · ctrl+o to toggle\n").skip, true);
  });
});

describe("classifySurface codex (herdr codex.toml 2026.10.11.1 + tern overrides)", () => {
  const c = (screen, title = "") => classifySurface("codex", screen, { title });

  it("Action Required in the title is a visible blocker; on screen it is not", () => {
    assert.deepEqual([c("x\n", "Codex — Action Required").state, c("x\n", "Codex — Action Required").visible_blocker], ["blocked", true]);
    assert.notEqual(c("Codex — Action Required\n").rule, "osc_title_blocked");
  });

  it("a spinner title is working; any other title is visibly idle", () => {
    assert.equal(c("x\n", "⠋ codex").state, "working");
    const t = c("x\n", "codex");
    assert.deepEqual([t.state, t.rule, t.visible_idle], ["idle", "osc_title_idle", true]);
  });

  it("the startup update picker is blocked (live 0.159.1)", () => {
    const s = c(["  Update available · 0.159.1 → 0.162.1", "  Release notes: https://github.com/openai/codex/releases/latest", "› 1. Update now", "  2. Skip", "  3. Skip until next version", "  enter continue · esc skip"].join("\n"));
    assert.deepEqual([s.state, s.rule], ["blocked", "startup_update"]);
  });

  it("the trust dialog is blocked", () => {
    const s = c(["> You are in C:\\work", "", "  Do you trust the contents of this directory?", "› 1. Yes, continue", "  2. No, quit"].join("\n"));
    assert.deepEqual([s.state, s.rule], ["blocked", "trust_directory"]);
  });

  it("first-run sandbox and hooks pickers are blocked (tern overrides, lab verbatim)", () => {
    assert.equal(c("Set up the Codex agent sandbox to protect your files\n› 1. Set up default sandbox (requires Administrator permissions)\n2. Use non-admin sandbox\n\nenter select · esc back").rule, "codex_sandbox_setup");
    assert.equal(c("Hooks need review\n6 hooks are new or changed.\n\n› 1. Review hooks\n2. Trust all and continue\n\nenter confirm · esc skip").rule, "codex_hooks_review");
  });

  it("the resting composer is visibly idle; the live timer is working", () => {
    const idle = ["  >_ OpenAI Codex (v0.159.1)", "› Ask Codex to do anything", "", "  GPT-6.1-Sol default · C:\\scratch", "  ← for agents · ? for shortcuts"].join("\n");
    const s = c(idle);
    assert.deepEqual([s.state, s.visible_idle], ["idle", true]);
    const busy = ["• Working (12s • esc to interrupt)", "", "› Ask Codex to do anything", "  ? for shortcuts"].join("\n");
    assert.equal(c(busy).state, "working");
  });
});

describe("classifySurface omp (tern startup rules only)", () => {
  it("the first-run setup wizard (omp 18.10.4, lab verbatim) is a visible blocker", () => {
    const s = classifySurface("omp", [
      " omp",
      "                                         Setup",
      "step 1 of 5",
      "    Sign in to your providers",
      "    ╭─ Select provider to login ─────────╮",
      "    │ ❯ ChatGPT Plus/Pro (Codex Subscription) │",
      "    ╰────────────────────────────────────╯",
      "                    ↑/↓ select · ⏎ confirm · ⎋ skip · Ctrl+C exit setup",
    ].join("\n"));
    assert.deepEqual([s.state, s.rule, s.visible_blocker], ["blocked", "omp_setup_wizard", true]);
  });
  it("a ready omp screen is idle", () => {
    assert.equal(classifySurface("omp", " π > ⬢ model > 🗑 scratch\n╰─ \n").state, "idle");
  });
});
