// runtime/connectors/detect.mjs — terminal-surface classifier for claude/codex.
//
// Ownership: ThirdConnectors. Read-only fallback used when hooks are absent
// (e.g. Codex hooks untrusted/disabled) or to validate readiness surfaces.
//
// Detection rules (working/blocked/unknown shapes) are ported from herdr's
// agent-detection packs (installed under
// %LOCALAPPDATA%/herdr/agent-detection/remote/):
//   - claude.toml id "claude" version 2026.09.11.1 (min_engine 2)
//   - codex.toml  id "codex"  version 2026.10.11.1 (min_engine 3)
// Those packs are herdr's (github.com/herdrdev/herdr); see sounds/LICENSE
// in this repo for the form of third-party attribution used here. The
// codex_composer_idle rule is connector-owned, backed by real lab evidence
// (local://codex-surface-evidence.md, codex-cli 0.159.1, capture --surfaces).
// Regions are approximated on plain captured text (bottom lines, text after
// the last horizontal rule, whole text); OSC title/progress regions only
// apply when the caller includes title text in the input.
//
// Honesty rule: anything unmatched is `unknown` (never idle). In particular
// the codex `osc_title_idle` catch-all (priority 100, title region) is NOT
// applied to surface text — on a surface it would mark everything idle.

const ANSI_RE = new RegExp("\u001b\\[[0-9;?]*[A-Za-z]|\u001b[()][0-9A-Z]", "g");

function clean(text) {
  return typeof text === "string" ? text.replace(ANSI_RE, "") : "";
}

function linesOf(text) {
  return clean(text).split(/\r?\n/);
}

function nonEmpty(text) {
  return linesOf(text).filter((l) => l.trim() !== "");
}

// herdr region: bottom_non_empty_lines(n)
function bottomText(text, n) {
  return nonEmpty(text).slice(-n).join("\n");
}

// herdr region: after_last_horizontal_rule (Claude renders ─── separators)
function afterLastRule(text) {
  const parts = clean(text).split(/[─━═]{3,}/);
  return parts[parts.length - 1] ?? "";
}

function has(hay, needle) {
  return hay.indexOf(needle) !== -1;
}

function hasAny(hay, needles) {
  return needles.some((n) => has(hay, n));
}

function hasAll(hay, needles) {
  return needles.every((n) => has(hay, n));
}

function re(hay, pattern, flags) {
  return new RegExp(pattern, flags === "" ? undefined : flags).test(hay);
}

// ---------------------------------------------------------------------------
// claude — herdr remote/claude.toml v2026.09.11.1
// ---------------------------------------------------------------------------

function classifyClaude(raw) {
  const whole = clean(raw);
  const lower = whole.toLowerCase();
  const bottom3 = bottomText(raw, 3);
  const bottom12 = bottomText(raw, 12);
  const afterRule = afterLastRule(raw);

  // skip_state_update rules first: overlays that must not move state.
  // claude.toml: "transcript_viewer" (priority 1000, skip_state_update).
  if (
    has(bottom3, "showing detailed transcript") &&
    hasAny(bottom3, [
      "to toggle",
      "show all",
      "collapse",
      "scroll",
      "? for shortcuts",
    ])
  ) {
    return { state: "unknown", rule: "transcript_viewer" };
  }
  // claude.toml: "model_picker_menu" (priority 900, skip_state_update).
  if (
    hasAll(lower, ["select model", "enter to set as default", "esc to cancel"]) &&
    !has(lower, "do you want to proceed?") &&
    !has(lower, "enter to select")
  ) {
    return { state: "unknown", rule: "model_picker_menu" };
  }

  // claude.toml: "live_blocked_form" (priority 980, after_last_horizontal_rule).
  if (
    has(afterRule, "esc to cancel") &&
    (has(afterRule, "enter to confirm") ||
      (has(afterRule, "enter to select") &&
        hasAny(afterRule, [
          "tab/arrow keys to navigate",
          "arrow keys to navigate",
          "arrows to navigate",
          "↑/↓ to navigate",
          "↑↓ to navigate",
        ])))
  ) {
    return { state: "blocked", rule: "live_blocked_form" };
  }
  // claude first-run folder trust (live 2.1.296, lab: "Is this a project you
  // created or one you trust? / No, exit · Yes, I trust this folder"): the
  // agent cannot proceed until the user answers. Real blocked (no herdr id).
  if (
    hasAny(lower, ["is this a project you created", "do you trust this folder"]) &&
    hasAny(whole, ["Yes, I trust", "No, exit", "trust this folder"])
  ) {
    return { state: "blocked", rule: "claude_folder_trust" };
  }
  // claude.toml: "mcp_elicitation_prompt" (priority 980, whole_recent).
  // Invariant header + Accept/Decline controls + cancel footer.
  if (
    has(afterRule, "esc to cancel") &&
    re(
      whole,
      "^\\s*MCP server [\"\\u201C].+[\"\\u201D] requests your input\\s*$",
      "im",
    ) &&
    (re(whole, "^\\s*\\u276F?\\s*Accept\\b", "im") ||
      re(whole, "^\\s*\\u276F?\\s*Decline\\b", "im"))
  ) {
    return { state: "blocked", rule: "mcp_elicitation_prompt" };
  }
  // claude.toml: "bash_permission_prompt" (priority 850, whole_recent).
  if (
    has(whole, "do you want to proceed?") &&
    hasAny(whole, [
      "bash command",
      "bash(",
      "contains expansion",
      "tab to amend",
      "ctrl+e to explain",
    ]) &&
    re(whole, "^\\s*❯?\\s*(1\\.\\s*yes|2\\.\\s*yes|2\\.\\s*no|3\\.\\s*no|yes)\\b", "mi")
  ) {
    return { state: "blocked", rule: "bash_permission_prompt" };
  }
  // claude.toml: "generic_permission_prompt" (priority 840,
  // after_last_horizontal_rule).
  if (
    has(afterRule, "do you want to proceed?") &&
    has(afterRule, "esc to cancel") &&
    re(afterRule, "^\\s*❯?\\s*(1\\.\\s*yes|2\\.\\s*yes|2\\.\\s*no|3\\.\\s*no)\\b", "mi")
  ) {
    return { state: "blocked", rule: "generic_permission_prompt" };
  }
  // claude.toml: "legacy_no_prompt_blocker" (priority 300, whole_recent).
  // Only shapes with a visible choice/cancel cue; a lone "❯" prompt box is idle.
  if (
    hasAny(lower, [
      "waiting for permission",
      "do you want to allow this connection?",
      "tab to amend",
      "ctrl+e to explain",
      "review your answers",
      "skip interview and plan immediately",
    ]) ||
    ((has(lower, "do you want to") || has(lower, "would you like to")) &&
      (has(lower, "yes") || has(whole, "❯")) &&
      !re(whole, "^\\s*❯\\s*$", "m"))
  ) {
    return { state: "blocked", rule: "legacy_no_prompt_blocker" };
  }

  // claude.toml: "live_turn_working" (priority 970, bottom 12).
  if (
    re(bottom12, "^\\s*[⏸⏵].*esc to interrupt(?:\\s|·|$)") ||
    re(bottom12, "^\\s*[\\*·✢✳✶✻✽]\\s+\\S.*…(?:\\s+\\(\\d+[smh](?:\\s|·)|\\s*$)")
  ) {
    return { state: "working", rule: "live_turn_working" };
  }
  // claude.toml: "background_agents_working" (priority 965).
  if (
    re(
      bottomText(raw, 20),
      "^\\s*[\\*·✢✶✻✽]\\s+Waiting for [1-9]\\d* background agents? to finish\\s*$",
      "m",
    )
  ) {
    return { state: "working", rule: "background_agents_working" };
  }
  // Title-region rules, applied when the caller folds OSC title text in.
  // claude.toml: "osc_title_working" (priority 1100, braille/half-circles).
  if (re(whole, "^[\\u2800-\\u28FF\\u25D0-\\u25D3] ", "m")) {
    return { state: "working", rule: "osc_title_working" };
  }

  // claude.toml: "live_prompt_box" (priority 950, prompt_box_body):
  // a ❯ box with no select/cancel/navigate chrome is the idle prompt.
  // Deviation from herdr, measured on Windows (claude 2.1.296 in a Tern pane): the
  // box draws `>` plus a no-break space (U+00A0), never `❯`. A shell prompt does not
  // start a line that way.
  if (
    re(whole, "^\\s*(❯|>\\u00a0)", "m") &&
    !hasAny(whole, [
      "enter to select",
      "esc to cancel",
      "tab/arrow keys",
      "arrow keys to navigate",
      "↑/↓ to navigate",
    ])
  ) {
    return { state: "idle", rule: "live_prompt_box" };
  }
  // claude.toml: "osc_title_idle" (priority 250, title region ✳).
  if (re(whole, "^\\u2733 ", "m")) {
    return { state: "idle", rule: "osc_title_idle" };
  }

  return { state: "unknown", rule: null };
}

// ---------------------------------------------------------------------------
// codex — herdr remote/codex.toml v2026.10.11.1
// ---------------------------------------------------------------------------

function classifyCodex(raw) {
  const whole = clean(raw);
  const lower = whole.toLowerCase();
  const bottom20 = bottomText(raw, 20);

  // skip_state_update first.
  // codex.toml: "transcript_viewer" (priority 1000, skip_state_update).
  if (
    hasAll(whole, ["↑/↓ to scroll", "pgup/pgdn to", "home/end to jump", "q to quit"]) &&
    (has(whole, "esc to edit prev") || has(whole, "esc/← to edit prev"))
  ) {
    return { state: "unknown", rule: "transcript_viewer" };
  }

  // codex.toml: "osc_title_blocked" (priority 1100): "Action Required".
  if (has(whole, "Action Required")) {
    return { state: "blocked", rule: "osc_title_blocked" };
  }
  // codex.toml: "trust_directory" (priority 950, top 20).
  if (
    (re(whole, "^> You are in [^\\r\\n]+(?:\\r?\\n|$)", "m") ||
      has(whole, "Folder access")) &&
    (re(whole, "Do\\s+you\\s+trust\\s+the\\s+contents\\s+of\\s+this\\s+directory\\?", "s") ||
      (has(whole, "Trust this folder?") &&
        has(whole, "Codex can read, edit, and run files here") &&
        (has(whole, "Trust and continue") || has(whole, "enter continue"))))
  ) {
    return { state: "blocked", rule: "trust_directory" };
  }
  // codex.toml: "startup_update" (priority 950, bottom 20): the legacy dialog
  // (heading + "Skip until next version" / "Press enter to continue"), or the
  // shared picker of 0.159+ (heading line + its footer at the very bottom).
  {
    const bottom = bottom20;
    const legacy =
      hasAll(bottom, ["Update available!", "Update now"]) &&
      (re(bottom, "Skip\\s+until\\s+next\\s+version", "") || re(bottom, "Press enter to continue\\s*$", ""));
    const picker =
      re(bottom, "^\\s*Update\\s+available\\s+·", "m") && re(bottom, "enter\\s+continue\\s+·\\s+esc\\s+skip\\s*$", "");
    if (legacy || picker) {
      return { state: "blocked", rule: "startup_update" };
    }
  }
  // codex "Hooks need review" dialog (live 0.159.1, evidence §4b): first run
  // with untrusted hooks shows a numbered picker; the agent cannot proceed
  // until the user reviews. Real blocked, needs its own rule (no herdr id).
  if (
    has(whole, "Hooks need review") &&
    hasAny(whole, ["Review hooks", "Trust all and continue", "Continue without trusting"]) &&
    hasAny(bottom20, ["enter confirm", "esc skip", "enter select", "esc back"])
  ) {
    return { state: "blocked", rule: "codex_hooks_review" };
  }
  // codex sandbox-setup dialog (live 0.159.1, evidence §4c): numbered picker
  // before any sandbox exists. Real blocked, needs its own rule.
  if (
    has(whole, "Set up the Codex agent sandbox") &&
    hasAny(whole, ["Set up default sandbox", "Use non-admin sandbox"]) &&
    hasAny(bottom20, ["enter select", "esc back", "enter continue"])
  ) {
    return { state: "blocked", rule: "codex_sandbox_setup" };
  }
  if (
    hasAny(whole, [
      "press enter to confirm or esc to cancel",
      "enter to submit answer",
      "enter to submit all",
      "allow command?",
      "All Results",
    ])
  ) {
    return { state: "blocked", rule: "live_strong_blocker" };
  }
  // codex.toml: "weak_blocker" (priority 600).
  if (
    hasAny(whole, ["[y/n]", "yes (y)"]) ||
    ((has(lower, "do you want to") || has(lower, "would you like to")) &&
      (has(lower, "yes") || has(whole, "❯")) &&
      !re(whole, "^›[⠁⠂⠄⠈⠐⠠⡀⢀][^\\n]*(?:\\n(?:[^•■✗✓\\n][^\\n]*)?)*$", "m"))
  ) {
    return { state: "blocked", rule: "weak_blocker" };
  }

  // codex.toml has no idle rule for this surface (its osc_title_idle is
  // title-region only). Real lab evidence (codex 0.159.1, capture --surfaces,
  // local://codex-surface-evidence.md): the resting composer is the `› Ask
  // Codex to do anything` prompt line plus the `GPT-… default · <cwd>` model
  // footer and the `? for shortcuts` hint (measured: the `← for agents` beside
  // it is not always there — a `⚠ 1 warning · f2 to view` can take its place). That chrome
  // is ALSO visible mid-turn, so idle additionally requires NO working line
  // (spinner/timer/interrupt) and NO turn-result line (`Worked for …`,
  // `Hook failed`, trust/sandbox/setup pickers handled above as blocked).
  // Rule id: codex_composer_idle (connector-owned, evidence-backed).
  if (
    re(whole, "^› Ask Codex to do anything\\s*$", "m") &&
    has(whole, "? for shortcuts") &&
    !re(whole, "(?:^| )[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?: |$)") &&
    !re(whole, "Worked for \\d", "") &&
    !has(whole, "Hook failed") &&
    !has(whole, " to interrupt)") &&
    !re(whole, "\\(\\d+[smh]\\)") &&
    !has(whole, "Action Required")
  ) {
    return { state: "idle", rule: "codex_composer_idle" };
  }


  // codex.toml: "osc_title_working" (priority 1050, braille spinner).
  if (re(whole, "(?:^| )[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?: |$)")) {
    return { state: "working", rule: "osc_title_working" };
  }
  // codex.toml: "screen_working_fallback" (priority 500): live timer suffix.
  if (
    ((has(whole, " to interrupt)") || re(whole, "\\(\\d+[smh]\\)"))) &&
    re(whole, "^(?:[•◦][ \\t]+)?[^\\s›•◦■✗✓─][^\\r\\n]* \\((?:[0-9]+[hm] )*[0-9]+s", "m") &&
    !re(whole, "^(?:[•◦][ \\t]+)?Reconnect failed — check the endpoint", "m")
  ) {
    return { state: "working", rule: "screen_working_fallback" };
  }

  // NOTE: codex.toml "osc_title_idle" (priority 100) is a title-region
  // catch-all (any non-empty title without spinner/"Action Required"). It is
  // deliberately NOT applied to surface text: on a surface it would mark
  // everything idle. Codex idleness from a surface alone is `unknown`.
  return { state: "unknown", rule: null };
}

// classifySurface(agent, text) -> {state, rule}.
// agent: "claude" | "codex". Anything else (or non-string text) is unknown.
// Used by RuntimeCLI start-readiness checks and RuntimeCore discovery;
// reporter hook states always win while a connector occupant lives.
export function classifySurface(agent, text) {
  if (agent === "claude") return classifyClaude(text);
  if (agent === "codex") return classifyCodex(text);
  return { state: "unknown", rule: null };
}
