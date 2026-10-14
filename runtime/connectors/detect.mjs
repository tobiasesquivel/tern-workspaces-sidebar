// runtime/connectors/detect.mjs — what an agent's screen says, by herdr's rules.
//
// Ownership: ThirdConnectors. The daemon's detection loop (runtime/detection.mjs)
// reads each agent pane and calls classifySurface; this module only picks the
// manifest and shapes the input. The rules themselves are herdr's agent-detection
// manifests (github.com/herdrdev/herdr, Apache-2.0; the license text ships in
// sounds/LICENSE) interpreted by ./manifest.mjs, plus Tern's own overlay rules in
// ./manifests/tern-<agent>.toml.
//
// Same answers as herdr: the highest-priority matching rule wins; no match is
// `idle` for a known agent; `skip` means "drop this read"; the OSC title is its own
// region (`title`), never the screen text.

import { detectionText, evaluate, loadManifest } from "./manifest.mjs";

const ANSI_RE = new RegExp("\u001b\\[[0-9;?]*[ -/]*[@-~]|\u001b\\][^\u0007\u001b]*(?:\u0007|\u001b\\\\)|\u001b[()][0-9A-Z]", "g");
const KNOWN = new Set(["claude", "codex", "omp"]);
const cache = new Map();

function manifestFor(agent) {
  if (!cache.has(agent)) cache.set(agent, loadManifest(agent));
  return cache.get(agent);
}

const UNKNOWN = Object.freeze({
  state: "unknown",
  rule: null,
  visible_idle: false,
  visible_blocker: false,
  visible_working: false,
  skip: false,
});

// classifySurface(agent, text, {title?, progress?}) ->
//   {state, rule, visible_idle, visible_blocker, visible_working, skip}.
// agent: "claude" | "codex" | "omp" (omp: Tern's startup rules only). Anything
// else is unknown: there is no manifest to read it with.
export function classifySurface(agent, text, { title = "", progress = "" } = {}) {
  if (!KNOWN.has(agent)) return { ...UNKNOWN };
  const screen = detectionText(typeof text === "string" ? text.replace(ANSI_RE, "") : "");
  const clip = (s) => (typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 256) : "");
  return evaluate(manifestFor(agent), { screen, title: clip(title), progress: clip(progress) });
}

// Tests and the lab reload the manifests after changing the remote copy.
export function resetManifestCache() {
  cache.clear();
}
